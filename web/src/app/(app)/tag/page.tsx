import { Suspense } from 'react';
import { TagView } from './TagView';

/** /tag?name=… (query parameter; see album/page.tsx for why). */
export default function TagPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-16">
          <div className="size-6 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
        </div>
      }
    >
      <TagView />
    </Suspense>
  );
}
