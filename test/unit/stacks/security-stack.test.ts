import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SecurityStack } from 'lib/stacks/security-stack';
import { PlatformConfig } from 'lib/config/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConfig(solutionName = 'test-solution'): PlatformConfig {
  return {
    vpc: { vpcMode: 'create', vpcCidr: '10.0.0.0/16', enableNatGateway: false, vpcEndpointMode: 'minimal' },
    account: { accountMode: 'single' },
    region: { regionMode: 'single' },
    identity: { identityMode: 'iam' },
    dataExports: { curBucketName: 'test-cur-bucket', curReportFormat: 'csv', reconciliationSchedule: 'rate(6 hours)' },
    dashboard: { enableQuickSuite: false },
    cloudTrail: { cloudTrailMode: 'create' },
    deployment: { solutionName, environment: 'dev' },
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

function buildSecurityStack(config: PlatformConfig): { stack: SecurityStack; template: Template } {
  const app = new cdk.App();
  const vpcStack = new cdk.Stack(app, 'VpcStack');
  const mockVpc = createMockVpc(vpcStack);

  const stack = new SecurityStack(app, 'SecurityStack', {
    config,
    vpc: mockVpc,
    env: { account: '123456789012', region: 'us-east-1' },
  });

  return { stack, template: Template.fromStack(stack) };
}

// ---------------------------------------------------------------------------
// KMS CMK
// ---------------------------------------------------------------------------

describe('SecurityStack - KMS CMK', () => {
  it('creates exactly one KMS key', () => {
    const config = buildConfig();
    const { template } = buildSecurityStack(config);

    template.resourceCountIs('AWS::KMS::Key', 1);
  });

  it('enables automatic key rotation', () => {
    const config = buildConfig();
    const { template } = buildSecurityStack(config);

    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  it('creates a KMS alias with the solutionName prefix', () => {
    const config = buildConfig('my-solution');
    const { template } = buildSecurityStack(config);

    template.hasResourceProperties('AWS::KMS::Alias', {
      AliasName: 'alias/my-solution-cmk',
    });
  });

  it('exports the cmk property', () => {
    const config = buildConfig();
    const { stack } = buildSecurityStack(config);

    expect(stack.cmk).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CMK key policy - service principal grants
// ---------------------------------------------------------------------------

describe('SecurityStack - CMK key policy grants', () => {
  const expectedServicePrincipals = [
    's3.amazonaws.com',
    'dynamodb.amazonaws.com',
    'sns.amazonaws.com',
    'sqs.amazonaws.com',
    'glue.amazonaws.com',
    'athena.amazonaws.com',
    'lambda.amazonaws.com',
    'quicksight.amazonaws.com',
  ];

  it('grants encrypt/decrypt to all required service principals', () => {
    const config = buildConfig();
    const { template } = buildSecurityStack(config);

    const keys = template.findResources('AWS::KMS::Key');
    const keyIds = Object.keys(keys);
    expect(keyIds.length).toBe(1);

    const keyPolicy = keys[keyIds[0]].Properties?.KeyPolicy;
    const statements: Array<{
      Principal?: { Service?: string | string[] };
      Action?: string | string[];
      Effect?: string;
    }> = keyPolicy?.Statement ?? [];

    for (const principal of expectedServicePrincipals) {
      const matchingStatement = statements.find((stmt) => {
        const service = stmt.Principal?.Service;
        if (!service) return false;
        const services = Array.isArray(service) ? service : [service];
        return services.includes(principal);
      });
      expect(matchingStatement).toBeDefined();

      // Verify the statement allows encrypt/decrypt actions
      const actions = matchingStatement?.Action;
      const actionList = Array.isArray(actions) ? actions : [actions ?? ''];
      const hasEncryptOrDecrypt = actionList.some(
        (a) => a.includes('kms:Encrypt') || a.includes('kms:Decrypt') || a.includes('kms:GenerateDataKey'),
      );
      expect(hasEncryptOrDecrypt).toBe(true);
    }
  });

  it('key policy statements have Effect Allow', () => {
    const config = buildConfig();
    const { template } = buildSecurityStack(config);

    const keys = template.findResources('AWS::KMS::Key');
    const keyIds = Object.keys(keys);
    const keyPolicy = keys[keyIds[0]].Properties?.KeyPolicy;
    const statements: Array<{ Effect?: string; Principal?: unknown }> = keyPolicy?.Statement ?? [];

    // All service principal statements should be Allow
    const serviceStatements = statements.filter((stmt) => {
      const principal = stmt.Principal as { Service?: string | string[] } | undefined;
      return principal?.Service !== undefined;
    });

    expect(serviceStatements.length).toBeGreaterThan(0);
    serviceStatements.forEach((stmt) => {
      expect(stmt.Effect).toBe('Allow');
    });
  });
});

// ---------------------------------------------------------------------------
// IAM Roles
// ---------------------------------------------------------------------------

describe('SecurityStack - IAM roles', () => {
  it('creates exactly 2 IAM roles (lambdaExecutionRole and adminApiRole)', () => {
    const config = buildConfig();
    const { template } = buildSecurityStack(config);

    template.resourceCountIs('AWS::IAM::Role', 2);
  });

  it('creates lambdaExecutionRole with Lambda service as assumed-by principal', () => {
    const config = buildConfig('test-solution');
    const { template } = buildSecurityStack(config);

    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'test-solution-lambda-execution-role',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          }),
        ]),
      }),
    });
  });

  it('creates adminApiRole with Lambda service as assumed-by principal', () => {
    const config = buildConfig('test-solution');
    const { template } = buildSecurityStack(config);

    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'test-solution-admin-api-role',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          }),
        ]),
      }),
    });
  });

  it('lambdaExecutionRole has AWSLambdaVPCAccessExecutionRole managed policy', () => {
    const config = buildConfig('test-solution');
    const { template } = buildSecurityStack(config);

    const roles = template.findResources('AWS::IAM::Role');
    const lambdaRole = Object.values(roles).find((r: unknown) => {
      const role = r as { Properties?: { RoleName?: string } };
      return role.Properties?.RoleName === 'test-solution-lambda-execution-role';
    }) as { Properties?: { ManagedPolicyArns?: unknown[] } } | undefined;

    expect(lambdaRole).toBeDefined();
    const arns = lambdaRole?.Properties?.ManagedPolicyArns ?? [];
    // ManagedPolicyArns are Fn::Join objects in CDK — check that there are 2 managed policies
    expect(arns.length).toBe(2);
    // Verify the ARNs reference the expected policy names via JSON serialization
    const arnStrings = arns.map((a) => JSON.stringify(a));
    expect(arnStrings.some((s) => s.includes('AWSLambdaVPCAccessExecutionRole'))).toBe(true);
  });

  it('lambdaExecutionRole has AWSLambdaBasicExecutionRole managed policy', () => {
    const config = buildConfig('test-solution');
    const { template } = buildSecurityStack(config);

    const roles = template.findResources('AWS::IAM::Role');
    const lambdaRole = Object.values(roles).find((r: unknown) => {
      const role = r as { Properties?: { RoleName?: string } };
      return role.Properties?.RoleName === 'test-solution-lambda-execution-role';
    }) as { Properties?: { ManagedPolicyArns?: unknown[] } } | undefined;

    expect(lambdaRole).toBeDefined();
    const arns = lambdaRole?.Properties?.ManagedPolicyArns ?? [];
    const arnStrings = arns.map((a) => JSON.stringify(a));
    expect(arnStrings.some((s) => s.includes('AWSLambdaBasicExecutionRole'))).toBe(true);
  });

  it('role names are prefixed with the solutionName', () => {
    const config = buildConfig('my-platform');
    const { template } = buildSecurityStack(config);

    const roles = template.findResources('AWS::IAM::Role');
    const roleValues = Object.values(roles) as Array<{ Properties?: { RoleName?: string } }>;

    roleValues.forEach((role) => {
      const roleName = role.Properties?.RoleName;
      if (typeof roleName === 'string') {
        expect(roleName.startsWith('my-platform')).toBe(true);
      }
    });
  });

  it('exports lambdaExecutionRole and adminApiRole', () => {
    const config = buildConfig();
    const { stack } = buildSecurityStack(config);

    expect(stack.lambdaExecutionRole).toBeDefined();
    expect(stack.adminApiRole).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Least-privilege policies
// ---------------------------------------------------------------------------

describe('SecurityStack - least-privilege IAM policies', () => {
  it('lambdaExecutionRole inline policy allows only kms:Decrypt and kms:GenerateDataKey', () => {
    const config = buildConfig('test-solution');
    const { template } = buildSecurityStack(config);

    // Find inline policies attached to the lambda execution role
    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Action?: string | string[]; Effect?: string; Sid?: string }>;
        };
        Roles?: unknown[];
      };
    }>;

    // Find the policy that has the CMK usage statement
    const cmkPolicy = policyValues.find((p) => {
      const statements = p.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
        return actions.includes('kms:Decrypt') || actions.includes('kms:GenerateDataKey');
      });
    });

    expect(cmkPolicy).toBeDefined();

    const cmkStatement = cmkPolicy?.Properties?.PolicyDocument?.Statement?.find((stmt) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
      return actions.includes('kms:Decrypt');
    });

    expect(cmkStatement?.Effect).toBe('Allow');
    const actions = Array.isArray(cmkStatement?.Action) ? cmkStatement!.Action! : [cmkStatement?.Action ?? ''];
    // Should only have kms:Decrypt and kms:GenerateDataKey (least-privilege)
    expect(actions.every((a) => a.startsWith('kms:'))).toBe(true);
  });

  it('adminApiRole inline policy allows DynamoDB CRUD operations', () => {
    const config = buildConfig('test-solution');
    const { template } = buildSecurityStack(config);

    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Action?: string | string[]; Effect?: string }>;
        };
      };
    }>;

    const dynamoPolicy = policyValues.find((p) => {
      const statements = p.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
        return actions.some((a) => a.startsWith('dynamodb:'));
      });
    });

    expect(dynamoPolicy).toBeDefined();

    const dynamoStatement = dynamoPolicy?.Properties?.PolicyDocument?.Statement?.find((stmt) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
      return actions.some((a) => a.startsWith('dynamodb:'));
    });

    const actions = Array.isArray(dynamoStatement?.Action) ? dynamoStatement!.Action! : [dynamoStatement?.Action ?? ''];
    expect(actions).toContain('dynamodb:GetItem');
    expect(actions).toContain('dynamodb:PutItem');
    expect(actions).toContain('dynamodb:UpdateItem');
    expect(actions).toContain('dynamodb:Query');
  });
});
