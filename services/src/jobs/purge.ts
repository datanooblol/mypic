/**
 * Purge job.
 *   - { userId }          "Empty trash": purge everything in that user's trash.
 *   - scheduled (daily)   purge every item trashed more than TRASH_RETENTION_DAYS ago.
 */
import { paginateQuery, paginateScan } from '@aws-sdk/lib-dynamodb';
import { TRASH_RETENTION_DAYS, ddb } from '@mypic/shared';
import { doc, mapLimit, tableName } from '../lib/ddb';
import type { MediaRecord } from '../lib/media';
import { purgeMedia } from '../lib/trash';

type PurgeEvent = { userId?: string };

export async function handler(event: PurgeEvent): Promise<{ purged: number; failed: number }> {
  const records: MediaRecord[] = [];

  if (event.userId) {
    for await (const page of paginateQuery(
      { client: doc },
      {
        TableName: tableName(),
        IndexName: 'GSI2',
        KeyConditionExpression: 'gsi2pk = :pk',
        ExpressionAttributeValues: { ':pk': ddb.trashPk(event.userId) },
      },
    )) {
      records.push(...((page.Items ?? []) as MediaRecord[]));
    }
  } else {
    // Personal-scale table: a filtered scan once a day is cheap and needs no extra index.
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    for await (const page of paginateScan(
      { client: doc },
      {
        TableName: tableName(),
        FilterExpression: 'begins_with(sk, :media) AND deletedAt < :cutoff',
        ExpressionAttributeValues: { ':media': 'MEDIA#', ':cutoff': cutoff },
      },
    )) {
      records.push(...((page.Items ?? []) as MediaRecord[]));
    }
  }

  let purged = 0;
  let failed = 0;
  await mapLimit(records, 5, async (record) => {
    try {
      if (await purgeMedia(record)) purged++;
    } catch (err) {
      failed++;
      console.error(JSON.stringify({ msg: 'purge failed', mediaId: record.mediaId, error: String(err) }));
    }
  });
  console.log(JSON.stringify({ msg: 'purge done', mode: event.userId ? 'empty-trash' : 'scheduled', purged, failed }));
  if (failed) throw new Error(`${failed} item(s) failed to purge`); // surfaces in Lambda error metrics
  return { purged, failed };
}
