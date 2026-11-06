import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { Duration, Size, Stack, type StackProps } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsDestination } from 'aws-cdk-lib/aws-lambda-destinations';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { StageConfig } from '../config';

export interface ProcessingStackProps extends StackProps {
  config: StageConfig;
  table: dynamodb.ITableV2;
  bucket: s3.IBucket;
}

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const CONTEXT_DIR = path.join(REPO_ROOT, 'services', 'processing');
/** Native/WASM modules installed inside the image instead of bundled. */
const RUNTIME_EXTERNALS = ['sharp', 'exiftool-vendored', 'heic-decode'];

/** Thumbnail/EXIF processing Lambda (container image: sharp + ExifTool + libheif). */
export class ProcessingStack extends Stack {
  readonly fn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Bundle the handler and its pure-JS deps into the Docker build context.
    buildSync({
      entryPoints: [path.join(REPO_ROOT, 'services', 'src', 'processing', 'index.ts')],
      outfile: path.join(CONTEXT_DIR, 'dist', 'index.js'),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      sourcemap: true,
      external: RUNTIME_EXTERNALS,
      logLevel: 'warning',
    });

    const dlq = new sqs.Queue(this, 'ProcessingDlq', {
      queueName: `${config.prefix}-processing-dlq`,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const fn = new lambda.DockerImageFunction(this, 'ProcessingFn', {
      functionName: `${config.prefix}-processing`,
      code: lambda.DockerImageCode.fromImageAsset(CONTEXT_DIR, { platform: Platform.LINUX_AMD64 }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 2048,
      timeout: Duration.minutes(5),
      ephemeralStorageSize: Size.gibibytes(4),
      // Cap parallel work (and cost) during bulk uploads; extra invocations queue.
      reservedConcurrentExecutions: 10,
      retryAttempts: 2,
      maxEventAge: Duration.hours(6),
      onFailure: new SqsDestination(dlq),
      environment: {
        TABLE_NAME: props.table.tableName,
        BUCKET_NAME: props.bucket.bucketName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: new logs.LogGroup(this, 'ProcessingFnLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
      }),
    });

    props.table.grantReadWriteData(fn);
    props.bucket.grantRead(fn, 'originals/*');
    props.bucket.grantPut(fn, 'derived/*');

    this.fn = fn;
  }
}
