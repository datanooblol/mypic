import { Suspense } from 'react';
import { AlbumView } from './AlbumView';

// Album IDs are only known at request time; the client view reads them inside Suspense.
export default function AlbumPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-16">
          <div className="size-6 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
        </div>
      }
    >
      <AlbumView />
    </Suspense>
  );
}
