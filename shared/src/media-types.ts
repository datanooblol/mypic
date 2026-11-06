import type { MediaType } from './types';

export const RAW_EXTENSIONS = [
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw', 'x3f', '3fr', 'iiq',
] as const;
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'avif', 'tif', 'tiff'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mts', 'm2ts', '3gp'] as const;

const RAW = new Set<string>(RAW_EXTENSIONS);
const IMAGE = new Set<string>(IMAGE_EXTENSIONS);
const VIDEO = new Set<string>(VIDEO_EXTENSIONS);

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : '';
}

/** Classify by extension first (browsers often send RAW as octet-stream), then by MIME. */
export function detectMediaType(filename: string, mime: string): MediaType | undefined {
  const ext = extensionOf(filename);
  if (RAW.has(ext)) return 'raw';
  if (VIDEO.has(ext) || mime.startsWith('video/')) return 'video';
  if (IMAGE.has(ext) || mime.startsWith('image/')) return 'image';
  return undefined;
}

/** Value for <input type="file" accept>. */
export const UPLOAD_ACCEPT = [
  'image/*',
  'video/*',
  ...[...RAW_EXTENSIONS, ...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].map((e) => `.${e}`),
].join(',');
