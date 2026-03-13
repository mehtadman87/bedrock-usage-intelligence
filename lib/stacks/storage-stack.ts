import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/schema';

export interface StorageStackProps extends cdk.StackProps {
  config: PlatformConfig;
  cmk: kms.Key;
}

export class StorageStack extends cdk.Stack {
  public readonly rawLogsBucket: s3.Bucket;
  public readonly processedDataBucket: s3.Bucket;
  public readonly failedRecordsBucket: s3.Bucket;
  public readonly runtimeConfigTable: dynamodb.Table;
  public readonly identityCacheTable: dynamodb.Table;
  public readonly idempotencyTable: dynamodb.Table;


  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { config, cmk } = props;
    const { solutionName, environment } = config.deployment;

    // ── Lifecycle rules by environment ────────────────────────────────────────
    const lifecycleRules = this.buildLifecycleRules(environment);

    // ── S3 Buckets ────────────────────────────────────────────────────────────
    const commonBucketProps: Partial<s3.BucketProps> = {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: cmk,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    };

    this.rawLogsBucket = new s3.Bucket(this, 'RawLogsBucket', {
      ...commonBucketProps,
      bucketName: `${solutionName}-raw-logs-${this.account}-${this.region}`,
      lifecycleRules,
    });

    // ── Bedrock invocation logging bucket policy ──────────────────────────────
    // Required by bedrock:PutModelInvocationLoggingConfiguration — the API
    // validates that the bedrock.amazonaws.com service principal has write
    // access to the target S3 bucket before accepting the configuration.
    // See: https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html
    if (config.enableInvocationLogging) {
      this.rawLogsBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowBedrockLoggingWrite',
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
          actions: ['s3:PutObject'],
          resources: [this.rawLogsBucket.arnForObjects('*')],
          conditions: {
            StringEquals: {
              'aws:SourceAccount': this.account,
            },
            ArnLike: {
              'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:*`,
            },
          },
        }),
      );

      // Also allow Bedrock to use the CMK for encrypting log objects
      cmk.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowBedrockKmsGenerateDataKey',
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
          actions: ['kms:GenerateDataKey'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'aws:SourceAccount': this.account,
            },
            ArnLike: {
              'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:*`,
            },
          },
        }),
      );
    }

    this.processedDataBucket = new s3.Bucket(this, 'ProcessedDataBucket', {
      ...commonBucketProps,
      bucketName: `${solutionName}-processed-data-${this.account}-${this.region}`,
      lifecycleRules,
    });

    this.failedRecordsBucket = new s3.Bucket(this, 'FailedRecordsBucket', {
      ...commonBucketProps,
      bucketName: `${solutionName}-failed-records-${this.account}-${this.region}`,
      lifecycleRules,
    });

    // ── Multi-account bucket policy on rawLogsBucket ──────────────────────────
    if (config.account.accountMode === 'multi') {
      this.addMultiAccountBucketPolicy(config, cmk);
    }

    // ── DynamoDB Tables ───────────────────────────────────────────────────────
    const commonTableProps: Partial<dynamodb.TableProps> = {
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: cmk,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
    };

    this.runtimeConfigTable = new dynamodb.Table(this, 'RuntimeConfigTable', {
      ...commonTableProps,
      tableName: `${solutionName}-runtime-config`,
      partitionKey: { name: 'configCategory', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'configKey', type: dynamodb.AttributeType.STRING },
    });

    this.identityCacheTable = new dynamodb.Table(this, 'IdentityCacheTable', {
      ...commonTableProps,
      tableName: `${solutionName}-identity-cache`,
      partitionKey: { name: 'principalArn', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sourceType', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
    });

    this.idempotencyTable = new dynamodb.Table(this, 'IdempotencyTable', {
      ...commonTableProps,
      tableName: `${solutionName}-idempotency`,
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
    });

    // ── CfnOutputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'RawLogsBucketArn', {
      value: this.rawLogsBucket.bucketArn,
      description: 'ARN of the S3 bucket for raw Bedrock invocation logs',
      exportName: `${solutionName}-raw-logs-bucket-arn`,
    });

    new cdk.CfnOutput(this, 'ProcessedDataBucketArn', {
      value: this.processedDataBucket.bucketArn,
      description: 'ARN of the S3 bucket for processed Parquet data',
      exportName: `${solutionName}-processed-data-bucket-arn`,
    });

    new cdk.CfnOutput(this, 'FailedRecordsBucketArn', {
      value: this.failedRecordsBucket.bucketArn,
      description: 'ARN of the S3 bucket for failed processing records',
      exportName: `${solutionName}-failed-records-bucket-arn`,
    });

    new cdk.CfnOutput(this, 'RuntimeConfigTableArn', {
      value: this.runtimeConfigTable.tableArn,
      description: 'ARN of the DynamoDB Runtime Config table',
      exportName: `${solutionName}-runtime-config-table-arn`,
    });

    new cdk.CfnOutput(this, 'IdentityCacheTableArn', {
      value: this.identityCacheTable.tableArn,
      description: 'ARN of the DynamoDB Identity Cache table',
      exportName: `${solutionName}-identity-cache-table-arn`,
    });

    new cdk.CfnOutput(this, 'IdempotencyTableArn', {
      value: this.idempotencyTable.tableArn,
      description: 'ARN of the DynamoDB Idempotency table',
      exportName: `${solutionName}-idempotency-table-arn`,
    });

  }

  private buildLifecycleRules(environment: 'dev' | 'staging' | 'production'): s3.LifecycleRule[] {
    switch (environment) {
      case 'dev':
        return [
          {
            transitions: [
              {
                storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                transitionAfter: cdk.Duration.days(30),
              },
            ],
            expiration: cdk.Duration.days(90),
          },
        ];
      case 'staging':
        return [
          {
            transitions: [
              {
                storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                transitionAfter: cdk.Duration.days(60),
              },
              {
                storageClass: s3.StorageClass.GLACIER,
                transitionAfter: cdk.Duration.days(180),
              },
            ],
          },
        ];
      case 'production':
        return [
          {
            transitions: [
              {
                storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                transitionAfter: cdk.Duration.days(90),
              },
              {
                storageClass: s3.StorageClass.GLACIER,
                transitionAfter: cdk.Duration.days(365),
              },
            ],
          },
        ];
    }
  }

  private addMultiAccountBucketPolicy(config: PlatformConfig, cmk: kms.Key): void {
    if (config.account.accountMode !== 'multi') return;

    const { organizationId, sourceAccountIds } = config.account;

    let principalCondition: Record<string, Record<string, unknown>>;

    if (organizationId) {
      // Use org-wide condition instead of enumerating account IDs
      principalCondition = { StringEquals: { 'aws:PrincipalOrgID': organizationId } };
    } else {
      // Enumerate individual source account IDs
      principalCondition = {
        StringEquals: { 'aws:PrincipalAccount': sourceAccountIds },
      };
    }

    this.rawLogsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCrossAccountPutObject',
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.rawLogsBucket.arnForObjects('*')],
        conditions: principalCondition,
      }),
    );

    // Also allow cross-account use of the CMK for encrypting objects
    cmk.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCrossAccountKmsUsage',
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: ['*'],
        conditions: principalCondition,
      }),
    );
  }
}
