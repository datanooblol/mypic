import * as path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { StageConfig } from '../config';

export interface ApiStackProps extends StackProps {
  config: StageConfig;
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  table: dynamodb.ITableV2;
  bucket: s3.IBucket;
  distribution: cloudfront.IDistribution;
  cdnKeyPairId: string;
  processingFn: lambda.IFunction;
}

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

/** Routes served by the API Lambda (must match services/src/api/index.ts). */
const ROUTES: [apigw.HttpMethod, string][] = [
  [apigw.HttpMethod.GET, '/me'],
  [apigw.HttpMethod.POST, '/uploads'],
  [apigw.HttpMethod.POST, '/uploads/{mediaId}/parts'],
  [apigw.HttpMethod.POST, '/uploads/{mediaId}/complete'],
  [apigw.HttpMethod.DELETE, '/uploads/{mediaId}'],
  [apigw.HttpMethod.GET, '/media'],
  [apigw.HttpMethod.GET, '/media/{mediaId}'],
  [apigw.HttpMethod.GET, '/media/{mediaId}/download'],
  [apigw.HttpMethod.POST, '/media/{mediaId}/reprocess'],
  [apigw.HttpMethod.DELETE, '/media/{mediaId}'],
  [apigw.HttpMethod.POST, '/media/{mediaId}/restore'],
  [apigw.HttpMethod.POST, '/media/batch'],
  [apigw.HttpMethod.GET, '/trash'],
  [apigw.HttpMethod.DELETE, '/trash'],
  [apigw.HttpMethod.GET, '/albums'],
  [apigw.HttpMethod.POST, '/albums'],
  [apigw.HttpMethod.GET, '/albums/{albumId}'],
  [apigw.HttpMethod.PATCH, '/albums/{albumId}'],
  [apigw.HttpMethod.DELETE, '/albums/{albumId}'],
  [apigw.HttpMethod.GET, '/albums/{albumId}/items'],
  [apigw.HttpMethod.GET, '/tags'],
  [apigw.HttpMethod.GET, '/tags/{tag}/items'],
];

/** HTTP API + one router Lambda, protected by the Cognito JWT authorizer. */
export class ApiStack extends Stack {
  readonly api: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config } = props;
    const privateKeyParam = `/mypic/${config.stage}/cloudfront/private-key`;

    // Shared settings for the Node.js Lambdas bundled from services/.
    const nodeFn = (id: string, entry: string, overrides: Partial<nodejs.NodejsFunctionProps>) =>
      new nodejs.NodejsFunction(this, id, {
        entry: path.join(REPO_ROOT, 'services', 'src', entry),
        handler: 'handler',
        projectRoot: REPO_ROOT,
        depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        bundling: {
          minify: true,
          sourceMap: true,
          externalModules: [], // bundle AWS SDK too: pinned versions, faster cold start
        },
        logGroup: new logs.LogGroup(this, `${id}Logs`, { retention: logs.RetentionDays.ONE_MONTH }),
        ...overrides,
      });

    // Purge job: daily cleanup of old trash, and "Empty trash" on demand.
    const purgeFn = nodeFn('PurgeFn', 'jobs/purge.ts', {
      functionName: `${config.prefix}-purge`,
      timeout: Duration.minutes(15),
      environment: {
        TABLE_NAME: props.table.tableName,
        BUCKET_NAME: props.bucket.bucketName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    props.table.grantReadWriteData(purgeFn);
    for (const prefix of ['originals/*', 'derived/*']) {
      props.bucket.grantRead(purgeFn, prefix); // includes ListBucketVersions
      props.bucket.grantDelete(purgeFn, prefix); // includes DeleteObjectVersion
    }
    new events.Rule(this, 'DailyPurge', {
      description: 'Purge media trashed more than 30 days ago',
      schedule: events.Schedule.cron({ minute: '0', hour: '19' }), // 02:00 in UTC+7
      targets: [new targets.LambdaFunction(purgeFn, { retryAttempts: 2 })],
    });

    const fn = nodeFn('ApiFn', 'api/index.ts', {
      functionName: `${config.prefix}-api`,
      timeout: Duration.seconds(29), // HTTP API integrations time out at 30 s
      environment: {
        TABLE_NAME: props.table.tableName,
        BUCKET_NAME: props.bucket.bucketName,
        PURGE_FN: purgeFn.functionName,
        CDN_DOMAIN: props.distribution.distributionDomainName,
        CDN_KEY_PAIR_ID: props.cdnKeyPairId,
        CDN_PRIVATE_KEY_PARAM: privateKeyParam,
        PROCESSING_FN: props.processingFn.functionName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    props.table.grantReadWriteData(fn);
    // Originals only: upload (incl. multipart), head/get for verify + download, delete for abort.
    props.bucket.grantPut(fn, 'originals/*');
    props.bucket.grantRead(fn, 'originals/*');
    props.bucket.grantDelete(fn, 'originals/*');
    // "Delete forever" purges derived files and all object versions.
    props.bucket.grantRead(fn, 'derived/*');
    props.bucket.grantDelete(fn, 'derived/*');
    props.processingFn.grantInvoke(fn);
    purgeFn.grantInvoke(fn);
    // CloudFront signing key (SecureString, AWS-managed aws/ssm key).
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: privateKeyParam.slice(1) })],
      }),
    );

    const authorizer = new HttpUserPoolAuthorizer('Cognito', props.userPool, {
      userPoolClients: [props.userPoolClient],
    });

    this.api = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `${config.prefix}-api`,
      // Auth is a bearer token (not cookies), so allowing any origin does not enable CSRF.
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigw.CorsHttpMethod.ANY],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', fn);
    for (const [method, routePath] of ROUTES) {
      this.api.addRoutes({ path: routePath, methods: [method], integration, authorizer });
    }

    // Basic abuse protection for a personal app.
    const stage = this.api.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 50, throttlingBurstLimit: 100 };

    new CfnOutput(this, 'ApiUrl', { value: this.api.apiEndpoint });
  }
}
