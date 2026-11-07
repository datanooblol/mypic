'use client';

import type { TagSummary } from '@mypic/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { TagIcon } from '@/components/icons';
import { listTags, tagPath } from '@/lib/media';

export default function TagsPage() {
  const [tags, setTags] = useState<TagSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listTags()
      .then((t) => {
        if (active) setTags(t);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="px-2 pt-4 sm:px-0">
      <h1 className="mb-4 text-lg font-semibold">Tags</h1>
      {error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : tags === null ? (
        <div className="flex justify-center py-16">
          <div className="size-6 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
        </div>
      ) : tags.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-24 text-center text-sm text-zinc-400">
          <TagIcon className="size-10 text-zinc-600" />
          <p>No tags yet.</p>
          <p className="text-xs text-zinc-500">Select photos and choose “Tags”, or add tags from a photo’s details.</p>
        </div>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {tags.map((t) => (
            <li key={t.tag}>
              <Link
                href={tagPath(t.tag)}
                className="flex items-center gap-2 rounded-full bg-zinc-900 px-3 py-1.5 text-sm ring-1 ring-zinc-800 hover:bg-zinc-800"
              >
                <TagIcon className="size-3.5 text-zinc-400" />
                {t.tag}
                <span className="text-xs text-zinc-500">{t.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
