'use client';

import { MAX_TAGS_PER_ITEM, normalizeTag, type TagSummary } from '@mypic/shared';
import { useEffect, useMemo, useState } from 'react';
import { listTags } from '@/lib/media';
import { buttonStyles, Dialog } from './Dialog';
import { CloseIcon } from './icons';

/**
 * Add/remove tags for one or more items. `current` lists tags present on any of the
 * selected items (with how many have each), so removing works across a selection.
 */
export function TagEditor({
  itemCount,
  current,
  onApply,
  onClose,
}: {
  itemCount: number;
  current: Map<string, number>;
  onApply: (changes: { add: string[]; remove: string[] }) => Promise<void>;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const [all, setAll] = useState<TagSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listTags()
      .then((tags) => {
        if (active) setAll(tags);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const query = normalizeTag(input) ?? '';
  const suggestions = useMemo(
    () =>
      all
        .filter((t) => (!query || t.tag.includes(query)) && !add.includes(t.tag) && !current.has(t.tag))
        .slice(0, 8),
    [all, query, add, current],
  );

  function addTag(raw: string) {
    const tag = normalizeTag(raw);
    if (!tag) {
      if (raw.trim()) setError('Use letters, numbers, spaces, "-" or "_" (max 40 characters)');
      return;
    }
    setError(null);
    setRemove((r) => r.filter((t) => t !== tag));
    if (!current.has(tag) || (current.get(tag) ?? 0) < itemCount) setAdd((a) => (a.includes(tag) ? a : [...a, tag]));
    setInput('');
  }

  async function apply() {
    const pending = input.trim() ? normalizeTag(input) : undefined;
    const toAdd = pending && !add.includes(pending) ? [...add, pending] : add;
    if (!toAdd.length && !remove.length) return onClose();
    if (current.size - remove.length + toAdd.length > MAX_TAGS_PER_ITEM) {
      setError(`At most ${MAX_TAGS_PER_ITEM} tags per item`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onApply({ add: toAdd, remove });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const shown = [...current.keys()].filter((t) => !remove.includes(t)).sort();

  return (
    <Dialog
      title={itemCount === 1 ? 'Tags' : `Tags for ${itemCount} items`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={buttonStyles.secondary}>
            Cancel
          </button>
          <button onClick={() => void apply()} className={buttonStyles.primary} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          addTag(input);
        }}
      >
        <input
          className={buttonStyles.input}
          placeholder="Add a tag and press Enter"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
        />
      </form>

      {suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {suggestions.map((t) => (
            <button
              key={t.tag}
              onClick={() => addTag(t.tag)}
              className="rounded-full border border-dashed border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-400 hover:border-sky-600 hover:text-sky-300"
            >
              + {t.tag}
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-1.5">
        {shown.map((tag) => {
          const n = current.get(tag) ?? 0;
          return (
            <Chip key={tag} onRemove={() => setRemove((r) => [...r, tag])}>
              {tag}
              {itemCount > 1 && n < itemCount && <span className="text-zinc-500"> · {n}/{itemCount}</span>}
            </Chip>
          );
        })}
        {add.map((tag) => (
          <Chip key={`+${tag}`} added onRemove={() => setAdd((a) => a.filter((t) => t !== tag))}>
            {tag}
          </Chip>
        ))}
        {!shown.length && !add.length && <p className="text-sm text-zinc-500">No tags yet.</p>}
      </div>
      {remove.length > 0 && (
        <p className="mt-3 text-xs text-zinc-500">
          Removing: {remove.join(', ')}{' '}
          <button onClick={() => setRemove([])} className="text-sky-400 hover:underline">
            undo
          </button>
        </p>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
    </Dialog>
  );
}

function Chip({ children, added, onRemove }: { children: React.ReactNode; added?: boolean; onRemove: () => void }) {
  return (
    <span
      className={`flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-xs ${
        added ? 'bg-sky-900/60 text-sky-100' : 'bg-zinc-800 text-zinc-200'
      }`}
    >
      {children}
      <button onClick={onRemove} aria-label="Remove tag" className="rounded-full p-0.5 text-zinc-400 hover:bg-black/30 hover:text-white">
        <CloseIcon className="size-3" />
      </button>
    </span>
  );
}
