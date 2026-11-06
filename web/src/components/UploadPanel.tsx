'use client';

import { useState } from 'react';
import { formatBytes } from '@/lib/format';
import type { UploadItem } from '@/lib/upload-queue';
import { ChevronIcon, CloseIcon, RetryIcon } from './icons';
import { useUploads } from './UploadProvider';

/** Floating upload queue: bottom sheet on mobile, card on desktop. */
export function UploadPanel() {
  const { items, queue, notice, dismissNotice } = useUploads();
  const [collapsed, setCollapsed] = useState(false);

  if (items.length === 0 && !notice) return null;

  const total = items.reduce((s, i) => s + (i.status === 'canceled' ? 0 : i.size), 0);
  const loaded = items.reduce((s, i) => s + (i.status === 'canceled' ? 0 : i.loaded), 0);
  const remaining = items.filter((i) => i.status === 'queued' || i.status === 'uploading').length;
  const failed = items.filter((i) => i.status === 'error').length;
  const pct = total ? Math.round((loaded / total) * 100) : 0;

  const title = remaining
    ? `Uploading ${remaining} file${remaining > 1 ? 's' : ''} · ${pct}%`
    : failed
      ? `${failed} upload${failed > 1 ? 's' : ''} failed`
      : 'Uploads complete';

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-96">
      <div className="overflow-hidden border border-zinc-800 bg-zinc-900 shadow-2xl sm:rounded-xl">
        {notice && (
          <div className="flex items-start gap-2 border-b border-zinc-800 bg-amber-950/60 px-4 py-2 text-xs text-amber-200">
            <span className="flex-1">{notice}</span>
            <button onClick={dismissNotice} aria-label="Dismiss" className="p-0.5 hover:text-white">
              <CloseIcon className="size-4" />
            </button>
          </div>
        )}
        {items.length > 0 && (
          <>
            <div className="flex items-center gap-2 px-4 py-3">
              <button
                onClick={() => setCollapsed((c) => !c)}
                className="flex flex-1 items-center gap-2 text-left text-sm font-medium"
                aria-expanded={!collapsed}
              >
                <ChevronIcon className={`size-4 transition-transform ${collapsed ? 'rotate-180' : ''}`} />
                {title}
              </button>
              {remaining > 0 ? (
                <button onClick={() => queue.cancelAll()} className="text-xs text-zinc-400 hover:text-white">
                  Cancel all
                </button>
              ) : (
                <button onClick={() => queue.clearFinished()} className="text-xs text-zinc-400 hover:text-white">
                  Clear
                </button>
              )}
            </div>
            <div className="h-0.5 bg-zinc-800">
              <div className="h-full bg-sky-500 transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            {!collapsed && (
              <ul className="max-h-[40vh] overflow-y-auto py-1 sm:max-h-80">
                {items.map((item) => (
                  <UploadRow key={item.id} item={item} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function UploadRow({ item }: { item: UploadItem }) {
  const { queue } = useUploads();
  const pct = item.size ? Math.round((item.loaded / item.size) * 100) : 0;
  const finishing = item.status === 'uploading' && item.loaded >= item.size;

  const statusText = {
    queued: 'Waiting',
    uploading: finishing ? 'Finishing…' : `${formatBytes(item.loaded)} / ${formatBytes(item.size)}`,
    done: formatBytes(item.size),
    error: item.error ?? 'Failed',
    canceled: 'Canceled',
  }[item.status];

  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm" title={item.name}>
          {item.name}
        </div>
        <div className={`truncate text-xs ${item.status === 'error' ? 'text-red-400' : 'text-zinc-500'}`}>
          {statusText}
        </div>
        {item.status === 'uploading' && (
          <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-800">
            <div className="h-full bg-sky-500 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      {item.status === 'done' && <span className="text-xs text-emerald-400">Done</span>}
      {(item.status === 'queued' || item.status === 'uploading') && (
        <button onClick={() => queue.cancel(item.id)} aria-label={`Cancel ${item.name}`} className="p-1 text-zinc-400 hover:text-white">
          <CloseIcon className="size-4" />
        </button>
      )}
      {(item.status === 'error' || item.status === 'canceled') && (
        <button onClick={() => queue.retry(item.id)} aria-label={`Retry ${item.name}`} className="p-1 text-zinc-400 hover:text-white">
          <RetryIcon className="size-4" />
        </button>
      )}
    </li>
  );
}
