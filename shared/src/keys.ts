/**
 * DynamoDB single-table key builders and S3 key layout.
 * Every key is scoped by userId (Cognito sub). Never take userId from a request body.
 */

export const ddb = {
  user: (uid: string) => `USER#${uid}`,
  media: (mediaId: string) => `MEDIA#${mediaId}`,
  album: (albumId: string) => `ALBUM#${albumId}`,
  albumItemsPk: (albumId: string) => `ALBUM#${albumId}`,
  tagItemsPk: (uid: string, tag: string) => `USER#${uid}#TAG#${tag.toLowerCase()}`,
  item: (takenAt: string, mediaId: string) => `ITEM#${takenAt}#${mediaId}`,
  share: (token: string) => `SHARE#${token}`,
  zip: (jobId: string) => `ZIP#${jobId}`,
  /** GSI1: timeline (sparse, only non-trashed media). */
  timelineSk: (takenAt: string, mediaId: string) => `TAKEN#${takenAt}#${mediaId}`,
  /** GSI2: trash (sparse, only trashed media). */
  trashPk: (uid: string) => `USER#${uid}#TRASH`,
  trashSk: (deletedAt: string, mediaId: string) => `${deletedAt}#${mediaId}`,
} as const;

export type DerivedKind = 'thumb.webp' | 'preview.webp' | 'video.mp4' | 'poster.jpg';

export const s3Keys = {
  original: (uid: string, mediaId: string, filename: string) =>
    `originals/${uid}/${mediaId}/${sanitizeFilename(filename)}`,
  derived: (uid: string, mediaId: string, kind: DerivedKind) =>
    `derived/${uid}/${mediaId}/${kind}`,
  /** Path as seen through CloudFront (distribution originPath is /derived). */
  cdnPath: (uid: string, mediaId: string, kind: DerivedKind) => `/${uid}/${mediaId}/${kind}`,
  zip: (uid: string, jobId: string) => `zips/${uid}/${jobId}.zip`,
} as const;

/** Keep S3 keys safe: strip path separators and control chars, cap length. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\w.\- ()]/g, '_')
    .trim();
  return (cleaned || 'file').slice(0, 200);
}
