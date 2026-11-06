'use client';

import { UPLOAD_ACCEPT } from '@mypic/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { DropZone } from '@/components/DropZone';
import { UploadIcon } from '@/components/icons';
import { UploadPanel } from '@/components/UploadPanel';
import { UploadProvider, useUploads } from '@/components/UploadProvider';

/** Signed-in area: auth guard, header, drag-and-drop uploads. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { auth } = useAuth();

  useEffect(() => {
    if (auth.status === 'signedOut') router.replace('/login');
  }, [auth.status, router]);

  if (auth.status !== 'signedIn') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
      </div>
    );
  }

  return (
    <UploadProvider accept={UPLOAD_ACCEPT}>
      <DropZone>
        <Header email={auth.email} />
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-1 pb-24 sm:px-4">{children}</main>
        <UploadPanel />
      </DropZone>
    </UploadProvider>
  );
}

function Header({ email }: { email?: string }) {
  const { signOut } = useAuth();
  const { pickFiles } = useUploads();

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-900 bg-zinc-950/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-3 sm:px-4">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          mypic
        </Link>
        <div className="flex-1" />
        <button
          onClick={pickFiles}
          className="flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
        >
          <UploadIcon className="size-4" />
          <span className="hidden sm:inline">Upload</span>
        </button>
        <span className="hidden max-w-48 truncate text-sm text-zinc-400 md:inline" title={email}>
          {email}
        </span>
        <button onClick={() => void signOut()} className="text-sm text-zinc-400 hover:text-white">
          Sign out
        </button>
      </div>
    </header>
  );
}
