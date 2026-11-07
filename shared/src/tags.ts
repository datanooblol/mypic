/** Tag rules shared by the API and the web app. */
export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_ITEM = 30;

/**
 * Normalize a tag: trim, collapse whitespace, lowercase. Letters (any script),
 * digits, spaces, "-" and "_" only. Returns undefined when nothing valid remains.
 */
export function normalizeTag(input: string): string | undefined {
  const tag = input
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} _-]/gu, '')
    .trim();
  return tag && tag.length <= MAX_TAG_LENGTH ? tag : undefined;
}
