'use client';

import { extensionOf, type MediaView } from '@mypic/shared';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useAlbums } from '@/lib/albums-store';
import { formatBytes, formatOffset, formatTaken } from '@/lib/format';
import { albumPath, canRetry, downloadOriginal, reprocess, tagPath } from '@/lib/media';
import { useNow } from '@/lib/use-now';
import {
  AlbumIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CloseIcon,
  DownloadIcon,
  ImageIcon,
  InfoIcon,
  RawIcon,
  RestoreIcon,
  RetryIcon,
  TagIcon,
  TrashIcon,
  VideoIcon,
} from './icons';

const TYPE_ICON = { image: ImageIcon, raw: RawIcon, video: VideoIcon };
const SWIPE_PX = 50;

/** Context-specific actions (timeline/album/tag vs trash). */
export interface LightboxActions {
  trash?: (media: MediaView) => void;
  restore?: (media: MediaView) => void;
  purge?: (media: MediaView) => void;
  editTags?: (media: MediaView) => void;
  addToAlbum?: (media: MediaView) => void;
}

interface LightboxProps {
  items: MediaView[];
  mediaId: string;
  onSelect: (mediaId: string) => void;
  onClose: () => void;
  /** An item changed here (e.g. retry); merge it into the list. */
  onChange: (media: MediaView) => void;
  /** Close to the end of the loaded items: load the next page. */
  onNearEnd: () => void;
  actions: LightboxActions;
}

export function Lightbox({ items, mediaId, onSelect, onClose, onChange, onNearEnd, actions }: LightboxProps) {
  const index = items.findIndex((m) => m.mediaId === mediaId);
  const media = items[index];
  const prev = index > 0 ? items[index - 1] : undefined;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : undefined;

  const [showInfo, setShowInfo] = useState(false);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'download' | 'retry' | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const now = useNow();

  // Keyboard: Esc closes, arrows navigate, "i" toggles info.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog on top (tags, album picker) or a text field owns the keyboard.
      if (document.querySelector('dialog[open]') || (e.target as HTMLElement)?.closest?.('input, textarea')) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && prev) onSelect(prev.mediaId);
      else if (e.key === 'ArrowRight' && next) onSelect(next.mediaId);
      else if (e.key === 'i') setShowInfo((s) => !s);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, onSelect, onClose]);

  // Lock page scroll while open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Preload neighbours; fetch more items as the end approaches.
  useEffect(() => {
    for (const m of [prev, next]) {
      if (m?.previewUrl) new Image().src = m.previewUrl;
    }
    if (index >= items.length - 5) onNearEnd();
  }, [prev, next, index, items.length, onNearEnd]);

  // The item can disappear (e.g. list refreshed); close instead of rendering nothing.
  useEffect(() => {
    if (!media) onClose();
  }, [media, onClose]);
  if (!media) return null;

  const Icon = TYPE_ICON[media.type];
  const loaded = loadedId === media.mediaId;
  const retryable = canRetry(media, now);

  async function run(kind: 'download' | 'retry') {
    setBusy(kind);
    try {
      if (kind === 'download') await downloadOriginal(media!);
      else onChange(await reprocess(media!));
    } catch (err) {
      alert(`${kind === 'download' ? 'Download' : 'Retry'} failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={media.filename}
      className="fixed inset-0 z-50 flex h-dvh bg-black"
      onTouchStart={(e) => {
        const t = e.touches[0];
        touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
      }}
      onTouchEnd={(e) => {
        const start = touchStart.current;
        const t = e.changedTouches[0];
        touchStart.current = null;
        if (!start || !t) return;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
          if (dx > 0 && prev) onSelect(prev.mediaId);
          if (dx < 0 && next) onSelect(next.mediaId);
        } else if (dy > SWIPE_PX * 2 && Math.abs(dy) > Math.abs(dx)) {
          onClose(); // swipe down to close
        }
      }}
    >
      <div className="relative min-w-0 flex-1">
        {/* Media */}
        <div className="absolute inset-0 flex items-center justify-center sm:px-16 sm:py-14">
          {media.previewUrl ? (
            <>
              {!loaded && (
                <div className="absolute size-8 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
              )}
              {/* eslint-disable-next-line @next/next/no-img-element -- pre-sized preview from CloudFront */}
              <img
                key={media.mediaId}
                src={media.previewUrl}
                alt={media.filename}
                onLoad={() => setLoadedId(media.mediaId)}
                className={`max-h-full max-w-full select-none object-contain transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
                draggable={false}
              />
            </>
          ) : (
            <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
              <Icon className="size-14 text-zinc-600" />
              <p className="break-all text-sm text-zinc-300">{media.filename}</p>
              <p className="text-sm text-zinc-500">
                {media.status === 'FAILED'
                  ? `Preview couldn't be generated: ${media.error ?? 'unknown error'}`
                  : media.type === 'video'
                    ? "Video preview isn't available yet. Download to watch."
                    : 'Generating preview…'}
              </p>
              {retryable && (
                <button
                  onClick={() => void run('retry')}
                  disabled={busy !== null}
                  className="flex items-center gap-2 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
                >
                  <RetryIcon className="size-4" /> Retry processing
                </button>
              )}
            </div>
          )}
        </div>

        {/* Top bar */}
        <div className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/80 to-transparent p-2 sm:p-3">
          <IconButton label="Close" onClick={onClose}>
            <CloseIcon className="size-5" />
          </IconButton>
          <div className="min-w-0 flex-1 px-1">
            <div className="truncate text-sm font-medium">{formatTaken(media)}</div>
            <div className="truncate text-xs text-zinc-400">{media.filename}</div>
          </div>
          {retryable && media.previewUrl && (
            <IconButton label="Retry processing" onClick={() => void run('retry')} disabled={busy !== null}>
              <RetryIcon className="size-5" />
            </IconButton>
          )}
          {actions.restore && (
            <IconButton label="Restore" onClick={() => actions.restore!(media)}>
              <RestoreIcon className="size-5" />
            </IconButton>
          )}
          {actions.purge && (
            <IconButton label="Delete forever" onClick={() => actions.purge!(media)}>
              <TrashIcon className="size-5 text-red-300" />
            </IconButton>
          )}
          {actions.addToAlbum && (
            <IconButton label="Add to album" onClick={() => actions.addToAlbum!(media)}>
              <AlbumIcon className="size-5" />
            </IconButton>
          )}
          <IconButton label="Info" onClick={() => setShowInfo((s) => !s)} active={showInfo}>
            <InfoIcon className="size-5" />
          </IconButton>
          <IconButton label="Download original" onClick={() => void run('download')} disabled={busy !== null}>
            <DownloadIcon className={`size-5 ${busy === 'download' ? 'animate-pulse' : ''}`} />
          </IconButton>
          {actions.trash && (
            <IconButton label="Move to trash" onClick={() => actions.trash!(media)}>
              <TrashIcon className="size-5" />
            </IconButton>
          )}
        </div>

        {/* Prev / next (desktop; mobile uses swipe) */}
        {prev && (
          <button
            onClick={() => onSelect(prev.mediaId)}
            aria-label="Previous"
            className="absolute left-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/50 p-2 text-zinc-200 hover:bg-black hover:text-white sm:block"
          >
            <ArrowLeftIcon className="size-6" />
          </button>
        )}
        {next && (
          <button
            onClick={() => onSelect(next.mediaId)}
            aria-label="Next"
            className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/50 p-2 text-zinc-200 hover:bg-black hover:text-white sm:block"
          >
            <ArrowRightIcon className="size-6" />
          </button>
        )}
      </div>

      {showInfo && <InfoPanel media={media} actions={actions} onClose={() => setShowInfo(false)} />}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`rounded-full p-2 text-zinc-200 hover:bg-white/10 hover:text-white disabled:opacity-50 ${active ? 'bg-white/15' : ''}`}
    >
      {children}
    </button>
  );
}

/** Side panel on desktop, bottom sheet on mobile. */
function InfoPanel({ media, actions, onClose }: { media: MediaView; actions: LightboxActions; onClose: () => void }) {
  const albums = useAlbums();
  const albumNames = (albums ?? []).filter((a) => media.albumIds.includes(a.albumId));
  const e = media.exif ?? {};
  const camera = [e.make, e.model].filter(Boolean).join(' ');
  const settings = [
    e.fNumber && `f/${e.fNumber}`,
    e.exposureTime && `${e.exposureTime}s`,
    e.focalLength && `${e.focalLength}mm`,
    e.iso && `ISO ${e.iso}`,
  ].filter(Boolean);
  const megapixels = media.width && media.height ? (media.width * media.height) / 1e6 : undefined;

  const rows: [string, React.ReactNode][] = [
    ['Taken', <>{formatTaken(media)} <span className="text-zinc-500">{formatOffset(media.takenAtOffset)}</span></>],
    ['Camera', camera],
    ['Lens', e.lens],
    ['Settings', settings.join(' · ')],
    [
      'Size',
      [
        media.width && media.height && `${media.width} × ${media.height}`,
        megapixels && `${megapixels.toFixed(1)} MP`,
        formatBytes(media.size),
      ]
        .filter(Boolean)
        .join(' · '),
    ],
    ['File', <span key="f" className="break-all">{media.filename} <span className="text-zinc-500">({extensionOf(media.filename).toUpperCase() || media.type})</span></span>],
    [
      'Location',
      e.gps && (
        <a
          href={`https://www.openstreetmap.org/?mlat=${e.gps.lat}&mlon=${e.gps.lon}#map=15/${e.gps.lat}/${e.gps.lon}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sky-400 hover:underline"
        >
          {e.gps.lat.toFixed(5)}, {e.gps.lon.toFixed(5)}
        </a>
      ),
    ],
    [
      'Albums',
      albumNames.length > 0 || actions.addToAlbum ? (
        <span key="albums" className="flex flex-wrap items-center gap-1.5">
          {albumNames.map((a) => (
            <Link key={a.albumId} href={albumPath(a.albumId)} className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs hover:bg-zinc-700">
              {a.name}
            </Link>
          ))}
          {actions.addToAlbum && (
            <button onClick={() => actions.addToAlbum!(media)} className="text-xs text-sky-400 hover:underline">
              {albumNames.length ? 'Add' : 'Add to album'}
            </button>
          )}
        </span>
      ) : null,
    ],
    [
      'Tags',
      media.tags.length > 0 || actions.editTags ? (
        <span key="tags" className="flex flex-wrap items-center gap-1.5">
          {media.tags.map((t) => (
            <Link key={t} href={tagPath(t)} className="flex items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs hover:bg-zinc-700">
              <TagIcon className="size-3" /> {t}
            </Link>
          ))}
          {actions.editTags && (
            <button onClick={() => actions.editTags!(media)} className="text-xs text-sky-400 hover:underline">
              {media.tags.length ? 'Edit' : 'Add tags'}
            </button>
          )}
        </span>
      ) : null,
    ],
    ['Status', media.status === 'FAILED' ? <span className="text-red-400">Failed: {media.error}</span> : media.status !== 'READY' ? 'Processing' : null],
  ];

  return (
    <aside className="absolute inset-x-0 bottom-0 z-10 max-h-[60dvh] overflow-y-auto rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-4 sm:static sm:max-h-none sm:w-80 sm:rounded-none sm:border-l sm:border-t-0">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Details</h2>
        <button onClick={onClose} aria-label="Close details" className="p-1 text-zinc-400 hover:text-white">
          <CloseIcon className="size-4" />
        </button>
      </div>
      <dl className="space-y-3 text-sm">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-zinc-500">{label}</dt>
              <dd className="text-zinc-200">{value}</dd>
            </div>
          ))}
      </dl>
    </aside>
  );
}
