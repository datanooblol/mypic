import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { s3Keys, type DerivedKind } from '@mypic/shared';

/**
 * CloudFront signed URLs for derived files.
 *
 * One custom policy per user covers https://{cdn}/{userId}/*, so every URL in a
 * response shares the same signature. The expiry is rounded up to a fixed window,
 * which keeps URLs identical across requests (browser cache hits) while still
 * expiring: a URL is valid for between WINDOW and 2 * WINDOW.
 */
export const SIGNING_WINDOW_MS = 6 * 60 * 60 * 1000;

const ssm = new SSMClient({});
let privateKeyPromise: Promise<string> | undefined;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function privateKey(): Promise<string> {
  privateKeyPromise ??= ssm
    .send(new GetParameterCommand({ Name: env('CDN_PRIVATE_KEY_PARAM'), WithDecryption: true }))
    .then((res) => {
      const value = res.Parameter?.Value;
      if (!value) throw new Error('CloudFront private key parameter is empty');
      return value;
    })
    .catch((err) => {
      privateKeyPromise = undefined; // retry on next call
      throw err;
    });
  return privateKeyPromise;
}

export function signingExpiry(now: number): number {
  return (Math.ceil(now / SIGNING_WINDOW_MS) + 1) * SIGNING_WINDOW_MS;
}

export type DerivedUrl = (mediaId: string, kind: DerivedKind) => string;

/** Build a URL factory for one user's derived files. */
export async function cdnUrlsFor(userId: string, now = Date.now()): Promise<DerivedUrl> {
  const domain = env('CDN_DOMAIN');
  const resource = `https://${domain}/${userId}/*`;
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: resource,
        Condition: { DateLessThan: { 'AWS:EpochTime': Math.floor(signingExpiry(now) / 1000) } },
      },
    ],
  });
  const signed = getSignedUrl({
    url: resource,
    keyPairId: env('CDN_KEY_PAIR_ID'),
    privateKey: await privateKey(),
    policy,
  });
  const query = signed.slice(signed.indexOf('?') + 1);
  return (mediaId, kind) => `https://${domain}${s3Keys.cdnPath(userId, mediaId, kind)}?${query}`;
}
