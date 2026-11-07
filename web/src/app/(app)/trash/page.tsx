'use client';

import { TRASH_RETENTION_DAYS, type MediaView, type Page } from '@mypic/shared';
import { useCallback, useState } from 'react';
import { buttonStyles } from '@/components/Dialog';
import { TrashIcon } from '@/components/icons';
import { MediaGallery } from '@/components/MediaGallery';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { emptyTrash } from '@/lib/media';

export default function TrashPage() {
  const toast = useToast();
  // Remount the gallery after "Empty trash" so it reloads from scratch.
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);

  const fetchPage = useCallback(
    (cursor?: string) => api<Page<MediaView>>(`/trash${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    [],
  );

  async function empty() {
    if (!confirm('Delete everything in the trash forever? This can’t be undone.')) return;
    setBusy(true);
    try {
      await emptyTrash();
      toast.show('Emptying trash…');
      setGeneration((g) => g + 1);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <MediaGallery
      key={generation}
      mode={{ kind: 'trash' }}
      fetchPage={generation === 0 ? fetchPage : async () => ({ items: [] })}
      header={
        <div className="flex items-center gap-3 px-2 pb-3 pt-2 sm:px-0">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">Trash</h1>
            <p className="text-xs text-zinc-500">Items are deleted forever {TRASH_RETENTION_DAYS} days after you move them here.</p>
          </div>
          <button onClick={() => void empty()} disabled={busy} className={`${buttonStyles.danger} flex items-center gap-1.5`}>
            <TrashIcon className="size-4" /> Empty trash
          </button>
        </div>
      }
      empty={
        <div className="flex flex-col items-center gap-2 py-24 text-center text-sm text-zinc-400">
          <TrashIcon className="size-10 text-zinc-600" />
          <p>Trash is empty.</p>
        </div>
      }
    />
  );
}
