/**
 * Re-run processing for existing media, e.g. items uploaded before the processor
 * existed, or after changing thumbnail settings.
 *
 * Usage: npm run reprocess -w infra -- <dev|prod> [--all] [--dry-run]
 *   default: items with status PROCESSING or FAILED
 *   --all:   every item (except in-progress uploads)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, paginateScan } from '@aws-sdk/lib-dynamodb';

async function main() {
  const stage = process.argv[2];
  const all = process.argv.includes('--all');
  const dryRun = process.argv.includes('--dry-run');
  if (stage !== 'dev' && stage !== 'prod') throw new Error('Usage: reprocess.ts <dev|prod> [--all] [--dry-run]');

  const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
  const region = cdkJson.context?.region as string;
  const prefix = `MyPic-${stage}`;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const lambda = new LambdaClient({ region });

  const statuses = all ? ['PROCESSING', 'FAILED', 'READY'] : ['PROCESSING', 'FAILED'];
  let count = 0;
  for await (const page of paginateScan(
    { client: doc },
    {
      TableName: `${prefix}-main`,
      FilterExpression: 'begins_with(sk, :media) AND #status IN (:s0, :s1, :s2)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':media': 'MEDIA#', ':s0': statuses[0], ':s1': statuses[1], ':s2': statuses[2] ?? statuses[0] },
      ProjectionExpression: 'userId, mediaId, filename, #status',
    },
  )) {
    for (const item of page.Items ?? []) {
      count++;
      console.log(`${dryRun ? '[dry-run] ' : ''}${item.status}\t${item.filename}`);
      if (!dryRun) {
        await lambda.send(
          new InvokeCommand({
            FunctionName: `${prefix}-processing`,
            InvocationType: 'Event',
            Payload: Buffer.from(JSON.stringify({ userId: item.userId, mediaId: item.mediaId })),
          }),
        );
      }
    }
  }
  console.log(`${dryRun ? 'Would queue' : 'Queued'} ${count} item(s) for processing.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
