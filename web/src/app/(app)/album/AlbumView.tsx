'use client';

import type { AlbumView as Album, MediaView, Page } from '@mypic/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { buttonStyles, Dialog } from '@/components/Dialog';
import { ArrowLeftIcon, TrashIcon } from '@/components/icons';
import { MediaGallery } from '@/components/MediaGallery';
import { useToast } from '@/components/Toast';
import { api } from '@/lib/api';
import { removeAlbum, upsertAlbum } from '@/lib/albums-store';
import { deleteAlbum, getAlbum, plural, updateAlbum } from '@/lib/media';

export function AlbumView() {
  const albumId = useSearchParams().get('id') ?? '';
  const router = useRouter();
  const toast = useToast();
  const [album, setAlbum] = useState<Album | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const reloadAlbum = useCallback(() => {
    getAlbum(albumId)
      .then((a) => {
        setAlbum(a);
        upsertAlbum(a);
      })
      .catch((err: Error) => setError(err.message));
  }, [albumId]);

  useEffect(() => {
    let active = true;
    getAlbum(albumId)
      .then((a) => {
        if (active) setAlbum(a);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [albumId]);

  const fetchPage = useCallback(
    (cursor?: string) =>
      api<Page<MediaView>>(
        `/albums/${encodeURIComponent(albumId)}/items${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    [albumId],
  );

  async function remove() {
    if (!album || !confirm(`Delete the album “${album.name}”? The photos stay in your library.`)) return;
    try {
      await deleteAlbum(albumId);
      removeAlbum(albumId);
      toast.show(`Deleted album “${album.name}”`);
      router.replace('/albums');
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), { tone: 'error' });
    }
  }

  if (error) {
    return (
      <div className="py-24 text-center text-sm">
        <p className="text-red-400">{error}</p>
        <Link href="/albums" className="mt-2 inline-block text-zinc-300 underline">Back to albums</Link>
      </div>
    );
  }

  return (
    <MediaGallery
      key={albumId}
      mode={{ kind: 'album', albumId, onAlbumChanged: reloadAlbum }}
      fetchPage={fetchPage}
      onItemsChanged={reloadAlbum}
      header={
        <div className="flex items-start gap-2 px-2 pb-2 pt-2 sm:px-0">
          <Link href="/albums" aria-label="Back to albums" className="mt-0.5 rounded-full p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white">
            <ArrowLeftIcon className="size-5" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{album?.name ?? ' '}</h1>
            <p className="text-xs text-zinc-500">
              {album ? plural(album.itemCount, 'item') : ''}
              {album?.description ? ` · ${album.description}` : ''}
            </p>
          </div>
          <button onClick={() => setEditing(true)} disabled={!album} className={buttonStyles.secondary}>
            Edit
          </button>
          <button onClick={() => void remove()} disabled={!album} aria-label="Delete album" title="Delete album"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-white/10 hover:text-red-300">
            <TrashIcon className="size-5" />
          </button>
          {editing && album && (
            <EditAlbumDialog
              album={album}
              onClose={() => setEditing(false)}
              onSaved={(a) => {
                setAlbum(a);
                upsertAlbum(a);
              }}
            />
          )}
        </div>
      }
      empty={
        <div className="py-24 text-center text-sm text-zinc-400">
          <p>This album is empty.</p>
          <p className="mt-1 text-xs text-zinc-500">Select photos on the timeline and choose “Add to album”.</p>
        </div>
      }
    />
  );
}

function EditAlbumDialog({ album, onClose, onSaved }: { album: Album; onClose: () => void; onSaved: (a: Album) => void }) {
  const [name, setName] = useState(album.name);
  const [description, setDescription] = useState(album.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateAlbum(album.albumId, { name: name.trim(), description: description.trim() }));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title="Edit album" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <input className={buttonStyles.input} placeholder="Name" required maxLength={100} autoFocus
          value={name} onChange={(e) => setName(e.target.value)} />
        <textarea className={buttonStyles.input} placeholder="Description (optional)" maxLength={500} rows={3}
          value={description} onChange={(e) => setDescription(e.target.value)} />
        <p className="text-xs text-zinc-500">To change the cover, select one photo in the album and choose “Set as cover”.</p>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonStyles.secondary}>Cancel</button>
          <button className={buttonStyles.primary} disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  );
}
