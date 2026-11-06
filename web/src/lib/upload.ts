/**
 * Upload one file straight to S3 using presigned URLs from the API.
 * Small files: one PUT. Large files: multipart, several parts in parallel, with retries.
 */
import type {
  CompleteUploadRequest,
  CreateUploadResponse,
  MediaView,
  PartUrlsResponse,
} from '@mypic/shared';
import { api } from './api';

const PART_CONCURRENCY = 4;
const URL_BATCH = 20;
const MAX_ATTEMPTS = 3;

export class UploadCanceled extends Error {
  constructor() {
    super('Canceled');
  }
}

class PutError extends Error {
  constructor(readonly status: number) {
    super(status === 0 ? 'Network error' : `Storage rejected the upload (HTTP ${status})`);
  }
}

/** PUT with upload progress (fetch can't report upload progress). Resolves with the ETag. */
function put(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new UploadCanceled());
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve(xhr.getResponseHeader('ETag'))
        : reject(new PutError(xhr.status));
    xhr.onerror = () => reject(new PutError(0));
    xhr.onabort = () => reject(new UploadCanceled());
    xhr.onloadend = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.send(body);
  });
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new UploadCanceled());
    }, { once: true });
  });
}

export async function uploadFile(
  file: File,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<MediaView> {
  const created = await api<CreateUploadResponse>('/uploads', {
    method: 'POST',
    signal,
    body: { filename: file.name, size: file.size, mime: file.type, lastModified: file.lastModified, timezoneOffset: -new Date(file.lastModified).getTimezoneOffset() },
  });

  try {
    let complete: CompleteUploadRequest = {};
    if (created.mode === 'single') {
      for (let attempt = 1; ; attempt++) {
        try {
          await put(created.url, file, created.headers, onProgress, signal);
          break;
        } catch (err) {
          if (err instanceof UploadCanceled || attempt >= MAX_ATTEMPTS) throw err;
          onProgress(0);
          await sleep(1000 * attempt, signal);
        }
      }
    } else {
      complete = { parts: await uploadParts(file, created, onProgress, signal) };
    }
    return await api<MediaView>(`/uploads/${created.mediaId}/complete`, {
      method: 'POST',
      body: complete,
      signal,
    });
  } catch (err) {
    if (signal.aborted) {
      // Best effort: free the multipart upload and the pending record.
      void api(`/uploads/${created.mediaId}`, { method: 'DELETE' }).catch(() => undefined);
    }
    throw err;
  }
}

async function uploadParts(
  file: File,
  created: Extract<CreateUploadResponse, { mode: 'multipart' }>,
  onProgress: (loaded: number) => void,
  outerSignal: AbortSignal,
): Promise<{ partNumber: number; etag: string }[]> {
  const { mediaId, partSize, partCount } = created;
  // Stop sibling workers when one part fails for good.
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  const onOuterAbort = () => ctrl.abort();
  outerSignal.addEventListener('abort', onOuterAbort, { once: true });

  const loaded = new Array<number>(partCount).fill(0);
  const report = () => onProgress(loaded.reduce((a, b) => a + b, 0));
  const urls = new Map<number, string>();
  const batches = new Map<number, Promise<void>>();
  const etags: { partNumber: number; etag: string }[] = [];

  const fetchUrls = async (partNumbers: number[]) => {
    const res = await api<PartUrlsResponse>(`/uploads/${mediaId}/parts`, {
      method: 'POST',
      body: { partNumbers },
      signal,
    });
    for (const [n, url] of Object.entries(res.urls)) urls.set(Number(n), url);
  };

  const urlFor = async (n: number, refresh: boolean): Promise<string> => {
    if (refresh) {
      await fetchUrls([n]);
    } else if (!urls.has(n)) {
      // Fetch URLs in batches of URL_BATCH; concurrent workers share the same request.
      const batch = Math.floor((n - 1) / URL_BATCH);
      let pending = batches.get(batch);
      if (!pending) {
        const first = batch * URL_BATCH + 1;
        const last = Math.min(first + URL_BATCH - 1, partCount);
        pending = fetchUrls(Array.from({ length: last - first + 1 }, (_, i) => first + i));
        pending.catch(() => batches.delete(batch));
        batches.set(batch, pending);
      }
      await pending;
    }
    const url = urls.get(n);
    if (!url) throw new Error(`No upload URL for part ${n}`);
    return url;
  };

  let next = 1;
  const worker = async () => {
    while (next <= partCount) {
      const n = next++;
      const start = (n - 1) * partSize;
      const blob = file.slice(start, Math.min(start + partSize, file.size));
      for (let attempt = 1, refresh = false; ; attempt++) {
        try {
          const url = await urlFor(n, refresh);
          const etag = await put(url, blob, {}, (l) => {
            loaded[n - 1] = l;
            report();
          }, signal);
          if (!etag) throw new Error('Missing ETag: the bucket CORS rule must expose the ETag header');
          etags.push({ partNumber: n, etag });
          break;
        } catch (err) {
          if (err instanceof UploadCanceled || attempt >= MAX_ATTEMPTS) throw err;
          loaded[n - 1] = 0;
          report();
          refresh = err instanceof PutError && err.status === 403; // presigned URL expired
          await sleep(1000 * attempt, signal);
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, worker));
    return etags;
  } catch (err) {
    ctrl.abort();
    throw outerSignal.aborted ? new UploadCanceled() : err;
  } finally {
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}
