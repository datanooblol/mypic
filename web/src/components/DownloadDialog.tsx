'use client';

import type { MediaView } from '@mypic/shared';
import { useEffect, useRef, useState } from 'react';
import {
  DownloadCanceled,
  SHARE_MAX_BYTES,
  SHARE_MAX_FILES,
  canSaveViaShareSheet,
  downloadSequentially,
  fetchForShare,
  type DownloadFailure,
} from '@/lib/download';
import { formatBytes } from '@/lib/format';
import { plural } from '@/lib/media';
import { buttonStyles, Dialog } from './Dialog';
import { useToast } from './Toast';

type Phase =
  | { kind: 'downloading'; done: number; current?: string }
  | { kind: 'fetching'; loaded: number }
  | { kind: 'ready'; files: File[] }
  | { kind: 'finished'; started: number }
  | { kind: 'error'; message: string };

type Strategy = 'sequential' | 'share';

/** "Download selected": plain downloads on desktop, the share sheet on phones. */
export function DownloadDialog({ items, onClose }: { items: MediaView[]; onClose: () => void }) {
  const toast = useToast();
  const totalBytes = items.reduce((s, m) => s + m.size, 0);
  const [strategy, setStrategy] = useState<Strategy>(() =>
    canSaveViaShareSheet() && totalBytes <= SHARE_MAX_BYTES && items.length <= SHARE_MAX_FILES ? 'share' : 'sequential',
  );
  const [phase, setPhase] = useState<Phase>(
    strategy === 'share' ? { kind: 'fetching', loaded: 0 } : { kind: 'downloading', done: 0 },
  );
  const [failed, setFailed] = useState<DownloadFailure[]>([]);
  const ctrl = useRef<AbortController | null>(null);
  const ids = items.map((m) => m.mediaId);
  const idsKey = ids.join(',');

  useEffect(() => {
    const controller = new AbortController();
    ctrl.current = controller;
    const mediaIds = idsKey.split(',');
    const fail = (err: unknown) => {
      if (err instanceof DownloadCanceled || controller.signal.aborted) return;
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    };
    if (strategy === 'sequential') {
      downloadSequentially(mediaIds, (done, current) => setPhase({ kind: 'downloading', done, current }), controller.signal)
        .then(({ started, failed: f }) => {
          setFailed(f);
          setPhase({ kind: 'finished', started });
        })
        .catch(fail);
    } else {
      fetchForShare(mediaIds, (loaded) => setPhase({ kind: 'fetching', loaded }), controller.signal)
        .then(({ files, failed: f }) => {
          setFailed(f);
          setPhase(files.length ? { kind: 'ready', files } : { kind: 'error', message: 'No files could be fetched' });
        })
        .catch(fail);
    }
    return () => controller.abort();
  }, [strategy, idsKey]);

  function switchToSequential() {
    ctrl.current?.abort();
    setFailed([]);
    setPhase({ kind: 'downloading', done: 0 });
    setStrategy('sequential');
  }

  async function share(files: File[]) {
    try {
      await navigator.share({ files });
      toast.show(`Shared ${plural(files.length, 'file')}`);
      onClose();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return; // user closed the sheet; let them retry
      toast.show(`Couldn't open the share sheet: ${(err as Error).message}`, { tone: 'error' });
    }
  }

  const pct =
    phase.kind === 'downloading'
      ? Math.round((phase.done / items.length) * 100)
      : phase.kind === 'fetching'
        ? Math.round((phase.loaded / Math.max(totalBytes, 1)) * 100)
        : 100;

  return (
    <Dialog
      title={`Download ${plural(items.length, 'item')}`}
      onClose={onClose}
      footer={
        phase.kind === 'ready' ? (
          <>
            <button onClick={onClose} className={buttonStyles.secondary}>Cancel</button>
            {/* Must run directly in the tap handler: share() needs a user gesture. */}
            <button onClick={() => void share(phase.files)} className={buttonStyles.primary}>
              Save {plural(phase.files.length, 'file')}
            </button>
          </>
        ) : (
          <button onClick={onClose} className={buttonStyles.secondary}>
            {phase.kind === 'finished' || phase.kind === 'error' ? 'Close' : 'Cancel'}
          </button>
        )
      }
    >
      <div className="space-y-3 text-sm">
        {(phase.kind === 'downloading' || phase.kind === 'fetching') && (
          <>
            <p className="text-zinc-300">
              {phase.kind === 'downloading'
                ? `Starting download ${Math.min(phase.done + 1, items.length)} of ${items.length}…`
                : `Preparing ${formatBytes(phase.loaded)} of ${formatBytes(totalBytes)}…`}
            </p>
            <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
              <div className="h-full bg-sky-500 transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            {phase.kind === 'downloading' && phase.current && <p className="truncate text-xs text-zinc-500">{phase.current}</p>}
            {phase.kind === 'downloading' && items.length > 1 && (
              <p className="text-xs text-zinc-500">
                If your browser asks, allow this site to download multiple files.
              </p>
            )}
          </>
        )}

        {phase.kind === 'ready' && (
          <p className="text-zinc-300">
            {plural(phase.files.length, 'file')} ready ({formatBytes(phase.files.reduce((s, f) => s + f.size, 0))}). Tap{' '}
            <strong>Save</strong>, then choose <em>Save to Photos</em> or <em>Save to Files</em>.
          </p>
        )}

        {phase.kind === 'finished' && (
          <p className="text-zinc-300">
            Started {plural(phase.started, 'download')}. Check your browser&apos;s downloads.
            {phase.started > 1 && (
              <span className="mt-1 block text-xs text-zinc-500">
                Only got one file? Allow multiple downloads for this site (usually an icon in the address bar), then try again.
              </span>
            )}
          </p>
        )}

        {phase.kind === 'error' && <p className="text-red-400">{phase.message}</p>}

        {failed.length > 0 && (
          <p className="text-xs text-amber-300">
            {plural(failed.length, 'item')} couldn&apos;t be downloaded ({failed[0]!.message}).
          </p>
        )}

        {strategy === 'share' && phase.kind !== 'error' && (
          <button onClick={switchToSequential} className="text-xs text-sky-400 hover:underline">
            Download files one by one instead
          </button>
        )}
        {strategy === 'sequential' && canSaveViaShareSheet() && totalBytes > SHARE_MAX_BYTES && (
          <p className="text-xs text-zinc-500">
            Selections over {formatBytes(SHARE_MAX_BYTES)} download one by one. Select fewer items to save them to Photos in one go.
          </p>
        )}
      </div>
    </Dialog>
  );
}
