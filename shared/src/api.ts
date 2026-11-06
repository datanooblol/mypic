/** Request/response contracts for the HTTP API (shared by services and web). */

export interface CreateUploadRequest {
  filename: string;
  size: number;
  mime: string;
  /** File.lastModified (epoch ms). Initial takenAt until EXIF is read. */
  lastModified?: number;
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

export interface MeResponse {
  userId: string;
  email?: string;
}

/** Max part URLs per /parts request. */
export const MAX_PART_URLS_PER_REQUEST = 100;
