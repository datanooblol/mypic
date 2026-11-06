'use client';

import { extensionOf, type DownloadResponse, type MediaView } from '@mypic/shared';
import { useState } from 'react';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { DownloadIcon, ImageIcon, RawIcon, VideoIcon } from './icons';

const TYPE_ICON = { image: ImageIcon, raw: RawIcon, video: VideoIcon };

/**
 * Grid tile. Until thumbnails exist (M3) this is a placeholder showing type, name and size.
 */
export function MediaTile({ media }: { media: MediaView }) {
  const [busy, setBusy] = useState(false);
  const Icon = TYPE_ICON[media.type];

  async function download() {
    setBusy(true);
    try {
      const { url } = await api<DownloadResponse>(`/media/${media.mediaId}/download`);
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      alert(`Download failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="group relative aspect-square overflow-hidden rounded-md bg-zinc-900 ring-1 ring-zinc-800">
      {media.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- already resized; no optimizer needed
        <img src={media.thumbUrl} alt={media.filename} loading="lazy" className="size-full object-cover" />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center">
          <Icon className="size-7 text-zinc-500" />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            {extensionOf(media.filename) || media.type}
          </span>
          <span className="line-clamp-2 break-all text-[11px] leading-tight text-zinc-300">{media.filename}</span>
          <span className="text-[10px] text-zinc-500">{formatBytes(media.size)}</span>
        </div>
      )}

      {media.status !== 'READY' && (
        <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-300">
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
