import type { MediaView } from '@mypic/shared';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

/**
 * The camera's local time as a Date whose UTC fields hold that wall-clock time.
 * Always format it with timeZone: 'UTC', so every viewer sees the time the photo was taken.
 */
export function cameraTime(media: Pick<MediaView, 'takenAt' | 'takenAtOffset'>): Date {
  const instant = Date.parse(media.takenAt);
  // Older items have no offset: fall back to the viewer's own time zone.
  const offset = media.takenAtOffset ?? -new Date(instant).getTimezoneOffset();
  return new Date(instant + offset * 60_000);
}

const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' });

export function monthKey(media: MediaView): string {
  const d = cameraTime(media);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}

export function monthLabel(media: MediaView): string {
  return monthFormat.format(cameraTime(media));
}

export function formatTaken(media: MediaView): string {
  return fullFormat.format(cameraTime(media));
}

export function formatOffset(minutes: number | undefined): string | undefined {
  if (minutes === undefined) return undefined;
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
