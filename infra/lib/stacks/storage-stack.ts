import * as fs from 'node:fs';
import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { StageConfig } from '../config';

export interface StorageStackProps extends StackProps {
  config: StageConfig;
}

/** Media bucket, metadata table, and CloudFront (signed URLs) for derived images. */
export class StorageStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly table: dynamodb.TableV2;
  readonly distribution: cloudfront.Distribution;
  readonly cfPublicKey: cloudfront.PublicKey;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const { config } = props;
    const removalPolicy = config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // ---------- S3 ----------
    this.bucket = new s3.Bucket(this, 'MediaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      eventBridgeEnabled: true, // processing pipeline listens to ObjectCreated
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: config.webOrigins,
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'], // needed to complete multipart uploads
          maxAge: 3600,
        },
      ],
      lifecycleRules: [
        {
          id: 'originals-intelligent-tiering',
          prefix: 'originals/',
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: Duration.days(0),
            },
          ],
        },
        { id: 'expire-zips', prefix: 'zips/', expiration: Duration.days(1) },
        {
          id: 'housekeeping',
          abortIncompleteMultipartUploadAfter: Duration.days(7),
          noncurrentVersionExpiration: Duration.days(30),
          expiredObjectDeleteMarker: true,
        },
      ],
      removalPolicy,
      autoDeleteObjects: !config.retainData,
    });

    // ---------- DynamoDB (single table) ----------
    this.table = new dynamodb.TableV2(this, 'Table', {
      tableName: `${config.prefix}-main`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: config.retainData },
      deletionProtection: config.retainData,
      removalPolicy,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1', // timeline: USER#uid / TAKEN#takenAt#mediaId
          partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
        },
        {
          indexName: 'GSI2', // trash: USER#uid#TRASH / deletedAt#mediaId
          partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    // ---------- CloudFront (derived/ only, signed URLs required) ----------
    const publicKeyPath = path.join(__dirname, '..', '..', 'keys', `${config.stage}-public.pem`);
    if (!fs.existsSync(publicKeyPath)) {
      throw new Error(
        `Missing ${publicKeyPath}. Run "npm run keys:${config.stage}" from the repo root first.`,
      );
    }
    this.cfPublicKey = new cloudfront.PublicKey(this, 'SigningPublicKey', {
      encodedKey: fs.readFileSync(publicKeyPath, 'utf8'),
      comment: `${config.prefix} URL signing key`,
    });
    const keyGroup = new cloudfront.KeyGroup(this, 'SigningKeyGroup', {
      items: [this.cfPublicKey],
    });

    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: `${config.prefix} media`,
      defaultBehavior: {
        // originPath maps /{uid}/{mediaId}/thumb.webp -> derived/{uid}/{mediaId}/thumb.webp
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
          originPath: '/derived',
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        trustedKeyGroups: [keyGroup],
        compress: false, // webp/jpg/mp4 are already compressed
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // includes Asia
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    new CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'CdnDomain', { value: this.distribution.distributionDomainName });
    new CfnOutput(this, 'CdnKeyPairId', { value: this.cfPublicKey.publicKeyId });
    new CfnOutput(this, 'CdnPrivateKeyParam', {
      value: `/mypic/${config.stage}/cloudfront/private-key`,
    });
  }
}
