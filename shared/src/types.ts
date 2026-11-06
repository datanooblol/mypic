import type { DerivedKind } from './keys';

/** Domain types shared by services (Lambda) and web (Next.js). See docs/SPEC.md. */

export type MediaType = 'image' | 'raw' | 'video';

export type MediaStatus =
  | 'UPLOADING'
  | 'PROCESSING'
  | 'TRANSCODING'
  | 'READY'
  | 'FAILED';

export interface ExifSummary {
  make?: string;
  model?: string;
  lens?: string;
  focalLength?: number;
  fNumber?: number;
  exposureTime?: string;
  iso?: number;
  gps?: { lat: number; lon: number };
}

export interface Media {
  mediaId: string; // ULID
  userId: string; // Cognito sub
  type: MediaType;
  status: MediaStatus;
  filename: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  durationSec?: number;
  takenAt: string; // ISO-8601 UTC instant (for zone-less camera times: wall clock as UTC)
  /** Minutes east of UTC where the photo was taken; display = takenAt + offset. */
  takenAtOffset?: number;
  uploadedAt: string; // ISO-8601
  exif?: ExifSummary;
  tags: string[];
  albumIds: string[];
  deletedAt?: string;
  error?: string;
  /** Derived files that exist under derived/{userId}/{mediaId}/. */
  derived?: DerivedKind[];
  processedAt?: string;
}

export interface Album {
  albumId: string;
  userId: string;
  name: string;
  description?: string;
  coverMediaId?: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Media as returned to clients, with short-lived signed URLs. */
export interface MediaView extends Media {
  thumbUrl?: string;
  previewUrl?: string;
  videoUrl?: string;
  posterUrl?: string;
}

export interface Page<T> {
  items: T[];
  cursor?: string;
}

/** Max upload size per file (5 GB). */
export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;
/** Files above this use S3 multipart upload. */
export const MULTIPART_THRESHOLD_BYTES = 16 * 1024 ** 2;
export const MULTIPART_PART_BYTES = 16 * 1024 ** 2;
