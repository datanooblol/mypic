import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { Media, MediaView } from '@mypic/shared';
import type { DerivedUrl } from './cdn';

export { detectMediaType } from '@mypic/shared';

const lambda = new LambdaClient({});

/** Payload of the processing Lambda. */
export interface ProcessRequest {
  userId: string;
  mediaId: string;
}

/** Media as stored in DynamoDB: the public shape plus keys and internal fields. */
export interface MediaRecord extends Media {
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
  const result: MediaView = view;
  if (url && record.derived?.length) {
    const has = new Set(record.derived);
    if (has.has('thumb.webp')) result.thumbUrl = url(record.mediaId, 'thumb.webp');
    if (has.has('preview.webp')) result.previewUrl = url(record.mediaId, 'preview.webp');
    if (has.has('video.mp4')) result.videoUrl = url(record.mediaId, 'video.mp4');
    if (has.has('poster.jpg')) result.posterUrl = url(record.mediaId, 'poster.jpg');
  }
  return result;
}

/** Async-invoke the processing Lambda for one media item. */
export async function startProcessing(userId: string, mediaId: string): Promise<void> {
  const fn = process.env.PROCESSING_FN;
  if (!fn) throw new Error('PROCESSING_FN is not set');
  await lambda.send(
    new InvokeCommand({
      FunctionName: fn,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ userId, mediaId } satisfies ProcessRequest)),
    }),
  );
}

/** RFC 6266 Content-Disposition with a UTF-8 filename. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
