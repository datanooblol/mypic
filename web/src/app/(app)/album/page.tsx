import { Suspense } from 'react';
import { AlbumView } from './AlbumView';

/**
 * /album?id=… (a query parameter, not /albums/[id]: the app is a static export,
 * which can't serve dynamic segments). The id is read on the client inside Suspense.
 */
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
