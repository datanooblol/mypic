#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { ApiStack } from '../lib/stacks/api-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { BudgetStack } from '../lib/stacks/budget-stack';
import { ProcessingStack } from '../lib/stacks/processing-stack';
import { StorageStack } from '../lib/stacks/storage-stack';

const app = new App();
const config = loadConfig(app);
const env = { account: config.account, region: config.region };

// Per-stage stacks
const auth = new AuthStack(app, `${config.prefix}-Auth`, { env, config });
const storage = new StorageStack(app, `${config.prefix}-Storage`, { env, config });
const processing = new ProcessingStack(app, `${config.prefix}-Processing`, {
  env,
  config,
  table: storage.table,
  bucket: storage.bucket,
});
const api = new ApiStack(app, `${config.prefix}-Api`, {
  env,
  config,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  table: storage.table,
  bucket: storage.bucket,
  distribution: storage.distribution,
  cdnKeyPairId: storage.cfPublicKey.publicKeyId,
  processingFn: processing.fn,
});
// Coming next: OpsStack alarms (M7)

// Account-wide stack (deployed once, independent of stage)
const alertEmail = app.node.tryGetContext('alertEmail') as string | undefined;
if (alertEmail) {
  new BudgetStack(app, 'MyPic-Budget', { env, alertEmail, monthlyLimitUsd: config.budgetUsd });
}

for (const stack of [auth, storage, processing, api]) {
  Tags.of(stack).add('app', 'mypic');
  Tags.of(stack).add('stage', config.stage);
}
