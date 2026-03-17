import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/schema';
import { LAMBDA_RUNTIME } from '../shared/cdk-constants';

export interface IngestionStackProps extends cdk.StackProps {
  config: PlatformConfig;
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
  lambdaSecurityGroup: ec2.SecurityGroup;
  cmk: kms.Key;
  rawLogsBucket: s3.Bucket;
  processedDataBucket: s3.Bucket;
  failedRecordsBucket: s3.Bucket;
  idempotencyTable: dynamodb.Table;
  curBucketName: string;
}

export class IngestionStack extends cdk.Stack {
  public readonly invocationProcessor: lambda.Function;
  public readonly cloudTrailProcessor: lambda.Function;
  public readonly metricsCollector: lambda.Function;
  public readonly curProcessor: lambda.Function;
  public readonly costReconciler: lambda.Function;
  public readonly invocationDlq: sqs.Queue;
  public readonly cloudTrailDlq: sqs.Queue;
  public readonly metricsDlq: sqs.Queue;
  public readonly curProcessorDlq: sqs.Queue;
  public readonly costReconcilerDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);

    const {
      config,
      vpc,
      privateSubnets,
      lambdaSecurityGroup,
      cmk,
      rawLogsBucket,
      processedDataBucket,
      failedRecordsBucket,
      idempotencyTable,
      curBucketName,
    } = props;

    const { solutionName } = config.deployment;
    const regionMode = config.region.regionMode;
    const sourceRegions =
      config.region.regionMode === 'multi' ? config.region.sourceRegions.join(',') : '';

    // ── VPC subnet selection ──────────────────────────────────────────────────
    const vpcSubnets: ec2.SubnetSelection = {
      subnets: privateSubnets,
    };

    // ── DLQs ─────────────────────────────────────────────────────────────────
    this.invocationDlq = new sqs.Queue(this, 'InvocationDlq', {
      queueName: `${solutionName}-invocation-dlq`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: cmk,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.cloudTrailDlq = new sqs.Queue(this, 'CloudTrailDlq', {
      queueName: `${solutionName}-cloudtrail-dlq`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: cmk,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.metricsDlq = new sqs.Queue(this, 'MetricsDlq', {
      queueName: `${solutionName}-metrics-dlq`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: cmk,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.curProcessorDlq = new sqs.Queue(this, 'CurProcessorDlq', {
      queueName: `${solutionName}-cur-processor-dlq`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: cmk,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.costReconcilerDlq = new sqs.Queue(this, 'CostReconcilerDlq', {
      queueName: `${solutionName}-cost-reconciler-dlq`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: cmk,
      retentionPeriod: cdk.Duration.days(14),
    });

    // ── Common NodejsFunction props ──────────────────────────────────────────
    const commonNodejsProps = {
      runtime: LAMBDA_RUNTIME,
      vpc,
      vpcSubnets,
      securityGroups: [lambdaSecurityGroup],
      environmentEncryption: cmk,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        // Exclude AWS SDK v3 (provided by Lambda runtime) to reduce bundle size
        externalModules: ['@aws-sdk/*'],
      },
    };

    // ── Invocation Processor Lambda ───────────────────────────────────────────
    this.invocationProcessor = new nodejs.NodejsFunction(this, 'InvocationProcessor', {
      ...commonNodejsProps,
      functionName: `${solutionName}-invocation-processor`,
      entry: path.join(__dirname, '../handlers/invocation-processor/index.ts'),
      deadLetterQueue: this.invocationDlq,
      environment: {
        PROCESSED_DATA_BUCKET: processedDataBucket.bucketName,
        FAILED_RECORDS_BUCKET: failedRecordsBucket.bucketName,
        IDEMPOTENCY_TABLE: idempotencyTable.tableName,
        REGION_MODE: regionMode,
        PROCESSOR_NAME: 'invocation',
      },
    });

    // S3 event source on rawLogsBucket.
    // Use fromBucketAttributes to create a bucket reference in THIS stack's scope,
    // so the BucketNotification custom resource is created in this stack (not the
    // bucket's owning stack), avoiding cross-stack cyclic dependencies.
    const rawLogsBucketRef = s3.Bucket.fromBucketAttributes(this, 'RawLogsBucketRef', {
      bucketArn: rawLogsBucket.bucketArn,
      bucketName: rawLogsBucket.bucketName,
    });

    // Use a prefix filter so this notification doesn't overlap with the
    // CloudTrail processor's AWSLogs/ prefix. Bedrock invocation logs are
    // delivered under the "bedrock-logs/" prefix by the Logging Bootstrap.
    rawLogsBucketRef.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.invocationProcessor),
      { prefix: 'bedrock-logs/' },
    );

    // ── CloudTrail Processor Lambda ───────────────────────────────────────────
    const correlationWindowMs = 300_000; // 5 minutes default

    this.cloudTrailProcessor = new nodejs.NodejsFunction(this, 'CloudTrailProcessor', {
      ...commonNodejsProps,
      functionName: `${solutionName}-cloudtrail-processor`,
      entry: path.join(__dirname, '../handlers/cloudtrail-processor/index.ts'),
      deadLetterQueue: this.cloudTrailDlq,
      environment: {
        PROCESSED_DATA_BUCKET: processedDataBucket.bucketName,
        FAILED_RECORDS_BUCKET: failedRecordsBucket.bucketName,
        IDEMPOTENCY_TABLE: idempotencyTable.tableName,
        CORRELATION_WINDOW_MS: String(correlationWindowMs),
        PROCESSOR_NAME: 'cloudtrail',
      },
    });

    // CloudTrail event source: use rawLogsBucket for "existing" mode,
    // or the dedicated CloudTrail bucket when "create" mode (added below)
    if (config.cloudTrail.cloudTrailMode === 'existing') {
      rawLogsBucketRef.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3n.LambdaDestination(this.cloudTrailProcessor),
        { prefix: 'AWSLogs/' },
      );
    }

    // ── Metrics Collector Lambda ──────────────────────────────────────────────
    this.metricsCollector = new nodejs.NodejsFunction(this, 'MetricsCollector', {
      ...commonNodejsProps,
      functionName: `${solutionName}-metrics-collector`,
      entry: path.join(__dirname, '../handlers/metrics-collector/index.ts'),
      deadLetterQueue: this.metricsDlq,
      environment: {
        PROCESSED_DATA_BUCKET: processedDataBucket.bucketName,
        REGION_MODE: regionMode,
        SOURCE_REGIONS: sourceRegions,
      },
    });

    // EventBridge rule: daily schedule (once every 24 hours)
    const metricsRule = new events.Rule(this, 'MetricsCollectorSchedule', {
      ruleName: `${solutionName}-metrics-collector-schedule`,
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
      description: 'Triggers Metrics Collector Lambda every 24 hours',
    });
    metricsRule.addTarget(
      new targets.LambdaFunction(this.metricsCollector, {
        deadLetterQueue: this.metricsDlq,
        retryAttempts: 2,
      }),
    );

    // ── CUR Processor Lambda ──────────────────────────────────────────────────
    // Processes CUR (Cost and Usage Report) files from the Data Exports bucket.
    // Triggered by S3 events when new CUR files arrive, and by a scheduled
    // EventBridge rule as a polling fallback.
    const curReportPrefix = config.dataExports.curReportPrefix ?? '';
    const reconciliationSchedule = config.dataExports.reconciliationSchedule ?? 'rate(6 hours)';

    this.curProcessor = new nodejs.NodejsFunction(this, 'CurProcessor', {
      ...commonNodejsProps,
      functionName: `${solutionName}-cur-processor`,
      entry: path.join(__dirname, '../handlers/cur-processor/index.ts'),
      deadLetterQueue: this.curProcessorDlq,
      environment: {
        CUR_BUCKET: curBucketName,
        CUR_REPORT_PREFIX: curReportPrefix,
        PROCESSED_DATA_BUCKET: processedDataBucket.bucketName,
        IDEMPOTENCY_TABLE: idempotencyTable.tableName,
        PROCESSOR_NAME: 'cur-processor',
      },
    });

    // S3 event notification for CUR bucket — triggers when new CUR files land
    const curBucket = s3.Bucket.fromBucketName(this, 'CurBucketRef', curBucketName);
    curBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.curProcessor),
      { suffix: '.csv.gz' },
    );

    // EventBridge scheduled rule: CUR polling fallback (default every 6 hours)
    const curPollingRule = new events.Rule(this, 'CurPollingSchedule', {
      ruleName: `${solutionName}-cur-polling-schedule`,
      schedule: events.Schedule.expression(reconciliationSchedule),
      description: 'Fallback polling for CUR files every 6 hours',
    });
    curPollingRule.addTarget(
      new targets.LambdaFunction(this.curProcessor, {
        deadLetterQueue: this.curProcessorDlq,
        retryAttempts: 2,
      }),
    );

    // ── Cost Reconciler Lambda ────────────────────────────────────────────────
    // Runs on a schedule to reconcile CUR costs with invocation logs via Athena,
    // computing proportional cost attribution per user.
    this.costReconciler = new nodejs.NodejsFunction(this, 'CostReconciler', {
      ...commonNodejsProps,
      timeout: cdk.Duration.minutes(15),
      functionName: `${solutionName}-cost-reconciler`,
      entry: path.join(__dirname, '../handlers/cost-reconciler/index.ts'),
      deadLetterQueue: this.costReconcilerDlq,
      environment: {
        PROCESSED_DATA_BUCKET: processedDataBucket.bucketName,
        IDEMPOTENCY_TABLE: idempotencyTable.tableName,
        PROCESSOR_NAME: 'cost-reconciler',
        GLUE_DATABASE: `${solutionName}_analytics`,
        ATHENA_WORKGROUP: `${solutionName}-workgroup`,
      },
    });

    // EventBridge scheduled rule for cost reconciliation
    const reconciliationRule = new events.Rule(this, 'CostReconcilerSchedule', {
      ruleName: `${solutionName}-cost-reconciler-schedule`,
      schedule: events.Schedule.expression(reconciliationSchedule),
      description: 'Triggers Cost Reconciler Lambda on schedule for CUR cost attribution',
    });
    reconciliationRule.addTarget(
      new targets.LambdaFunction(this.costReconciler, {
        deadLetterQueue: this.costReconcilerDlq,
        retryAttempts: 2,
      }),
    );

    // ── Conditional CloudTrail Trail ──────────────────────────────────────────
    if (config.cloudTrail.cloudTrailMode === 'create') {
      const trail = new cloudtrail.Trail(this, 'BedrockCloudTrail', {
        trailName: `${solutionName}-bedrock-trail`,
        bucket: rawLogsBucket,
        encryptionKey: cmk,
        isMultiRegionTrail: regionMode === 'multi',
        includeGlobalServiceEvents: false,
        sendToCloudWatchLogs: false,
      });

      // Add Bedrock data events
      trail.addEventSelector(cloudtrail.DataResourceType.LAMBDA_FUNCTION, ['arn:aws:lambda']);

      // Trigger CloudTrail processor from the raw logs bucket with AWSLogs prefix
      rawLogsBucketRef.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3n.LambdaDestination(this.cloudTrailProcessor),
        { prefix: 'AWSLogs/' },
      );
    }

    // ── Logging Bootstrap Custom Resource ─────────────────────────────────────
    //
    // Uses the CDK Provider framework (cr.Provider) which automatically handles
    // the CloudFormation cfn-response callback to the pre-signed S3 URL.
    //
    // Why this matters:
    //   - A raw cdk.CustomResource with serviceToken = Lambda ARN requires the
    //     Lambda to manually HTTP PUT a response to event.ResponseURL.
    //   - If the Lambda fails to call back (e.g. network issue, unhandled error,
    //     VPC without internet), CloudFormation waits for the 1-hour timeout,
    //     then the stack gets stuck in ROLLBACK_IN_PROGRESS / DELETE_FAILED.
    //   - The Provider framework wraps your Lambda in a framework function that
    //     handles the callback automatically. Your onEvent handler just returns
    //     a result object or throws — the framework does the rest.
    //
    // The onEvent Lambda is NOT placed in the VPC because:
    //   - It only calls the Bedrock control plane API (not a VPC resource)
    //   - The VPC has no NAT gateway, so VPC Lambdas can't reach the internet
    //   - Even with the Provider framework handling cfn-response, the onEvent
    //     Lambda still needs internet access to reach the Bedrock API endpoint
    //     (unless a Bedrock VPC endpoint is configured in "full" mode)
    //
    if (config.enableInvocationLogging) {
      const loggingBootstrapFn = new nodejs.NodejsFunction(this, 'LoggingBootstrapFn', {
        runtime: LAMBDA_RUNTIME,
        environmentEncryption: cmk,
        timeout: cdk.Duration.minutes(2),
        memorySize: 256,
        functionName: `${solutionName}-logging-bootstrap`,
        entry: path.join(__dirname, '../handlers/logging-bootstrap/index.ts'),
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'node22',
          externalModules: ['@aws-sdk/*'],
        },
        environment: {
          RAW_LOGS_BUCKET_ARN: rawLogsBucket.bucketArn,
          RAW_LOGS_BUCKET_PREFIX: 'bedrock-logs/',
          DISABLE_ON_DELETE: 'false',
        },
      });

      // Grant Bedrock permissions to the bootstrap function
      loggingBootstrapFn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'AllowBedrockLoggingConfig',
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock:PutModelInvocationLoggingConfiguration',
            'bedrock:DeleteModelInvocationLoggingConfiguration',
            'bedrock:GetModelInvocationLoggingConfiguration',
          ],
          resources: ['*'],
        }),
      );

      // The Provider framework creates its own internal Lambda that:
      //   1. Invokes our onEvent handler
      //   2. Catches any errors
      //   3. Sends SUCCESS or FAILED to the CloudFormation pre-signed S3 URL
      // This guarantees CloudFormation always gets a response, preventing
      // stuck stacks on create, update, AND delete operations.
      const loggingProvider = new cr.Provider(this, 'LoggingBootstrapProvider', {
        onEventHandler: loggingBootstrapFn,
        providerFunctionEnvEncryption: cmk,
      });

      new cdk.CustomResource(this, 'LoggingBootstrap', {
        serviceToken: loggingProvider.serviceToken,
        properties: {
          // Pass as a property so CloudFormation detects changes and triggers
          // an Update event if the bucket ARN changes.
          RawLogsBucketArn: rawLogsBucket.bucketArn,
        },
      });
    }

    // ── IAM Permissions ───────────────────────────────────────────────────────

    // Invocation Processor: read raw logs, write processed + failed
    this.invocationProcessor.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowRawLogsBucketRead',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
      resources: [rawLogsBucket.bucketArn, rawLogsBucket.arnForObjects('*')],
    }));
    this.invocationProcessor.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowProcessedDataBucketWrite',
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:PutObjectAcl'],
      resources: [processedDataBucket.arnForObjects('*')],
    }));
    this.invocationProcessor.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowFailedRecordsBucketWrite',
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:PutObjectAcl'],
      resources: [failedRecordsBucket.arnForObjects('*')],
    }));
    idempotencyTable.grantReadWriteData(this.invocationProcessor);
    cmk.grantEncryptDecrypt(this.invocationProcessor);

    // CloudTrail Processor: read raw logs, write processed + failed
    this.cloudTrailProcessor.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowRawLogsBucketReadCT',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
      resources: [rawLogsBucket.bucketArn, rawLogsBucket.arnForObjects('*')],
    }));
    this.cloudTrailProcessor.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowProcessedDataBucketWriteCT',
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:PutObjectAcl'],
      resources: [processedDataBucket.arnForObjects('*')],
    }));
    this.cloudTrailProcessor.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowFailedRecordsBucketWriteCT',
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:PutObjectAcl'],
      resources: [failedRecordsBucket.arnForObjects('*')],
    }));
    idempotencyTable.grantReadWriteData(this.cloudTrailProcessor);
    cmk.grantEncryptDecrypt(this.cloudTrailProcessor);

    // Metrics Collector: write processed data, read CloudWatch metrics
    this.metricsCollector.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowProcessedDataBucketWriteMC',
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:PutObjectAcl'],
      resources: [processedDataBucket.arnForObjects('*')],
    }));
    cmk.grantEncryptDecrypt(this.metricsCollector);

    this.metricsCollector.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchMetricsRead',
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudwatch:GetMetricData',
          'cloudwatch:GetMetricStatistics',
          'cloudwatch:ListMetrics',
        ],
        resources: ['*'],
      }),
    );

    // Bedrock read access for all ingestion processors
    const bedrockReadPolicy = new iam.PolicyStatement({
      sid: 'AllowBedrockRead',
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:GetFoundationModel',
        'bedrock:ListFoundationModels',
        'bedrock:GetInferenceProfile',
        'bedrock:ListInferenceProfiles',
      ],
      resources: ['*'],
    });

    this.invocationProcessor.addToRolePolicy(bedrockReadPolicy);
    this.cloudTrailProcessor.addToRolePolicy(bedrockReadPolicy);
    this.metricsCollector.addToRolePolicy(bedrockReadPolicy);

    // ── CUR Processor IAM Permissions ─────────────────────────────────────────

    // S3 read on CUR bucket
    this.curProcessor.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowCurBucketRead',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
      resources: [curBucket.bucketArn, curBucket.arnForObjects('*')],
    }));

    // S3 write on processed data bucket
    this.curProcessor.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowProcessedDataBucketWriteCur',
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:PutObjectAcl'],
      resources: [processedDataBucket.arnForObjects('*')],
    }));

    idempotencyTable.grantReadWriteData(this.curProcessor);
    cmk.grantEncryptDecrypt(this.curProcessor);

    // ── Cost Reconciler IAM Permissions ───────────────────────────────────────

    // S3 read on CUR bucket (for direct CUR data access if needed)
    this.costReconciler.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowCurBucketReadReconciler',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket'],
      resources: [curBucket.bucketArn, curBucket.arnForObjects('*')],
    }));

    // S3 write on processed data bucket (for reconciled cost output)
    this.costReconciler.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowProcessedDataBucketWriteReconciler',
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject', 's3:PutObjectAcl', 's3:GetObject', 's3:ListBucket', 's3:GetBucketLocation'],
      resources: [
        processedDataBucket.bucketArn,
        processedDataBucket.arnForObjects('*'),
      ],
    }));

    // Athena query execution for CUR and invocation log reconciliation
    this.costReconciler.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowAthenaQueryExecution',
      effect: iam.Effect.ALLOW,
      actions: [
        'athena:StartQueryExecution',
        'athena:GetQueryExecution',
        'athena:GetQueryResults',
      ],
      resources: ['*'],
    }));

    // Glue catalog read for table metadata
    this.costReconciler.addToRolePolicy(new iam.PolicyStatement({
      sid: 'AllowGlueCatalogRead',
      effect: iam.Effect.ALLOW,
      actions: ['glue:GetTable', 'glue:GetPartitions'],
      resources: ['*'],
    }));

    idempotencyTable.grantReadWriteData(this.costReconciler);
    cmk.grantEncryptDecrypt(this.costReconciler);
  }
}
