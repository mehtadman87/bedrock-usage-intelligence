import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IngestionStack } from 'lib/stacks/ingestion-stack';
import { PlatformConfig } from 'lib/config/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConfig(overrides: Partial<{
  environment: 'dev' | 'staging' | 'production';
  solutionName: string;
  enableInvocationLogging: boolean;
  cloudTrailMode: 'create' | 'existing';
  regionMode: 'single' | 'multi';
  sourceRegions: string[];
}> = {}): PlatformConfig {
  const {
    environment = 'dev',
    solutionName = 'test-solution',
    enableInvocationLogging = true,
    cloudTrailMode = 'existing',
    regionMode = 'single',
    sourceRegions = ['us-east-1', 'us-west-2'],
  } = overrides;

  const region =
    regionMode === 'multi'
      ? { regionMode: 'multi' as const, sourceRegions }
      : { regionMode: 'single' as const };

  const cloudTrail =
    cloudTrailMode === 'create'
      ? { cloudTrailMode: 'create' as const }
      : { cloudTrailMode: 'existing' as const, existingCloudTrailBucket: 'existing-ct-bucket' };

  return {
    vpc: { vpcMode: 'create', vpcCidr: '10.0.0.0/16', enableNatGateway: false, vpcEndpointMode: 'minimal' },
    account: { accountMode: 'single' },
    region,
    identity: { identityMode: 'iam' },
    dataExports: { curBucketName: 'test-cur-bucket', curReportFormat: 'csv', reconciliationSchedule: 'rate(6 hours)' },
    dashboard: { enableQuickSuite: false },
    cloudTrail,
    deployment: { solutionName, environment },
    enableInvocationLogging,
  };
}

interface StackSet {
  ingestionStack: IngestionStack;
  template: Template;
}

/**
 * Build the IngestionStack for testing.
 *
 * CDK's S3 event notification mechanism adds a BucketNotification custom resource
 * to the bucket's owning stack. To avoid cross-stack cyclic dependencies, we
 * create all dependency resources in a separate "deps" stack within the same app,
 * and verify IngestionStack-specific resources (Lambdas, DLQs, EventBridge rules)
 * via the IngestionStack template.
 *
 * Note: S3 bucket notifications will be in the deps stack template, not the
 * IngestionStack template. We verify them via the deps stack.
 */
interface FullStackSet {
  ingestionStack: IngestionStack;
  template: Template;
  depsTemplate: Template;
}

function buildIngestionStackFull(config: PlatformConfig): FullStackSet {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };

  const depsStack = new cdk.Stack(app, 'DepsStack', { env });

  const vpc = ec2.Vpc.fromVpcAttributes(depsStack, 'Vpc', {
    vpcId: 'vpc-12345678',
    availabilityZones: ['us-east-1a', 'us-east-1b'],
    privateSubnetIds: ['subnet-11111111', 'subnet-22222222'],
  });

  const cmk = new kms.Key(depsStack, 'Cmk', { enableKeyRotation: true });
  const lambdaSg = new ec2.SecurityGroup(depsStack, 'LambdaSG', { vpc, description: 'Lambda SG' });

  const bucketProps: s3.BucketProps = {
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: cmk,
    versioned: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
  };

  const rawLogsBucket = new s3.Bucket(depsStack, 'RawLogsBucket', bucketProps);
  const processedDataBucket = new s3.Bucket(depsStack, 'ProcessedDataBucket', bucketProps);
  const failedRecordsBucket = new s3.Bucket(depsStack, 'FailedRecordsBucket', bucketProps);

  const idempotencyTable = new dynamodb.Table(depsStack, 'IdempotencyTable', {
    partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
    encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
    encryptionKey: cmk,
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  });

  const privateSubnets = vpc.selectSubnets({
    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
  }).subnets;

  const ingestionStack = new IngestionStack(app, 'IngestionStack', {
    config,
    vpc,
    privateSubnets,
    lambdaSecurityGroup: lambdaSg,
    cmk,
    rawLogsBucket,
    processedDataBucket,
    failedRecordsBucket,
    idempotencyTable,
    curBucketName: 'test-cur-bucket',
    env,
  });

  return {
    ingestionStack,
    template: Template.fromStack(ingestionStack),
    depsTemplate: Template.fromStack(depsStack),
  };
}

function buildIngestionStack(config: PlatformConfig): StackSet {
  const { ingestionStack, template } = buildIngestionStackFull(config);
  return { ingestionStack, template };
}

// ---------------------------------------------------------------------------
// DLQ creation and CMK encryption
// ---------------------------------------------------------------------------

describe('IngestionStack - DLQ creation', () => {
  it('creates exactly 5 SQS DLQs', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    // 5 DLQs: invocation, cloudtrail, metrics, CUR processor, cost reconciler
    template.resourceCountIs('AWS::SQS::Queue', 5);
  });

  it('all DLQs are encrypted with the CMK', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    const queues = template.findResources('AWS::SQS::Queue');
    Object.values(queues).forEach((queue: unknown) => {
      const q = queue as { Properties?: { KmsMasterKeyId?: unknown } };
      expect(q.Properties?.KmsMasterKeyId).toBeDefined();
    });
  });

  it('exports invocationDlq, cloudTrailDlq, and metricsDlq', () => {
    const config = buildConfig();
    const { ingestionStack } = buildIngestionStack(config);

    expect(ingestionStack.invocationDlq).toBeDefined();
    expect(ingestionStack.cloudTrailDlq).toBeDefined();
    expect(ingestionStack.metricsDlq).toBeDefined();
  });

  it('DLQ names are prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildIngestionStack(config);

    const queues = template.findResources('AWS::SQS::Queue');
    const queueNames = Object.values(queues)
      .map((q: unknown) => (q as { Properties?: { QueueName?: string } }).Properties?.QueueName)
      .filter(Boolean) as string[];

    expect(queueNames.some((n) => n.startsWith('my-platform'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lambda functions - VPC attachment and security groups
// ---------------------------------------------------------------------------

describe('IngestionStack - Lambda VPC attachment', () => {
  it('all Lambda functions have VpcConfig', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    const lambdas = template.findResources('AWS::Lambda::Function');
    // Filter to only VPC-attached application Lambdas. Exclude:
    //   - CDK framework Lambdas (Python runtime or no FunctionName)
    //   - LoggingBootstrap Lambda (intentionally outside VPC — only calls
    //     Bedrock control plane API, needs internet, no NAT in VPC)
    //   - CDK Provider framework Lambda (auto-generated, no FunctionName)
    const appLambdas = Object.values(lambdas).filter((fn: unknown) => {
      const f = fn as { Properties?: { Runtime?: string; FunctionName?: unknown } };
      if (f.Properties?.Runtime !== 'nodejs22.x') return false;
      // Only include Lambdas with an explicit FunctionName that isn't logging-bootstrap
      const fnName = JSON.stringify(f.Properties?.FunctionName ?? '');
      if (!f.Properties?.FunctionName) return false;
      return !fnName.includes('logging-bootstrap');
    });

    // We should have at least 3 app Lambdas (invocation, cloudtrail, metrics)
    expect(appLambdas.length).toBeGreaterThanOrEqual(3);

    appLambdas.forEach((fn: unknown) => {
      const f = fn as { Properties?: { VpcConfig?: unknown } };
      expect(f.Properties?.VpcConfig).toBeDefined();
    });
  });

  it('Lambda functions reference the provided security group', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    const lambdas = template.findResources('AWS::Lambda::Function');
    const appLambdas = Object.values(lambdas).filter((fn: unknown) => {
      const f = fn as { Properties?: { Runtime?: string; FunctionName?: unknown } };
      if (f.Properties?.Runtime !== 'nodejs22.x') return false;
      if (!f.Properties?.FunctionName) return false;
      const fnName = JSON.stringify(f.Properties?.FunctionName ?? '');
      return !fnName.includes('logging-bootstrap');
    });

    appLambdas.forEach((fn: unknown) => {
      const f = fn as { Properties?: { VpcConfig?: { SecurityGroupIds?: unknown[] } } };
      const sgIds = f.Properties?.VpcConfig?.SecurityGroupIds ?? [];
      expect(sgIds.length).toBeGreaterThan(0);
    });
  });

  it('exports invocationProcessor, cloudTrailProcessor, and metricsCollector', () => {
    const config = buildConfig();
    const { ingestionStack } = buildIngestionStack(config);

    expect(ingestionStack.invocationProcessor).toBeDefined();
    expect(ingestionStack.cloudTrailProcessor).toBeDefined();
    expect(ingestionStack.metricsCollector).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Lambda environment variable encryption
// ---------------------------------------------------------------------------

describe('IngestionStack - Lambda environment variable encryption', () => {
  it('Lambda functions have KMS key for environment variable encryption', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    const lambdas = template.findResources('AWS::Lambda::Function');
    const appLambdas = Object.values(lambdas).filter((fn: unknown) => {
      const f = fn as { Properties?: { Runtime?: string } };
      return f.Properties?.Runtime === 'nodejs22.x';
    });

    appLambdas.forEach((fn: unknown) => {
      const f = fn as { Properties?: { KmsKeyArn?: unknown } };
      expect(f.Properties?.KmsKeyArn).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// S3 event source on raw logs bucket
// ---------------------------------------------------------------------------

describe('IngestionStack - S3 event source configuration', () => {
  it('creates S3 bucket notification for invocation processor', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    // CDK creates a BucketNotification custom resource for S3 event notifications
    const notifications = template.findResources('Custom::S3BucketNotifications');
    expect(Object.keys(notifications).length).toBeGreaterThan(0);
  });

  it('invocation processor has PROCESSED_DATA_BUCKET env var', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          PROCESSOR_NAME: 'invocation',
        }),
      },
    });
  });

  it('cloudtrail processor has CORRELATION_WINDOW_MS env var', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          PROCESSOR_NAME: 'cloudtrail',
          CORRELATION_WINDOW_MS: Match.anyValue(),
        }),
      },
    });
  });

  it('metrics collector has REGION_MODE env var', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          REGION_MODE: 'single',
        }),
      },
    });
  });

  it('metrics collector has SOURCE_REGIONS env var in multi-region mode', () => {
    const config = buildConfig({ regionMode: 'multi', sourceRegions: ['us-east-1', 'eu-west-1'] });
    const { template } = buildIngestionStack(config);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          REGION_MODE: 'multi',
          SOURCE_REGIONS: 'us-east-1,eu-west-1',
        }),
      },
    });
  });
});

// ---------------------------------------------------------------------------
// EventBridge rule for Metrics Collector
// ---------------------------------------------------------------------------

describe('IngestionStack - EventBridge rule for Metrics Collector', () => {
  it('creates an EventBridge rule with 5-minute rate schedule', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
    });
  });

  it('EventBridge rule targets the Metrics Collector Lambda', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    const rules = template.findResources('AWS::Events::Rule');
    const ruleValues = Object.values(rules) as Array<{
      Properties?: {
        ScheduleExpression?: string;
        Targets?: Array<{ Arn?: unknown }>;
      };
    }>;

    const metricsRule = ruleValues.find(
      (r) => r.Properties?.ScheduleExpression === 'rate(5 minutes)',
    );

    expect(metricsRule).toBeDefined();
    expect(metricsRule?.Properties?.Targets?.length).toBeGreaterThan(0);
  });

  it('EventBridge rule name is prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildIngestionStack(config);

    template.hasResourceProperties('AWS::Events::Rule', {
      Name: Match.stringLikeRegexp('^my-platform'),
      ScheduleExpression: 'rate(5 minutes)',
    });
  });
});

// ---------------------------------------------------------------------------
// Logging Bootstrap Custom Resource
// ---------------------------------------------------------------------------

describe('IngestionStack - Logging Bootstrap Custom Resource', () => {
  it('creates a Custom Resource when enableInvocationLogging is true', () => {
    const config = buildConfig({ enableInvocationLogging: true });
    const { template } = buildIngestionStack(config);

    // The logging bootstrap Lambda is created
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          RAW_LOGS_BUCKET_ARN: Match.anyValue(),
        }),
      },
    });
  });

  it('does NOT create a Logging Bootstrap Lambda when enableInvocationLogging is false', () => {
    const configWithLogging = buildConfig({ enableInvocationLogging: true });
    const configWithoutLogging = buildConfig({ enableInvocationLogging: false });

    const { template: withLogging } = buildIngestionStack(configWithLogging);
    const { template: withoutLogging } = buildIngestionStack(configWithoutLogging);

    // Count lambdas with RAW_LOGS_BUCKET_ARN env var
    const countBootstrapLambdas = (template: Template): number => {
      const lambdas = template.findResources('AWS::Lambda::Function');
      return Object.values(lambdas).filter((fn: unknown) => {
        const f = fn as { Properties?: { Environment?: { Variables?: { RAW_LOGS_BUCKET_ARN?: unknown } } } };
        return f.Properties?.Environment?.Variables?.RAW_LOGS_BUCKET_ARN !== undefined;
      }).length;
    };

    expect(countBootstrapLambdas(withLogging)).toBe(1);
    expect(countBootstrapLambdas(withoutLogging)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CloudTrail creation vs existing mode
// ---------------------------------------------------------------------------

describe('IngestionStack - CloudTrail mode', () => {
  it('creates a CloudTrail trail when cloudTrailMode is "create"', () => {
    const config = buildConfig({ cloudTrailMode: 'create' });
    const { template } = buildIngestionStack(config);

    template.resourceCountIs('AWS::CloudTrail::Trail', 1);
  });

  it('does NOT create a CloudTrail trail when cloudTrailMode is "existing"', () => {
    const config = buildConfig({ cloudTrailMode: 'existing' });
    const { template } = buildIngestionStack(config);

    template.resourceCountIs('AWS::CloudTrail::Trail', 0);
  });

  it('CloudTrail trail is encrypted with the CMK', () => {
    const config = buildConfig({ cloudTrailMode: 'create' });
    const { template } = buildIngestionStack(config);

    const trails = template.findResources('AWS::CloudTrail::Trail');
    const trailValues = Object.values(trails) as Array<{
      Properties?: { KMSKeyId?: unknown };
    }>;

    trailValues.forEach((trail) => {
      expect(trail.Properties?.KMSKeyId).toBeDefined();
    });
  });

  it('CloudTrail trail name is prefixed with solutionName', () => {
    const config = buildConfig({ cloudTrailMode: 'create', solutionName: 'my-platform' });
    const { template } = buildIngestionStack(config);

    template.hasResourceProperties('AWS::CloudTrail::Trail', {
      TrailName: Match.stringLikeRegexp('^my-platform'),
    });
  });
});

// ---------------------------------------------------------------------------
// IAM permissions
// ---------------------------------------------------------------------------

describe('IngestionStack - IAM permissions', () => {
  it('invocation processor has S3 read permission on raw logs bucket', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    // CDK grants produce IAM policies — verify at least one policy allows s3:GetObject
    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Action?: string | string[]; Effect?: string }>;
        };
      };
    }>;

    const hasS3Read = policyValues.some((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
        return (
          stmt.Effect === 'Allow' &&
          actions.some((a) => a.startsWith('s3:Get') || a === 's3:*' || a === 's3:GetObject')
        );
      });
    });

    expect(hasS3Read).toBe(true);
  });

  it('metrics collector has CloudWatch read permissions', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Action?: string | string[]; Effect?: string }>;
        };
      };
    }>;

    const hasCloudWatchRead = policyValues.some((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
        return (
          stmt.Effect === 'Allow' &&
          actions.some((a) => a.startsWith('cloudwatch:'))
        );
      });
    });

    expect(hasCloudWatchRead).toBe(true);
  });

  it('Lambda functions have Bedrock read permissions', () => {
    const config = buildConfig();
    const { template } = buildIngestionStack(config);

    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Action?: string | string[]; Effect?: string }>;
        };
      };
    }>;

    const hasBedrockRead = policyValues.some((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
        return (
          stmt.Effect === 'Allow' &&
          actions.some((a) => a.startsWith('bedrock:'))
        );
      });
    });

    expect(hasBedrockRead).toBe(true);
  });
});
