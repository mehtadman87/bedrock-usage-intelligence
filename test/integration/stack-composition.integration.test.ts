/**
 * Integration tests for CDK stack composition.
 *
 * Tests full CDK synth with minimal and maximal configs, verifies the stack
 * dependency chain, and checks cross-stack references are correctly wired.
 *
 * Requirements: 15.1, 15.2
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PlatformConfig } from 'lib/config/schema';
import { NetworkStack } from 'lib/stacks/network-stack';
import { SecurityStack } from 'lib/stacks/security-stack';
import { StorageStack } from 'lib/stacks/storage-stack';
import { IngestionStack } from 'lib/stacks/ingestion-stack';
import { IdentityStack } from 'lib/stacks/identity-stack';
import { AnalyticsStack } from 'lib/stacks/analytics-stack';
import { ApiStack } from 'lib/stacks/api-stack';
import { MonitoringStack } from 'lib/stacks/monitoring-stack';

// ---------------------------------------------------------------------------
// Config factories
// ---------------------------------------------------------------------------

/** Minimal config: all defaults, single account, single region, IAM identity,
 *  CUR data exports, existing cloudtrail, no quicksight, create VPC. */
const minimalConfig: PlatformConfig = {
  vpc: {
    vpcMode: 'create',
    vpcCidr: '10.0.0.0/16',
    enableNatGateway: false,
    vpcEndpointMode: 'minimal',
  },
  account: { accountMode: 'single' },
  region: { regionMode: 'single' },
  identity: { identityMode: 'iam' },
  dataExports: { curBucketName: 'test-cur-bucket', curReportFormat: 'csv', reconciliationSchedule: 'rate(6 hours)' },
  dashboard: { enableQuickSuite: false },
  cloudTrail: {
    cloudTrailMode: 'existing',
    existingCloudTrailBucket: 'existing-cloudtrail-bucket',
  },
  deployment: {
    solutionName: 'test-minimal',
    environment: 'dev',
    tags: { Project: 'test' },
  },
  enableInvocationLogging: true,
};

/** Maximal config: existing VPC, multi-account with org, multi-region, SSO identity,
 *  CUR parquet format, QuickSight Enterprise, create cloudtrail. */
const maximalConfig: PlatformConfig = {
  vpc: {
    vpcMode: 'existing',
    existingVpcId: 'vpc-0abc1234def56789a',
    enableNatGateway: true,
    vpcEndpointMode: 'full',
  },
  account: {
    accountMode: 'multi',
    sourceAccountIds: ['123456789012', '234567890123'],
    organizationId: 'o-abc1234567',
  },
  region: {
    regionMode: 'multi',
    sourceRegions: ['us-east-1', 'us-west-2', 'eu-west-1'],
  },
  identity: {
    identityMode: 'sso',
    identityStoreId: 'd-1234567890',
  },
  dataExports: { curBucketName: 'test-cur-bucket', curReportFormat: 'parquet', reconciliationSchedule: 'rate(6 hours)' },
  dashboard: {
    enableQuickSuite: true,
    quickSuiteEdition: 'ENTERPRISE',
    quickSightPrincipalArn: 'arn:aws:quicksight:us-east-1:123456789012:user/default/admin',
  },
  cloudTrail: { cloudTrailMode: 'create' },
  deployment: {
    solutionName: 'test-maximal',
    environment: 'production',
    tags: { Project: 'test', Team: 'platform' },
  },
  enableInvocationLogging: true,
};

// ---------------------------------------------------------------------------
// Stack composition helper
// ---------------------------------------------------------------------------

interface AllStacks {
  app: cdk.App;
  networkStack: NetworkStack;
  securityStack: SecurityStack;
  storageStack: StorageStack;
  ingestionStack: IngestionStack;
  identityStack: IdentityStack;
  analyticsStack: AnalyticsStack;
  apiStack: ApiStack;
  monitoringStack: MonitoringStack;
}

/**
 * Instantiate all stacks in dependency order, mirroring bin/app.ts.
 * Uses a fixed account/region so CDK doesn't require environment lookups.
 */
function buildAllStacks(config: PlatformConfig): AllStacks {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const solutionName = config.deployment.solutionName;

  const networkStack = new NetworkStack(app, `${solutionName}-network`, { env, config });
  const vpc = networkStack.vpc;

  const securityStack = new SecurityStack(app, `${solutionName}-security`, { env, config, vpc });
  securityStack.addDependency(networkStack);

  const storageStack = new StorageStack(app, `${solutionName}-storage`, {
    env, config, cmk: securityStack.cmk,
  });
  storageStack.addDependency(securityStack);

  const ingestionStack = new IngestionStack(app, `${solutionName}-ingestion`, {
    env, config, vpc,
    privateSubnets: networkStack.privateSubnets,
    lambdaSecurityGroup: networkStack.lambdaSecurityGroup,
    cmk: securityStack.cmk,
    rawLogsBucket: storageStack.rawLogsBucket,
    processedDataBucket: storageStack.processedDataBucket,
    failedRecordsBucket: storageStack.failedRecordsBucket,
    idempotencyTable: storageStack.idempotencyTable,
    curBucketName: config.dataExports.curBucketName,
  });
  ingestionStack.addDependency(storageStack);
  ingestionStack.addDependency(networkStack);

  const identityStack = new IdentityStack(app, `${solutionName}-identity`, {
    env, config, vpc,
    privateSubnets: networkStack.privateSubnets,
    lambdaSecurityGroup: networkStack.lambdaSecurityGroup,
    cmk: securityStack.cmk,
    identityCacheTable: storageStack.identityCacheTable,
  });
  identityStack.addDependency(storageStack);
  identityStack.addDependency(networkStack);

  const analyticsStack = new AnalyticsStack(app, `${solutionName}-analytics`, {
    env, config, cmk: securityStack.cmk,
    processedDataBucket: storageStack.processedDataBucket,
  });
  analyticsStack.addDependency(storageStack);

  const apiStack = new ApiStack(app, `${solutionName}-api`, {
    env, config, vpc,
    apiGatewaySecurityGroup: networkStack.apiGatewaySecurityGroup,
    vpcEndpointSecurityGroup: networkStack.vpcEndpointSecurityGroup,
    cmk: securityStack.cmk,
    runtimeConfigTable: storageStack.runtimeConfigTable,
  });
  apiStack.addDependency(storageStack);
  apiStack.addDependency(networkStack);

  const allDlqs = [
    ingestionStack.invocationDlq,
    ingestionStack.cloudTrailDlq,
    ingestionStack.metricsDlq,
    ingestionStack.curProcessorDlq,
    ingestionStack.costReconcilerDlq,
  ];
  const allLambdaFunctions = [
    ingestionStack.invocationProcessor,
    ingestionStack.cloudTrailProcessor,
    ingestionStack.metricsCollector,
    ingestionStack.curProcessor,
    ingestionStack.costReconciler,
    identityStack.identityResolver,
  ];

  const monitoringStack = new MonitoringStack(app, `${solutionName}-monitoring`, {
    env, config, cmk: securityStack.cmk,
    dlqs: allDlqs,
    lambdaFunctions: allLambdaFunctions,
  });
  monitoringStack.addDependency(ingestionStack);
  monitoringStack.addDependency(identityStack);
  monitoringStack.addDependency(analyticsStack);
  monitoringStack.addDependency(apiStack);

  // Wire cross-stack references (mirrors bin/app.ts)
  identityStack.identityResolver.grantInvoke(ingestionStack.invocationProcessor);
  identityStack.identityResolver.grantInvoke(ingestionStack.cloudTrailProcessor);
  ingestionStack.invocationProcessor.addEnvironment(
    'IDENTITY_RESOLVER_ARN',
    identityStack.identityResolver.functionArn,
  );
  ingestionStack.cloudTrailProcessor.addEnvironment(
    'IDENTITY_RESOLVER_ARN',
    identityStack.identityResolver.functionArn,
  );

  return {
    app, networkStack, securityStack, storageStack,
    ingestionStack, identityStack, analyticsStack, apiStack, monitoringStack,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Stack composition integration tests', () => {
  // ── Minimal config ─────────────────────────────────────────────────────────

  describe('Minimal config (all defaults)', () => {
    let stacks: AllStacks;

    beforeAll(() => {
      stacks = buildAllStacks(minimalConfig);
    });

    it('synthesizes all stacks without errors', () => {
      expect(() => stacks.app.synth()).not.toThrow();
    });

    it('NetworkStack synthesizes with a VPC', () => {
      const template = Template.fromStack(stacks.networkStack);
      template.resourceCountIs('AWS::EC2::VPC', 1);
    });

    it('SecurityStack synthesizes with a KMS CMK', () => {
      const template = Template.fromStack(stacks.securityStack);
      template.resourceCountIs('AWS::KMS::Key', 1);
      template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    });

    it('StorageStack synthesizes with 3 S3 buckets and 3 DynamoDB tables', () => {
      const template = Template.fromStack(stacks.storageStack);
      template.resourceCountIs('AWS::S3::Bucket', 3);
      template.resourceCountIs('AWS::DynamoDB::Table', 3);
    });

    it('IngestionStack synthesizes with Lambda functions and DLQs', () => {
      const template = Template.fromStack(stacks.ingestionStack);
      const lambdas = template.findResources('AWS::Lambda::Function');
      expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(3);
    });

    it('IdentityStack synthesizes with an Identity Resolver Lambda', () => {
      const template = Template.fromStack(stacks.identityStack);
      const lambdas = template.findResources('AWS::Lambda::Function');
      expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(1);
    });

    it('AnalyticsStack synthesizes with Glue database and Athena workgroup', () => {
      const template = Template.fromStack(stacks.analyticsStack);
      template.resourceCountIs('AWS::Glue::Database', 1);
      template.resourceCountIs('AWS::Athena::WorkGroup', 1);
    });

    it('AnalyticsStack does NOT create QuickSight resources when disabled', () => {
      const template = Template.fromStack(stacks.analyticsStack);
      template.resourceCountIs('AWS::QuickSight::DataSource', 0);
      template.resourceCountIs('AWS::QuickSight::DataSet', 0);
    });

    it('ApiStack synthesizes with a private REST API Gateway', () => {
      const template = Template.fromStack(stacks.apiStack);
      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        EndpointConfiguration: { Types: ['PRIVATE'] },
      });
    });

    it('MonitoringStack synthesizes with an SNS alarm topic', () => {
      const template = Template.fromStack(stacks.monitoringStack);
      template.resourceCountIs('AWS::SNS::Topic', 1);
    });

    it('MonitoringStack has CloudWatch alarms for DLQs', () => {
      const template = Template.fromStack(stacks.monitoringStack);
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      const dlqAlarms = Object.values(alarms).filter((r: any) => {
        const alarmName = r.Properties?.AlarmName ?? '';
        const alarmDesc = r.Properties?.AlarmDescription ?? '';
        return (
          (typeof alarmName === 'string' && alarmName.includes('dlq')) ||
          (typeof alarmDesc === 'string' && alarmDesc.includes('DLQ'))
        );
      });
      expect(dlqAlarms.length).toBeGreaterThanOrEqual(3);
    });

    it('No PricingStack or pricing-related resources exist', () => {
      const ingestionTemplate = Template.fromStack(stacks.ingestionStack);
      const lambdas = ingestionTemplate.findResources('AWS::Lambda::Function');
      const hasPricingEnv = Object.values(lambdas).some((fn: any) => {
        const envVars = fn.Properties?.Environment?.Variables ?? {};
        return 'PRICING_ENGINE_ARN' in envVars || 'PRICING_SCRAPER_ARN' in envVars;
      });
      expect(hasPricingEnv).toBe(false);
    });
  });

  // ── Maximal config ─────────────────────────────────────────────────────────

  describe('Maximal config (multi-account, multi-region, SSO, QuickSight Enterprise)', () => {
    let stacks: AllStacks;

    beforeAll(() => {
      stacks = buildAllStacks(maximalConfig);
    });

    it('synthesizes all stacks without errors', () => {
      expect(() => stacks.app.synth()).not.toThrow();
    });

    it('NetworkStack uses existing VPC (no AWS::EC2::VPC resource)', () => {
      const template = Template.fromStack(stacks.networkStack);
      template.resourceCountIs('AWS::EC2::VPC', 0);
    });

    it('NetworkStack creates full set of VPC endpoints', () => {
      const template = Template.fromStack(stacks.networkStack);
      const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
      expect(Object.keys(endpoints).length).toBeGreaterThan(5);
    });

    it('StorageStack has cross-account bucket policy on rawLogsBucket', () => {
      const template = Template.fromStack(stacks.storageStack);
      const policies = template.findResources('AWS::S3::BucketPolicy');
      const policyValues = Object.values(policies) as any[];
      const hasOrgCondition = policyValues.some((p) => {
        return JSON.stringify(p).includes('PrincipalOrgID');
      });
      expect(hasOrgCondition).toBe(true);
    });

    it('IngestionStack creates a CloudTrail trail when cloudTrailMode is "create"', () => {
      const template = Template.fromStack(stacks.ingestionStack);
      template.resourceCountIs('AWS::CloudTrail::Trail', 1);
    });

    it('IdentityStack grants Identity Store permissions for SSO mode', () => {
      const template = Template.fromStack(stacks.identityStack);
      const policies = template.findResources('AWS::IAM::Policy');
      const policyValues = Object.values(policies) as any[];
      const hasIdentityStorePermission = policyValues.some((p) =>
        JSON.stringify(p).includes('identitystore:DescribeUser'),
      );
      expect(hasIdentityStorePermission).toBe(true);
    });

    it('AnalyticsStack creates QuickSight resources when enabled', () => {
      const template = Template.fromStack(stacks.analyticsStack);
      template.resourceCountIs('AWS::QuickSight::DataSource', 1);
      const datasets = template.findResources('AWS::QuickSight::DataSet');
      expect(Object.keys(datasets).length).toBeGreaterThanOrEqual(2);
    });

    it('AnalyticsStack configures multi-region partition projection', () => {
      const template = Template.fromStack(stacks.analyticsStack);
      const tables = template.findResources('AWS::Glue::Table');
      const tableValues = Object.values(tables) as any[];
      const hasRegionProjection = tableValues.some((t) =>
        JSON.stringify(t).includes('projection.region.type'),
      );
      expect(hasRegionProjection).toBe(true);
    });

    it('MonitoringStack applies production log retention (365 days)', () => {
      const template = Template.fromStack(stacks.monitoringStack);
      const logRetentions = template.findResources('Custom::LogRetention');
      const retentionValues = Object.values(logRetentions) as any[];
      const hasYearRetention = retentionValues.some((r) =>
        JSON.stringify(r).includes('365'),
      );
      expect(hasYearRetention).toBe(true);
    });
  });

  // ── Stack dependency chain ─────────────────────────────────────────────────

  describe('Stack dependency chain', () => {
    let stacks: AllStacks;

    beforeAll(() => {
      stacks = buildAllStacks(minimalConfig);
    });

    it('SecurityStack depends on NetworkStack', () => {
      expect(stacks.securityStack.dependencies).toContain(stacks.networkStack);
    });

    it('StorageStack depends on SecurityStack', () => {
      expect(stacks.storageStack.dependencies).toContain(stacks.securityStack);
    });

    it('IngestionStack depends on StorageStack and NetworkStack', () => {
      expect(stacks.ingestionStack.dependencies).toContain(stacks.storageStack);
      expect(stacks.ingestionStack.dependencies).toContain(stacks.networkStack);
    });

    it('IdentityStack depends on StorageStack and NetworkStack', () => {
      expect(stacks.identityStack.dependencies).toContain(stacks.storageStack);
      expect(stacks.identityStack.dependencies).toContain(stacks.networkStack);
    });

    it('AnalyticsStack depends on StorageStack', () => {
      expect(stacks.analyticsStack.dependencies).toContain(stacks.storageStack);
    });

    it('ApiStack depends on StorageStack and NetworkStack', () => {
      expect(stacks.apiStack.dependencies).toContain(stacks.storageStack);
      expect(stacks.apiStack.dependencies).toContain(stacks.networkStack);
    });

    it('MonitoringStack depends on IngestionStack, IdentityStack, AnalyticsStack, ApiStack', () => {
      expect(stacks.monitoringStack.dependencies).toContain(stacks.ingestionStack);
      expect(stacks.monitoringStack.dependencies).toContain(stacks.identityStack);
      expect(stacks.monitoringStack.dependencies).toContain(stacks.analyticsStack);
      expect(stacks.monitoringStack.dependencies).toContain(stacks.apiStack);
    });

    it('NetworkStack has no dependencies', () => {
      expect(stacks.networkStack.dependencies).toHaveLength(0);
    });

    it('has no circular dependencies (app synth succeeds)', () => {
      expect(() => stacks.app.synth()).not.toThrow();
    });
  });

  // ── Cross-stack references ─────────────────────────────────────────────────

  describe('Cross-stack references', () => {
    let stacks: AllStacks;

    beforeAll(() => {
      stacks = buildAllStacks(minimalConfig);
    });

    it('IngestionStack Lambda has IDENTITY_RESOLVER_ARN env var wired from IdentityStack', () => {
      const template = Template.fromStack(stacks.ingestionStack);
      const lambdas = template.findResources('AWS::Lambda::Function');
      const invocationProcessor = Object.values(lambdas).find((fn: any) =>
        JSON.stringify(fn.Properties?.Environment?.Variables ?? {}).includes('IDENTITY_RESOLVER_ARN'),
      ) as any;
      expect(invocationProcessor).toBeDefined();
    });

    it('IngestionStack has PROCESSED_DATA_BUCKET env var referencing StorageStack bucket', () => {
      const template = Template.fromStack(stacks.ingestionStack);
      const lambdas = template.findResources('AWS::Lambda::Function');
      const hasProcessedBucketRef = Object.values(lambdas).some((fn: any) => {
        const envVars = fn.Properties?.Environment?.Variables ?? {};
        return 'PROCESSED_DATA_BUCKET' in envVars;
      });
      expect(hasProcessedBucketRef).toBe(true);
    });

    it('IngestionStack has IDEMPOTENCY_TABLE env var referencing StorageStack table', () => {
      const template = Template.fromStack(stacks.ingestionStack);
      const lambdas = template.findResources('AWS::Lambda::Function');
      const hasIdempotencyRef = Object.values(lambdas).some((fn: any) => {
        const envVars = fn.Properties?.Environment?.Variables ?? {};
        return 'IDEMPOTENCY_TABLE' in envVars;
      });
      expect(hasIdempotencyRef).toBe(true);
    });

    it('IdentityStack has IDENTITY_CACHE_TABLE env var referencing StorageStack table', () => {
      const template = Template.fromStack(stacks.identityStack);
      const lambdas = template.findResources('AWS::Lambda::Function');
      const hasIdentityCacheRef = Object.values(lambdas).some((fn: any) => {
        const envVars = fn.Properties?.Environment?.Variables ?? {};
        return 'IDENTITY_CACHE_TABLE' in envVars;
      });
      expect(hasIdentityCacheRef).toBe(true);
    });

    it('ApiStack has RUNTIME_CONFIG_TABLE env var referencing StorageStack table', () => {
      const template = Template.fromStack(stacks.apiStack);
      const lambdas = template.findResources('AWS::Lambda::Function');
      const hasRuntimeConfigRef = Object.values(lambdas).some((fn: any) => {
        const envVars = fn.Properties?.Environment?.Variables ?? {};
        return 'RUNTIME_CONFIG_TABLE' in envVars;
      });
      expect(hasRuntimeConfigRef).toBe(true);
    });

    it('MonitoringStack SNS topic is encrypted with CMK from SecurityStack', () => {
      const template = Template.fromStack(stacks.monitoringStack);
      template.hasResourceProperties('AWS::SNS::Topic', {
        KmsMasterKeyId: Match.anyValue(),
      });
    });
  });
});
