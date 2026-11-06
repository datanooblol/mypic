'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { UploadQueue, type UploadItem } from '@/lib/upload-queue';

interface UploadContextValue {
  queue: UploadQueue;
  /** Add files and surface any that were skipped. */
  addFiles: (files: Iterable<File>) => void;
  /** Open the system file picker. */
  pickFiles: () => void;
  notice: string | null;
  dismissNotice: () => void;
}

const UploadContext = createContext<UploadContextValue | null>(null);
const EMPTY: UploadItem[] = [];

export function UploadProvider({
  accept,
  children,
}: {
  accept: string;
  children: React.ReactNode;
}) {
  const [queue] = useState(() => new UploadQueue(3));
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    (files: Iterable<File>) => {
      const { rejected } = queue.add(files);
      if (rejected.length) {
        const names = rejected.slice(0, 3).map((r) => `${r.name} (${r.reason})`).join(', ');
        const more = rejected.length > 3 ? ` and ${rejected.length - 3} more` : '';
        setNotice(`Skipped ${rejected.length} file${rejected.length > 1 ? 's' : ''}: ${names}${more}`);
      }
    },
    [queue],
  );

  // Warn before closing the tab while uploads are running.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (queue.active) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [queue]);

  const value: UploadContextValue = {
    queue,
    addFiles,
    pickFiles: () => inputRef.current?.click(),
    notice,
    dismissNotice: () => setNotice(null),
  };

  return (
    <UploadContext.Provider value={value}>
      {children}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addFiles(Array.from(e.target.files));
          e.target.value = ''; // allow picking the same file again
        }}
      />
    </UploadContext.Provider>
  );
}

export function useUploads() {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error('useUploads must be used inside <UploadProvider>');
  const items = useSyncExternalStore(ctx.queue.subscribe, ctx.queue.getSnapshot, () => EMPTY);
  return { ...ctx, items };
}
