'use client';

import { extensionOf, type MediaView } from '@mypic/shared';
import { memo, useRef, useState } from 'react';
import { formatBytes } from '@/lib/format';
import { CheckIcon, ImageIcon, RawIcon, VideoIcon } from './icons';

const TYPE_ICON = { image: ImageIcon, raw: RawIcon, video: VideoIcon };
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 10;

interface MediaTileProps {
  media: MediaView;
  selected: boolean;
  /** Any item is selected: taps toggle instead of opening. */
  selecting: boolean;
  onOpen: (mediaId: string) => void;
  onToggle: (mediaId: string, range: boolean) => void;
  badge?: React.ReactNode;
}

/**
 * Grid tile. Desktop: hover shows a checkbox; shift-click selects a range.
 * Touch: long-press starts selecting. While selecting, taps toggle.
 */
export const MediaTile = memo(function MediaTile({ media, selected, selecting, onOpen, onToggle, badge }: MediaTileProps) {
  const [broken, setBroken] = useState(false);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const longPressed = useRef(false);
  const Icon = TYPE_ICON[media.type];
  const showThumb = media.thumbUrl && !broken;

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  return (
    <div
      className={`group relative aspect-square overflow-hidden rounded-md bg-zinc-900 ring-1 transition ${
        selected ? 'ring-2 ring-sky-500' : 'ring-zinc-800'
      }`}
    >
      <button
        className={`block size-full ${selecting ? 'cursor-pointer' : 'cursor-zoom-in'}`}
        aria-label={selecting ? `${selected ? 'Deselect' : 'Select'} ${media.filename}` : `Open ${media.filename}`}
        aria-pressed={selecting ? selected : undefined}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse') return;
          longPressed.current = false;
          const timer = setTimeout(() => {
            longPressed.current = true;
            onToggle(media.mediaId, false);
            navigator.vibrate?.(15);
          }, LONG_PRESS_MS);
          press.current = { timer, x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE_PX) cancelPress(); // scrolling
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(e) => {
          if (longPressed.current || press.current) e.preventDefault(); // no system menu on long-press
        }}
        onClick={(e) => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          if (selecting || e.shiftKey) onToggle(media.mediaId, e.shiftKey);
          else onOpen(media.mediaId);
        }}
      >
        {showThumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- already resized; no optimizer needed
          <img
            src={media.thumbUrl}
            alt={media.filename}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setBroken(true)}
            className={`size-full select-none object-cover transition ${selected ? 'scale-90 rounded' : 'group-hover:opacity-90'}`}
          />
        ) : (
          <span className={`flex size-full flex-col items-center justify-center gap-1 p-2 text-center transition ${selected ? 'scale-90' : ''}`}>
            <Icon className="size-7 text-zinc-500" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              {extensionOf(media.filename) || media.type}
            </span>
            <span className="line-clamp-2 break-all text-[11px] leading-tight text-zinc-300">{media.filename}</span>
            <span className="text-[10px] text-zinc-500">{formatBytes(media.size)}</span>
          </span>
        )}
      </button>

      {/* Selection checkbox (hover on desktop; always visible while selecting) */}
      <button
        onClick={(e) => onToggle(media.mediaId, e.shiftKey)}
        aria-label={`${selected ? 'Deselect' : 'Select'} ${media.filename}`}
        className={`absolute left-1.5 top-1.5 flex size-6 items-center justify-center rounded-full border-2 transition ${
          selected
            ? 'border-sky-500 bg-sky-500 text-white'
            : `border-white/80 bg-black/30 text-transparent hover:bg-black/50 ${selecting ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-sm:hidden'}`
        }`}
      >
        <CheckIcon className="size-3.5" />
      </button>

      {media.type === 'video' && showThumb && (
        <VideoIcon className="pointer-events-none absolute right-1.5 top-1.5 size-4 text-white drop-shadow" />
      )}
      <div className="pointer-events-none absolute bottom-1.5 left-1.5 flex gap-1">
        {media.status !== 'READY' && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              media.status === 'FAILED' ? 'bg-red-950/90 text-red-200' : 'bg-black/70 text-zinc-300'
            }`}
          >
            {media.status === 'FAILED' ? 'Failed' : 'Processing'}
          </span>
        )}
        {badge}
      </div>
    </div>
  );
});
