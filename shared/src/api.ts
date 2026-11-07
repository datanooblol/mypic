/** Request/response contracts for the HTTP API (shared by services and web). */

export interface CreateUploadRequest {
  filename: string;
  size: number;
  mime: string;
  /** File.lastModified (epoch ms). Initial takenAt until EXIF is read. */
  lastModified?: number;
  /** Browser's UTC offset (minutes east) at lastModified, until EXIF provides one. */
  timezoneOffset?: number;
}

export type CreateUploadResponse =
  | {
      mediaId: string;
      mode: 'single';
      url: string;
      /** Headers the PUT must send exactly (they are part of the signature). */
      headers: Record<string, string>;
    }
  | {
      mediaId: string;
      mode: 'multipart';
      partSize: number;
      partCount: number;
    };

export interface PartUrlsRequest {
  partNumbers: number[];
}

export interface PartUrlsResponse {
  urls: Record<string, string>;
}

export interface CompleteUploadRequest {
  /** Required for multipart uploads: ETag returned by each part PUT. */
  parts?: { partNumber: number; etag: string }[];
}

export interface DownloadResponse {
  url: string;
}

export interface DownloadManyRequest {
  mediaIds: string[];
}

export interface DownloadManyResponse {
  /** In request order; presigned GETs with Content-Disposition: attachment. */
  items: { mediaId: string; filename: string; size: number; mime: string; url: string }[];
  failed: { mediaId: string; message: string }[];
}

export interface MeResponse {
  userId: string;
  email?: string;
}

/** Max part URLs per /parts request. */
export const MAX_PART_URLS_PER_REQUEST = 100;

/** Album as returned to clients, with a signed cover thumbnail. */
export interface AlbumView {
  albumId: string;
  name: string;
  description?: string;
  coverMediaId?: string;
  coverUrl?: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAlbumRequest {
  name: string;
  description?: string;
}

export interface UpdateAlbumRequest {
  name?: string;
  description?: string;
  coverMediaId?: string;
}

export interface TagSummary {
  tag: string;
  count: number;
}

export type BatchAction =
  | 'trash'
  | 'restore'
  | 'purge'
  | 'addToAlbum'
  | 'removeFromAlbum'
  | 'addTags'
  | 'removeTags';

export interface BatchRequest {
  action: BatchAction;
  mediaIds: string[];
  /** For addToAlbum / removeFromAlbum. */
  albumId?: string;
  /** For addTags / removeTags. */
  tags?: string[];
}

export interface BatchResponse {
  succeeded: string[];
  failed: { mediaId: string; message: string }[];
}

/** Max items per batch request (the web app sends larger selections in chunks). */
export const MAX_BATCH_ITEMS = 100;
/** Items stay in the trash this long before being purged automatically. */
export const TRASH_RETENTION_DAYS = 30;
