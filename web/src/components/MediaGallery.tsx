'use client';

import { TRASH_RETENTION_DAYS, type MediaView, type Page } from '@mypic/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { refreshAlbums } from '@/lib/albums-store';
import { monthKey, monthLabel } from '@/lib/format';
import { batch, getMedia, isPending, plural, updateAlbum } from '@/lib/media';
import { useNow } from '@/lib/use-now';
import { AlbumPicker } from './AlbumPicker';
import { DownloadDialog } from './DownloadDialog';
import { AlbumIcon, CloseIcon, DownloadIcon, RestoreIcon, StarIcon, TagIcon, TrashIcon } from './icons';
import { Lightbox, type LightboxActions } from './Lightbox';
import { MediaTile } from './MediaTile';
import { TagEditor } from './TagEditor';
import { useToast } from './Toast';
import { useUploads } from './UploadProvider';

export type GalleryMode =
  | { kind: 'timeline' }
  | { kind: 'album'; albumId: string; onAlbumChanged?: () => void }
  | { kind: 'tag'; tag: string }
  | { kind: 'trash' };

const POLL_MS = 3000;
const AUTO_POLL_WINDOW_MS = 15 * 60 * 1000;
const MAX_POLL_BATCH = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

interface MediaGalleryProps {
  mode: GalleryMode;
  fetchPage: (cursor?: string) => Promise<Page<MediaView>>;
  empty: React.ReactNode;
  /** Rendered above the grid (e.g. album title, "Empty trash"). */
  header?: React.ReactNode;
  /** Called after items leave or join the view (e.g. to refresh counts). */
  onItemsChanged?: () => void;
}

type DialogState =
  | { kind: 'album'; ids: string[] }
  | { kind: 'tags'; ids: string[] }
  | { kind: 'download'; items: MediaView[] }
  | null;

export function MediaGallery({ mode, fetchPage, empty, header, onItemsChanged }: MediaGalleryProps) {
  const { queue } = useUploads();
  const toast = useToast();
  const now = useNow(60_000);
  const [items, setItems] = useState<MediaView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const loadingRef = useRef(false);
  const lastToggled = useRef<string | null>(null);
  const watching = useRef(new Set<string>());
  const sentinel = useRef<HTMLDivElement>(null);

  const isTrash = mode.kind === 'trash';
  const sortKey = isTrash ? 'deletedAt' : 'takenAt';
  const merge = useCallback(
    (incoming: MediaView[]) => setItems((prev) => mergeSorted(prev, incoming, sortKey)),
    [sortKey],
  );
  const removeFromView = useCallback((ids: string[]) => {
    const gone = new Set(ids);
    setItems((prev) => prev.filter((m) => !gone.has(m.mediaId)));
    setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
  }, []);
  const patch = useCallback((ids: string[], fn: (m: MediaView) => MediaView) => {
    const set = new Set(ids);
    setItems((prev) => prev.map((m) => (set.has(m.mediaId) ? fn(m) : m)));
  }, []);

  // ---------- Loading ----------
  const loadMore = useCallback(async () => {
    if (loadingRef.current || done) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(cursor);
      merge(page.items);
      setCursor(page.cursor);
      if (!page.cursor) setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [cursor, done, fetchPage, merge]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || done || error) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void loadMore();
    }, { rootMargin: '800px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore, done, error]);

  // New uploads appear on the timeline immediately.
  useEffect(() => {
    if (mode.kind !== 'timeline') return;
    return queue.onComplete((media) => {
      watching.current.add(media.mediaId);
      merge([media]);
    });
  }, [mode.kind, queue, merge]);

  // Poll items that are still processing.
  useEffect(() => {
    const t = Date.now();
    const pending = items
      .filter((m) => isPending(m) && (watching.current.has(m.mediaId) || t - Date.parse(m.uploadedAt) < AUTO_POLL_WINDOW_MS))
      .slice(0, MAX_POLL_BATCH);
    if (!pending.length) return;
    const timer = setTimeout(async () => {
      const fresh = (await Promise.all(pending.map((m) => getMedia(m.mediaId).catch(() => null)))).filter(
        (m): m is MediaView => m !== null,
      );
      for (const m of fresh) if (!isPending(m)) watching.current.delete(m.mediaId);
      merge(fresh);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [items, merge]);

  // ---------- Selection ----------
  const toggle = useCallback(
    (mediaId: string, range: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        const anchor = lastToggled.current;
        if (range && anchor && anchor !== mediaId) {
          const a = items.findIndex((m) => m.mediaId === anchor);
          const b = items.findIndex((m) => m.mediaId === mediaId);
          if (a >= 0 && b >= 0) {
            for (const m of items.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(m.mediaId);
            lastToggled.current = mediaId;
            return next;
          }
        }
        if (next.has(mediaId)) next.delete(mediaId);
        else next.add(mediaId);
        lastToggled.current = mediaId;
        return next;
      });
    },
    [items],
  );
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  useEffect(() => {
    if (!selected.size || openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size, openId, clearSelection]);

  // ---------- Actions ----------
  const report = useCallback(
    (verb: string, ok: number, failed: { message: string }[]) => {
      if (failed.length) {
        toast.show(`${verb} ${plural(ok, 'item')}; ${failed.length} failed: ${failed[0]!.message}`, { tone: 'error' });
      }
    },
    [toast],
  );

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        toast.show(err instanceof Error ? err.message : String(err), { tone: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const restore = useCallback(
    (ids: string[], restored?: MediaView[]) =>
      run(async () => {
        const res = await batch('restore', ids);
        report('Restored', res.succeeded.length, res.failed);
        if (isTrash) removeFromView(res.succeeded);
        else if (restored) merge(restored.filter((m) => res.succeeded.includes(m.mediaId)).map((m) => ({ ...m, deletedAt: undefined })));
        void refreshAlbums().catch(() => undefined);
        onItemsChanged?.();
        if (isTrash && res.succeeded.length) toast.show(`Restored ${plural(res.succeeded.length, 'item')}`);
      }),
    [run, report, isTrash, removeFromView, merge, onItemsChanged, toast],
  );

  const trash = useCallback(
    (ids: string[]) =>
      run(async () => {
        const snapshot = items.filter((m) => ids.includes(m.mediaId));
        removeFromView(ids); // optimistic
        setOpenId((id) => (id && ids.includes(id) ? null : id));
        const res = await batch('trash', ids);
        if (res.failed.length) merge(snapshot.filter((m) => !res.succeeded.includes(m.mediaId)));
        report('Moved', res.succeeded.length, res.failed);
        void refreshAlbums().catch(() => undefined);
        onItemsChanged?.();
        if (res.succeeded.length) {
          toast.show(`Moved ${plural(res.succeeded.length, 'item')} to trash`, {
            action: { label: 'Undo', onClick: () => void restore(res.succeeded, snapshot) },
          });
        }
      }),
    [run, items, removeFromView, merge, report, onItemsChanged, toast, restore],
  );

  const purge = useCallback(
    (ids: string[]) => {
      if (!confirm(`Delete ${plural(ids.length, 'item')} forever? This can't be undone.`)) return;
      void run(async () => {
        const res = await batch('purge', ids);
        removeFromView(res.succeeded);
        setOpenId((id) => (id && res.succeeded.includes(id) ? null : id));
        report('Deleted', res.succeeded.length, res.failed);
        if (res.succeeded.length) toast.show(`Deleted ${plural(res.succeeded.length, 'item')} forever`);
      });
    },
    [run, removeFromView, report, toast],
  );

  const removeFromAlbum = useCallback(
    (ids: string[]) => {
      if (mode.kind !== 'album') return;
      void run(async () => {
        const res = await batch('removeFromAlbum', ids, { albumId: mode.albumId });
        removeFromView(res.succeeded);
        setOpenId((id) => (id && res.succeeded.includes(id) ? null : id));
        report('Removed', res.succeeded.length, res.failed);
        void refreshAlbums().catch(() => undefined);
        mode.onAlbumChanged?.();
        if (res.succeeded.length) toast.show(`Removed ${plural(res.succeeded.length, 'item')} from album`);
      });
    },
    [mode, run, removeFromView, report, toast],
  );

  const setCover = useCallback(
    (mediaId: string) => {
      if (mode.kind !== 'album') return;
      void run(async () => {
        await updateAlbum(mode.albumId, { coverMediaId: mediaId });
        void refreshAlbums().catch(() => undefined);
        mode.onAlbumChanged?.();
        toast.show('Album cover updated');
      });
    },
    [mode, run, toast],
  );

  const addToAlbum = useCallback(
    async (ids: string[], albumId: string, albumName: string) => {
      const res = await batch('addToAlbum', ids, { albumId });
      patch(res.succeeded, (m) => ({ ...m, albumIds: [...new Set([...m.albumIds, albumId])] }));
      report('Added', res.succeeded.length, res.failed);
      if (res.succeeded.length) toast.show(`Added ${plural(res.succeeded.length, 'item')} to ${albumName}`);
      if (mode.kind === 'album' && mode.albumId === albumId) mode.onAlbumChanged?.();
    },
    [patch, report, toast, mode],
  );

  const applyTags = useCallback(
    async (ids: string[], { add, remove }: { add: string[]; remove: string[] }) => {
      if (add.length) {
        const res = await batch('addTags', ids, { tags: add });
        patch(res.succeeded, (m) => ({ ...m, tags: [...new Set([...m.tags, ...add])].sort() }));
        report('Tagged', res.succeeded.length, res.failed);
      }
      if (remove.length) {
        const res = await batch('removeTags', ids, { tags: remove });
        patch(res.succeeded, (m) => ({ ...m, tags: m.tags.filter((t) => !remove.includes(t)) }));
        report('Updated', res.succeeded.length, res.failed);
        if (mode.kind === 'tag' && remove.includes(mode.tag)) removeFromView(res.succeeded);
      }
      onItemsChanged?.();
    },
    [patch, report, mode, removeFromView, onItemsChanged],
  );

  // ---------- Derived ----------
  const selectedIds = useMemo(() => items.filter((m) => selected.has(m.mediaId)).map((m) => m.mediaId), [items, selected]);
  const groups = useMemo(() => {
    if (isTrash) return [{ key: 'all', label: '', items }];
    const out: { key: string; label: string; items: MediaView[] }[] = [];
    for (const m of items) {
      const key = monthKey(m);
      const last = out[out.length - 1];
      if (last?.key === key) last.items.push(m);
      else out.push({ key, label: monthLabel(m), items: [m] });
    }
    return out;
  }, [items, isTrash]);

  const tagCounts = useCallback(
    (ids: string[]) => {
      const counts = new Map<string, number>();
      for (const m of items) if (ids.includes(m.mediaId)) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      return counts;
    },
    [items],
  );

  const lightboxActions: LightboxActions = isTrash
    ? { restore: (m) => void restore([m.mediaId]), purge: (m) => purge([m.mediaId]) }
    : {
        trash: (m) => void trash([m.mediaId]),
        editTags: (m) => setDialog({ kind: 'tags', ids: [m.mediaId] }),
        addToAlbum: (m) => setDialog({ kind: 'album', ids: [m.mediaId] }),
      };

  const onSelect = useCallback((id: string) => setOpenId(id), []);
  const onClose = useCallback(() => setOpenId(null), []);
  const onNearEnd = useCallback(() => void loadMore(), [loadMore]);
  const onChange = useCallback(
    (m: MediaView) => {
      watching.current.add(m.mediaId);
      merge([m]);
    },
    [merge],
  );

  const trashBadge = (m: MediaView) => {
    if (!isTrash || !m.deletedAt || !now) return undefined;
    const days = Math.max(0, Math.ceil((Date.parse(m.deletedAt) + TRASH_RETENTION_DAYS * DAY_MS - now) / DAY_MS));
    return <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-300">{days}d left</span>;
  };

  // ---------- Render ----------
  return (
    <div className="pt-2">
      {selectedIds.length > 0 && (
        <div className="fixed inset-x-0 top-0 z-40 border-b border-zinc-800 bg-zinc-900/95 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-1 px-2 sm:gap-2 sm:px-4">
            <button onClick={clearSelection} aria-label="Clear selection" className="rounded-full p-2 hover:bg-white/10">
              <CloseIcon className="size-5" />
            </button>
            <span className="mr-auto text-sm font-medium">{selectedIds.length} selected</span>
            <button
              onClick={() => setSelected(new Set(items.map((m) => m.mediaId)))}
              className="hidden rounded-lg px-2 py-1.5 text-sm text-zinc-300 hover:bg-white/10 sm:block"
            >
              Select all
            </button>
            <BarButton
              icon={DownloadIcon}
              label="Download"
              disabled={busy}
              onClick={() => setDialog({ kind: 'download', items: items.filter((m) => selected.has(m.mediaId)) })}
            />
            {isTrash ? (
              <>
                <BarButton icon={RestoreIcon} label="Restore" disabled={busy} onClick={() => void restore(selectedIds).then(clearSelection)} />
                <BarButton icon={TrashIcon} label="Delete forever" danger disabled={busy} onClick={() => purge(selectedIds)} />
              </>
            ) : (
              <>
                {mode.kind === 'album' && selectedIds.length === 1 && (
                  <BarButton icon={StarIcon} label="Set as cover" disabled={busy} onClick={() => { setCover(selectedIds[0]!); clearSelection(); }} />
                )}
                <BarButton icon={AlbumIcon} label="Add to album" disabled={busy} onClick={() => setDialog({ kind: 'album', ids: selectedIds })} />
                <BarButton icon={TagIcon} label="Tags" disabled={busy} onClick={() => setDialog({ kind: 'tags', ids: selectedIds })} />
                {mode.kind === 'album' && (
                  <BarButton icon={CloseIcon} label="Remove from album" disabled={busy} onClick={() => { removeFromAlbum(selectedIds); clearSelection(); }} />
                )}
                <BarButton icon={TrashIcon} label="Trash" disabled={busy} onClick={() => { void trash(selectedIds); clearSelection(); }} />
              </>
            )}
          </div>
        </div>
      )}

      {header}

      {done && items.length === 0 ? (
        empty
      ) : (
        groups.map((group) => (
          <section key={group.key} className="mb-6">
            {group.label && (
              <h2 className="sticky top-14 z-10 bg-zinc-950/90 px-2 py-2 text-sm font-medium text-zinc-300 backdrop-blur sm:px-0">
                {group.label}
              </h2>
            )}
            <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
              {group.items.map((m) => (
                <MediaTile
                  key={m.mediaId}
                  media={m}
                  selected={selected.has(m.mediaId)}
                  selecting={selected.size > 0}
                  onOpen={onSelect}
                  onToggle={toggle}
                  badge={trashBadge(m)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      <div ref={sentinel} className="h-px" />
      {loading && (
        <div className="flex justify-center py-8">
          <div className="size-6 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
        </div>
      )}
      {error && (
        <div className="flex flex-col items-center gap-2 py-8 text-sm">
          <p className="text-red-400">Couldn&apos;t load: {error}</p>
          <button onClick={() => void loadMore()} className="text-zinc-300 underline hover:text-white">
            Try again
          </button>
        </div>
      )}

      {openId && (
        <Lightbox
          items={items}
          mediaId={openId}
          onSelect={onSelect}
          onClose={onClose}
          onChange={onChange}
          onNearEnd={onNearEnd}
          actions={lightboxActions}
        />
      )}

      {dialog?.kind === 'album' && (
        <AlbumPicker
          title={`Add ${plural(dialog.ids.length, 'item')} to album`}
          excludeAlbumId={mode.kind === 'album' ? mode.albumId : undefined}
          onPick={async (album) => {
            await addToAlbum(dialog.ids, album.albumId, album.name);
            if (dialog.ids.length > 1) clearSelection();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'download' && <DownloadDialog items={dialog.items} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'tags' && (
        <TagEditor
          itemCount={dialog.ids.length}
          current={tagCounts(dialog.ids)}
          onApply={async (changes) => {
            await applyTags(dialog.ids, changes);
            if (dialog.ids.length > 1) clearSelection();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function BarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: (p: { className?: string }) => React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm hover:bg-white/10 disabled:opacity-50 ${
        danger ? 'text-red-300' : 'text-zinc-100'
      }`}
    >
      <Icon className="size-5" />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

/** Merge by mediaId (newer copy wins), newest first by the given date. */
function mergeSorted(prev: MediaView[], incoming: MediaView[], key: 'takenAt' | 'deletedAt'): MediaView[] {
  const byId = new Map(prev.map((m) => [m.mediaId, m]));
  for (const m of incoming) byId.set(m.mediaId, m);
  return [...byId.values()].sort((a, b) => {
    const av = a[key] ?? '';
    const bv = b[key] ?? '';
    return av === bv ? b.mediaId.localeCompare(a.mediaId) : bv.localeCompare(av);
  });
}
