import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, type Media, type MediaView } from '@mypic/shared';
import { doc, tableName } from './ddb';
import { HttpError } from './http';
import type { DerivedUrl } from './cdn';

export { detectMediaType } from '@mypic/shared';

const lambda = new LambdaClient({});

/** Payload of the processing Lambda. */
export interface ProcessRequest {
  userId: string;
  mediaId: string;
}

/**
 * Media as stored in DynamoDB: the public shape plus keys and internal fields.
 * tags/albumIds are string sets (absent when empty). Records written before M4 may
 * hold empty lists instead; normalizeLegacyLists converts those before set updates.
 */
export interface MediaRecord extends Omit<Media, 'tags' | 'albumIds'> {
  tags?: Set<string> | string[];
  albumIds?: Set<string> | string[];
  pk: string;
  sk: string;
  s3Key: string;
  /** Present while a multipart upload is in progress. */
  uploadId?: string;
  partCount?: number;
  gsi1pk?: string;
  gsi1sk?: string;
  gsi2pk?: string;
  gsi2sk?: string;
  /** DynamoDB TTL (epoch seconds): abandoned uploads expire. */
  ttl?: number;
}

/** Strip keys and internal fields before returning to clients; attach signed CDN URLs. */
export function toView(record: MediaRecord, url?: DerivedUrl): MediaView {
  const {
    pk: _pk, sk: _sk, s3Key: _s3Key, uploadId: _uploadId, partCount: _partCount,
    gsi1pk: _g1p, gsi1sk: _g1s, gsi2pk: _g2p, gsi2sk: _g2s, ttl: _ttl,
    ...view
  } = record;
  const result: MediaView = { ...view, tags: setValues(record.tags), albumIds: setValues(record.albumIds) };
  if (url && record.derived?.length) {
    const has = new Set(record.derived);
    if (has.has('thumb.webp')) result.thumbUrl = url(record.mediaId, 'thumb.webp');
    if (has.has('preview.webp')) result.previewUrl = url(record.mediaId, 'preview.webp');
    if (has.has('video.mp4')) result.videoUrl = url(record.mediaId, 'video.mp4');
    if (has.has('poster.jpg')) result.posterUrl = url(record.mediaId, 'poster.jpg');
  }
  return result;
}

/** Sorted array from a DynamoDB set, a legacy list, or nothing. */
export function setValues(value: Set<string> | string[] | undefined): string[] {
  return value ? [...value].sort() : [];
}

/** Async-invoke a Lambda named by an environment variable. */
export async function invokeAsync(envName: string, payload: unknown): Promise<void> {
  const fn = process.env[envName];
  if (!fn) throw new Error(`${envName} is not set`);
  await lambda.send(
    new InvokeCommand({ FunctionName: fn, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload)) }),
  );
}

/** Async-invoke the processing Lambda for one media item. */
export function startProcessing(userId: string, mediaId: string): Promise<void> {
  return invokeAsync('PROCESSING_FN', { userId, mediaId } satisfies ProcessRequest);
}

/** Load one of the caller's media records; 404 if missing (or still uploading, unless allowed). */
export async function getMediaRecord(
  userId: string,
  mediaId: string,
  opts: { allowUploading?: boolean } = {},
): Promise<MediaRecord> {
  const res = await doc.send(
    new GetCommand({ TableName: tableName(), Key: { pk: ddb.user(userId), sk: ddb.media(mediaId) } }),
  );
  const record = res.Item as MediaRecord | undefined;
  if (!record || (record.status === 'UPLOADING' && !opts.allowUploading)) throw new HttpError(404, 'Not found');
  return record;
}

/** RFC 6266 Content-Disposition with a UTF-8 filename. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
