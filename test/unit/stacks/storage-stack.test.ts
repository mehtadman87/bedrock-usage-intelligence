import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SecurityStack } from 'lib/stacks/security-stack';
import { StorageStack } from 'lib/stacks/storage-stack';
import { PlatformConfig } from 'lib/config/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConfig(overrides: Partial<{
  environment: 'dev' | 'staging' | 'production';
  solutionName: string;
  accountMode: 'single' | 'multi';
  sourceAccountIds: string[];
  organizationId: string;
}> = {}): PlatformConfig {
  const {
    environment = 'dev',
    solutionName = 'test-solution',
    accountMode = 'single',
    sourceAccountIds = ['123456789012'],
    organizationId,
  } = overrides;

  const account =
    accountMode === 'multi'
      ? { accountMode: 'multi' as const, sourceAccountIds, ...(organizationId ? { organizationId } : {}) }
      : { accountMode: 'single' as const };

  return {
    vpc: { vpcMode: 'create', vpcCidr: '10.0.0.0/16', enableNatGateway: false, vpcEndpointMode: 'minimal' },
    account,
    region: { regionMode: 'single' },
    identity: { identityMode: 'iam' },
    dataExports: { curBucketName: 'test-cur-bucket', curReportFormat: 'csv', reconciliationSchedule: 'rate(6 hours)' },
    dashboard: { enableQuickSuite: false },
    cloudTrail: { cloudTrailMode: 'create' },
    deployment: { solutionName, environment },
    enableInvocationLogging: true,
  };
}

function createMockVpc(scope: cdk.Stack): ec2.IVpc {
  return ec2.Vpc.fromVpcAttributes(scope, 'MockVpc', {
    vpcId: 'vpc-12345678',
    availabilityZones: ['us-east-1a', 'us-east-1b'],
    privateSubnetIds: ['subnet-11111111', 'subnet-22222222'],
  });
}

function buildStorageStack(config: PlatformConfig): { stack: StorageStack; template: Template } {
  const app = new cdk.App();
  const vpcStack = new cdk.Stack(app, 'VpcStack');
  const mockVpc = createMockVpc(vpcStack);

  const secStack = new SecurityStack(app, 'SecurityStack', {
    config,
    vpc: mockVpc,
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const storageStack = new StorageStack(app, 'StorageStack', {
    config,
    cmk: secStack.cmk,
    env: { account: '123456789012', region: 'us-east-1' },
  });

  return { stack: storageStack, template: Template.fromStack(storageStack) };
}

// ---------------------------------------------------------------------------
// S3 Buckets - encryption, versioning, public access
// ---------------------------------------------------------------------------

describe('StorageStack - S3 bucket configuration', () => {
  it('creates exactly 3 S3 buckets', () => {
    const config = buildConfig();
    const { template } = buildStorageStack(config);

    template.resourceCountIs('AWS::S3::Bucket', 3);
  });

  it('all buckets use SSE-KMS encryption', () => {
    const config = buildConfig();
    const { template } = buildStorageStack(config);

    const buckets = template.findResources('AWS::S3::Bucket');
    Object.values(buckets).forEach((bucket: unknown) => {
      const b = bucket as { Properties?: { BucketEncryption?: { ServerSideEncryptionConfiguration?: Array<{ ServerSideEncryptionByDefault?: { SSEAlgorithm?: string } }> } } };
      const sseConfig = b.Properties?.BucketEncryption?.ServerSideEncryptionConfiguration ?? [];
      const hasKms = sseConfig.some((rule) => rule.ServerSideEncryptionByDefault?.SSEAlgorithm === 'aws:kms');
      expect(hasKms).toBe(true);
    });
  });

  it('all buckets have versioning enabled', () => {
    const config = buildConfig();
    const { template } = buildStorageStack(config);

    const buckets = template.findResources('AWS::S3::Bucket');
    Object.values(buckets).forEach((bucket: unknown) => {
      const b = bucket as { Properties?: { VersioningConfiguration?: { Status?: string } } };
      expect(b.Properties?.VersioningConfiguration?.Status).toBe('Enabled');
    });
  });

  it('all buckets block all public access', () => {
    const config = buildConfig();
    const { template } = buildStorageStack(config);

    const buckets = template.findResources('AWS::S3::Bucket');
    Object.values(buckets).forEach((bucket: unknown) => {
      const b = bucket as {
        Properties?: {
          PublicAccessBlockConfiguration?: {
            BlockPublicAcls?: boolean;
            BlockPublicPolicy?: boolean;
            IgnorePublicAcls?: boolean;
            RestrictPublicBuckets?: boolean;
          };
        };
      };
      const pab = b.Properties?.PublicAccessBlockConfiguration;
      expect(pab?.BlockPublicAcls).toBe(true);
      expect(pab?.BlockPublicPolicy).toBe(true);
      expect(pab?.IgnorePublicAcls).toBe(true);
      expect(pab?.RestrictPublicBuckets).toBe(true);
    });
  });

  it('all buckets enforce SSL via bucket policy', () => {
    const config = buildConfig();
    const { template } = buildStorageStack(config);

    // CDK enforceSSL: true adds a bucket policy denying non-SSL requests
    const policies = template.findResources('AWS::S3::BucketPolicy');
    expect(Object.keys(policies).length).toBeGreaterThanOrEqual(3);

    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Effect?: string; Condition?: { Bool?: { 'aws:SecureTransport'?: string } } }>;
        };
      };
    }>;

    const hasSslDeny = policyValues.some((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some(
        (stmt) =>
          stmt.Effect === 'Deny' &&
          stmt.Condition?.Bool?.['aws:SecureTransport'] === 'false',
      );
    });
    expect(hasSslDeny).toBe(true);
  });

  it('bucket names are prefixed with the solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildStorageStack(config);

    const buckets = template.findResources('AWS::S3::Bucket');
    Object.values(buckets).forEach((bucket: unknown) => {
      const b = bucket as { Properties?: { BucketName?: string } };
      const name = b.Properties?.BucketName;
      if (typeof name === 'string') {
        expect(name.startsWith('my-platform')).toBe(true);
      }
    });
  });

  it('exports rawLogsBucket, processedDataBucket, and failedRecordsBucket', () => {
    const config = buildConfig();
    const { stack } = buildStorageStack(config);

    expect(stack.rawLogsBucket).toBeDefined();
    expect(stack.processedDataBucket).toBeDefined();
    expect(stack.failedRecordsBucket).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// S3 Lifecycle policies
// ---------------------------------------------------------------------------

describe('StorageStack - S3 lifecycle policies', () => {
  it('dev: transitions to IA after 30 days and expires after 90 days', () => {
    const config = buildConfig({ environment: 'dev' });
    const { template } = buildStorageStack(config);

    const buckets = template.findResources('AWS::S3::Bucket');
    const bucketValues = Object.values(buckets) as Array<{
      Properties?: {
        LifecycleConfiguration?: {
          Rules?: Array<{
            Status?: string;
            Transitions?: Array<{ StorageClass?: string; TransitionInDays?: number }>;
            ExpirationInDays?: number;
          }>;
        };
      };
    }>;

    bucketValues.forEach((bucket) => {
      const rules = bucket.Properties?.LifecycleConfiguration?.Rules ?? [];
      const enabledRule = rules.find((r) => r.Status === 'Enabled');
      expect(enabledRule).toBeDefined();

      const iaTransition = enabledRule?.Transitions?.find((t) => t.StorageClass === 'STANDARD_IA');
      expect(iaTransition?.TransitionInDays).toBe(30);
      expect(enabledRule?.ExpirationInDays).toBe(90);
    });
  });

  it('staging: transitions to IA after 60 days and Glacier after 180 days', () => {
    const config = buildConfig({ environment: 'staging' });
    const { template } = buildStorageStack(config);

    const buckets = template.findResources('AWS::S3::Bucket');
    const bucketValues = Object.values(buckets) as Array<{
      Properties?: {
        LifecycleConfiguration?: {
          Rules?: Array<{
            Status?: string;
            Transitions?: Array<{ StorageClass?: string; TransitionInDays?: number }>;
            ExpirationInDays?: number;
          }>;
        };
      };
    }>;

    bucketValues.forEach((bucket) => {
      const rules = bucket.Properties?.LifecycleConfiguration?.Rules ?? [];
      const enabledRule = rules.find((r) => r.Status === 'Enabled');
      expect(enabledRule).toBeDefined();

      const iaTransition = enabledRule?.Transitions?.find((t) => t.StorageClass === 'STANDARD_IA');
      expect(iaTransition?.TransitionInDays).toBe(60);

      const glacierTransition = enabledRule?.Transitions?.find((t) => t.StorageClass === 'GLACIER');
      expect(glacierTransition?.TransitionInDays).toBe(180);

      // No expiration for staging
      expect(enabledRule?.ExpirationInDays).toBeUndefined();
    });
  });

  it('production: transitions to IA after 90 days and Glacier after 365 days', () => {
    const config = buildConfig({ environment: 'production' });
    const { template } = buildStorageStack(config);

    const buckets = template.findResources('AWS::S3::Bucket');
    const bucketValues = Object.values(buckets) as Array<{
      Properties?: {
        LifecycleConfiguration?: {
          Rules?: Array<{
            Status?: string;
            Transitions?: Array<{ StorageClass?: string; TransitionInDays?: number }>;
            ExpirationInDays?: number;
          }>;
        };
      };
    }>;

    bucketValues.forEach((bucket) => {
      const rules = bucket.Properties?.LifecycleConfiguration?.Rules ?? [];
      const enabledRule = rules.find((r) => r.Status === 'Enabled');
      expect(enabledRule).toBeDefined();

      const iaTransition = enabledRule?.Transitions?.find((t) => t.StorageClass === 'STANDARD_IA');
      expect(iaTransition?.TransitionInDays).toBe(90);

      const glacierTransition = enabledRule?.Transitions?.find((t) => t.StorageClass === 'GLACIER');
      expect(glacierTransition?.TransitionInDays).toBe(365);

      // No expiration for production
      expect(enabledRule?.ExpirationInDays).toBeUndefined();
    });
  });

  it('each environment produces distinct IA transition days', () => {
    const devConfig = buildConfig({ environment: 'dev' });
    const stagingConfig = buildConfig({ environment: 'staging' });
    const prodConfig = buildConfig({ environment: 'production' });

    const getIaDays = (config: PlatformConfig): number | undefined => {
      const { template } = buildStorageStack(config);
      const buckets = template.findResources('AWS::S3::Bucket');
      const firstBucket = Object.values(buckets)[0] as {
        Properties?: {
          LifecycleConfiguration?: {
            Rules?: Array<{
              Status?: string;
              Transitions?: Array<{ StorageClass?: string; TransitionInDays?: number }>;
            }>;
          };
        };
      };
      const rules = firstBucket?.Properties?.LifecycleConfiguration?.Rules ?? [];
      const enabledRule = rules.find((r) => r.Status === 'Enabled');
      return enabledRule?.Transitions?.find((t) => t.StorageClass === 'STANDARD_IA')?.TransitionInDays;
    };

    expect(getIaDays(devConfig)).toBe(30);
    expect(getIaDays(stagingConfig)).toBe(60);
    expect(getIaDays(prodConfig)).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// DynamoDB Tables
// ---------------------------------------------------------------------------

describe('StorageStack - DynamoDB tables', () => {
  it('creates exactly 3 DynamoDB tables', () => {
    const config = buildConfig();
    const { template } = buildStorageStack(config);

    // runtimeConfig, identityCache, idempotency (pricing table removed)
    template.resourceCountIs('AWS::DynamoDB::Table', 3);
  });

  it('all tables use CMK encryption (SSEEnabled: true)', () => {
    const config = buildConfig();
    const { template } = buildStorageStack(config);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: { SSEEnabled: true },
    });

    const tables = template.findResources('AWS::DynamoDB::Table');
    Object.values(tables).forEach((table: unknown) => {
      const t = table as { Properties?: { SSESpecification?: { SSEEnabled?: boolean } } };
      expect(t.Properties?.SSESpecification?.SSEEnabled).toBe(true);
    });
  });

  it('all tables use PAY_PER_REQUEST billing mode', () => {
    const config = buildConfig();
    const { template } = buildStorageStack(config);

    const tables = template.findResources('AWS::DynamoDB::Table');
    Object.values(tables).forEach((table: unknown) => {
      const t = table as { Properties?: { BillingMode?: string } };
      expect(t.Properties?.BillingMode).toBe('PAY_PER_REQUEST');
    });
  });

  it('all tables have PITR enabled', () => {
    const config = buildConfig();
    const { template } = buildStorageStack(config);

    const tables = template.findResources('AWS::DynamoDB::Table');
    Object.values(tables).forEach((table: unknown) => {
      const t = table as { Properties?: { PointInTimeRecoverySpecification?: { PointInTimeRecoveryEnabled?: boolean } } };
      expect(t.Properties?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled).toBe(true);
    });
  });

  it('identityCacheTable has TTL on expiresAt attribute', () => {
    const config = buildConfig({ solutionName: 'test-solution' });
    const { template } = buildStorageStack(config);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-solution-identity-cache',
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    });
  });

  it('idempotencyTable has TTL on expiresAt attribute', () => {
    const config = buildConfig({ solutionName: 'test-solution' });
    const { template } = buildStorageStack(config);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-solution-idempotency',
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    });
  });

  it('runtimeConfigTable has correct partition and sort keys', () => {
    const config = buildConfig({ solutionName: 'test-solution' });
    const { template } = buildStorageStack(config);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-solution-runtime-config',
      KeySchema: Match.arrayWith([
        { AttributeName: 'configCategory', KeyType: 'HASH' },
        { AttributeName: 'configKey', KeyType: 'RANGE' },
      ]),
    });
  });

  it('identityCacheTable has correct partition and sort keys', () => {
    const config = buildConfig({ solutionName: 'test-solution' });
    const { template } = buildStorageStack(config);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-solution-identity-cache',
      KeySchema: Match.arrayWith([
        { AttributeName: 'principalArn', KeyType: 'HASH' },
        { AttributeName: 'sourceType', KeyType: 'RANGE' },
      ]),
    });
  });

  it('idempotencyTable has correct partition and sort keys', () => {
    const config = buildConfig({ solutionName: 'test-solution' });
    const { template } = buildStorageStack(config);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'test-solution-idempotency',
      KeySchema: Match.arrayWith([
        { AttributeName: 'requestId', KeyType: 'HASH' },
        { AttributeName: 'timestamp', KeyType: 'RANGE' },
      ]),
    });
  });

  it('exports all 3 DynamoDB tables', () => {
    const config = buildConfig();
    const { stack } = buildStorageStack(config);

    expect(stack.runtimeConfigTable).toBeDefined();
    expect(stack.identityCacheTable).toBeDefined();
    expect(stack.idempotencyTable).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-account bucket policies
// ---------------------------------------------------------------------------

describe('StorageStack - multi-account bucket policies', () => {
  it('does not add cross-account bucket policy in single-account mode', () => {
    const config = buildConfig({ accountMode: 'single' });
    const { template } = buildStorageStack(config);

    const policies = template.findResources('AWS::S3::BucketPolicy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Sid?: string }>;
        };
      };
    }>;

    const hasCrossAccountPolicy = policyValues.some((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => stmt.Sid === 'AllowCrossAccountPutObject');
    });

    expect(hasCrossAccountPolicy).toBe(false);
  });

  it('adds cross-account PutObject policy on rawLogsBucket in multi-account mode', () => {
    const config = buildConfig({
      accountMode: 'multi',
      sourceAccountIds: ['111111111111', '222222222222'],
    });
    const { template } = buildStorageStack(config);

    const policies = template.findResources('AWS::S3::BucketPolicy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{
            Sid?: string;
            Effect?: string;
            Action?: string | string[];
            Condition?: Record<string, unknown>;
          }>;
        };
      };
    }>;

    const crossAccountPolicy = policyValues.find((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => stmt.Sid === 'AllowCrossAccountPutObject');
    });

    expect(crossAccountPolicy).toBeDefined();

    const crossAccountStatement = crossAccountPolicy?.Properties?.PolicyDocument?.Statement?.find(
      (stmt) => stmt.Sid === 'AllowCrossAccountPutObject',
    );

    expect(crossAccountStatement?.Effect).toBe('Allow');
    const actions = Array.isArray(crossAccountStatement?.Action)
      ? crossAccountStatement!.Action!
      : [crossAccountStatement?.Action ?? ''];
    expect(actions).toContain('s3:PutObject');
  });

  it('uses StringEquals/aws:PrincipalAccount condition when sourceAccountIds provided without organizationId', () => {
    const config = buildConfig({
      accountMode: 'multi',
      sourceAccountIds: ['111111111111', '222222222222'],
    });
    const { template } = buildStorageStack(config);

    const policies = template.findResources('AWS::S3::BucketPolicy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{
            Sid?: string;
            Condition?: { StringEquals?: { 'aws:PrincipalAccount'?: string[] } };
          }>;
        };
      };
    }>;

    const crossAccountPolicy = policyValues.find((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => stmt.Sid === 'AllowCrossAccountPutObject');
    });

    const crossAccountStatement = crossAccountPolicy?.Properties?.PolicyDocument?.Statement?.find(
      (stmt) => stmt.Sid === 'AllowCrossAccountPutObject',
    );

    expect(crossAccountStatement?.Condition?.StringEquals?.['aws:PrincipalAccount']).toEqual(
      expect.arrayContaining(['111111111111', '222222222222']),
    );
  });

  it('uses StringEquals/aws:PrincipalOrgID condition when organizationId is provided', () => {
    const config = buildConfig({
      accountMode: 'multi',
      sourceAccountIds: ['111111111111'],
      organizationId: 'o-abc123def456',
    });
    const { template } = buildStorageStack(config);

    const policies = template.findResources('AWS::S3::BucketPolicy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{
            Sid?: string;
            Condition?: { StringEquals?: { 'aws:PrincipalOrgID'?: string } };
          }>;
        };
      };
    }>;

    const crossAccountPolicy = policyValues.find((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => stmt.Sid === 'AllowCrossAccountPutObject');
    });

    const crossAccountStatement = crossAccountPolicy?.Properties?.PolicyDocument?.Statement?.find(
      (stmt) => stmt.Sid === 'AllowCrossAccountPutObject',
    );

    expect(crossAccountStatement?.Condition?.StringEquals?.['aws:PrincipalOrgID']).toBe('o-abc123def456');
  });
});

// ---------------------------------------------------------------------------
// Source account setup template validation (Requirement 16.4, 16.5)
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

/**
 * Parses a CloudFormation YAML template, handling CF intrinsic function tags
 * (e.g. !Sub, !Ref, !GetAtt) by treating them as plain strings.
 */
function parseCfnTemplate(content: string): Record<string, unknown> {
  // Register CloudFormation intrinsic function tags as plain scalars
  const cfnTags = ['Sub', 'Ref', 'GetAtt', 'If', 'Select', 'Join', 'Split', 'FindInMap', 'Base64', 'Condition', 'ImportValue', 'Transform'];
  const customTags: yaml.Tags = cfnTags.map((tag) => ({
    tag: `!${tag}`,
    resolve: (_doc: unknown, cst: unknown) => {
      const node = cst as { value?: unknown };
      return node.value ?? null;
    },
  }));
  return yaml.parse(content, { customTags }) as Record<string, unknown>;
}

describe('source-account-setup.yaml - CloudFormation template structure', () => {
  const templatePath = path.join(__dirname, '../../../templates/source-account-setup.yaml');

  it('template file exists at templates/source-account-setup.yaml', () => {
    expect(fs.existsSync(templatePath)).toBe(true);
  });

  it('template is valid YAML', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');
    expect(() => parseCfnTemplate(content)).not.toThrow();
  });

  it('template has AWSTemplateFormatVersion', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');
    const template = parseCfnTemplate(content);
    expect(template['AWSTemplateFormatVersion']).toBe('2010-09-09');
  });

  it('template has Parameters section with CentralAccountId and CentralBucketArn', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');
    const template = parseCfnTemplate(content);
    const params = template['Parameters'] as Record<string, unknown>;

    expect(params).toBeDefined();
    expect(params['CentralAccountId']).toBeDefined();
    expect(params['CentralBucketArn']).toBeDefined();
  });

  it('CentralAccountId parameter has AllowedPattern for 12-digit account ID', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');
    const template = parseCfnTemplate(content);
    const params = template['Parameters'] as Record<string, Record<string, unknown>>;
    const centralAccountId = params['CentralAccountId'];

    expect(centralAccountId['AllowedPattern']).toBeDefined();
    // Pattern should match 12-digit account IDs
    const pattern = new RegExp(centralAccountId['AllowedPattern'] as string);
    expect(pattern.test('123456789012')).toBe(true);
    expect(pattern.test('12345')).toBe(false);
  });

  it('template has Resources section with BedrockLogDeliveryRole', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');
    const template = parseCfnTemplate(content);
    const resources = template['Resources'] as Record<string, Record<string, unknown>>;

    expect(resources).toBeDefined();
    expect(resources['BedrockLogDeliveryRole']).toBeDefined();
    expect(resources['BedrockLogDeliveryRole']['Type']).toBe('AWS::IAM::Role');
  });

  it('BedrockLogDeliveryRole has trust policy allowing central account to assume it', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');
    const template = parseCfnTemplate(content);
    const resources = template['Resources'] as Record<string, Record<string, unknown>>;
    const role = resources['BedrockLogDeliveryRole'] as Record<string, unknown>;
    const props = role['Properties'] as Record<string, unknown>;
    const trustPolicy = props['AssumeRolePolicyDocument'] as Record<string, unknown>;

    expect(trustPolicy).toBeDefined();
    const statements = trustPolicy['Statement'] as Array<Record<string, unknown>>;
    expect(statements).toBeDefined();
    expect(statements.length).toBeGreaterThan(0);

    // At least one statement should allow sts:AssumeRole
    const hasAssumeRole = statements.some(
      (stmt) => stmt['Action'] === 'sts:AssumeRole' && stmt['Effect'] === 'Allow',
    );
    expect(hasAssumeRole).toBe(true);
  });

  it('template has Resources section with BedrockLogDeliveryPolicy', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');
    const template = parseCfnTemplate(content);
    const resources = template['Resources'] as Record<string, Record<string, unknown>>;

    expect(resources['BedrockLogDeliveryPolicy']).toBeDefined();
    expect(resources['BedrockLogDeliveryPolicy']['Type']).toBe('AWS::IAM::ManagedPolicy');
  });

  it('BedrockLogDeliveryPolicy grants s3:PutObject permission', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');
    const template = parseCfnTemplate(content);
    const resources = template['Resources'] as Record<string, Record<string, unknown>>;
    const policy = resources['BedrockLogDeliveryPolicy'] as Record<string, unknown>;
    const props = policy['Properties'] as Record<string, unknown>;
    const policyDoc = props['PolicyDocument'] as Record<string, unknown>;
    const statements = policyDoc['Statement'] as Array<Record<string, unknown>>;

    const hasPutObject = statements.some((stmt) => {
      const actions = Array.isArray(stmt['Action']) ? stmt['Action'] : [stmt['Action']];
      return actions.includes('s3:PutObject') && stmt['Effect'] === 'Allow';
    });
    expect(hasPutObject).toBe(true);
  });

  it('BedrockLogDeliveryPolicy grants bedrock:PutModelInvocationLoggingConfiguration permission', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');
    const template = parseCfnTemplate(content);
    const resources = template['Resources'] as Record<string, Record<string, unknown>>;
    const policy = resources['BedrockLogDeliveryPolicy'] as Record<string, unknown>;
    const props = policy['Properties'] as Record<string, unknown>;
    const policyDoc = props['PolicyDocument'] as Record<string, unknown>;
    const statements = policyDoc['Statement'] as Array<Record<string, unknown>>;

    const hasBedrockLogging = statements.some((stmt) => {
      const actions = Array.isArray(stmt['Action']) ? stmt['Action'] : [stmt['Action']];
      return (
        actions.includes('bedrock:PutModelInvocationLoggingConfiguration') &&
        stmt['Effect'] === 'Allow'
      );
    });
    expect(hasBedrockLogging).toBe(true);
  });

  it('template has Outputs section with BedrockLogDeliveryRoleArn', () => {
    const content = fs.readFileSync(templatePath, 'utf-8');
    const template = parseCfnTemplate(content);
    const outputs = template['Outputs'] as Record<string, unknown>;

    expect(outputs).toBeDefined();
    expect(outputs['BedrockLogDeliveryRoleArn']).toBeDefined();
  });
});
