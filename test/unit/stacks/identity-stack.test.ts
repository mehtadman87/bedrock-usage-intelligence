/**
 * Unit tests for the Identity_Stack CDK construct.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.8, 15.2
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IdentityStack } from 'lib/stacks/identity-stack';
import { PlatformConfig } from 'lib/config/schema';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildConfig(overrides: Partial<{
  identityMode: 'iam' | 'sso' | 'auto';
  identityStoreId: string;
  solutionName: string;
  environment: 'dev' | 'staging' | 'production';
}> = {}): PlatformConfig {
  const {
    identityMode = 'iam',
    identityStoreId = 'd-1234567890',
    solutionName = 'test-solution',
    environment = 'dev',
  } = overrides;

  const identity =
    identityMode === 'iam'
      ? { identityMode: 'iam' as const }
      : identityMode === 'sso'
      ? { identityMode: 'sso' as const, identityStoreId }
      : { identityMode: 'auto' as const, identityStoreId };

  return {
    vpc: { vpcMode: 'create', vpcCidr: '10.0.0.0/16', enableNatGateway: false, vpcEndpointMode: 'minimal' },
    account: { accountMode: 'single' },
    region: { regionMode: 'single' },
    identity,
    dataExports: { curBucketName: 'test-cur-bucket', curReportFormat: 'csv', reconciliationSchedule: 'rate(6 hours)' },
    dashboard: { enableQuickSuite: false },
    cloudTrail: { cloudTrailMode: 'existing', existingCloudTrailBucket: 'ct-bucket' },
    deployment: { solutionName, environment },
    enableInvocationLogging: true,
  };
}

interface StackSet {
  identityStack: IdentityStack;
  template: Template;
}

function buildIdentityStack(config: PlatformConfig): StackSet {
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

  const identityCacheTable = new dynamodb.Table(depsStack, 'IdentityCacheTable', {
    partitionKey: { name: 'principalArn', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sourceType', type: dynamodb.AttributeType.STRING },
    encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
    encryptionKey: cmk,
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  });

  const privateSubnets = vpc.selectSubnets({
    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
  }).subnets;

  const identityStack = new IdentityStack(app, 'IdentityStack', {
    config,
    vpc,
    privateSubnets,
    lambdaSecurityGroup: lambdaSg,
    cmk,
    identityCacheTable,
    env,
  });

  return {
    identityStack,
    template: Template.fromStack(identityStack),
  };
}

// ─── Lambda creation ──────────────────────────────────────────────────────────

describe('IdentityStack - Lambda creation', () => {
  it('creates exactly one Lambda function', () => {
    const config = buildConfig();
    const { template } = buildIdentityStack(config);
    template.resourceCountIs('AWS::Lambda::Function', 1);
  });

  it('Lambda uses nodejs22.x runtime', () => {
    const config = buildConfig();
    const { template } = buildIdentityStack(config);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    });
  });

  it('Lambda function name is prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildIdentityStack(config);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('^my-platform'),
    });
  });

  it('exports identityResolver Lambda function', () => {
    const config = buildConfig();
    const { identityStack } = buildIdentityStack(config);
    expect(identityStack.identityResolver).toBeDefined();
  });
});

// ─── VPC attachment ───────────────────────────────────────────────────────────

describe('IdentityStack - VPC attachment', () => {
  it('Lambda has VpcConfig', () => {
    const config = buildConfig();
    const { template } = buildIdentityStack(config);

    const lambdas = template.findResources('AWS::Lambda::Function');
    const appLambdas = Object.values(lambdas).filter((fn: unknown) => {
      const f = fn as { Properties?: { Runtime?: string } };
      return f.Properties?.Runtime === 'nodejs22.x';
    });

    expect(appLambdas.length).toBe(1);
    appLambdas.forEach((fn: unknown) => {
      const f = fn as { Properties?: { VpcConfig?: unknown } };
      expect(f.Properties?.VpcConfig).toBeDefined();
    });
  });

  it('Lambda references the provided security group', () => {
    const config = buildConfig();
    const { template } = buildIdentityStack(config);

    const lambdas = template.findResources('AWS::Lambda::Function');
    const appLambdas = Object.values(lambdas).filter((fn: unknown) => {
      const f = fn as { Properties?: { Runtime?: string } };
      return f.Properties?.Runtime === 'nodejs22.x';
    });

    appLambdas.forEach((fn: unknown) => {
      const f = fn as { Properties?: { VpcConfig?: { SecurityGroupIds?: unknown[] } } };
      expect(f.Properties?.VpcConfig?.SecurityGroupIds?.length).toBeGreaterThan(0);
    });
  });
});

// ─── Environment variable configuration ──────────────────────────────────────

describe('IdentityStack - environment variable configuration', () => {
  it('sets IDENTITY_MODE env var to iam', () => {
    const config = buildConfig({ identityMode: 'iam' });
    const { template } = buildIdentityStack(config);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ IDENTITY_MODE: 'iam' }),
      },
    });
  });

  it('sets IDENTITY_MODE env var to sso', () => {
    const config = buildConfig({ identityMode: 'sso', identityStoreId: 'd-abc123' });
    const { template } = buildIdentityStack(config);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ IDENTITY_MODE: 'sso', IDENTITY_STORE_ID: 'd-abc123' }),
      },
    });
  });

  it('sets IDENTITY_MODE env var to auto', () => {
    const config = buildConfig({ identityMode: 'auto', identityStoreId: 'd-xyz789' });
    const { template } = buildIdentityStack(config);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ IDENTITY_MODE: 'auto', IDENTITY_STORE_ID: 'd-xyz789' }),
      },
    });
  });

  it('sets IDENTITY_CACHE_TABLE env var', () => {
    const config = buildConfig();
    const { template } = buildIdentityStack(config);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ IDENTITY_CACHE_TABLE: Match.anyValue() }),
      },
    });
  });

  it('sets circuit breaker env vars', () => {
    const config = buildConfig();
    const { template } = buildIdentityStack(config);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CIRCUIT_BREAKER_THRESHOLD: '5',
          CIRCUIT_BREAKER_COOLDOWN: '60000',
        }),
      },
    });
  });

  it('sets RATE_LIMIT_MAX_RPS env var', () => {
    const config = buildConfig();
    const { template } = buildIdentityStack(config);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ RATE_LIMIT_MAX_RPS: '10' }),
      },
    });
  });
});

// ─── CMK encryption ───────────────────────────────────────────────────────────

describe('IdentityStack - CMK encryption', () => {
  it('Lambda has KmsKeyArn for environment variable encryption', () => {
    const config = buildConfig();
    const { template } = buildIdentityStack(config);

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

// ─── IAM permissions ─────────────────────────────────────────────────────────

describe('IdentityStack - IAM permissions', () => {
  it('grants DynamoDB read/write on Identity_Cache table', () => {
    const config = buildConfig();
    const { template } = buildIdentityStack(config);

    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Action?: string | string[]; Effect?: string }>;
        };
      };
    }>;

    const hasDdbAccess = policyValues.some((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
        return stmt.Effect === 'Allow' && actions.some((a) => a.startsWith('dynamodb:'));
      });
    });

    expect(hasDdbAccess).toBe(true);
  });

  it('grants Identity Store read permissions in SSO mode', () => {
    const config = buildConfig({ identityMode: 'sso', identityStoreId: 'd-abc123' });
    const { template } = buildIdentityStack(config);

    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Action?: string | string[]; Effect?: string }>;
        };
      };
    }>;

    const hasIdentityStoreAccess = policyValues.some((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
        return stmt.Effect === 'Allow' && actions.some((a) => a.startsWith('identitystore:'));
      });
    });

    expect(hasIdentityStoreAccess).toBe(true);
  });

  it('grants Identity Store read permissions in auto mode', () => {
    const config = buildConfig({ identityMode: 'auto', identityStoreId: 'd-abc123' });
    const { template } = buildIdentityStack(config);

    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Action?: string | string[]; Effect?: string }>;
        };
      };
    }>;

    const hasIdentityStoreAccess = policyValues.some((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
        return stmt.Effect === 'Allow' && actions.some((a) => a.startsWith('identitystore:'));
      });
    });

    expect(hasIdentityStoreAccess).toBe(true);
  });

  it('does NOT grant Identity Store permissions in IAM mode', () => {
    const config = buildConfig({ identityMode: 'iam' });
    const { template } = buildIdentityStack(config);

    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Action?: string | string[]; Effect?: string }>;
        };
      };
    }>;

    const hasIdentityStoreAccess = policyValues.some((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
        return stmt.Effect === 'Allow' && actions.some((a) => a.startsWith('identitystore:'));
      });
    });

    expect(hasIdentityStoreAccess).toBe(false);
  });
});
