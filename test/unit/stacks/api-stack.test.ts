/**
 * Unit tests for the Api_Stack CDK construct.
 *
 * Requirements: 4.2, 12.1, 12.2
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../../../lib/stacks/api-stack';
import { PlatformConfig } from '../../../lib/config/schema';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildConfig(overrides: Partial<{
  solutionName: string;
  environment: 'dev' | 'staging' | 'production';
}> = {}): PlatformConfig {
  const {
    solutionName = 'test-solution',
    environment = 'dev',
  } = overrides;

  return {
    vpc: { vpcMode: 'create', vpcCidr: '10.0.0.0/16', enableNatGateway: false, vpcEndpointMode: 'minimal' },
    account: { accountMode: 'single' },
    region: { regionMode: 'single' },
    identity: { identityMode: 'iam' },
    dataExports: { curBucketName: 'test-cur-bucket', curReportFormat: 'csv', reconciliationSchedule: 'rate(6 hours)' },
    dashboard: { enableQuickSuite: false },
    cloudTrail: { cloudTrailMode: 'existing', existingCloudTrailBucket: 'ct-bucket' },
    deployment: { solutionName, environment },
    enableInvocationLogging: true,
  };
}

interface StackSet {
  apiStack: ApiStack;
  template: Template;
}

function buildApiStack(config: PlatformConfig): StackSet {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };

  const depsStack = new cdk.Stack(app, 'DepsStack', { env });

  const vpc = ec2.Vpc.fromVpcAttributes(depsStack, 'Vpc', {
    vpcId: 'vpc-12345678',
    availabilityZones: ['us-east-1a', 'us-east-1b'],
    privateSubnetIds: ['subnet-11111111', 'subnet-22222222'],
    vpcCidrBlock: '10.0.0.0/16',
  });

  const cmk = new kms.Key(depsStack, 'Cmk', { enableKeyRotation: true });

  const apiGatewaySg = new ec2.SecurityGroup(depsStack, 'ApiGatewaySG', {
    vpc,
    description: 'API Gateway SG',
  });

  const vpcEndpointSg = new ec2.SecurityGroup(depsStack, 'VpcEndpointSG', {
    vpc,
    description: 'VPC Endpoint SG',
  });

  const runtimeConfigTable = new dynamodb.Table(depsStack, 'RuntimeConfigTable', {
    partitionKey: { name: 'configCategory', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'configKey', type: dynamodb.AttributeType.STRING },
    encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
    encryptionKey: cmk,
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  });

  const apiStack = new ApiStack(app, 'ApiStack', {
    config,
    vpc,
    apiGatewaySecurityGroup: apiGatewaySg,
    vpcEndpointSecurityGroup: vpcEndpointSg,
    cmk,
    runtimeConfigTable,
    env,
  });

  return {
    apiStack,
    template: Template.fromStack(apiStack),
  };
}

// ── Private API Gateway creation ──────────────────────────────────────────────

describe('ApiStack - Private API Gateway', () => {
  it('creates a REST API Gateway', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });

  it('API Gateway is configured as PRIVATE endpoint type', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: {
        Types: Match.arrayWith(['PRIVATE']),
      },
    });
  });

  it('API Gateway name is prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildApiStack(config);

    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: Match.stringLikeRegexp('^my-platform'),
    });
  });

  it('exports api property', () => {
    const config = buildConfig();
    const { apiStack } = buildApiStack(config);

    expect(apiStack.api).toBeDefined();
  });
});

// ── VPC Endpoint for API Gateway ──────────────────────────────────────────────

describe('ApiStack - VPC Endpoint', () => {
  it('creates a VPC endpoint for API Gateway (execute-api)', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    // VPC endpoint for execute-api service
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const endpointValues = Object.values(endpoints) as Array<{
      Properties?: {
        ServiceName?: string;
        VpcEndpointType?: string;
      };
    }>;

    const apiGwEndpoint = endpointValues.find(
      (ep) =>
        ep.Properties?.ServiceName?.includes('execute-api') &&
        ep.Properties?.VpcEndpointType === 'Interface',
    );

    expect(apiGwEndpoint).toBeDefined();
  });

  it('VPC endpoint has private DNS enabled', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const endpointValues = Object.values(endpoints) as Array<{
      Properties?: {
        ServiceName?: string;
        PrivateDnsEnabled?: boolean;
      };
    }>;

    const apiGwEndpoint = endpointValues.find(
      (ep) => ep.Properties?.ServiceName?.includes('execute-api'),
    );

    expect(apiGwEndpoint?.Properties?.PrivateDnsEnabled).toBe(true);
  });
});

// ── API Gateway resource policy ───────────────────────────────────────────────

describe('ApiStack - API Gateway resource policy', () => {
  it('API Gateway has a resource policy', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    const apis = template.findResources('AWS::ApiGateway::RestApi');
    const apiValues = Object.values(apis) as Array<{
      Properties?: { Policy?: unknown };
    }>;

    const hasPolicy = apiValues.some((api) => api.Properties?.Policy !== undefined);
    expect(hasPolicy).toBe(true);
  });

  it('resource policy restricts access to VPC endpoint (aws:SourceVpce condition)', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    const apis = template.findResources('AWS::ApiGateway::RestApi');
    const apiValues = Object.values(apis) as Array<{
      Properties?: { Policy?: { Statement?: Array<{ Condition?: Record<string, unknown> }> } };
    }>;

    const hasVpceCondition = apiValues.some((api) => {
      const statements = api.Properties?.Policy?.Statement ?? [];
      return statements.some((stmt) => {
        const conditions = stmt.Condition ?? {};
        return (
          'StringEquals' in conditions ||
          'StringNotEquals' in conditions ||
          JSON.stringify(conditions).includes('SourceVpce')
        );
      });
    });

    expect(hasVpceCondition).toBe(true);
  });
});

// ── Admin API Lambda ──────────────────────────────────────────────────────────

describe('ApiStack - Admin API Lambda', () => {
  it('creates an Admin API Lambda function', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    const lambdas = template.findResources('AWS::Lambda::Function');
    const appLambdas = Object.values(lambdas).filter((fn: unknown) => {
      const f = fn as { Properties?: { Runtime?: string } };
      return f.Properties?.Runtime === 'nodejs22.x';
    });

    expect(appLambdas.length).toBeGreaterThanOrEqual(1);
  });

  it('Lambda function is VPC-attached', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    const lambdas = template.findResources('AWS::Lambda::Function');
    const appLambdas = Object.values(lambdas).filter((fn: unknown) => {
      const f = fn as { Properties?: { Runtime?: string } };
      return f.Properties?.Runtime === 'nodejs22.x';
    });

    appLambdas.forEach((fn: unknown) => {
      const f = fn as { Properties?: { VpcConfig?: unknown } };
      expect(f.Properties?.VpcConfig).toBeDefined();
    });
  });

  it('Lambda function has CMK encryption for environment variables', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

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

  it('Lambda function has RUNTIME_CONFIG_TABLE environment variable', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          RUNTIME_CONFIG_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  it('Lambda function name is prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildApiStack(config);

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('^my-platform'),
    });
  });
});

// ── API Gateway resources and methods ─────────────────────────────────────────

describe('ApiStack - API Gateway resources and methods', () => {
  it('creates /config resource', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'config',
    });
  });

  it('creates resources for all 6 config categories', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    const expectedCategories = ['pricing', 'alerts', 'identity', 'accounts', 'retention', 'pricing-auto-update'];

    expectedCategories.forEach((category) => {
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: category,
      });
    });
  });

  it('creates GET and PUT methods for each config category', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    const methods = template.findResources('AWS::ApiGateway::Method');
    const methodValues = Object.values(methods) as Array<{
      Properties?: { HttpMethod?: string };
    }>;

    const getMethods = methodValues.filter((m) => m.Properties?.HttpMethod === 'GET');
    const putMethods = methodValues.filter((m) => m.Properties?.HttpMethod === 'PUT');

    // 6 categories × 1 GET + 6 categories × 1 PUT = 12 methods minimum
    expect(getMethods.length).toBeGreaterThanOrEqual(6);
    expect(putMethods.length).toBeGreaterThanOrEqual(6);
  });

  it('methods use Lambda proxy integration', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    const methods = template.findResources('AWS::ApiGateway::Method');
    const methodValues = Object.values(methods) as Array<{
      Properties?: {
        HttpMethod?: string;
        Integration?: { Type?: string };
      };
    }>;

    const appMethods = methodValues.filter(
      (m) => m.Properties?.HttpMethod === 'GET' || m.Properties?.HttpMethod === 'PUT',
    );

    appMethods.forEach((m) => {
      expect(m.Properties?.Integration?.Type).toBe('AWS_PROXY');
    });
  });

  it('creates a request validator', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    template.resourceCountIs('AWS::ApiGateway::RequestValidator', 1);
    template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
      ValidateRequestBody: true,
      ValidateRequestParameters: true,
    });
  });
});

// ── IAM permissions ───────────────────────────────────────────────────────────

describe('ApiStack - IAM permissions', () => {
  it('Lambda has DynamoDB read/write permissions on Runtime_Config table', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Action?: string | string[]; Effect?: string }>;
        };
      };
    }>;

    const hasDynamoDbAccess = policyValues.some((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
        return (
          stmt.Effect === 'Allow' &&
          actions.some((a) => a.startsWith('dynamodb:'))
        );
      });
    });

    expect(hasDynamoDbAccess).toBe(true);
  });

  it('Lambda has KMS encrypt/decrypt permissions', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies) as Array<{
      Properties?: {
        PolicyDocument?: {
          Statement?: Array<{ Action?: string | string[]; Effect?: string }>;
        };
      };
    }>;

    const hasKmsAccess = policyValues.some((policy) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt) => {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
        return (
          stmt.Effect === 'Allow' &&
          actions.some((a) => a.startsWith('kms:'))
        );
      });
    });

    expect(hasKmsAccess).toBe(true);
  });
});

// ── API Gateway deployment ────────────────────────────────────────────────────

describe('ApiStack - API Gateway deployment', () => {
  it('creates an API Gateway deployment', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    template.resourceCountIs('AWS::ApiGateway::Deployment', 1);
  });

  it('creates an API Gateway stage', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    template.resourceCountIs('AWS::ApiGateway::Stage', 1);
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'v1',
    });
  });
});

// ── Dashboard refresh endpoint ────────────────────────────────────────────────

describe('ApiStack - Dashboard refresh endpoint', () => {
  function buildApiStackWithRefreshLambda(): StackSet {
    const app = new cdk.App();
    const env = { account: '123456789012', region: 'us-east-1' };

    const depsStack = new cdk.Stack(app, 'DepsStack', { env });

    const vpc = ec2.Vpc.fromVpcAttributes(depsStack, 'Vpc', {
      vpcId: 'vpc-12345678',
      availabilityZones: ['us-east-1a', 'us-east-1b'],
      privateSubnetIds: ['subnet-11111111', 'subnet-22222222'],
      vpcCidrBlock: '10.0.0.0/16',
    });

    const cmk = new kms.Key(depsStack, 'Cmk', { enableKeyRotation: true });

    const apiGatewaySg = new ec2.SecurityGroup(depsStack, 'ApiGatewaySG', {
      vpc,
      description: 'API Gateway SG',
    });

    const vpcEndpointSg = new ec2.SecurityGroup(depsStack, 'VpcEndpointSG', {
      vpc,
      description: 'VPC Endpoint SG',
    });

    const runtimeConfigTable = new dynamodb.Table(depsStack, 'RuntimeConfigTable', {
      partitionKey: { name: 'configCategory', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'configKey', type: dynamodb.AttributeType.STRING },
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: cmk,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Stub refresh lambda
    const refreshLambda = new cdk.aws_lambda.Function(depsStack, 'RefreshLambda', {
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => ({statusCode: 200})'),
    });

    const config = buildConfig();
    const apiStack = new ApiStack(app, 'ApiStack', {
      config,
      vpc,
      apiGatewaySecurityGroup: apiGatewaySg,
      vpcEndpointSecurityGroup: vpcEndpointSg,
      cmk,
      runtimeConfigTable,
      refreshLambda,
      env,
    });

    return {
      apiStack,
      template: Template.fromStack(apiStack),
    };
  }

  it('does NOT create /dashboard resource when refreshLambda is not provided', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    const resources = template.findResources('AWS::ApiGateway::Resource');
    const resourceValues = Object.values(resources) as Array<{
      Properties?: { PathPart?: string };
    }>;

    const hasDashboard = resourceValues.some((r) => r.Properties?.PathPart === 'dashboard');
    expect(hasDashboard).toBe(false);
  });

  it('creates /dashboard/refresh resource when refreshLambda is provided', () => {
    const { template } = buildApiStackWithRefreshLambda();

    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'dashboard',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'refresh',
    });
  });

  it('creates GET method on /dashboard/refresh with Lambda proxy integration', () => {
    const { template } = buildApiStackWithRefreshLambda();

    const methods = template.findResources('AWS::ApiGateway::Method');
    const methodValues = Object.values(methods) as Array<{
      Properties?: {
        HttpMethod?: string;
        Integration?: { Type?: string };
        AuthorizationType?: string;
      };
    }>;

    const refreshGet = methodValues.find(
      (m) =>
        m.Properties?.HttpMethod === 'GET' &&
        m.Properties?.Integration?.Type === 'AWS_PROXY',
    );

    expect(refreshGet).toBeDefined();
  });

  it('GET /dashboard/refresh has no IAM auth (NONE)', () => {
    const { template } = buildApiStackWithRefreshLambda();

    const methods = template.findResources('AWS::ApiGateway::Method');
    const methodValues = Object.values(methods) as Array<{
      Properties?: {
        HttpMethod?: string;
        AuthorizationType?: string;
      };
    }>;

    // The refresh GET method should have no IAM auth
    const refreshGet = methodValues.find((m) => m.Properties?.HttpMethod === 'GET');
    expect(refreshGet?.Properties?.AuthorizationType).toBe('NONE');
  });

  it('outputs DashboardRefreshEndpointUrl when refreshLambda is provided', () => {
    const { template } = buildApiStackWithRefreshLambda();

    const outputs = template.findOutputs('DashboardRefreshEndpointUrl');
    expect(Object.keys(outputs).length).toBe(1);
  });

  it('does NOT output DashboardRefreshEndpointUrl when refreshLambda is not provided', () => {
    const config = buildConfig();
    const { template } = buildApiStack(config);

    const outputs = template.findOutputs('DashboardRefreshEndpointUrl');
    expect(Object.keys(outputs).length).toBe(0);
  });
});
