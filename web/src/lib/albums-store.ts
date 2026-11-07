/**
 * Tiny shared cache for the album list (used by the album picker, the lightbox
 * details panel and the Albums page), so it's fetched once and refreshed after changes.
 */
import type { AlbumView } from '@mypic/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { listAlbums } from './media';

let albums: AlbumView[] | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function refreshAlbums(): Promise<void> {
  inflight ??= listAlbums()
    .then((list) => {
      albums = list;
      emit();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Optimistically replace or insert one album (e.g. after create/rename). */
export function upsertAlbum(album: AlbumView) {
  const rest = (albums ?? []).filter((a) => a.albumId !== album.albumId);
  albums = [album, ...rest];
  emit();
}

export function removeAlbum(albumId: string) {
  albums = (albums ?? []).filter((a) => a.albumId !== albumId);
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Albums (null while loading the first time). */
export function useAlbums(): AlbumView[] | null {
  const value = useSyncExternalStore(subscribe, () => albums, () => null);
  useEffect(() => {
    if (albums === null) void refreshAlbums().catch(() => undefined);
  }, []);
  return value;
}
