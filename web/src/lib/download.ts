/**
 * "Download selected".
 *  - Desktop: start each original's download in turn (Content-Disposition: attachment).
 *    Browsers ask once to allow multiple downloads.
 *  - Phones: fetch the files, then hand them to the system share sheet, which can save
 *    to Photos/Files in one step. navigator.share needs a fresh tap, so fetching and
 *    saving are two steps in the UI.
 */
import type { DownloadManyResponse } from '@mypic/shared';
import { api } from './api';

/** Links are requested just in time, a few at a time, so none expire while queued. */
const LINK_BATCH = 10;
/** Gap between automatic downloads; browsers drop downloads started too close together. */
const DOWNLOAD_GAP_MS = 700;
/** The share sheet path holds files in memory; keep it to phone-sized selections. */
export const SHARE_MAX_BYTES = 300 * 1024 * 1024;
export const SHARE_MAX_FILES = 60;

export type DownloadLink = DownloadManyResponse['items'][number];
export interface DownloadFailure {
  mediaId: string;
  message: string;
}

export class DownloadCanceled extends Error {
  constructor() {
    super('Canceled');
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DownloadCanceled());
    }, { once: true });
  });

async function* links(mediaIds: string[], signal: AbortSignal, failed: DownloadFailure[]) {
  for (let i = 0; i < mediaIds.length; i += LINK_BATCH) {
    if (signal.aborted) throw new DownloadCanceled();
    const res = await api<DownloadManyResponse>('/media/download', {
      method: 'POST',
      body: { mediaIds: mediaIds.slice(i, i + LINK_BATCH) },
      signal,
    });
    failed.push(...res.failed);
    yield* res.items;
  }
}

/** True on touch devices whose browser can share files (iOS Safari, Android Chrome). */
export function canSaveViaShareSheet(): boolean {
  if (typeof window === 'undefined' || typeof navigator.canShare !== 'function') return false;
  if (!window.matchMedia('(pointer: coarse)').matches) return false; // desktops: plain downloads
  try {
    return navigator.canShare({ files: [new File([''], 'probe.jpg', { type: 'image/jpeg' })] });
  } catch {
    return false;
  }
}

function triggerDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Desktop: download each original in turn. */
export async function downloadSequentially(
  mediaIds: string[],
  onProgress: (done: number, current?: string) => void,
  signal: AbortSignal,
): Promise<{ started: number; failed: DownloadFailure[] }> {
  const failed: DownloadFailure[] = [];
  let started = 0;
  for await (const link of links(mediaIds, signal, failed)) {
    onProgress(started, link.filename);
    triggerDownload(link.url);
    started++;
    onProgress(started, link.filename);
    if (started < mediaIds.length) await sleep(DOWNLOAD_GAP_MS, signal);
  }
  return { started, failed };
}

/** Phones: fetch originals into memory (with byte progress) for the share sheet. */
export async function fetchForShare(
  mediaIds: string[],
  onProgress: (loadedBytes: number) => void,
  signal: AbortSignal,
): Promise<{ files: File[]; failed: DownloadFailure[] }> {
  const failed: DownloadFailure[] = [];
  const files: File[] = [];
  let loaded = 0;
  for await (const link of links(mediaIds, signal, failed)) {
    try {
      const res = await fetch(link.url, { signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress(loaded);
      }
      const type = link.mime && link.mime !== 'application/octet-stream' ? link.mime : res.headers.get('content-type') ?? '';
      files.push(new File(chunks, link.filename, { type }));
    } catch (err) {
      if (signal.aborted) throw new DownloadCanceled();
      failed.push({ mediaId: link.mediaId, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { files, failed };
}
