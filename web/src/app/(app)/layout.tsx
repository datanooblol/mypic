'use client';

import { UPLOAD_ACCEPT } from '@mypic/shared';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { DropZone } from '@/components/DropZone';
import { AlbumIcon, PhotosIcon, TagIcon, TrashIcon, UploadIcon } from '@/components/icons';
import { ToastProvider } from '@/components/Toast';
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
    <ToastProvider>
      <UploadProvider accept={UPLOAD_ACCEPT}>
        <DropZone>
          <Header email={auth.email} />
          <main className="mx-auto w-full max-w-[1600px] flex-1 px-1 pb-32 sm:px-4 sm:pb-24">{children}</main>
          {/* Mobile: tabs at the bottom, within thumb reach */}
          <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-900 bg-zinc-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
            <Suspense fallback={<NavLinks active={null} variant="bottom" />}>
              <ActiveNav variant="bottom" />
            </Suspense>
          </nav>
          <UploadPanel />
        </DropZone>
      </UploadProvider>
    </ToastProvider>
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
        <nav className="ml-4 hidden flex-1 sm:block">
          <Suspense fallback={<NavLinks active={null} variant="top" />}>
            <ActiveNav variant="top" />
          </Suspense>
        </nav>
        <div className="flex-1 sm:hidden" />
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

const NAV = [
  { href: '/', label: 'Photos', icon: PhotosIcon },
  { href: '/albums', label: 'Albums', icon: AlbumIcon },
  { href: '/tags', label: 'Tags', icon: TagIcon },
  { href: '/trash', label: 'Trash', icon: TrashIcon },
] as const;

type NavVariant = 'top' | 'bottom';

/** Reads the current path (inside Suspense: dynamic segments resolve at request time). */
function ActiveNav({ variant }: { variant: NavVariant }) {
  const pathname = usePathname();
  // /album?id= and /tag?name= belong to the Albums and Tags tabs.
  const section = (href: string) => (href === '/' ? href : href.replace(/s$/, ''));
  const active =
    NAV.find((n) => (n.href === '/' ? pathname === '/' : pathname.startsWith(section(n.href))))?.href ?? null;
  return <NavLinks active={active} variant={variant} />;
}

function NavLinks({ active, variant }: { active: string | null; variant: NavVariant }) {
  if (variant === 'bottom') {
    return (
      <ul className="grid grid-cols-4">
        {NAV.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              aria-current={active === href ? 'page' : undefined}
              className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${active === href ? 'text-white' : 'text-zinc-500'}`}
            >
              <Icon className="size-5" />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="flex gap-1">
      {NAV.map(({ href, label }) => (
        <li key={href}>
          <Link
            href={href}
            aria-current={active === href ? 'page' : undefined}
            className={`rounded-lg px-3 py-1.5 text-sm ${active === href ? 'bg-white/10 text-white' : 'text-zinc-400 hover:text-white'}`}
          >
            {label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
