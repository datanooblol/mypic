'use client';

import type { AlbumView } from '@mypic/shared';
import { useState } from 'react';
import { refreshAlbums, upsertAlbum, useAlbums } from '@/lib/albums-store';
import { createAlbum, plural } from '@/lib/media';
import { buttonStyles, Dialog } from './Dialog';
import { AlbumIcon, PlusIcon } from './icons';

/** Pick an existing album or create one; calls onPick with the chosen album. */
export function AlbumPicker({
  title,
  excludeAlbumId,
  onPick,
  onClose,
}: {
  title: string;
  excludeAlbumId?: string;
  onPick: (album: AlbumView) => Promise<void> | void;
  onClose: () => void;
}) {
  const albums = useAlbums();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(album: AlbumView) {
    setBusy(true);
    setError(null);
    try {
      await onPick(album);
      void refreshAlbums().catch(() => undefined); // counts and covers changed
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const album = await createAlbum({ name: name.trim() });
      upsertAlbum(album);
      await pick(album);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const choices = (albums ?? []).filter((a) => a.albumId !== excludeAlbumId);

  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={create} className="mb-4 flex gap-2">
        <input
          className={buttonStyles.input}
          placeholder="New album name"
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <button className={`${buttonStyles.primary} flex shrink-0 items-center gap-1`} disabled={busy || !name.trim()}>
          <PlusIcon className="size-4" /> Create
        </button>
      </form>

      {albums === null ? (
        <p className="py-6 text-center text-sm text-zinc-500">Loading albums…</p>
      ) : choices.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">No albums yet. Create one above.</p>
      ) : (
        <ul className="-mx-2 space-y-1">
          {choices.map((album) => (
            <li key={album.albumId}>
              <button
                onClick={() => void pick(album)}
                disabled={busy}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-zinc-800 disabled:opacity-50"
              >
                <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-800">
                  {album.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- signed CDN thumbnail
                    <img src={album.coverUrl} alt="" className="size-full object-cover" />
                  ) : (
                    <AlbumIcon className="size-5 text-zinc-500" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{album.name}</span>
                  <span className="text-xs text-zinc-500">{plural(album.itemCount, 'item')}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
    </Dialog>
  );
}
