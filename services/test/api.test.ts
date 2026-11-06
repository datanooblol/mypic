import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { handler } from '../src/api/index';
import { encodeCursor } from '../src/lib/cursor';
import type { AuthedEvent } from '../src/lib/http';
import { attachmentDisposition, detectMediaType } from '../src/lib/media';

process.env.TABLE_NAME = 'table';
process.env.BUCKET_NAME = 'bucket';
process.env.AWS_REGION = 'ap-southeast-1';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

function event(routeKey: string, opts: Partial<AuthedEvent> & { json?: unknown; sub?: string } = {}) {
  const { json: body, sub = 'user-1', ...rest } = opts;
  return {
    routeKey,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub, email: 'a@b.c' }, scopes: [] } } },
    ...rest,
  } as unknown as AuthedEvent;
}

const parse = (res: unknown) => JSON.parse((res as { body: string }).body);
const status = (res: unknown) => (res as { statusCode: number }).statusCode;

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
});

describe('detectMediaType', () => {
  it('classifies RAW by extension even when MIME is generic', () => {
    expect(detectMediaType('IMG_0001.CR3', 'application/octet-stream')).toBe('raw');
    expect(detectMediaType('a.dng', '')).toBe('raw');
  });
  it('classifies images and videos', () => {
    expect(detectMediaType('a.HEIC', '')).toBe('image');
    expect(detectMediaType('clip.mov', 'video/quicktime')).toBe('video');
    expect(detectMediaType('x', 'image/jpeg')).toBe('image');
  });
  it('rejects other files', () => {
    expect(detectMediaType('notes.pdf', 'application/pdf')).toBeUndefined();
  });
});

describe('attachmentDisposition', () => {
  it('encodes non-ASCII filenames', () => {
    expect(attachmentDisposition('ภาพ.jpg')).toBe(
      `attachment; filename="___.jpg"; filename*=UTF-8''%E0%B8%A0%E0%B8%B2%E0%B8%9E.jpg`,
    );
  });
});

describe('router', () => {
  it('returns 404 for unknown routes', async () => {
    expect(status(await handler(event('GET /nope')))).toBe(404);
  });
  it('returns 401 without a sub claim', async () => {
    expect(status(await handler(event('GET /me', { sub: '' })))).toBe(401);
  });
  it('GET /me returns the caller', async () => {
    expect(parse(await handler(event('GET /me')))).toEqual({ userId: 'user-1', email: 'a@b.c' });
  });
});

describe('POST /uploads', () => {
  it('uses a single presigned PUT for small files, without checksum params', async () => {
    ddbMock.on(PutCommand).resolves({});
    const res = await handler(
      event('POST /uploads', { json: { filename: 'a.jpg', size: 1000, mime: 'image/jpeg' } }),
    );
    expect(status(res)).toBe(201);
    const body = parse(res);
    expect(body.mode).toBe('single');
    expect(body.headers).toEqual({ 'content-type': 'image/jpeg' });
    expect(body.url).toContain('/originals/user-1/');
    expect(body.url).toContain('x-amz-storage-class=INTELLIGENT_TIERING');
    expect(body.url).not.toMatch(/checksum/i);

    const item = ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(item).toMatchObject({ pk: 'USER#user-1', status: 'UPLOADING', type: 'image' });
    expect(item.gsi1pk).toBeUndefined(); // not in the timeline until completed
    expect(item.ttl).toBeGreaterThan(0);
  });

  it('starts a multipart upload for large files', async () => {
    ddbMock.on(PutCommand).resolves({});
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'up-1' });
    const size = 40 * 1024 ** 2;
    const res = await handler(
      event('POST /uploads', { json: { filename: 'big.CR3', size, mime: '' } }),
    );
    expect(parse(res)).toMatchObject({ mode: 'multipart', partCount: 3 });
    const item = ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(item).toMatchObject({ uploadId: 'up-1', partCount: 3, type: 'raw' });
  });

  it('rejects unsupported and oversized files', async () => {
    expect(
      status(await handler(event('POST /uploads', { json: { filename: 'a.pdf', size: 1, mime: 'application/pdf' } }))),
    ).toBe(415);
    expect(
      status(await handler(event('POST /uploads', { json: { filename: 'a.jpg', size: 6 * 1024 ** 3, mime: '' } }))),
    ).toBe(400);
  });
});

describe('POST /uploads/{mediaId}/complete', () => {
  const uploading = {
    pk: 'USER#user-1',
    sk: 'MEDIA#m1',
    mediaId: 'm1',
    status: 'UPLOADING',
    size: 100,
    s3Key: 'originals/user-1/m1/a.jpg',
    takenAt: '2024-05-01T00:00:00.000Z',
  };

  it('verifies size and adds the item to the timeline', async () => {
    ddbMock.on(GetCommand).resolves({ Item: uploading });
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 100 });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...uploading, status: 'PROCESSING' } });

    const res = await handler(event('POST /uploads/{mediaId}/complete', { pathParameters: { mediaId: 'm1' } }));
    expect(status(res)).toBe(200);
    expect(parse(res).pk).toBeUndefined(); // internal fields stripped
    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':g1pk': 'USER#user-1',
      ':g1sk': 'TAKEN#2024-05-01T00:00:00.000Z#m1',
    });
  });

  it('completes multipart uploads with sorted parts', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...uploading, uploadId: 'up-1', partCount: 2 } });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 100 });
    ddbMock.on(UpdateCommand).resolves({ Attributes: uploading });

    await handler(
      event('POST /uploads/{mediaId}/complete', {
        pathParameters: { mediaId: 'm1' },
        json: { parts: [{ partNumber: 2, etag: '"b"' }, { partNumber: 1, etag: '"a"' }] },
      }),
    );
    const parts = s3Mock.commandCalls(CompleteMultipartUploadCommand)[0]!.args[0].input.MultipartUpload!.Parts;
    expect(parts).toEqual([{ PartNumber: 1, ETag: '"a"' }, { PartNumber: 2, ETag: '"b"' }]);
  });

  it('rejects a size mismatch', async () => {
    ddbMock.on(GetCommand).resolves({ Item: uploading });
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 99 });
    const res = await handler(event('POST /uploads/{mediaId}/complete', { pathParameters: { mediaId: 'm1' } }));
    expect(status(res)).toBe(409);
  });

  it('returns 409 when completed twice concurrently', async () => {
    ddbMock.on(GetCommand).resolves({ Item: uploading });
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 100 });
    ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    const res = await handler(event('POST /uploads/{mediaId}/complete', { pathParameters: { mediaId: 'm1' } }));
    expect(status(res)).toBe(409);
  });

  it('returns 404 for another user\'s upload', async () => {
    ddbMock.on(GetCommand).resolves({});
    const res = await handler(
      event('POST /uploads/{mediaId}/complete', { pathParameters: { mediaId: 'm1' }, sub: 'user-2' }),
    );
    expect(status(res)).toBe(404);
    expect(ddbMock.commandCalls(GetCommand)[0]!.args[0].input.Key).toEqual({ pk: 'USER#user-2', sk: 'MEDIA#m1' });
  });
});

describe('GET /media', () => {
  it('queries the caller\'s timeline newest-first and returns a cursor', async () => {
    const last = { pk: 'USER#user-1', sk: 'MEDIA#m1', gsi1pk: 'USER#user-1', gsi1sk: 'TAKEN#x#m1' };
    ddbMock.on(QueryCommand).resolves({ Items: [{ ...last, mediaId: 'm1' }], LastEvaluatedKey: last });
    const res = await handler(event('GET /media', { queryStringParameters: { limit: '500' } }));
    const body = parse(res);
    expect(body.items).toEqual([{ mediaId: 'm1' }]);
    expect(body.cursor).toBe(encodeCursor(last));
    const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ IndexName: 'GSI1', ScanIndexForward: false, Limit: 100 });
  });

  it('rejects a cursor for another user\'s partition', async () => {
    const cursor = encodeCursor({ gsi1pk: 'USER#someone-else', gsi1sk: 'x', pk: 'x', sk: 'x' });
    const res = await handler(event('GET /media', { queryStringParameters: { cursor } }));
    expect(status(res)).toBe(400);
  });
});
