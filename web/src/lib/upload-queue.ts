/**
 * Framework-agnostic upload queue (used from React with useSyncExternalStore).
 * Runs up to `concurrency` files at once; each file may use several parallel part uploads.
 */
import { detectMediaType, MAX_UPLOAD_BYTES, type MediaView } from '@mypic/shared';
import { UploadCanceled, uploadFile } from './upload';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'canceled';

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  status: UploadStatus;
  loaded: number;
  error?: string;
}

export interface AddResult {
  added: number;
  rejected: { name: string; reason: string }[];
}

export class UploadQueue {
  private items: UploadItem[] = [];
  private readonly files = new Map<string, File>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  private readonly completeListeners = new Set<(media: MediaView) => void>();

  constructor(private readonly concurrency = 3) {}

  getSnapshot = (): UploadItem[] => this.items;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onComplete(listener: (media: MediaView) => void): () => void {
    this.completeListeners.add(listener);
    return () => this.completeListeners.delete(listener);
  }

  get active(): boolean {
    return this.items.some((i) => i.status === 'queued' || i.status === 'uploading');
  }

  add(files: Iterable<File>): AddResult {
    const result: AddResult = { added: 0, rejected: [] };
    const added: UploadItem[] = [];
    for (const file of files) {
      if (!detectMediaType(file.name, file.type)) {
        result.rejected.push({ name: file.name, reason: 'unsupported type' });
      } else if (file.size === 0) {
        result.rejected.push({ name: file.name, reason: 'empty file' });
      } else if (file.size > MAX_UPLOAD_BYTES) {
        result.rejected.push({ name: file.name, reason: 'larger than 5 GB' });
      } else {
        const id = crypto.randomUUID();
        this.files.set(id, file);
        added.push({ id, name: file.name, size: file.size, status: 'queued', loaded: 0 });
      }
    }
    result.added = added.length;
    if (added.length) {
      this.items = [...this.items, ...added];
      this.emit();
      this.pump();
    }
    return result;
  }

  cancel(id: string) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    if (item.status === 'queued') this.update(id, { status: 'canceled' });
    this.controllers.get(id)?.abort();
  }

  cancelAll() {
    for (const item of this.items) this.cancel(item.id);
  }

  retry(id: string) {
    const item = this.items.find((i) => i.id === id);
    if (!item || (item.status !== 'error' && item.status !== 'canceled')) return;
    this.update(id, { status: 'queued', loaded: 0, error: undefined });
    this.pump();
  }

  clearFinished() {
    const keep = this.items.filter((i) => i.status === 'queued' || i.status === 'uploading' || i.status === 'error');
    for (const item of this.items) if (!keep.includes(item)) this.files.delete(item.id);
    this.items = keep;
    this.emit();
  }

  private pump() {
    let running = this.items.filter((i) => i.status === 'uploading').length;
    for (const item of this.items) {
      if (running >= this.concurrency) break;
      if (item.status === 'queued') {
        running++;
        void this.start(item.id);
      }
    }
  }

  private async start(id: string) {
    const file = this.files.get(id);
    if (!file) return;
    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    this.update(id, { status: 'uploading', loaded: 0 });
    try {
      const media = await uploadFile(file, (loaded) => this.update(id, { loaded }), ctrl.signal);
      this.update(id, { status: 'done', loaded: file.size });
      for (const listener of this.completeListeners) listener(media);
    } catch (err) {
      if (err instanceof UploadCanceled || ctrl.signal.aborted) {
        this.update(id, { status: 'canceled' });
      } else {
        this.update(id, { status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.controllers.delete(id);
      this.pump();
    }
  }

  private update(id: string, patch: Partial<UploadItem>) {
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...patch } : i));
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
