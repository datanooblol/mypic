import { S3Client } from '@aws-sdk/client-s3';

/**
 * Browser uploads use presigned URLs. Newer SDK versions add CRC32 checksum
 * parameters to presigned URLs by default, which browsers can't satisfy, so only
 * compute checksums when an operation requires them.
 */
export const s3 = new S3Client({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

export function bucketName(): string {
  const name = process.env.BUCKET_NAME;
  if (!name) throw new Error('BUCKET_NAME is not set');
  return name;
}

/** Presigned URL lifetimes (seconds). */
export const UPLOAD_URL_TTL = 60 * 60;
export const DOWNLOAD_URL_TTL = 5 * 60;
