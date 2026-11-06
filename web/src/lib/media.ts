import type { DownloadResponse, MediaView } from '@mypic/shared';
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

/** Processing normally takes seconds; after this long, offer a retry. */
const STALE_MS = 10 * 60 * 1000;

export function canRetry(media: MediaView, now: number): boolean {
  if (media.status === 'FAILED') return true;
  return media.status === 'PROCESSING' && now - Date.parse(media.uploadedAt) > STALE_MS;
}

export function isPending(media: MediaView): boolean {
  return media.status === 'PROCESSING' || media.status === 'TRANSCODING';
}
