/** Map exiftool tags to the app's metadata. Pure functions (unit tested). */
import type { ExifSummary } from '@mypic/shared';
import { ExifDateTime, type Tags } from 'exiftool-vendored';

/** Tags tried in order for "date taken". */
const DATE_TAGS = [
  'SubSecDateTimeOriginal',
  'DateTimeOriginal',
  'SubSecCreateDate',
  'CreateDate',
  'DateTimeCreated',
  'DigitalCreationDateTime',
  'MediaCreateDate',
] as const;

/**
 * "Date taken" as ISO-8601 UTC. With a recorded time zone this is the real instant.
 * Without one, the camera's wall-clock time is treated as UTC, so the date and time
 * shown are what the camera displayed and sorting stays stable.
 */
export function takenAtFrom(tags: Tags): { takenAt: string; offset: number } | undefined {
  for (const name of DATE_TAGS) {
    const value = (tags as Record<string, unknown>)[name];
    const dt = value instanceof ExifDateTime ? value : typeof value === 'string' ? ExifDateTime.from(value) : undefined;
    if (!dt || dt.year < 1900 || dt.year > 2200) continue; // skip 0000:00:00 and junk
    const zoned = dt.hasZone && !dt.inferredZone && dt.tzoffsetMinutes !== undefined;
    const ms = zoned
      ? dt.toDate().getTime()
      : Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond ?? 0);
    if (Number.isFinite(ms)) return { takenAt: new Date(ms).toISOString(), offset: zoned ? dt.tzoffsetMinutes! : 0 };
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value); // "50.0 mm" -> 50
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s && s.toLowerCase() !== 'unknown' ? s : undefined;
}

function coordinate(value: unknown, ref: unknown, negativeRef: 'S' | 'W'): number | undefined {
  const n = num(value);
  if (n === undefined) return undefined;
  const isNegativeRef = typeof ref === 'string' && ref.toUpperCase().startsWith(negativeRef);
  return isNegativeRef && n > 0 ? -n : n;
}

function exposure(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  const n = num(value);
  if (n === undefined || n <= 0) return undefined;
  return n >= 1 ? `${n}` : `1/${Math.round(1 / n)}`;
}

export function exifSummaryFrom(tags: Tags): ExifSummary | undefined {
  const t = tags as Record<string, unknown>;
  const make = str(t.Make);
  let model = str(t.Model);
  // Many cameras repeat the make in the model ("Canon Canon EOS R5").
  if (make && model?.toLowerCase().startsWith(make.toLowerCase())) model = model.slice(make.length).trim() || model;

  const lat = coordinate(t.GPSLatitude, t.GPSLatitudeRef, 'S');
  const lon = coordinate(t.GPSLongitude, t.GPSLongitudeRef, 'W');
  const gps =
    lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)
      ? { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 }
      : undefined;

  const summary: ExifSummary = {
    make,
    model,
    lens: str(t.LensModel) ?? str(t.LensID) ?? str(t.Lens),
    focalLength: num(t.FocalLength),
    fNumber: num(t.FNumber),
    exposureTime: exposure(t.ExposureTime),
    iso: num(t.ISO),
    gps,
  };
  const cleaned = Object.fromEntries(Object.entries(summary).filter(([, v]) => v !== undefined));
  return Object.keys(cleaned).length ? (cleaned as ExifSummary) : undefined;
}

/** EXIF Orientation (1-8); 1 when missing or invalid. */
export function orientationFrom(tags: Tags): number {
  const o = num((tags as Record<string, unknown>).Orientation);
  return o && o >= 1 && o <= 8 ? Math.round(o) : 1;
}
