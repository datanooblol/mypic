'use client';

import { useRef, useState } from 'react';
import { UploadIcon } from './icons';
import { useUploads } from './UploadProvider';

/** Accept files dropped anywhere inside; shows a full-screen overlay while dragging. */
export function DropZone({ children }: { children: React.ReactNode }) {
  const { addFiles } = useUploads();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  return (
    <div
      className="flex min-h-full flex-1 flex-col"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {children}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 p-6">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-sky-500 px-10 py-12 text-sky-300">
            <UploadIcon className="size-10" />
            <span className="text-lg font-medium">Drop to upload</span>
          </div>
        </div>
      )}
    </div>
  );
}
