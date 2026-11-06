'use client';

import type { MediaView, Page } from '@mypic/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MediaTile } from '@/components/MediaTile';
import { UploadIcon } from '@/components/icons';
import { useUploads } from '@/components/UploadProvider';
import { api } from '@/lib/api';
import { monthKey, monthLabel } from '@/lib/format';

/** Timeline: all media, newest first, grouped by month, infinite scroll. */
export default function TimelinePage() {
  const { queue, pickFiles } = useUploads();
  const [items, setItems] = useState<MediaView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || done) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const page = await api<Page<MediaView>>(`/media${qs}`);
      setItems((prev) => mergeSorted(prev, page.items));
      setCursor(page.cursor);
      if (!page.cursor) setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [cursor, done]);

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

  // Show freshly uploaded files immediately.
  useEffect(() => queue.onComplete((media) => setItems((prev) => mergeSorted(prev, [media]))), [queue]);

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: MediaView[] }[] = [];
    for (const m of items) {
      const key = monthKey(m.takenAt);
      const last = out[out.length - 1];
      if (last?.key === key) last.items.push(m);
      else out.push({ key, label: monthLabel(m.takenAt), items: [m] });
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
              <MediaTile key={m.mediaId} media={m} />
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
