import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  paginateQuery,
} from '@aws-sdk/lib-dynamodb';
import { ddb, type AlbumView } from '@mypic/shared';
import { ulid } from 'ulid';
import { z } from 'zod';
import { cdnUrlsFor, type DerivedUrl } from '../lib/cdn';
import { listMembers } from '../lib/collections';
import { batchGetAll, batchWriteAll, doc, mapLimit, tableName } from '../lib/ddb';
import { HttpError, json, parseBody, pathParam, userIdOf, type AuthedEvent } from '../lib/http';
import { getMediaRecord, setValues, type MediaRecord } from '../lib/media';

interface AlbumRecord {
  pk: string;
  sk: string;
  albumId: string;
  userId: string;
  name: string;
  description?: string;
  coverMediaId?: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

const name = z.string().trim().min(1).max(100);
const description = z.string().trim().max(500);
const createSchema = z.object({ name, description: description.optional() });
const updateSchema = z
  .object({ name: name.optional(), description: description.optional(), coverMediaId: z.string().min(1).optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

function view(album: AlbumRecord, cover?: MediaRecord, url?: DerivedUrl): AlbumView {
  const usableCover = cover && !cover.deletedAt && setValues(cover.derived).includes('thumb.webp');
  return {
    albumId: album.albumId,
    name: album.name,
    description: album.description || undefined,
    coverMediaId: album.coverMediaId,
    coverUrl: usableCover && url ? url(cover.mediaId, 'thumb.webp') : undefined,
    itemCount: Math.max(0, album.itemCount ?? 0),
    createdAt: album.createdAt,
    updatedAt: album.updatedAt,
  };
}

async function getAlbum(userId: string, albumId: string): Promise<AlbumRecord> {
  const res = await doc.send(
    new GetCommand({ TableName: tableName(), Key: { pk: ddb.user(userId), sk: ddb.album(albumId) } }),
  );
  if (!res.Item) throw new HttpError(404, 'Album not found');
  return res.Item as AlbumRecord;
}

async function withCovers(userId: string, albums: AlbumRecord[]): Promise<AlbumView[]> {
  const coverIds = [...new Set(albums.map((a) => a.coverMediaId).filter((id): id is string => !!id))];
  const [covers, url] = await Promise.all([
    batchGetAll<MediaRecord>(coverIds.map((id) => ({ pk: ddb.user(userId), sk: ddb.media(id) }))),
    cdnUrlsFor(userId),
  ]);
  const byId = new Map(covers.map((c) => [c.mediaId, c]));
  return albums.map((a) => view(a, a.coverMediaId ? byId.get(a.coverMediaId) : undefined, url));
}

/** GET /albums: all albums, most recently changed first. */
export async function listAlbums(event: AuthedEvent) {
  const userId = userIdOf(event);
  const albums: AlbumRecord[] = [];
  for await (const page of paginateQuery(
    { client: doc },
    {
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': ddb.user(userId), ':prefix': 'ALBUM#' },
    },
  )) {
    albums.push(...((page.Items ?? []) as AlbumRecord[]));
  }
  albums.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return json(200, { items: await withCovers(userId, albums) });
}

/** POST /albums */
export async function createAlbum(event: AuthedEvent) {
  const userId = userIdOf(event);
  const body = parseBody(event, createSchema);
  const now = new Date().toISOString();
  const albumId = ulid();
  const album: AlbumRecord = {
    pk: ddb.user(userId),
    sk: ddb.album(albumId),
    albumId,
    userId,
    name: body.name,
    description: body.description || undefined,
    itemCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await doc.send(new PutCommand({ TableName: tableName(), Item: album }));
  return json(201, view(album));
}

/** GET /albums/{albumId} */
export async function getAlbumView(event: AuthedEvent) {
  const userId = userIdOf(event);
  const album = await getAlbum(userId, pathParam(event, 'albumId'));
  const [result] = await withCovers(userId, [album]);
  return json(200, result);
}

/** PATCH /albums/{albumId}: rename, describe, or choose a cover (must be in the album). */
export async function updateAlbum(event: AuthedEvent) {
  const userId = userIdOf(event);
  const albumId = pathParam(event, 'albumId');
  const body = parseBody(event, updateSchema);
  if (body.coverMediaId) {
    const media = await getMediaRecord(userId, body.coverMediaId);
    if (!setValues(media.albumIds).includes(albumId)) throw new HttpError(400, 'Cover must be an item in this album');
  }
  const set: Record<string, unknown> = { ...body, updatedAt: new Date().toISOString() };
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const assignments = Object.entries(set).map(([key, value], i) => {
    names[`#k${i}`] = key;
    values[`:v${i}`] = value;
    return `#k${i} = :v${i}`;
  });
  try {
    const res = await doc.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: ddb.user(userId), sk: ddb.album(albumId) },
        ConditionExpression: 'attribute_exists(pk)',
        UpdateExpression: `SET ${assignments.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    const [result] = await withCovers(userId, [res.Attributes as AlbumRecord]);
    return json(200, result);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw new HttpError(404, 'Album not found');
    throw err;
  }
}

/** DELETE /albums/{albumId}: removes the album and memberships; the photos stay. */
export async function deleteAlbum(event: AuthedEvent) {
  const userId = userIdOf(event);
  const albumId = pathParam(event, 'albumId');
  await getAlbum(userId, albumId);

  // Delete the album first so nothing new can be added while memberships are cleaned up.
  await doc.send(new DeleteCommand({ TableName: tableName(), Key: { pk: ddb.user(userId), sk: ddb.album(albumId) } }));

  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': ddb.albumItemsPk(albumId) },
        ExclusiveStartKey: cursor,
        Limit: 200,
      }),
    );
    const items = (page.Items ?? []) as { pk: string; sk: string; mediaId: string }[];
    await mapLimit(items, 10, (item) =>
      doc
        .send(
          new UpdateCommand({
            TableName: tableName(),
            Key: { pk: ddb.user(userId), sk: ddb.media(item.mediaId) },
            ConditionExpression: 'attribute_exists(pk)',
            UpdateExpression: 'DELETE albumIds :a',
            ExpressionAttributeValues: { ':a': new Set([albumId]) },
          }),
        )
        .catch((err) => {
          if (!(err instanceof ConditionalCheckFailedException)) throw err;
        }),
    );
    await batchWriteAll(items.map((i) => ({ DeleteRequest: { Key: { pk: i.pk, sk: i.sk } } })));
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  return { statusCode: 204 };
}

/** GET /albums/{albumId}/items */
export async function listAlbumItems(event: AuthedEvent) {
  const userId = userIdOf(event);
  const albumId = pathParam(event, 'albumId');
  await getAlbum(userId, albumId); // ownership check: membership PKs don't include the user
  return json(200, await listMembers(userId, ddb.albumItemsPk(albumId), event.queryStringParameters ?? {}));
}
