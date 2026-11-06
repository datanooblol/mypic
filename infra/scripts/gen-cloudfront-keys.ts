/**
 * Generate the RSA key pair CloudFront uses to verify signed URLs.
 *   - public key  -> infra/keys/{stage}-public.pem   (gitignored, read by StorageStack at synth)
 *   - private key -> SSM SecureString /mypic/{stage}/cloudfront/private-key (never on disk)
 *
 * Usage: npm run keys:dev            (from repo root)
 *        npm run keys -w infra -- prod [--force]
 */
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';

function regionFromCdkJson(): string {
  const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
  const region = cdkJson.context?.region as string | undefined;
  if (!region) throw new Error('Set "region" in infra/cdk.json context');
  return region;
}

async function parameterExists(ssm: SSMClient, name: string): Promise<boolean> {
  try {
    await ssm.send(new GetParameterCommand({ Name: name }));
    return true;
  } catch (err) {
    if (err instanceof ParameterNotFound) return false;
    throw err;
  }
}

async function main() {
  const stage = process.argv[2];
  const force = process.argv.includes('--force');
  if (stage !== 'dev' && stage !== 'prod') {
    throw new Error('Usage: gen-cloudfront-keys.ts <dev|prod> [--force]');
  }

  const region = regionFromCdkJson();
  const ssm = new SSMClient({ region });
  const name = `/mypic/${stage}/cloudfront/private-key`;
  const publicPath = path.join(__dirname, '..', 'keys', `${stage}-public.pem`);

  if (fs.existsSync(publicPath) && !force) {
    if (await parameterExists(ssm, name)) {
      console.log(`Key pair already set up (${publicPath} + SSM ${name}). Use --force to rotate.`);
      return;
    }
    throw new Error(
      `${publicPath} exists but SSM ${name} was not found in ${region}. ` +
        'The public key does not match this account. Re-run with --force to create a new pair.',
    );
  }

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048, // CloudFront requires RSA 2048
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  await ssm.send(
    new PutParameterCommand({
      Name: name,
      Value: privateKey,
      Type: 'SecureString',
      Overwrite: true,
      Description: `mypic ${stage} CloudFront URL signing private key`,
    }),
  );

  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  fs.writeFileSync(publicPath, publicKey);
  console.log(`Stored private key in SSM (${region}): ${name}`);
  console.log(`Wrote public key: ${publicPath}`);
  if (force) console.log('Redeploy the Storage stack so CloudFront trusts the new key.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
