import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExifDateTime, type Tags } from 'exiftool-vendored';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exifSummaryFrom, orientationFrom, takenAtFrom } from '../src/processing/exif';
import { orientedSize, PREVIEW_LONG_EDGE, render, THUMB_SHORT_EDGE } from '../src/processing/image';

const tags = (t: Record<string, unknown>) => t as unknown as Tags;

describe('takenAtFrom', () => {
  it('uses the real instant when the time zone was recorded', () => {
    const dt = ExifDateTime.fromEXIF('2024:05:01 10:20:30+07:00');
    expect(takenAtFrom(tags({ DateTimeOriginal: dt }))).toEqual({ takenAt: '2024-05-01T03:20:30.000Z', offset: 420 });
  });

  it('treats zone-less camera time as UTC wall clock', () => {
    const dt = ExifDateTime.fromEXIF('2024:05:01 10:20:30');
    expect(takenAtFrom(tags({ DateTimeOriginal: dt }))).toEqual({ takenAt: '2024-05-01T10:20:30.000Z', offset: 0 });
  });

  it('falls back through date tags and skips zeroed dates', () => {
    expect(
      takenAtFrom(tags({ DateTimeOriginal: '0000:00:00 00:00:00', CreateDate: ExifDateTime.fromEXIF('2020:01:02 03:04:05') })),
    ).toEqual({ takenAt: '2020-01-02T03:04:05.000Z', offset: 0 });
    expect(takenAtFrom(tags({}))).toBeUndefined();
  });
});

describe('exifSummaryFrom', () => {
  it('maps camera fields and signs GPS by reference', () => {
    const s = exifSummaryFrom(
      tags({
        Make: 'Canon',
        Model: 'Canon EOS R5',
        LensModel: 'RF24-70mm F2.8 L IS USM',
        FocalLength: '50.0 mm',
        FNumber: 2.8,
        ExposureTime: 0.004,
        ISO: 400,
        GPSLatitude: 13.7563,
        GPSLatitudeRef: 'North',
        GPSLongitude: 100.5018,
        GPSLongitudeRef: 'W',
      }),
    );
    expect(s).toEqual({
      make: 'Canon',
      model: 'EOS R5',
      lens: 'RF24-70mm F2.8 L IS USM',
      focalLength: 50,
      fNumber: 2.8,
      exposureTime: '1/250',
      iso: 400,
      gps: { lat: 13.7563, lon: -100.5018 },
    });
  });

  it('drops null-island GPS and returns undefined when empty', () => {
    expect(exifSummaryFrom(tags({ GPSLatitude: 0, GPSLongitude: 0 }))).toBeUndefined();
  });
});

describe('orientation', () => {
  it('reads valid orientation, defaults to 1', () => {
    expect(orientationFrom(tags({ Orientation: 6 }))).toBe(6);
    expect(orientationFrom(tags({ Orientation: 42 }))).toBe(1);
    expect(orientationFrom(tags({}))).toBe(1);
  });
  it('swaps dimensions for 90-degree orientations', () => {
    expect(orientedSize(400, 300, 6)).toEqual({ width: 300, height: 400 });
    expect(orientedSize(400, 300, 3)).toEqual({ width: 400, height: 300 });
  });
});

describe('render', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mypic-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const jpeg = (width: number, height: number, orientation?: number) => {
    const img = sharp({ create: { width, height, channels: 3, background: '#3366cc' } }).jpeg();
    return (orientation ? img.withMetadata({ orientation }) : img).toBuffer();
  };

  it('makes a cover-sized thumb and a bounded preview without metadata', async () => {
    const file = join(dir, 'big.jpg');
    await writeFile(file, await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#888' } })
      .jpeg()
      .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '13/1 45/1 0/1' } })
      .toBuffer());
    const r = await render(file, { ext: 'jpg' });
    expect({ width: r.width, height: r.height }).toEqual({ width: 4000, height: 3000 });

    const thumb = await sharp(r.thumb).metadata();
    expect(thumb.format).toBe('webp');
    expect(Math.min(thumb.width!, thumb.height!)).toBe(THUMB_SHORT_EDGE);

    const preview = await sharp(r.preview).metadata();
    expect(Math.max(preview.width!, preview.height!)).toBe(PREVIEW_LONG_EDGE);
    expect(preview.exif).toBeUndefined(); // GPS stripped
  });

  it('applies the file\'s own EXIF orientation', async () => {
    const file = join(dir, 'rotated.jpg');
    await writeFile(file, await jpeg(800, 600, 6));
    const r = await render(file, { ext: 'jpg' });
    expect({ width: r.width, height: r.height }).toEqual({ width: 600, height: 800 });
    const preview = await sharp(r.preview).metadata();
    expect({ w: preview.width, h: preview.height }).toEqual({ w: 600, h: 800 });
  });

  it('applies the RAW file orientation when the embedded JPEG has none', async () => {
    const file = join(dir, 'embedded.jpg');
    await writeFile(file, await jpeg(800, 600));
    const r = await render(file, { ext: 'jpg', fallbackOrientation: 8 });
    const preview = await sharp(r.preview).metadata();
    expect({ w: preview.width, h: preview.height }).toEqual({ w: 600, h: 800 });
  });

  it('does not enlarge small images', async () => {
    const file = join(dir, 'small.png');
    await writeFile(file, await sharp({ create: { width: 120, height: 80, channels: 4, background: '#0000' } }).png().toBuffer());
    const r = await render(file, { ext: 'png' });
    const preview = await sharp(r.preview).metadata();
    expect({ w: preview.width, h: preview.height }).toEqual({ w: 120, h: 80 });
  });
});

describe('processing runtime package', () => {
  it('pins the same versions the code is tested against', async () => {
    const runtime = JSON.parse(await readFile(join(__dirname, '..', 'processing', 'package.json'), 'utf8'));
    for (const [name, version] of Object.entries(runtime.dependencies as Record<string, string>)) {
      const installed = JSON.parse(
        await readFile(join(__dirname, '..', '..', 'node_modules', name, 'package.json'), 'utf8'),
      ).version;
      expect(`${name}@${version}`).toBe(`${name}@${installed}`);
    }
  });
});
