'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { buttonStyles, Dialog } from '@/components/Dialog';
import { AlbumIcon, PlusIcon } from '@/components/icons';
import { refreshAlbums, upsertAlbum, useAlbums } from '@/lib/albums-store';
import { albumPath, createAlbum, plural } from '@/lib/media';

export default function AlbumsPage() {
  const albums = useAlbums();
  const [creating, setCreating] = useState(false);

  // Counts and covers change elsewhere; refresh whenever the page is shown.
  useEffect(() => {
    void refreshAlbums().catch(() => undefined);
  }, []);

  return (
    <div className="px-2 pt-4 sm:px-0">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Albums</h1>
        <button onClick={() => setCreating(true)} className={`${buttonStyles.primary} flex items-center gap-1.5`}>
          <PlusIcon className="size-4" /> New album
        </button>
      </div>

      {albums === null ? (
        <div className="flex justify-center py-16">
          <div className="size-6 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
        </div>
      ) : albums.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-24 text-center text-sm text-zinc-400">
          <AlbumIcon className="size-10 text-zinc-600" />
          <p>No albums yet.</p>
          <p className="text-xs text-zinc-500">Create one here, or select photos on the timeline and choose “Add to album”.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {albums.map((album) => (
            <Link key={album.albumId} href={albumPath(album.albumId)} className="group">
              <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-zinc-800">
                {album.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed CDN thumbnail
                  <img src={album.coverUrl} alt="" loading="lazy" className="size-full object-cover transition group-hover:scale-105" />
                ) : (
                  <AlbumIcon className="size-10 text-zinc-600" />
                )}
              </div>
              <div className="mt-2 truncate text-sm font-medium">{album.name}</div>
              <div className="text-xs text-zinc-500">{plural(album.itemCount, 'item')}</div>
            </Link>
          ))}
        </div>
      )}

      {creating && <CreateAlbumDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateAlbumDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      upsertAlbum(await createAlbum({ name: name.trim(), description: description.trim() || undefined }));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title="New album" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <input className={buttonStyles.input} placeholder="Name" required maxLength={100} autoFocus
          value={name} onChange={(e) => setName(e.target.value)} />
        <textarea className={buttonStyles.input} placeholder="Description (optional)" maxLength={500} rows={3}
          value={description} onChange={(e) => setDescription(e.target.value)} />
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonStyles.secondary}>Cancel</button>
          <button className={buttonStyles.primary} disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </Dialog>
  );
}
