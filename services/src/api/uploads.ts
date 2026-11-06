import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  MAX_PART_URLS_PER_REQUEST,
  MAX_UPLOAD_BYTES,
  MULTIPART_PART_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  ddb,
  s3Keys,
  type CreateUploadResponse,
  type PartUrlsResponse,
} from '@mypic/shared';
import { ulid } from 'ulid';
import { z } from 'zod';
import { doc, tableName } from '../lib/ddb';
import { HttpError, json, parseBody, pathParam, userIdOf, type AuthedEvent } from '../lib/http';
import { detectMediaType, startProcessing, toView, type MediaRecord } from '../lib/media';
import { bucketName, s3, UPLOAD_URL_TTL } from '../lib/s3';

/** Abandoned uploads disappear after this (matches the bucket's multipart cleanup rule). */
const UPLOAD_TTL_SECONDS = 7 * 24 * 60 * 60;
const INTELLIGENT_TIERING = 'INTELLIGENT_TIERING';

const createSchema = z.object({
  filename: z.string().min(1).max(500),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  mime: z.string().max(200).default(''),
  lastModified: z.number().int().positive().optional(),
  timezoneOffset: z.number().int().min(-14 * 60).max(14 * 60).optional(),
});

const partsSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(MAX_PART_URLS_PER_REQUEST),
});

const completeSchema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) }))
    .optional(),
});

/** POST /uploads: create the media record and return how to upload the bytes. */
export async function createUpload(event: AuthedEvent) {
  const userId = userIdOf(event);
  const body = parseBody(event, createSchema);

  const type = detectMediaType(body.filename, body.mime);
  if (!type) throw new HttpError(415, `Unsupported file type: ${body.filename}`);

  const now = new Date();
  const mediaId = ulid();
  const s3Key = s3Keys.original(userId, mediaId, body.filename);
  const contentType = body.mime || 'application/octet-stream';
  const multipart = body.size > MULTIPART_THRESHOLD_BYTES;
  const takenAt = new Date(body.lastModified ?? now.getTime()).toISOString();

  let uploadId: string | undefined;
  let partCount: number | undefined;
  if (multipart) {
    const res = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: bucketName(),
        Key: s3Key,
        ContentType: contentType,
        StorageClass: INTELLIGENT_TIERING,
      }),
    );
    uploadId = res.UploadId;
    partCount = Math.ceil(body.size / MULTIPART_PART_BYTES);
  }

  const record: MediaRecord = {
    pk: ddb.user(userId),
    sk: ddb.media(mediaId),
    mediaId,
    userId,
    type,
    status: 'UPLOADING',
    filename: body.filename,
    mime: contentType,
    size: body.size,
    takenAt,
    takenAtOffset: body.timezoneOffset,
    uploadedAt: now.toISOString(),
    tags: [],
    albumIds: [],
    s3Key,
    uploadId,
    partCount,
    ttl: Math.floor(now.getTime() / 1000) + UPLOAD_TTL_SECONDS,
  };
  await doc.send(new PutCommand({ TableName: tableName(), Item: record }));

  let response: CreateUploadResponse;
  if (multipart) {
    response = { mediaId, mode: 'multipart', partSize: MULTIPART_PART_BYTES, partCount: partCount! };
  } else {
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucketName(),
        Key: s3Key,
        ContentType: contentType,
        StorageClass: INTELLIGENT_TIERING,
      }),
      { expiresIn: UPLOAD_URL_TTL },
    );
    response = { mediaId, mode: 'single', url, headers: { 'content-type': contentType } };
  }
  return json(201, response);
}

/** POST /uploads/{mediaId}/parts: presigned URLs for a batch of multipart parts. */
export async function partUrls(event: AuthedEvent) {
  const userId = userIdOf(event);
  const mediaId = pathParam(event, 'mediaId');
  const { partNumbers } = parseBody(event, partsSchema);
  const record = await getUploading(userId, mediaId);
  if (!record.uploadId || !record.partCount) throw new HttpError(409, 'Not a multipart upload');

  const urls: PartUrlsResponse['urls'] = {};
  for (const partNumber of new Set(partNumbers)) {
    if (partNumber > record.partCount) throw new HttpError(400, `Part ${partNumber} out of range`);
    urls[partNumber] = await getSignedUrl(
      s3,
      new UploadPartCommand({
        Bucket: bucketName(),
        Key: record.s3Key,
        UploadId: record.uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: UPLOAD_URL_TTL },
    );
  }
  return json(200, { urls } satisfies PartUrlsResponse);
}

/** POST /uploads/{mediaId}/complete: finish the upload and add it to the timeline. */
export async function completeUpload(event: AuthedEvent) {
  const userId = userIdOf(event);
  const mediaId = pathParam(event, 'mediaId');
  const { parts } = parseBody(event, completeSchema);
  const record = await getUploading(userId, mediaId);

  if (record.uploadId) {
    if (!parts || parts.length !== record.partCount) {
      throw new HttpError(400, `Expected ${record.partCount} parts`);
    }
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucketName(),
        Key: record.s3Key,
        UploadId: record.uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  // Verify the object really landed and matches the declared size.
  let size: number | undefined;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucketName(), Key: record.s3Key }));
    size = head.ContentLength;
  } catch {
    throw new HttpError(409, 'Upload not found in storage');
  }
  if (size !== record.size) throw new HttpError(409, `Size mismatch: expected ${record.size}, got ${size}`);

  try {
    const res = await doc.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: record.pk, sk: record.sk },
        ConditionExpression: '#status = :uploading',
        UpdateExpression:
          'SET #status = :processing, gsi1pk = :g1pk, gsi1sk = :g1sk REMOVE uploadId, partCount, #ttl',
        ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':uploading': 'UPLOADING',
          ':processing': 'PROCESSING',
          ':g1pk': ddb.user(userId),
          ':g1sk': ddb.timelineSk(record.takenAt, mediaId),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    // Thumbnails + EXIF. If the invoke fails the item stays PROCESSING and can be retried.
    await startProcessing(userId, mediaId).catch((err) =>
      console.error(JSON.stringify({ msg: 'startProcessing failed', mediaId, error: String(err) })),
    );
    return json(200, toView(res.Attributes as MediaRecord));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw new HttpError(409, 'Upload already completed');
    throw err;
  }
}

/** DELETE /uploads/{mediaId}: cancel an in-progress upload. */
export async function abortUpload(event: AuthedEvent) {
  const userId = userIdOf(event);
  const mediaId = pathParam(event, 'mediaId');
  const record = await getUploading(userId, mediaId);

  if (record.uploadId) {
    await s3
      .send(
        new AbortMultipartUploadCommand({
          Bucket: bucketName(),
          Key: record.s3Key,
          UploadId: record.uploadId,
        }),
      )
      .catch(() => undefined); // already aborted or expired
  } else {
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName(), Key: record.s3Key }));
  }
  await doc.send(
    new DeleteCommand({
      TableName: tableName(),
      Key: { pk: record.pk, sk: record.sk },
      ConditionExpression: '#status = :uploading',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':uploading': 'UPLOADING' },
    }),
  );
  return { statusCode: 204 };
}

async function getUploading(userId: string, mediaId: string): Promise<MediaRecord> {
  const res = await doc.send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: ddb.user(userId), sk: ddb.media(mediaId) },
    }),
  );
  const record = res.Item as MediaRecord | undefined;
  if (!record) throw new HttpError(404, 'Upload not found');
  if (record.status !== 'UPLOADING') throw new HttpError(409, 'Upload already completed');
  return record;
}
