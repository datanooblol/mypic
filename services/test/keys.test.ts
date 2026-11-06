import { describe, expect, it } from 'vitest';
import { ddb, s3Keys, sanitizeFilename } from '@mypic/shared';

describe('sanitizeFilename', () => {
  it('strips directories and unsafe characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\photos\\IMG 001.CR3')).toBe('IMG 001.CR3');
    expect(sanitizeFilename('a<b>?.jpg')).toBe('a_b__.jpg');
  });

  it('never returns empty', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('/')).toBe('file');
  });
});

describe('keys', () => {
  it('scopes S3 keys by user', () => {
    expect(s3Keys.original('u1', 'm1', 'a.jpg')).toBe('originals/u1/m1/a.jpg');
    expect(s3Keys.derived('u1', 'm1', 'thumb.webp')).toBe('derived/u1/m1/thumb.webp');
    expect(s3Keys.cdnPath('u1', 'm1', 'thumb.webp')).toBe('/u1/m1/thumb.webp');
  });

  it('builds sortable timeline keys', () => {
    const a = ddb.timelineSk('2024-01-01T00:00:00Z', 'A');
    const b = ddb.timelineSk('2025-01-01T00:00:00Z', 'B');
    expect(a < b).toBe(true);
  });
});
