import {
  MAX_BATCH_ITEMS,
  type AlbumView,
  type BatchAction,
  type BatchResponse,
  type CreateAlbumRequest,
  type DownloadResponse,
  type MediaView,
  type TagSummary,
  type UpdateAlbumRequest,
} from '@mypic/shared';
import { api } from './api';

/** Download the original via a short-lived presigned link (Content-Disposition: attachment). */
export async function downloadOriginal(media: MediaView): Promise<void> {
  const { url } = await api<DownloadResponse>(`/media/${media.mediaId}/download`);
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function reprocess(media: MediaView): Promise<MediaView> {
  return api<MediaView>(`/media/${media.mediaId}/reprocess`, { method: 'POST' });
}

export function getMedia(mediaId: string): Promise<MediaView> {
  return api<MediaView>(`/media/${mediaId}`);
}

/** Processing normally takes seconds; after this long, offer a retry. */
const STALE_MS = 10 * 60 * 1000;

export function canRetry(media: MediaView, now: number): boolean {
  if (media.status === 'FAILED') return true;
  return media.status === 'PROCESSING' && now > 0 && now - Date.parse(media.uploadedAt) > STALE_MS;
}

export function isPending(media: MediaView): boolean {
  return media.status === 'PROCESSING' || media.status === 'TRANSCODING';
}

/** Apply one action to any number of items (sent in chunks); merges per-item results. */
export async function batch(
  action: BatchAction,
  mediaIds: string[],
  extra: { albumId?: string; tags?: string[] } = {},
): Promise<BatchResponse> {
  const result: BatchResponse = { succeeded: [], failed: [] };
  for (let i = 0; i < mediaIds.length; i += MAX_BATCH_ITEMS) {
    const res = await api<BatchResponse>('/media/batch', {
      method: 'POST',
      body: { action, mediaIds: mediaIds.slice(i, i + MAX_BATCH_ITEMS), ...extra },
    });
    result.succeeded.push(...res.succeeded);
    result.failed.push(...res.failed);
  }
  return result;
}

export function emptyTrash(): Promise<void> {
  return api('/trash', { method: 'DELETE' });
}

export async function listAlbums(): Promise<AlbumView[]> {
  return (await api<{ items: AlbumView[] }>('/albums')).items;
}

export function getAlbum(albumId: string): Promise<AlbumView> {
  return api<AlbumView>(`/albums/${encodeURIComponent(albumId)}`);
}

export function createAlbum(body: CreateAlbumRequest): Promise<AlbumView> {
  return api<AlbumView>('/albums', { method: 'POST', body });
}

export function updateAlbum(albumId: string, body: UpdateAlbumRequest): Promise<AlbumView> {
  return api<AlbumView>(`/albums/${encodeURIComponent(albumId)}`, { method: 'PATCH', body });
}

export function deleteAlbum(albumId: string): Promise<void> {
  return api(`/albums/${encodeURIComponent(albumId)}`, { method: 'DELETE' });
}

export async function listTags(): Promise<TagSummary[]> {
  return (await api<{ items: TagSummary[] }>('/tags')).items;
}

/** App routes use query parameters (static export: no dynamic segments). */
export function tagPath(tag: string): string {
  return `/tag?name=${encodeURIComponent(tag)}`;
}

export function albumPath(albumId: string): string {
  return `/album?id=${encodeURIComponent(albumId)}`;
}

/** "3 items" / "1 item" */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
