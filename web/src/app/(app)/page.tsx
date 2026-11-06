'use client';

import type { MediaView, Page } from '@mypic/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lightbox } from '@/components/Lightbox';
import { MediaTile } from '@/components/MediaTile';
import { UploadIcon } from '@/components/icons';
import { useUploads } from '@/components/UploadProvider';
import { api } from '@/lib/api';
import { monthKey, monthLabel } from '@/lib/format';
import { isPending } from '@/lib/media';

const POLL_MS = 3000;
/** Poll recent uploads automatically; older stuck items only when explicitly retried. */
const AUTO_POLL_WINDOW_MS = 15 * 60 * 1000;
const MAX_POLL_BATCH = 25;

/** Timeline: all media, newest first, grouped by month, infinite scroll. */
export default function TimelinePage() {
  const { queue, pickFiles } = useUploads();
  const [items, setItems] = useState<MediaView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const watching = useRef(new Set<string>());
  const sentinel = useRef<HTMLDivElement>(null);

  const merge = useCallback((incoming: MediaView[]) => setItems((prev) => mergeSorted(prev, incoming)), []);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || done) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const page = await api<Page<MediaView>>(`/media${qs}`);
      merge(page.items);
      setCursor(page.cursor);
      if (!page.cursor) setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [cursor, done, merge]);

  // Load the next page whenever the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || done || error) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: '800px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore, done, error]);

  // Show freshly uploaded files immediately, then watch them until processed.
  useEffect(
    () =>
      queue.onComplete((media) => {
        watching.current.add(media.mediaId);
        merge([media]);
      }),
    [queue, merge],
  );

  // Poll items that are still processing.
  useEffect(() => {
    const now = Date.now();
    const pending = items
      .filter((m) => isPending(m) && (watching.current.has(m.mediaId) || now - Date.parse(m.uploadedAt) < AUTO_POLL_WINDOW_MS))
      .slice(0, MAX_POLL_BATCH);
    if (!pending.length) return;
    const timer = setTimeout(async () => {
      const updated = await Promise.all(
        pending.map((m) => api<MediaView>(`/media/${m.mediaId}`).catch(() => null)),
      );
      const fresh = updated.filter((m): m is MediaView => m !== null);
      for (const m of fresh) if (!isPending(m)) watching.current.delete(m.mediaId);
      merge(fresh);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [items, merge]);

  const onChange = useCallback(
    (media: MediaView) => {
      watching.current.add(media.mediaId);
      merge([media]);
    },
    [merge],
  );
  const onNearEnd = useCallback(() => void loadMore(), [loadMore]);
  const onClose = useCallback(() => setOpenId(null), []);

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: MediaView[] }[] = [];
    for (const m of items) {
      const key = monthKey(m);
      const last = out[out.length - 1];
      if (last?.key === key) last.items.push(m);
      else out.push({ key, label: monthLabel(m), items: [m] });
    }
    return out;
  }, [items]);

  if (done && items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-32 text-center">
        <p className="text-zinc-400">No photos or videos yet.</p>
        <button
          onClick={pickFiles}
          className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
        >
          <UploadIcon className="size-4" /> Upload files
        </button>
        <p className="text-xs text-zinc-500">or drag and drop them anywhere on this page</p>
      </div>
    );
  }

  return (
    <div className="pt-2">
      {groups.map((group) => (
        <section key={group.key} className="mb-6">
          <h2 className="sticky top-14 z-10 bg-zinc-950/90 px-2 py-2 text-sm font-medium text-zinc-300 backdrop-blur sm:px-0">
            {group.label}
          </h2>
          <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {group.items.map((m) => (
              <MediaTile key={m.mediaId} media={m} onOpen={() => setOpenId(m.mediaId)} />
            ))}
          </div>
        </section>
      ))}

      <div ref={sentinel} className="h-px" />
      {loading && (
        <div className="flex justify-center py-8">
          <div className="size-6 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
        </div>
      )}
      {error && (
        <div className="flex flex-col items-center gap-2 py-8 text-sm">
          <p className="text-red-400">Couldn&apos;t load photos: {error}</p>
          <button onClick={() => void loadMore()} className="text-zinc-300 underline hover:text-white">
            Try again
          </button>
        </div>
      )}

      {openId && (
        <Lightbox
          items={items}
          mediaId={openId}
          onSelect={setOpenId}
          onClose={onClose}
          onChange={onChange}
          onNearEnd={onNearEnd}
        />
      )}
    </div>
  );
}

/** Merge by mediaId (newer copy wins), newest takenAt first. */
function mergeSorted(prev: MediaView[], incoming: MediaView[]): MediaView[] {
  const byId = new Map(prev.map((m) => [m.mediaId, m]));
  for (const m of incoming) byId.set(m.mediaId, m);
  return [...byId.values()].sort((a, b) =>
    a.takenAt === b.takenAt ? b.mediaId.localeCompare(a.mediaId) : b.takenAt.localeCompare(a.takenAt),
  );
}
