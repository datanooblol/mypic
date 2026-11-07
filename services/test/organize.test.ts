import { generateKeyPairSync } from 'node:crypto';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { normalizeTag } from '@mypic/shared';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../src/api/index';
import { handler as purgeJob } from '../src/jobs/purge';
import type { AuthedEvent } from '../src/lib/http';
import type { MediaRecord } from '../src/lib/media';
import { addToCollection, rekeyMemberships, removeFromCollection } from '../src/lib/membership';
import { purgeMedia, trashMedia } from '../src/lib/trash';

process.env.TABLE_NAME = 'table';
process.env.BUCKET_NAME = 'bucket';
process.env.AWS_REGION = 'ap-southeast-1';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.CDN_DOMAIN = 'cdn.example.net';
process.env.CDN_KEY_PAIR_ID = 'KTEST';
process.env.CDN_PRIVATE_KEY_PARAM = '/p';
process.env.PURGE_FN = 'purge-fn';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const ssmMock = mockClient(SSMClient);
const lambdaMock = mockClient(LambdaClient);

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ssmMock.reset();
  lambdaMock.reset();
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: privateKey } });
  lambdaMock.on(InvokeCommand).resolves({});
});

const record = (over: Partial<MediaRecord> = {}): MediaRecord => ({
  pk: 'USER#u1',
  sk: 'MEDIA#m1',
  mediaId: 'm1',
  userId: 'u1',
  type: 'image',
  status: 'READY',
  filename: 'a.jpg',
  mime: 'image/jpeg',
  size: 10,
  takenAt: '2024-01-01T00:00:00.000Z',
  uploadedAt: '2024-01-02T00:00:00.000Z',
  s3Key: 'originals/u1/m1/a.jpg',
  ...over,
});

function event(routeKey: string, opts: Partial<AuthedEvent> & { json?: unknown } = {}) {
  const { json: body, ...rest } = opts;
  return {
    routeKey,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub: 'u1' }, scopes: [] } } },
    ...rest,
  } as unknown as AuthedEvent;
}
const parse = (res: unknown) => JSON.parse((res as { body: string }).body);
const status = (res: unknown) => (res as { statusCode: number }).statusCode;
const canceled = (codes: string[]) =>
  new TransactionCanceledException({
    message: 'x',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe('normalizeTag', () => {
  it('normalizes case, whitespace and punctuation; keeps other scripts', () => {
    expect(normalizeTag('  Beach   Trip! ')).toBe('beach trip');
    expect(normalizeTag('ทะเล')).toBe('ทะเล');
    expect(normalizeTag('#$%')).toBeUndefined();
    expect(normalizeTag('x'.repeat(41))).toBeUndefined();
  });
});

describe('membership', () => {
  it('adds with one transaction: membership + set + counter (album gets a default cover)', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    expect(await addToCollection(record(), { kind: 'album', albumId: 'a1' })).toBe(true);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items[0]!.Put!.Item).toMatchObject({ pk: 'ALBUM#a1', sk: 'ITEM#2024-01-01T00:00:00.000Z#m1' });
    expect(items[1]!.Update!.ExpressionAttributeValues![':v']).toEqual(new Set(['a1']));
    expect(items[2]!.Update!.Key).toEqual({ pk: 'USER#u1', sk: 'ALBUM#a1' });
    expect(items[2]!.Update!.UpdateExpression).toContain('if_not_exists(coverMediaId');
  });

  it('is idempotent: an existing membership is not an error and not double-counted', async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceled(['ConditionalCheckFailed', 'None', 'None']));
    expect(await addToCollection(record(), { kind: 'tag', tag: 'beach' })).toBe(false);
  });

  it('retries transaction conflicts from parallel batch items, then succeeds', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejectsOnce(canceled(['None', 'None', 'TransactionConflict']))
      .rejectsOnce(canceled(['None', 'None', 'TransactionConflict']))
      .resolves({});
    expect(await addToCollection(record(), { kind: 'tag', tag: 'beach' })).toBe(true);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(3);
  });

  it('reports a missing album and refuses trashed items', async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceled(['None', 'None', 'ConditionalCheckFailed']));
    await expect(addToCollection(record(), { kind: 'album', albumId: 'gone' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(addToCollection(record({ deletedAt: 'x' }), { kind: 'album', albumId: 'a1' })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('converts legacy empty lists before set updates', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});
    await addToCollection(record({ tags: [], albumIds: [] }), { kind: 'tag', tag: 'x' });
    expect(ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input.UpdateExpression).toBe('REMOVE #a0, #a1');
  });

  it('removes a tag and deletes its summary when the count reaches zero', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
    expect(await removeFromCollection(record({ tags: new Set(['beach']) }), { kind: 'tag', tag: 'beach' })).toBe(true);
    const del = ddbMock.commandCalls(DeleteCommand)[0]!.args[0].input;
    expect(del.Key).toEqual({ pk: 'USER#u1', sk: 'TAG#beach' });
    expect(del.ConditionExpression).toBe('#count <= :zero');
  });

  it('re-keys memberships when the date taken changes', async () => {
    ddbMock.on(BatchWriteCommand).resolves({});
    await rekeyMemberships(record({ albumIds: new Set(['a1']), tags: new Set(['t']) }), '2020-05-05T00:00:00.000Z');
    const reqs = ddbMock.commandCalls(BatchWriteCommand)[0]!.args[0].input.RequestItems!.table!;
    expect(reqs).toHaveLength(4);
    expect(reqs[0]!.DeleteRequest!.Key).toEqual({ pk: 'ALBUM#a1', sk: 'ITEM#2024-01-01T00:00:00.000Z#m1' });
    expect(reqs[1]!.PutRequest!.Item).toMatchObject({ pk: 'ALBUM#a1', sk: 'ITEM#2020-05-05T00:00:00.000Z#m1' });
    expect(reqs[2]!.DeleteRequest!.Key!.pk).toBe('USER#u1#TAG#t');
  });
});

describe('trash and purge', () => {
  it('trash moves the item from the timeline index to the trash index and decrements counters', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: record({ deletedAt: 'now' }) });
    ddbMock.on(DeleteCommand).resolves({});
    await trashMedia(record({ albumIds: new Set(['a1']), tags: new Set(['t']) }));
    const calls = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(calls[0]!.UpdateExpression).toContain('REMOVE gsi1pk, gsi1sk');
    expect(calls[0]!.ExpressionAttributeValues![':g2pk']).toBe('USER#u1#TRASH');
    const counters = calls.slice(1).map((c) => [c.Key!.sk, c.ExpressionAttributeValues![':d']]);
    expect(counters).toEqual(expect.arrayContaining([['ALBUM#a1', -1], ['TAG#t', -1]]));
  });

  it('purge deletes the record first, then memberships and every S3 version', async () => {
    const order: string[] = [];
    ddbMock.on(DeleteCommand).callsFake(() => {
      order.push('record');
      return {};
    });
    ddbMock.on(BatchWriteCommand).callsFake(() => {
      order.push('memberships');
      return {};
    });
    s3Mock.on(ListObjectVersionsCommand).callsFake((input: { Prefix: string }) => {
      order.push(`list:${input.Prefix}`);
      return {
        Versions: [{ Key: `${input.Prefix}x`, VersionId: 'v1' }],
        DeleteMarkers: [{ Key: `${input.Prefix}x`, VersionId: 'dm' }],
      };
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});
    expect(await purgeMedia(record({ deletedAt: 'x', albumIds: new Set(['a1']) }))).toBe(true);
    expect(order).toEqual(['record', 'memberships', 'list:originals/u1/m1/', 'list:derived/u1/m1/']);
    const objects = s3Mock.commandCalls(DeleteObjectsCommand)[0]!.args[0].input.Delete!.Objects;
    expect(objects).toEqual([
      { Key: 'originals/u1/m1/x', VersionId: 'v1' },
      { Key: 'originals/u1/m1/x', VersionId: 'dm' },
    ]);
  });

  it('purge does nothing if the item was restored concurrently', async () => {
    ddbMock.on(DeleteCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    expect(await purgeMedia(record({ deletedAt: 'x' }))).toBe(false);
    expect(s3Mock.commandCalls(ListObjectVersionsCommand)).toHaveLength(0);
  });

  it('refuses to purge items that are not in the trash', async () => {
    await expect(purgeMedia(record())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("empty trash purges only the caller's trash index", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [record({ deletedAt: 'x' })] });
    ddbMock.on(DeleteCommand).resolves({});
    s3Mock.on(ListObjectVersionsCommand).resolves({});
    expect(await purgeJob({ userId: 'u1' })).toEqual({ purged: 1, failed: 0 });
    expect(ddbMock.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({
      ':pk': 'USER#u1#TRASH',
    });
  });
});

describe('API', () => {
  it('batch reports per-item results and validates input', async () => {
    ddbMock.on(GetCommand, { Key: { pk: 'USER#u1', sk: 'MEDIA#m1' } }).resolves({ Item: record() });
    ddbMock.on(GetCommand, { Key: { pk: 'USER#u1', sk: 'MEDIA#nope' } }).resolves({});
    ddbMock.on(TransactWriteCommand).resolves({});
    const res = parse(
      await handler(event('POST /media/batch', { json: { action: 'addTags', mediaIds: ['m1', 'nope'], tags: ['Beach'] } })),
    );
    expect(res).toEqual({ succeeded: ['m1'], failed: [{ mediaId: 'nope', message: 'Not found' }] });
    const tagItem = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems![0]!.Put!.Item;
    expect(tagItem!.pk).toBe('USER#u1#TAG#beach');

    const bad = await handler(event('POST /media/batch', { json: { action: 'addTags', mediaIds: ['m1'], tags: ['!!!'] } }));
    expect(status(bad)).toBe(400);
    const missingAlbum = await handler(event('POST /media/batch', { json: { action: 'addToAlbum', mediaIds: ['m1'] } }));
    expect(status(missingAlbum)).toBe(400);
  });

  it('album items require owning the album', async () => {
    ddbMock.on(GetCommand).resolves({});
    const res = await handler(event('GET /albums/{albumId}/items', { pathParameters: { albumId: 'someone-elses' } }));
    expect(status(res)).toBe(404);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('album items skip trashed media and keep membership order', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { albumId: 'a1' } });
    ddbMock.on(QueryCommand).resolves({ Items: [{ mediaId: 'm2' }, { mediaId: 'm1' }, { mediaId: 'm3' }] });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        table: [record({ mediaId: 'm1' }), record({ mediaId: 'm2' }), record({ mediaId: 'm3', deletedAt: 'x' })],
      },
    });
    const body = parse(await handler(event('GET /albums/{albumId}/items', { pathParameters: { albumId: 'a1' } })));
    expect(body.items.map((m: { mediaId: string }) => m.mediaId)).toEqual(['m2', 'm1']);
  });

  it('download selected returns attachment links in request order and reports missing items', async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        table: [
          record({ mediaId: 'm2', filename: 'b.CR3', s3Key: 'originals/u1/m2/b.CR3' }),
          record({ mediaId: 'm1' }),
          record({ mediaId: 'm3', status: 'UPLOADING' }),
        ],
      },
    });
    const res = parse(await handler(event('POST /media/download', { json: { mediaIds: ['m1', 'm2', 'm3', 'm4'] } })));
    expect(res.items.map((i: { mediaId: string }) => i.mediaId)).toEqual(['m1', 'm2']);
    expect(res.failed).toEqual([
      { mediaId: 'm3', message: 'Not found' },
      { mediaId: 'm4', message: 'Not found' },
    ]);
    const url = new URL(res.items[1].url);
    expect(url.pathname).toBe('/originals/u1/m2/b.CR3');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('response-content-disposition')).toContain('filename="b.CR3"');
    // keys are always scoped to the caller
    const keys = ddbMock.commandCalls(BatchGetCommand)[0]!.args[0].input.RequestItems!.table!.Keys!;
    expect(keys.every((k) => k.pk === 'USER#u1')).toBe(true);

    expect(status(await handler(event('POST /media/download', { json: { mediaIds: [] } })))).toBe(400);
  });

  it('empty trash hands off to the purge job', async () => {
    const res = await handler(event('DELETE /trash'));
    expect(status(res)).toBe(202);
    expect(lambdaMock.commandCalls(InvokeCommand)[0]!.args[0].input).toMatchObject({
      FunctionName: 'purge-fn',
      InvocationType: 'Event',
    });
  });

  it('tags list hides zero counts and sorts by use', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ tag: 'a', count: 1 }, { tag: 'b', count: 0 }, { tag: 'c', count: 5 }],
    });
    expect(parse(await handler(event('GET /tags'))).items).toEqual([
      { tag: 'c', count: 5 },
      { tag: 'a', count: 1 },
    ]);
  });
});
