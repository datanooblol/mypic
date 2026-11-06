import type { App } from 'aws-cdk-lib';

export type Stage = 'dev' | 'prod';

export interface StageConfig {
  stage: Stage;
  /** Prefix for stack and resource names, e.g. "MyPic-dev". */
  prefix: string;
  account?: string;
  region: string;
  /** Origins allowed to upload to S3 directly (CORS). */
  webOrigins: string[];
  /** Keep data when stacks are deleted. */
  retainData: boolean;
  /** Monthly cost budget for the account-wide BudgetStack. */
  budgetUsd: number;
}

const LOCAL_ORIGIN = 'http://localhost:3000';
// Amplify default domains look like https://<branch>.<appId>.amplifyapp.com
const AMPLIFY_ORIGIN = 'https://*.amplifyapp.com';

export function loadConfig(app: App): StageConfig {
  const stage = (app.node.tryGetContext('stage') ?? 'dev') as string;
  if (stage !== 'dev' && stage !== 'prod') {
    throw new Error(`Unknown stage "${stage}". Use -c stage=dev|prod`);
  }
  // Defaults live in infra/cdk.json "context"; override with -c region=... etc.
  const region = app.node.tryGetContext('region') as string | undefined;
  if (!region) throw new Error('Set "region" in infra/cdk.json context (or pass -c region=...)');
  return {
    stage,
    prefix: `MyPic-${stage}`,
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
    webOrigins: stage === 'dev' ? [LOCAL_ORIGIN, AMPLIFY_ORIGIN] : [AMPLIFY_ORIGIN],
    retainData: stage === 'prod',
    budgetUsd: Number(app.node.tryGetContext('budgetUsd') ?? 10),
  };
}
