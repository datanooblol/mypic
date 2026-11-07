/**
 * Album and tag membership. Each collection keeps three things in sync:
 *   1. a membership record   (ALBUM#{id} | USER#{uid}#TAG#{tag}) / ITEM#{takenAt}#{mediaId}
 *   2. the media's string set (albumIds | tags)
 *   3. a counter             (album.itemCount | tag summary count)
 * Adds/removes are DynamoDB transactions, so a retry or double-click can't skew counts.
 * Counters exclude trashed items (trash/restore adjust them, see trash.ts).
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from '@mypic/shared';
import { batchWriteAll, doc, mapLimit, tableName, type Key } from './ddb';
import { HttpError } from './http';
import { setValues, type MediaRecord } from './media';

export type Collection = { kind: 'album'; albumId: string } | { kind: 'tag'; tag: string };

const setAttr = (c: Collection) => (c.kind === 'album' ? 'albumIds' : 'tags');
const setValue = (c: Collection) => (c.kind === 'album' ? c.albumId : c.tag);

export function membershipKey(userId: string, c: Collection, takenAt: string, mediaId: string): Key {
  return {
    pk: c.kind === 'album' ? ddb.albumItemsPk(c.albumId) : ddb.tagItemsPk(userId, c.tag),
    sk: ddb.item(takenAt, mediaId),
  };
}

export function counterKey(userId: string, c: Collection): Key {
  return { pk: ddb.user(userId), sk: c.kind === 'album' ? ddb.album(c.albumId) : ddb.tagSummary(c.tag) };
}

/** Every collection a media item belongs to. */
export function collectionsOf(record: MediaRecord): Collection[] {
  return [
    ...setValues(record.albumIds).map((albumId): Collection => ({ kind: 'album', albumId })),
    ...setValues(record.tags).map((tag): Collection => ({ kind: 'tag', tag })),
  ];
}

/** Pre-M4 records stored empty lists; set operations need the attribute absent or a set. */
export async function normalizeLegacyLists(record: MediaRecord): Promise<void> {
  const legacy = (['tags', 'albumIds'] as const).filter((a) => Array.isArray(record[a]) && record[a].length === 0);
  if (!legacy.length) return;
  await doc.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: record.pk, sk: record.sk },
      UpdateExpression: `REMOVE ${legacy.map((_, i) => `#a${i}`).join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(legacy.map((a, i) => [`#a${i}`, a])),
    }),
  );
  for (const a of legacy) delete record[a];
}

/**
 * Counter update for one collection. Albums must exist (never resurrect a deleted
 * album); tag summaries are created on first use. On add, an album without a cover
 * gets this item as its cover.
 */
function counterUpdate(c: Collection, delta: number, now: string, coverMediaId?: string) {
  if (c.kind === 'album') {
    return {
      UpdateExpression: coverMediaId
        ? 'ADD itemCount :d SET updatedAt = :now, coverMediaId = if_not_exists(coverMediaId, :m)'
        : 'ADD itemCount :d SET updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':d': delta, ':now': now, ...(coverMediaId ? { ':m': coverMediaId } : {}) },
    };
  }
  return {
    UpdateExpression: 'ADD #count :d SET #tag = :tag, updatedAt = :now',
    ExpressionAttributeNames: { '#count': 'count', '#tag': 'tag' },
    ExpressionAttributeValues: { ':d': delta, ':tag': c.tag, ':now': now },
  };
}

function cancellationCodes(err: unknown): string[] | undefined {
  return err instanceof TransactionCanceledException
    ? (err.CancellationReasons ?? []).map((r) => r.Code ?? 'None')
    : undefined;
}

const MAX_CONFLICT_RETRIES = 6;

/**
 * Run a transaction, retrying when another transaction touched the same item at the
 * same moment (TransactionConflict). That happens routinely here: batch actions update
 * one album/tag counter from several items in parallel.
 */
export async function transactWithRetry(input: TransactWriteCommandInput): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await doc.send(new TransactWriteCommand(input));
      return;
    } catch (err) {
      const codes = cancellationCodes(err);
      const conflict = codes?.includes('TransactionConflict') && !codes.includes('ConditionalCheckFailed');
      if (!conflict || attempt >= MAX_CONFLICT_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, Math.random() * 40 * 2 ** attempt)); // full jitter
    }
  }
}

/** Add to an album or tag. Returns false if it was already a member. */
export async function addToCollection(record: MediaRecord, c: Collection): Promise<boolean> {
  if (record.deletedAt) throw new HttpError(409, 'Item is in the trash');
  await normalizeLegacyLists(record);
  const table = tableName();
  const now = new Date().toISOString();
  const counter = counterUpdate(c, 1, now, record.mediaId);
  try {
    await transactWithRetry({
        TransactItems: [
          {
            Put: {
              TableName: table,
              Item: {
                ...membershipKey(record.userId, c, record.takenAt, record.mediaId),
                mediaId: record.mediaId,
                userId: record.userId,
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: table,
              Key: { pk: record.pk, sk: record.sk },
              UpdateExpression: 'ADD #set :v',
              ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deletedAt)',
              ExpressionAttributeNames: { '#set': setAttr(c) },
              ExpressionAttributeValues: { ':v': new Set([setValue(c)]) },
            },
          },
          { Update: { TableName: table, Key: counterKey(record.userId, c), ...counter } },
        ],
    });
    return true;
  } catch (err) {
    const codes = cancellationCodes(err);
    if (codes?.[0] === 'ConditionalCheckFailed') return false;
    if (codes?.[1] === 'ConditionalCheckFailed') throw new HttpError(409, 'Item is in the trash or was deleted');
    if (codes?.[2] === 'ConditionalCheckFailed') throw new HttpError(404, 'Album not found');
    throw err;
  }
}

/** Remove from an album or tag. Returns false if it wasn't a member. */
export async function removeFromCollection(record: MediaRecord, c: Collection): Promise<boolean> {
  if (record.deletedAt) throw new HttpError(409, 'Item is in the trash');
  const table = tableName();
  const now = new Date().toISOString();
  const counter = counterUpdate(c, -1, now);
  try {
    await transactWithRetry({
        TransactItems: [
          {
            Delete: {
              TableName: table,
              Key: membershipKey(record.userId, c, record.takenAt, record.mediaId),
              ConditionExpression: 'attribute_exists(pk)',
            },
          },
          {
            Update: {
              TableName: table,
              Key: { pk: record.pk, sk: record.sk },
              UpdateExpression: 'DELETE #set :v',
              ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deletedAt)',
              ExpressionAttributeNames: { '#set': setAttr(c) },
              ExpressionAttributeValues: { ':v': new Set([setValue(c)]) },
            },
          },
          { Update: { TableName: table, Key: counterKey(record.userId, c), ...counter } },
        ],
    });
  } catch (err) {
    const codes = cancellationCodes(err);
    if (codes?.[0] === 'ConditionalCheckFailed') return false;
    if (codes?.[1] === 'ConditionalCheckFailed') throw new HttpError(409, 'Item is in the trash or was deleted');
    throw err;
  }
  if (c.kind === 'tag') await deleteEmptyTagSummary(record.userId, c.tag);
  return true;
}

/** Adjust album/tag counters by `delta` for every collection of an item (trash: -1, restore: +1). */
export async function adjustCounters(record: MediaRecord, delta: 1 | -1): Promise<void> {
  const now = new Date().toISOString();
  await mapLimit(collectionsOf(record), 5, async (c) => {
    try {
      await doc.send(
        new UpdateCommand({ TableName: tableName(), Key: counterKey(record.userId, c), ...counterUpdate(c, delta, now) }),
      );
    } catch (err) {
      // An album deleted meanwhile has no counter to adjust.
      if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
    }
    if (c.kind === 'tag' && delta < 0) await deleteEmptyTagSummary(record.userId, c.tag);
  });
}

async function deleteEmptyTagSummary(userId: string, tag: string) {
  try {
    await doc.send(
      new DeleteCommand({
        TableName: tableName(),
        Key: counterKey(userId, { kind: 'tag', tag }),
        ConditionExpression: '#count <= :zero',
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: { ':zero': 0 },
      }),
    );
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
  }
}

/** Processing changed takenAt: move membership records to the new sort key. */
export async function rekeyMemberships(record: MediaRecord, newTakenAt: string): Promise<void> {
  if (newTakenAt === record.takenAt) return;
  const collections = collectionsOf(record);
  if (!collections.length) return;
  await batchWriteAll(
    collections.flatMap((c) => [
      { DeleteRequest: { Key: membershipKey(record.userId, c, record.takenAt, record.mediaId) } },
      {
        PutRequest: {
          Item: {
            ...membershipKey(record.userId, c, newTakenAt, record.mediaId),
            mediaId: record.mediaId,
            userId: record.userId,
          },
        },
      },
    ]),
  );
}

/** Purge: delete every membership record of an item (counters were already adjusted on trash). */
export async function deleteMemberships(record: MediaRecord): Promise<void> {
  await batchWriteAll(
    collectionsOf(record).map((c) => ({
      DeleteRequest: { Key: membershipKey(record.userId, c, record.takenAt, record.mediaId) },
    })),
  );
}
