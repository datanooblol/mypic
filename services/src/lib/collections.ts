import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, type MediaView, type Page } from '@mypic/shared';
import { cdnUrlsFor } from './cdn';
import { decodeCursor, encodeCursor } from './cursor';
import { batchGetAll, doc, tableName } from './ddb';
import { toView, type MediaRecord } from './media';

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 100;

export function pageLimit(raw: string | undefined): number {
  return Math.min(Math.max(Number(raw) || DEFAULT_LIMIT, 1), MAX_LIMIT);
}

/**
 * One page of an album's or tag's items, newest first. Membership records give the
 * order; media records come from BatchGet. Trashed items are skipped (so a page can
 * be shorter than the limit while a cursor still follows).
 */
export async function listMembers(
  userId: string,
  membershipPk: string,
  qs: Record<string, string | undefined>,
): Promise<Page<MediaView>> {
  const res = await doc.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': membershipPk },
      ScanIndexForward: false,
      Limit: pageLimit(qs.limit),
      ExclusiveStartKey: decodeCursor(qs.cursor, { attr: 'pk', value: membershipPk }),
    }),
  );
  const ids = ((res.Items ?? []) as { mediaId: string }[]).map((i) => i.mediaId);
  const [records, url] = await Promise.all([
    batchGetAll<MediaRecord>(ids.map((id) => ({ pk: ddb.user(userId), sk: ddb.media(id) }))),
    cdnUrlsFor(userId),
  ]);
  const byId = new Map(records.map((r) => [r.mediaId, r]));
  const items = ids
    .map((id) => byId.get(id))
    .filter((r): r is MediaRecord => !!r && !r.deletedAt)
    .map((r) => toView(r, url));
  return { items, cursor: encodeCursor(res.LastEvaluatedKey) };
}
