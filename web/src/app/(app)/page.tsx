'use client';

import type { MediaView, Page } from '@mypic/shared';
import { useCallback } from 'react';
import { MediaGallery } from '@/components/MediaGallery';
import { UploadIcon } from '@/components/icons';
import { useUploads } from '@/components/UploadProvider';
import { api } from '@/lib/api';

/** Timeline: all media, newest first, grouped by month. */
export default function TimelinePage() {
  const { pickFiles } = useUploads();
  const fetchPage = useCallback(
    (cursor?: string) => api<Page<MediaView>>(`/media${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    [],
  );

  return (
    <MediaGallery
      mode={{ kind: 'timeline' }}
      fetchPage={fetchPage}
      empty={
        <div className="flex flex-col items-center justify-center gap-4 py-32 text-center">
          <p className="text-zinc-400">No photos or videos yet.</p>
          <button
            onClick={pickFiles}
            className="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
          >
            <UploadIcon className="size-4" /> Upload files
          </button>
          <p className="text-xs text-zinc-500">or drag and drop them anywhere on this page</p>
        </div>
      }
    />
  );
}
