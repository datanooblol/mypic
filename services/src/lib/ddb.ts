import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  type BatchWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';

/** Shared DocumentClient (reused across warm invocations). */
export const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export function tableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) throw new Error('TABLE_NAME is not set');
  return name;
}

export type Key = { pk: string; sk: string };

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** BatchGet any number of keys (100 per request), retrying unprocessed keys. */
export async function batchGetAll<T>(keys: Key[]): Promise<T[]> {
  const table = tableName();
  const out: T[] = [];
  for (const group of chunk(keys, 100)) {
    let pending: Key[] = group;
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt > 0) await sleep(Math.min(1000, 50 * 2 ** attempt));
      const res = await doc.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: pending } } }));
      out.push(...((res.Responses?.[table] as T[] | undefined) ?? []));
      pending = (res.UnprocessedKeys?.[table]?.Keys as Key[] | undefined) ?? [];
      if (attempt > 8 && pending.length) throw new Error('BatchGet: too many unprocessed keys');
    }
  }
  return out;
}

type WriteRequest = NonNullable<BatchWriteCommandInput['RequestItems']>[string][number];

/** BatchWrite any number of puts/deletes (25 per request), retrying unprocessed items. */
export async function batchWriteAll(requests: WriteRequest[]): Promise<void> {
  const table = tableName();
  for (const group of chunk(requests, 25)) {
    let pending = group;
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt > 0) await sleep(Math.min(1000, 50 * 2 ** attempt));
      const res = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
      pending = (res.UnprocessedItems?.[table] as WriteRequest[] | undefined) ?? [];
      if (attempt > 8 && pending.length) throw new Error('BatchWrite: too many unprocessed items');
    }
  }
}
