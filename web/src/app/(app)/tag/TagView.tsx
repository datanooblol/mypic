'use client';

import type { MediaView, Page } from '@mypic/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { ArrowLeftIcon, TagIcon } from '@/components/icons';
import { MediaGallery } from '@/components/MediaGallery';
import { api } from '@/lib/api';

export function TagView() {
  const tag = useSearchParams().get('name') ?? '';

  const fetchPage = useCallback(
    (cursor?: string) =>
      api<Page<MediaView>>(
        `/tags/${encodeURIComponent(tag)}/items${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    [tag],
  );

  return (
    <MediaGallery
      key={tag}
      mode={{ kind: 'tag', tag }}
      fetchPage={fetchPage}
      header={
        <div className="flex items-center gap-2 px-2 pb-2 pt-2 sm:px-0">
          <Link href="/tags" aria-label="Back to tags" className="rounded-full p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white">
            <ArrowLeftIcon className="size-5" />
          </Link>
          <TagIcon className="size-5 text-zinc-400" />
          <h1 className="truncate text-lg font-semibold">{tag}</h1>
        </div>
      }
      empty={<p className="py-24 text-center text-sm text-zinc-400">Nothing is tagged “{tag}”.</p>}
    />
  );
}
