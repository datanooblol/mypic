import { HttpError } from './http';

type Key = Record<string, unknown>;

/** Opaque pagination cursor: base64url(JSON(LastEvaluatedKey)). */
export function encodeCursor(key: Key | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key)).toString('base64url') : undefined;
}

/**
 * Decode a cursor and check it belongs to the expected partition, so a tampered
 * cursor can't point a query at someone else's data.
 */
export function decodeCursor(
  cursor: string | undefined,
  expect: { attr: string; value: string },
): Key | undefined {
  if (!cursor) return undefined;
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid cursor');
  }
  if (!key || typeof key !== 'object' || (key as Key)[expect.attr] !== expect.value) {
    throw new HttpError(400, 'Invalid cursor');
  }
  return key as Key;
}
