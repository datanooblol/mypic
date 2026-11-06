import type { Media, MediaView } from '@mypic/shared';

export { detectMediaType } from '@mypic/shared';

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

/** Strip keys and internal fields before returning to clients. */
export function toView(record: MediaRecord): MediaView {
  const {
    pk: _pk, sk: _sk, s3Key: _s3Key, uploadId: _uploadId, partCount: _partCount,
    gsi1pk: _g1p, gsi1sk: _g1s, gsi2pk: _g2p, gsi2sk: _g2s, ttl: _ttl,
    ...view
  } = record;
  return view;
}

/** RFC 6266 Content-Disposition with a UTF-8 filename. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
