import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  MAX_BATCH_ITEMS,
  MAX_TAGS_PER_ITEM,
  ddb,
  normalizeTag,
  type BatchResponse,
  type MediaView,
  type Page,
} from '@mypic/shared';
import { z } from 'zod';
import { cdnUrlsFor } from '../lib/cdn';
import { pageLimit } from '../lib/collections';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { doc, mapLimit, tableName } from '../lib/ddb';
import { HttpError, json, parseBody, pathParam, userIdOf, type AuthedEvent } from '../lib/http';
import { getMediaRecord, invokeAsync, setValues, toView, type MediaRecord } from '../lib/media';
import { addToCollection, removeFromCollection } from '../lib/membership';
import { purgeMedia, restoreMedia, trashMedia } from '../lib/trash';

/** DELETE /media/{mediaId}: move to trash. */
export async function trashOne(event: AuthedEvent) {
  const userId = userIdOf(event);
  const record = await trashMedia(await getMediaRecord(userId, pathParam(event, 'mediaId')));
  return json(200, toView(record));
}

/** POST /media/{mediaId}/restore */
export async function restoreOne(event: AuthedEvent) {
  const userId = userIdOf(event);
  const record = await restoreMedia(await getMediaRecord(userId, pathParam(event, 'mediaId')));
  return json(200, toView(record, await cdnUrlsFor(userId)));
}

/** GET /trash: trashed items, most recently deleted first. */
export async function listTrash(event: AuthedEvent) {
  const userId = userIdOf(event);
  const qs = event.queryStringParameters ?? {};
  const pk = ddb.trashPk(userId);
  const [res, url] = await Promise.all([
    doc.send(
      new QueryCommand({
        TableName: tableName(),
        IndexName: 'GSI2',
        KeyConditionExpression: 'gsi2pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ScanIndexForward: false,
        Limit: pageLimit(qs.limit),
        ExclusiveStartKey: decodeCursor(qs.cursor, { attr: 'gsi2pk', value: pk }),
      }),
    ),
    cdnUrlsFor(userId),
  ]);
  const page: Page<MediaView> = {
    items: ((res.Items ?? []) as MediaRecord[]).map((r) => toView(r, url)),
    cursor: encodeCursor(res.LastEvaluatedKey),
  };
  return json(200, page);
}

/** DELETE /trash: purge everything in the caller's trash (runs in the purge job). */
export async function emptyTrash(event: AuthedEvent) {
  const userId = userIdOf(event);
  await invokeAsync('PURGE_FN', { userId });
  return json(202, { message: 'Emptying trash' });
}

const batchSchema = z
  .object({
    action: z.enum(['trash', 'restore', 'purge', 'addToAlbum', 'removeFromAlbum', 'addTags', 'removeTags']),
    mediaIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_BATCH_ITEMS),
    albumId: z.string().min(1).max(64).optional(),
    tags: z.array(z.string()).max(MAX_TAGS_PER_ITEM).optional(),
  })
  .refine((b) => !['addToAlbum', 'removeFromAlbum'].includes(b.action) || b.albumId, 'albumId is required')
  .refine((b) => !['addTags', 'removeTags'].includes(b.action) || b.tags?.length, 'tags are required');

/** POST /media/batch: apply one action to many items; reports per-item failures. */
export async function batch(event: AuthedEvent) {
  const userId = userIdOf(event);
  const body = parseBody(event, batchSchema);

  const tags = body.tags?.map(normalizeTag) ?? [];
  if (tags.some((t) => !t)) throw new HttpError(400, 'Tags may use letters, numbers, spaces, "-" and "_" (max 40)');
  const validTags = [...new Set(tags as string[])];

  const response: BatchResponse = { succeeded: [], failed: [] };
  await mapLimit([...new Set(body.mediaIds)], 8, async (mediaId) => {
    try {
      const record = await getMediaRecord(userId, mediaId);
      switch (body.action) {
        case 'trash':
          await trashMedia(record);
          break;
        case 'restore':
          await restoreMedia(record);
          break;
        case 'purge':
          await purgeMedia(record);
          break;
        case 'addToAlbum':
          await addToCollection(record, { kind: 'album', albumId: body.albumId! });
          break;
        case 'removeFromAlbum':
          await removeFromCollection(record, { kind: 'album', albumId: body.albumId! });
          break;
        case 'addTags': {
          const current = setValues(record.tags);
          if (new Set([...current, ...validTags]).size > MAX_TAGS_PER_ITEM) {
            throw new HttpError(400, `At most ${MAX_TAGS_PER_ITEM} tags per item`);
          }
          for (const tag of validTags) await addToCollection(record, { kind: 'tag', tag });
          break;
        }
        case 'removeTags':
          for (const tag of validTags) await removeFromCollection(record, { kind: 'tag', tag });
          break;
      }
      response.succeeded.push(mediaId);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(JSON.stringify({ msg: 'batch item failed', mediaId, error: String(err) }));
      response.failed.push({ mediaId, message: err instanceof HttpError ? err.message : 'Internal error' });
    }
  });
  return json(200, response);
}
