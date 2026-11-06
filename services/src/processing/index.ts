/**
 * Processing Lambda (container image). Invoked asynchronously by the API after an
 * upload completes, or on "reprocess". Reads EXIF, renders thumb + preview WebP,
 * and marks the item READY (or FAILED with a reason).
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, extensionOf, s3Keys, type DerivedKind, type ExifSummary } from '@mypic/shared';
import { ExifTool, type Tags } from 'exiftool-vendored';
import { doc, tableName } from '../lib/ddb';
import type { MediaRecord, ProcessRequest } from '../lib/media';
import { bucketName, s3 } from '../lib/s3';
import { exifSummaryFrom, orientationFrom, takenAtFrom } from './exif';
import { render } from './image';

/** Larger images than this are not processed (ephemeral storage is 4 GB). */
const MAX_PROCESS_BYTES = 2 * 1024 ** 3;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

// One long-lived exiftool process per container, reused across invocations.
const exiftool = new ExifTool({ maxProcs: 1, taskTimeoutMillis: 60_000 });

const log = (msg: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...data }));

export async function handler(event: ProcessRequest): Promise<void> {
  const { userId, mediaId } = event;
  if (!userId || !mediaId) throw new Error('userId and mediaId are required');

  const res = await doc.send(
    new GetCommand({ TableName: tableName(), Key: { pk: ddb.user(userId), sk: ddb.media(mediaId) } }),
  );
  const record = res.Item as MediaRecord | undefined;
  if (!record || record.status === 'UPLOADING') {
    log('skip', { mediaId, reason: record ? 'still uploading' : 'not found' });
    return;
  }

  if (record.type === 'video') {
    // Transcoding (poster frame + MP4) comes later; the original is downloadable.
    await markReady(record, { derived: [] });
    log('video: marked ready without derivatives', { mediaId });
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'mypic-'));
  const started = Date.now();
  try {
    if (record.size > MAX_PROCESS_BYTES) throw new Error('File is too large to generate previews');

    const ext = extensionOf(record.filename);
    const original = join(dir, `original.${ext || 'bin'}`);
    const body = (await s3.send(new GetObjectCommand({ Bucket: bucketName(), Key: record.s3Key }))).Body;
    if (!body) throw new Error('Original is empty');
    await pipeline(body as Readable, createWriteStream(original));

    const tags: Tags = await exiftool.read(original).catch((err) => {
      log('exif read failed', { mediaId, error: String(err) });
      return {} as Tags;
    });

    const rendered =
      record.type === 'raw'
        ? await render(await extractRawPreview(original, dir), {
            ext: 'jpg',
            fallbackOrientation: orientationFrom(tags),
          })
        : await render(original, { ext });

    const derived: DerivedKind[] = ['thumb.webp', 'preview.webp'];
    await Promise.all([
      putDerived(userId, mediaId, 'thumb.webp', rendered.thumb),
      putDerived(userId, mediaId, 'preview.webp', rendered.preview),
    ]);

    await markReady(record, {
      derived,
      ...takenAtFrom(tags),
      exif: exifSummaryFrom(tags),
      width: rendered.width,
      height: rendered.height,
    });
    log('processed', { mediaId, type: record.type, ms: Date.now() - started });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('processing failed', { mediaId, error: message, stack: (err as Error)?.stack });
    await markFailed(record, message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** RAW: pick the largest embedded JPEG (JpgFromRaw is usually full size, PreviewImage smaller). */
async function extractRawPreview(original: string, dir: string): Promise<string> {
  const candidates: { path: string; size: number }[] = [];
  const attempts: [string, (src: string, dest: string) => Promise<void>][] = [
    ['jpgfromraw.jpg', (s, d) => exiftool.extractJpgFromRaw(s, d)],
    ['preview.jpg', (s, d) => exiftool.extractPreview(s, d)],
  ];
  for (const [name, extract] of attempts) {
    const dest = join(dir, name);
    try {
      await extract(original, dest);
      const { size } = await stat(dest);
      if (size > 0) candidates.push({ path: dest, size });
    } catch {
      // tag not present in this RAW format
    }
  }
  const best = candidates.sort((a, b) => b.size - a.size)[0];
  if (!best) throw new Error('No embedded preview found in RAW file');
  return best.path;
}

async function putDerived(userId: string, mediaId: string, kind: DerivedKind, body: Buffer) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: s3Keys.derived(userId, mediaId, kind),
      Body: body,
      ContentType: kind.endsWith('.webp') ? 'image/webp' : kind.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg',
      CacheControl: CACHE_CONTROL,
    }),
  );
}

interface ReadyUpdate {
  derived: DerivedKind[];
  takenAt?: string;
  offset?: number;
  exif?: ExifSummary;
  width?: number;
  height?: number;
}

async function markReady(record: MediaRecord, update: ReadyUpdate) {
  const takenAt = update.takenAt ?? record.takenAt;
  const set: Record<string, unknown> = {
    status: 'READY',
    derived: update.derived,
    takenAt,
    processedAt: new Date().toISOString(),
  };
  if (update.takenAt) set.takenAtOffset = update.offset ?? 0;
  if (update.exif) set.exif = update.exif;
  if (update.width && update.height) {
    set.width = update.width;
    set.height = update.height;
  }
  // Keep the timeline sort key in sync with the real date taken (only while not in trash).
  if (record.gsi1pk) set.gsi1sk = ddb.timelineSk(takenAt, record.mediaId);

  const names: Record<string, string> = { '#error': 'error' };
  const values: Record<string, unknown> = {};
  const assignments = Object.entries(set).map(([key, value], i) => {
    names[`#k${i}`] = key;
    values[`:v${i}`] = value;
    return `#k${i} = :v${i}`;
  });
  await doc.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: record.pk, sk: record.sk },
      ConditionExpression: 'attribute_exists(pk)',
      UpdateExpression: `SET ${assignments.join(', ')} REMOVE #error`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

async function markFailed(record: MediaRecord, message: string) {
  await doc.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: record.pk, sk: record.sk },
      ConditionExpression: 'attribute_exists(pk)',
      UpdateExpression: 'SET #status = :failed, #error = :error, processedAt = :now',
      ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
      ExpressionAttributeValues: {
        ':failed': 'FAILED',
        ':error': message.slice(0, 300),
        ':now': new Date().toISOString(),
      },
    }),
  );
}
