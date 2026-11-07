import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  MAX_BATCH_ITEMS,
  ddb,
  type DownloadManyResponse,
  type DownloadResponse,
  type MediaView,
  type Page,
} from '@mypic/shared';
import { z } from 'zod';
import { cdnUrlsFor } from '../lib/cdn';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { batchGetAll, doc, tableName } from '../lib/ddb';
import { HttpError, json, parseBody, pathParam, userIdOf, type AuthedEvent } from '../lib/http';
import { attachmentDisposition, getMediaRecord, startProcessing, toView, type MediaRecord } from '../lib/media';
import { bucketName, DOWNLOAD_URL_TTL, s3 } from '../lib/s3';

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 100;

/** GET /media?cursor=&limit=: timeline, newest first (GSI1, excludes trash). */
export async function listMedia(event: AuthedEvent) {
  const userId = userIdOf(event);
  const qs = event.queryStringParameters ?? {};
  const limit = Math.min(Math.max(Number(qs.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const pk = ddb.user(userId);

  const [res, url] = await Promise.all([
    doc.send(
      new QueryCommand({
        TableName: tableName(),
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: decodeCursor(qs.cursor, { attr: 'gsi1pk', value: pk }),
      }),
    ),
    cdnUrlsFor(userId),
  ]);

  const page: Page<MediaView> = {
    items: ((res.Items as MediaRecord[] | undefined) ?? []).map((r) => toView(r, url)),
    cursor: encodeCursor(res.LastEvaluatedKey),
  };
  return json(200, page);
}

/** GET /media/{mediaId}: one item with signed URLs (used to poll processing status). */
export async function getMedia(event: AuthedEvent) {
  const userId = userIdOf(event);
  const record = await getMediaRecord(userId, pathParam(event, 'mediaId'));
  return json(200, toView(record, await cdnUrlsFor(userId)));
}

function originalUrl(record: MediaRecord, expiresIn: number): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucketName(),
      Key: record.s3Key,
      ResponseContentDisposition: attachmentDisposition(record.filename),
    }),
    { expiresIn },
  );
}

/** GET /media/{mediaId}/download: short-lived link to the original file. */
export async function downloadMedia(event: AuthedEvent) {
  const userId = userIdOf(event);
  const record = await getMediaRecord(userId, pathParam(event, 'mediaId'));
  return json(200, { url: await originalUrl(record, DOWNLOAD_URL_TTL) } satisfies DownloadResponse);
}

/** Batch links live longer: the browser works through them one after another. */
const BATCH_DOWNLOAD_URL_TTL = 15 * 60;
const downloadManySchema = z.object({
  mediaIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_BATCH_ITEMS),
});

/** POST /media/download: links to many originals at once ("Download selected"). */
export async function downloadMany(event: AuthedEvent) {
  const userId = userIdOf(event);
  const ids = [...new Set(parseBody(event, downloadManySchema).mediaIds)];
  const records = await batchGetAll<MediaRecord>(ids.map((id) => ({ pk: ddb.user(userId), sk: ddb.media(id) })));
  const byId = new Map(records.map((r) => [r.mediaId, r]));

  const response: DownloadManyResponse = { items: [], failed: [] };
  for (const mediaId of ids) {
    const record = byId.get(mediaId);
    if (!record || record.status === 'UPLOADING') {
      response.failed.push({ mediaId, message: 'Not found' });
      continue;
    }
    response.items.push({
      mediaId,
      filename: record.filename,
      size: record.size,
      mime: record.mime,
      url: await originalUrl(record, BATCH_DOWNLOAD_URL_TTL), // local signing, no network call
    });
  }
  return json(200, response);
}

/** POST /media/{mediaId}/reprocess: regenerate thumbnails/metadata (e.g. after a failure). */
export async function reprocessMedia(event: AuthedEvent) {
  const userId = userIdOf(event);
  const mediaId = pathParam(event, 'mediaId');
  try {
    const res = await doc.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: ddb.user(userId), sk: ddb.media(mediaId) },
        ConditionExpression: 'attribute_exists(pk) AND #status <> :uploading',
        UpdateExpression: 'SET #status = :processing REMOVE #error',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
        ExpressionAttributeValues: { ':uploading': 'UPLOADING', ':processing': 'PROCESSING' },
        ReturnValues: 'ALL_NEW',
      }),
    );
    await startProcessing(userId, mediaId);
    return json(202, toView(res.Attributes as MediaRecord));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw new HttpError(404, 'Not found');
    throw err;
  }
}
