'use client';

import { useEffect, useRef } from 'react';
import { CloseIcon } from './icons';

/** Modal built on <dialog>: focus trap, Esc to close and backdrop come from the browser. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on backdrop
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-0 text-zinc-100 shadow-2xl backdrop:bg-black/70"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button onClick={onClose} aria-label="Close" className="p-1 text-zinc-400 hover:text-white">
          <CloseIcon className="size-4" />
        </button>
      </div>
      <div className="max-h-[60dvh] overflow-y-auto p-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">{footer}</div>}
    </dialog>
  );
}

export const buttonStyles = {
  primary: 'rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50',
  secondary: 'rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-700 disabled:opacity-50',
  danger: 'rounded-lg bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50',
  input:
    'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-base outline-none placeholder:text-zinc-500 focus:border-sky-500 sm:text-sm',
};
