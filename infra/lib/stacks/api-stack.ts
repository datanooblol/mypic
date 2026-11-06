import * as path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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
  [apigw.HttpMethod.GET, '/media/{mediaId}/download'],
];

/** HTTP API + one router Lambda, protected by the Cognito JWT authorizer. */
export class ApiStack extends Stack {
  readonly api: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config } = props;

    const fn = new nodejs.NodejsFunction(this, 'ApiFn', {
      functionName: `${config.prefix}-api`,
      entry: path.join(REPO_ROOT, 'services', 'src', 'api', 'index.ts'),
      handler: 'handler',
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(15),
      environment: {
        TABLE_NAME: props.table.tableName,
        BUCKET_NAME: props.bucket.bucketName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [], // bundle AWS SDK too: pinned versions, faster cold start
      },
      logGroup: new logs.LogGroup(this, 'ApiFnLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
      }),
    });

    props.table.grantReadWriteData(fn);
    // Originals only: upload (incl. multipart), head/get for verify + download, delete for abort.
    props.bucket.grantPut(fn, 'originals/*');
    props.bucket.grantRead(fn, 'originals/*');
    props.bucket.grantDelete(fn, 'originals/*');

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
