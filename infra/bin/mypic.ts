#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { ApiStack } from '../lib/stacks/api-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { BudgetStack } from '../lib/stacks/budget-stack';
import { StorageStack } from '../lib/stacks/storage-stack';

const app = new App();
const config = loadConfig(app);
const env = { account: config.account, region: config.region };

// Per-stage stacks
const auth = new AuthStack(app, `${config.prefix}-Auth`, { env, config });
const storage = new StorageStack(app, `${config.prefix}-Storage`, { env, config });
const api = new ApiStack(app, `${config.prefix}-Api`, {
  env,
  config,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  table: storage.table,
  bucket: storage.bucket,
});
// Coming next: ProcessingStack (M3), OpsStack alarms (M7)

// Account-wide stack (deployed once, independent of stage)
const alertEmail = app.node.tryGetContext('alertEmail') as string | undefined;
if (alertEmail) {
  new BudgetStack(app, 'MyPic-Budget', { env, alertEmail, monthlyLimitUsd: config.budgetUsd });
}

for (const stack of [auth, storage, api]) {
  Tags.of(stack).add('app', 'mypic');
  Tags.of(stack).add('stage', config.stage);
}
