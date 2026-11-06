import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, type DownloadResponse, type MediaView, type Page } from '@mypic/shared';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { doc, tableName } from '../lib/ddb';
import { HttpError, json, pathParam, userIdOf, type AuthedEvent } from '../lib/http';
import { attachmentDisposition, toView, type MediaRecord } from '../lib/media';
import { bucketName, DOWNLOAD_URL_TTL, s3 } from '../lib/s3';

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 100;

/** GET /media?cursor=&limit=: timeline, newest first (GSI1, excludes trash). */
export async function listMedia(event: AuthedEvent) {
  const userId = userIdOf(event);
  const qs = event.queryStringParameters ?? {};
  const limit = Math.min(Math.max(Number(qs.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const pk = ddb.user(userId);

  const res = await doc.send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: decodeCursor(qs.cursor, { attr: 'gsi1pk', value: pk }),
    }),
  );

  const page: Page<MediaView> = {
    items: (res.Items as MediaRecord[] | undefined ?? []).map(toView),
    cursor: encodeCursor(res.LastEvaluatedKey),
  };
  return json(200, page);
}

/** GET /media/{mediaId}/download: short-lived link to the original file. */
export async function downloadMedia(event: AuthedEvent) {
  const userId = userIdOf(event);
  const mediaId = pathParam(event, 'mediaId');
  const res = await doc.send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: ddb.user(userId), sk: ddb.media(mediaId) },
    }),
  );
  const record = res.Item as MediaRecord | undefined;
  if (!record || record.status === 'UPLOADING') throw new HttpError(404, 'Not found');

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
