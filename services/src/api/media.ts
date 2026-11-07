import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, type DownloadResponse, type MediaView, type Page } from '@mypic/shared';
import { cdnUrlsFor } from '../lib/cdn';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { doc, tableName } from '../lib/ddb';
import { HttpError, json, pathParam, userIdOf, type AuthedEvent } from '../lib/http';
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

/** GET /media/{mediaId}/download: short-lived link to the original file. */
export async function downloadMedia(event: AuthedEvent) {
  const userId = userIdOf(event);
  const record = await getMediaRecord(userId, pathParam(event, 'mediaId'));
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucketName(),
      Key: record.s3Key,
      ResponseContentDisposition: attachmentDisposition(record.filename),
    }),
    { expiresIn: DOWNLOAD_URL_TTL },
  );
  return json(200, { url } satisfies DownloadResponse);
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
