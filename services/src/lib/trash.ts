/**
 * Trash lifecycle: trash (hide everywhere, keep data) -> restore, or purge (delete
 * the original, derived files and every record). Purge runs on "Delete forever",
 * "Empty trash", and daily for items trashed more than TRASH_RETENTION_DAYS ago.
 */
import { DeleteObjectsCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '@mypic/shared';
import { doc, tableName } from './ddb';
import { HttpError } from './http';
import type { MediaRecord } from './media';
import { adjustCounters, deleteMemberships } from './membership';
import { bucketName, s3 } from './s3';

export async function trashMedia(record: MediaRecord): Promise<MediaRecord> {
  if (record.status === 'UPLOADING') throw new HttpError(409, 'Upload in progress');
  if (record.deletedAt) return record;
  const deletedAt = new Date().toISOString();
  try {
    const res = await doc.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: record.pk, sk: record.sk },
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deletedAt)',
        UpdateExpression: 'SET deletedAt = :d, gsi2pk = :g2pk, gsi2sk = :g2sk REMOVE gsi1pk, gsi1sk',
        ExpressionAttributeValues: {
          ':d': deletedAt,
          ':g2pk': ddb.trashPk(record.userId),
          ':g2sk': ddb.trashSk(deletedAt, record.mediaId),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    await adjustCounters(record, -1);
    return res.Attributes as MediaRecord;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return record; // trashed concurrently
    throw err;
  }
}

export async function restoreMedia(record: MediaRecord): Promise<MediaRecord> {
  if (!record.deletedAt) return record;
  try {
    const res = await doc.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: record.pk, sk: record.sk },
        ConditionExpression: 'attribute_exists(deletedAt)',
        UpdateExpression: 'SET gsi1pk = :g1pk, gsi1sk = :g1sk REMOVE deletedAt, gsi2pk, gsi2sk',
        ExpressionAttributeValues: {
          ':g1pk': ddb.user(record.userId),
          ':g1sk': ddb.timelineSk(record.takenAt, record.mediaId),
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    await adjustCounters(record, 1);
    return res.Attributes as MediaRecord;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return record; // restored concurrently
    throw err;
  }
}

/** Every object version under a prefix (versioning is on, so a plain delete would keep data). */
async function deleteAllVersions(prefix: string): Promise<number> {
  let deleted = 0;
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucketName(),
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
      .filter((v) => v.Key)
      .map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
    if (!objects.length) continue;
    const res = await s3.send(
      new DeleteObjectsCommand({ Bucket: bucketName(), Delete: { Objects: objects, Quiet: true } }),
    );
    if (res.Errors?.length) throw new Error(`S3 delete failed: ${res.Errors[0]?.Code} ${res.Errors[0]?.Key}`);
    deleted += objects.length;
  } while (keyMarker);
  return deleted;
}

/**
 * Permanently delete a trashed item. The record goes first (conditionally), so a
 * concurrent restore wins and nothing is lost; a failure after that can only leave
 * orphaned objects behind, never a record pointing at deleted files.
 */
export async function purgeMedia(record: MediaRecord): Promise<boolean> {
  if (!record.deletedAt) throw new HttpError(409, 'Only items in the trash can be deleted forever');
  try {
    await doc.send(
      new DeleteCommand({
        TableName: tableName(),
        Key: { pk: record.pk, sk: record.sk },
        ConditionExpression: 'attribute_exists(deletedAt)',
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false; // restored meanwhile
    throw err;
  }
  await deleteMemberships(record);
  await deleteAllVersions(record.s3Key.slice(0, record.s3Key.lastIndexOf('/') + 1));
  await deleteAllVersions(`derived/${record.userId}/${record.mediaId}/`);
  return true;
}
