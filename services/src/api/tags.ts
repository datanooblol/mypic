import { paginateQuery } from '@aws-sdk/lib-dynamodb';
import { ddb, normalizeTag, type TagSummary } from '@mypic/shared';
import { listMembers } from '../lib/collections';
import { doc, tableName } from '../lib/ddb';
import { HttpError, json, pathParam, userIdOf, type AuthedEvent } from '../lib/http';

/** GET /tags: tags in use, most used first. */
export async function listTags(event: AuthedEvent) {
  const userId = userIdOf(event);
  const tags: TagSummary[] = [];
  for await (const page of paginateQuery(
    { client: doc },
    {
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': ddb.user(userId), ':prefix': 'TAG#' },
    },
  )) {
    for (const item of page.Items ?? []) {
      if ((item.count as number) > 0) tags.push({ tag: item.tag as string, count: item.count as number });
    }
  }
  tags.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return json(200, { items: tags });
}

/** GET /tags/{tag}/items */
export async function listTagItems(event: AuthedEvent) {
  const userId = userIdOf(event);
  let raw = pathParam(event, 'tag');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // already decoded
  }
  const tag = normalizeTag(raw);
  if (!tag) throw new HttpError(400, 'Invalid tag');
  return json(200, await listMembers(userId, ddb.tagItemsPk(userId, tag), event.queryStringParameters ?? {}));
}
