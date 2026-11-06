'use client';

import { extensionOf, type MediaView } from '@mypic/shared';
import { useState } from 'react';
import { formatBytes } from '@/lib/format';
import { downloadOriginal } from '@/lib/media';
import { DownloadIcon, ImageIcon, RawIcon, VideoIcon } from './icons';

const TYPE_ICON = { image: ImageIcon, raw: RawIcon, video: VideoIcon };

/** Grid tile: thumbnail when available, otherwise a placeholder with type, name and size. */
export function MediaTile({ media, onOpen }: { media: MediaView; onOpen: () => void }) {
  const [busy, setBusy] = useState(false);
  const [broken, setBroken] = useState(false);
  const Icon = TYPE_ICON[media.type];
  const showThumb = media.thumbUrl && !broken;

  async function download() {
    setBusy(true);
    try {
      await downloadOriginal(media);
    } catch (err) {
      alert(`Download failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="group relative aspect-square overflow-hidden rounded-md bg-zinc-900 ring-1 ring-zinc-800">
      <button onClick={onOpen} className="block size-full cursor-zoom-in" aria-label={`Open ${media.filename}`}>
        {showThumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- already resized; no optimizer needed
          <img
            src={media.thumbUrl}
            alt={media.filename}
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
            className="size-full object-cover transition-opacity group-hover:opacity-90"
          />
        ) : (
          <span className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center">
            <Icon className="size-7 text-zinc-500" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              {extensionOf(media.filename) || media.type}
            </span>
            <span className="line-clamp-2 break-all text-[11px] leading-tight text-zinc-300">{media.filename}</span>
            <span className="text-[10px] text-zinc-500">{formatBytes(media.size)}</span>
          </span>
        )}
      </button>

      {media.type === 'video' && showThumb && (
        <VideoIcon className="pointer-events-none absolute right-1.5 top-1.5 size-4 text-white drop-shadow" />
      )}
      {media.status !== 'READY' && (
        <span
          className={`pointer-events-none absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] ${
            media.status === 'FAILED' ? 'bg-red-950/90 text-red-200' : 'bg-black/70 text-zinc-300'
          }`}
        >
          {media.status === 'FAILED' ? 'Failed' : 'Processing'}
        </span>
      )}

      <button
        onClick={download}
        disabled={busy}
        aria-label={`Download ${media.filename}`}
        className="absolute bottom-1.5 right-1.5 rounded-full bg-black/70 p-1.5 text-zinc-200 transition hover:bg-black hover:text-white focus-visible:opacity-100 disabled:opacity-50 sm:opacity-0 sm:group-hover:opacity-100"
      >
        <DownloadIcon className={`size-4 ${busy ? 'animate-pulse' : ''}`} />
      </button>
    </div>
  );
}
