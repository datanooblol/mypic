/** Decode any supported image (incl. HEIC and RAW previews) and render derivatives with sharp. */
import { readFile } from 'node:fs/promises';
import type { Sharp } from 'sharp';
import sharp from 'sharp';

export const THUMB_SHORT_EDGE = 400; // grid tiles are square crops; short edge keeps them sharp
export const PREVIEW_LONG_EDGE = 2048; // lightbox
const WEBP_OPTS = { quality: 80, effort: 4 } as const;

export interface Rendered {
  thumb: Buffer;
  preview: Buffer;
  /** Oriented dimensions of the decoded source. */
  width: number;
  height: number;
}

const HEIF_EXTENSIONS = new Set(['heic', 'heif']);

/** sharp ops equivalent to EXIF orientation 2-8 (for sources whose own metadata lost it). */
export function applyOrientation(img: Sharp, orientation: number): Sharp {
  switch (orientation) {
    case 2: return img.flop();
    case 3: return img.rotate(180);
    case 4: return img.flip();
    case 5: return img.rotate(90).flop();
    case 6: return img.rotate(90);
    case 7: return img.rotate(270).flop();
    case 8: return img.rotate(270);
    default: return img;
  }
}

/** Orientations 5-8 swap width and height. */
export function orientedSize(width: number, height: number, orientation: number) {
  return orientation >= 5 ? { width: height, height: width } : { width, height };
}

export interface SourceOptions {
  /** File extension of the original (lowercase). */
  ext: string;
  /**
   * For RAW: orientation from the RAW file, applied when the embedded JPEG
   * carries no orientation of its own.
   */
  fallbackOrientation?: number;
}

/** Load the input into an oriented sharp pipeline. */
export async function loadSource(path: string, opts: SourceOptions): Promise<{ img: Sharp; width: number; height: number }> {
  if (HEIF_EXTENSIONS.has(opts.ext)) {
    // Prebuilt sharp can't decode HEVC-based HEIC; libheif (WASM) can. libheif
    // applies the container's rotation (irot/imir), so no further orientation.
    const { default: decode } = await import('heic-decode');
    const { width, height, data } = await decode({ buffer: await readFile(path) });
    const img = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width, height, channels: 4 },
    });
    return { img, width, height };
  }

  const img = sharp(path, { failOn: 'none', limitInputPixels: 500_000_000 });
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error('Could not read image dimensions');

  if (meta.orientation && meta.orientation > 1) {
    return { img: img.rotate(), ...orientedSize(meta.width, meta.height, meta.orientation) };
  }
  const o = opts.fallbackOrientation ?? 1;
  return { img: applyOrientation(img, o), ...orientedSize(meta.width, meta.height, o) };
}

export async function render(path: string, opts: SourceOptions): Promise<Rendered> {
  const { img, width, height } = await loadSource(path, opts);
  const base = img.toColourspace('srgb');
  const [thumb, preview] = await Promise.all([
    base
      .clone()
      .resize({ width: THUMB_SHORT_EDGE, height: THUMB_SHORT_EDGE, fit: 'outside', withoutEnlargement: true })
      .webp(WEBP_OPTS)
      .toBuffer(),
    base
      .clone()
      .resize({ width: PREVIEW_LONG_EDGE, height: PREVIEW_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp(WEBP_OPTS)
      .toBuffer(),
  ]);
  // sharp strips metadata by default, so derived files carry no GPS.
  return { thumb, preview, width, height };
}
