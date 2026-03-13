/**
 * CDK synth tests for CUR migration.
 *
 * Verifies that the pricing stack and all pricing-related resources have been
 * removed, and that the new CUR Processor and Cost Reconciler Lambdas are
 * created with correct triggers and permissions.
 *
 * Validates: Requirements 2.1, 2.2
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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
// Config factory
// ---------------------------------------------------------------------------

const testConfig: PlatformConfig = {
  vpc: {
    vpcMode: 'create',
    vpcCidr: '10.0.0.0/16',
    enableNatGateway: false,
    vpcEndpointMode: 'minimal',
  },
  account: { accountMode: 'single' },
  region: { regionMode: 'single' },
  identity: { identityMode: 'iam' },
  dataExports: {
    curBucketName: 'test-cur-exports-bucket',
    curReportPrefix: 'cur-reports',
    curReportFormat: 'csv',
    reconciliationSchedule: 'rate(6 hours)',
  },
  dashboard: { enableQuickSuite: false },
  cloudTrail: {
    cloudTrailMode: 'existing',
    existingCloudTrailBucket: 'existing-cloudtrail-bucket',
  },
  deployment: {
    solutionName: 'test-synth',
    environment: 'dev',
    tags: { Project: 'test' },
  },
  enableInvocationLogging: true,
};

// ---------------------------------------------------------------------------
// Stack composition helper (mirrors bin/app.ts post-CUR-migration)
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

function buildAllStacks(config: PlatformConfig): AllStacks {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const solutionName = config.deployment.solutionName;

  const networkStack = new NetworkStack(app, `${solutionName}-network`, { env, config });
  const vpc = networkStack.vpc;

  const securityStack = new SecurityStack(app, `${solutionName}-security`, { env, config, vpc });
  securityStack.addDependency(networkStack);

  const storageStack = new StorageStack(app, `${solutionName}-storage`, {
    env,
    config,
    cmk: securityStack.cmk,
  });
  storageStack.addDependency(securityStack);

  const ingestionStack = new IngestionStack(app, `${solutionName}-ingestion`, {
    env,
    config,
    vpc,
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
    env,
    config,
    vpc,
    privateSubnets: networkStack.privateSubnets,
    lambdaSecurityGroup: networkStack.lambdaSecurityGroup,
    cmk: securityStack.cmk,
    identityCacheTable: storageStack.identityCacheTable,
  });
  identityStack.addDependency(storageStack);
  identityStack.addDependency(networkStack);

  const analyticsStack = new AnalyticsStack(app, `${solutionName}-analytics`, {
    env,
    config,
    cmk: securityStack.cmk,
    processedDataBucket: storageStack.processedDataBucket,
  });
  analyticsStack.addDependency(storageStack);

  const apiStack = new ApiStack(app, `${solutionName}-api`, {
    env,
    config,
    vpc,
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
    env,
    config,
    cmk: securityStack.cmk,
    dlqs: allDlqs,
    lambdaFunctions: allLambdaFunctions,
  });
  monitoringStack.addDependency(ingestionStack);
  monitoringStack.addDependency(identityStack);
  monitoringStack.addDependency(analyticsStack);
  monitoringStack.addDependency(apiStack);

  // Wire cross-stack references
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
    app,
    networkStack,
    securityStack,
    storageStack,
    ingestionStack,
    identityStack,
    analyticsStack,
    apiStack,
    monitoringStack,
  };
}

// ---------------------------------------------------------------------------
// Helper: stringify all resources in a template for text search
// ---------------------------------------------------------------------------
function templateJson(template: Template): string {
  return JSON.stringify(template.toJSON());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CDK synth — pricing removal verification', () => {
  let stacks: AllStacks;

  beforeAll(() => {
    stacks = buildAllStacks(testConfig);
    // Force synth to catch any circular dependency or synthesis errors
    stacks.app.synth();
  });

  it('synthesizes all stacks without errors (no PricingStack)', () => {
    expect(() => stacks.app.synth()).not.toThrow();
  });

  it('app has no stack with "pricing" in its name', () => {
    const stackNames = stacks.app.node.children
      .filter((c): c is cdk.Stack => c instanceof cdk.Stack)
      .map((s) => s.stackName);

    const pricingStacks = stackNames.filter((n) =>
      n.toLowerCase().includes('pricing'),
    );
    expect(pricingStacks).toHaveLength(0);
  });

  it('StorageStack has no Pricing_Rates DynamoDB table', () => {
    const template = Template.fromStack(stacks.storageStack);
    const tables = template.findResources('AWS::DynamoDB::Table');
    const tableNames = Object.values(tables).map(
      (t: any) => t.Properties?.TableName ?? '',
    );

    const pricingTables = tableNames.filter((n: string) =>
      n.toLowerCase().includes('pricing'),
    );
    expect(pricingTables).toHaveLength(0);
  });

  it('StorageStack has no PricingTableArn CfnOutput', () => {
    const template = Template.fromStack(stacks.storageStack);
    const outputs = template.toJSON().Outputs ?? {};
    const pricingOutputs = Object.keys(outputs).filter((k) =>
      k.toLowerCase().includes('pricing'),
    );
    expect(pricingOutputs).toHaveLength(0);
  });

  it('IngestionStack has no pricing retry queue', () => {
    const template = Template.fromStack(stacks.ingestionStack);
    const queues = template.findResources('AWS::SQS::Queue');
    const queueNames = Object.values(queues).map(
      (q: any) => q.Properties?.QueueName ?? '',
    );

    const pricingQueues = queueNames.filter((n: string) =>
      n.toLowerCase().includes('pricing'),
    );
    expect(pricingQueues).toHaveLength(0);
  });

  it('invocation processor has no PRICING_ENGINE_ARN env var', () => {
    const template = Template.fromStack(stacks.ingestionStack);
    const lambdas = template.findResources('AWS::Lambda::Function');
    const invocationProcessor = Object.values(lambdas).find((fn: any) => {
      const name = JSON.stringify(fn.Properties?.FunctionName ?? '');
      return name.includes('invocation-processor');
    }) as any;

    expect(invocationProcessor).toBeDefined();
    const envVars = invocationProcessor?.Properties?.Environment?.Variables ?? {};
    expect(envVars).not.toHaveProperty('PRICING_ENGINE_ARN');
  });

  it('invocation processor has no PRICING_SCRAPER_ARN env var', () => {
    const template = Template.fromStack(stacks.ingestionStack);
    const lambdas = template.findResources('AWS::Lambda::Function');
    const invocationProcessor = Object.values(lambdas).find((fn: any) => {
      const name = JSON.stringify(fn.Properties?.FunctionName ?? '');
      return name.includes('invocation-processor');
    }) as any;

    expect(invocationProcessor).toBeDefined();
    const envVars = invocationProcessor?.Properties?.Environment?.Variables ?? {};
    expect(envVars).not.toHaveProperty('PRICING_SCRAPER_ARN');
  });

  it('invocation processor has no PRICING_RETRY_QUEUE_URL env var', () => {
    const template = Template.fromStack(stacks.ingestionStack);
    const lambdas = template.findResources('AWS::Lambda::Function');
    const invocationProcessor = Object.values(lambdas).find((fn: any) => {
      const name = JSON.stringify(fn.Properties?.FunctionName ?? '');
      return name.includes('invocation-processor');
    }) as any;

    expect(invocationProcessor).toBeDefined();
    const envVars = invocationProcessor?.Properties?.Environment?.Variables ?? {};
    expect(envVars).not.toHaveProperty('PRICING_RETRY_QUEUE_URL');
  });

  it('no Lambda function across all stacks has a pricing-related function name', () => {
    const allStackRefs = [
      stacks.networkStack,
      stacks.securityStack,
      stacks.storageStack,
      stacks.ingestionStack,
      stacks.identityStack,
      stacks.analyticsStack,
      stacks.apiStack,
      stacks.monitoringStack,
    ];

    const allLambdaNames: string[] = [];
    for (const stack of allStackRefs) {
      const template = Template.fromStack(stack);
      const lambdas = template.findResources('AWS::Lambda::Function');
      for (const fn of Object.values(lambdas) as any[]) {
        const name = fn.Properties?.FunctionName ?? '';
        if (typeof name === 'string') allLambdaNames.push(name);
      }
    }

    const pricingLambdas = allLambdaNames.filter(
      (n) =>
        n.includes('pricing-scraper') ||
        n.includes('pricing-engine') ||
        n.includes('pricing-web-scraper'),
    );
    expect(pricingLambdas).toHaveLength(0);
  });

  it('no SQS queue across all stacks has a pricing-related name', () => {
    const allStackRefs = [
      stacks.ingestionStack,
      stacks.storageStack,
    ];

    const allQueueNames: string[] = [];
    for (const stack of allStackRefs) {
      const template = Template.fromStack(stack);
      const queues = template.findResources('AWS::SQS::Queue');
      for (const q of Object.values(queues) as any[]) {
        const name = q.Properties?.QueueName ?? '';
        if (typeof name === 'string') allQueueNames.push(name);
      }
    }

    const pricingQueues = allQueueNames.filter(
      (n) => n.includes('PricingRetry') || n.includes('pricing-retry'),
    );
    expect(pricingQueues).toHaveLength(0);
  });
});

describe('CDK synth — CUR Processor and Cost Reconciler verification', () => {
  let stacks: AllStacks;
  let ingestionTemplate: Template;

  beforeAll(() => {
    stacks = buildAllStacks(testConfig);
    stacks.app.synth();
    ingestionTemplate = Template.fromStack(stacks.ingestionStack);
  });

  it('CUR Processor Lambda is created', () => {
    ingestionTemplate.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('cur-processor'),
    });
  });

  it('Cost Reconciler Lambda is created', () => {
    ingestionTemplate.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('cost-reconciler'),
    });
  });

  it('CUR Processor has CUR_BUCKET env var', () => {
    ingestionTemplate.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('cur-processor'),
      Environment: {
        Variables: Match.objectLike({
          CUR_BUCKET: 'test-cur-exports-bucket',
        }),
      },
    });
  });

  it('CUR Processor has PROCESSED_DATA_BUCKET env var', () => {
    ingestionTemplate.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('cur-processor'),
      Environment: {
        Variables: Match.objectLike({
          PROCESSED_DATA_BUCKET: Match.anyValue(),
        }),
      },
    });
  });

  it('Cost Reconciler has PROCESSED_DATA_BUCKET env var', () => {
    ingestionTemplate.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('cost-reconciler'),
      Environment: {
        Variables: Match.objectLike({
          PROCESSED_DATA_BUCKET: Match.anyValue(),
        }),
      },
    });
  });

  it('CUR Processor DLQ and Cost Reconciler DLQ are created', () => {
    const queues = ingestionTemplate.findResources('AWS::SQS::Queue');
    const queueNames = Object.values(queues).map(
      (q: any) => q.Properties?.QueueName ?? '',
    );

    expect(queueNames.some((n: string) => n.includes('cur-processor-dlq'))).toBe(true);
    expect(queueNames.some((n: string) => n.includes('cost-reconciler-dlq'))).toBe(true);
  });

  it('EventBridge scheduled rules exist for CUR polling and cost reconciliation', () => {
    const rules = ingestionTemplate.findResources('AWS::Events::Rule');
    const ruleDescriptions = Object.values(rules).map(
      (r: any) => r.Properties?.Description ?? '',
    );

    expect(ruleDescriptions.some((d: string) => d.toLowerCase().includes('cur'))).toBe(true);
    expect(ruleDescriptions.some((d: string) => d.toLowerCase().includes('reconcil'))).toBe(true);
  });

  it('CUR Processor has S3 read permissions on CUR bucket', () => {
    const policies = ingestionTemplate.findResources('AWS::IAM::Policy');
    const allStatements = Object.values(policies).flatMap(
      (p: any) => p.Properties?.PolicyDocument?.Statement ?? [],
    );

    const curBucketReadStatements = allStatements.filter((stmt: any) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
      return (
        stmt.Effect === 'Allow' &&
        actions.some((a: string) => a === 's3:GetObject' || a === 's3:ListBucket')
      );
    });

    expect(curBucketReadStatements.length).toBeGreaterThan(0);
  });

  it('Cost Reconciler has Athena query execution permissions', () => {
    const policies = ingestionTemplate.findResources('AWS::IAM::Policy');
    const allStatements = Object.values(policies).flatMap(
      (p: any) => p.Properties?.PolicyDocument?.Statement ?? [],
    );

    const athenaStatements = allStatements.filter((stmt: any) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
      return (
        stmt.Effect === 'Allow' &&
        actions.some((a: string) => a.startsWith('athena:'))
      );
    });

    expect(athenaStatements.length).toBeGreaterThan(0);
  });

  it('Cost Reconciler has Glue catalog read permissions', () => {
    const policies = ingestionTemplate.findResources('AWS::IAM::Policy');
    const allStatements = Object.values(policies).flatMap(
      (p: any) => p.Properties?.PolicyDocument?.Statement ?? [],
    );

    const glueStatements = allStatements.filter((stmt: any) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action ?? ''];
      return (
        stmt.Effect === 'Allow' &&
        actions.some((a: string) => a.startsWith('glue:'))
      );
    });

    expect(glueStatements.length).toBeGreaterThan(0);
  });

  it('IngestionStack exports curProcessor and costReconciler properties', () => {
    expect(stacks.ingestionStack.curProcessor).toBeDefined();
    expect(stacks.ingestionStack.costReconciler).toBeDefined();
    expect(stacks.ingestionStack.curProcessorDlq).toBeDefined();
    expect(stacks.ingestionStack.costReconcilerDlq).toBeDefined();
  });
});

describe('CDK synth — stack dependency graph (no pricing references)', () => {
  let stacks: AllStacks;

  beforeAll(() => {
    stacks = buildAllStacks(testConfig);
    stacks.app.synth();
  });

  it('no stack depends on a pricing stack', () => {
    const allStacks = [
      stacks.networkStack,
      stacks.securityStack,
      stacks.storageStack,
      stacks.ingestionStack,
      stacks.identityStack,
      stacks.analyticsStack,
      stacks.apiStack,
      stacks.monitoringStack,
    ];

    allStacks.forEach((stack) => {
      const depNames = stack.dependencies.map((d) => d.node.id.toLowerCase());
      const pricingDeps = depNames.filter((n) => n.includes('pricing'));
      expect(pricingDeps).toHaveLength(0);
    });
  });

  it('MonitoringStack depends on IngestionStack (not PricingStack)', () => {
    const deps = stacks.monitoringStack.dependencies;
    expect(deps).toContain(stacks.ingestionStack);

    const depIds = deps.map((d) => d.node.id.toLowerCase());
    expect(depIds).not.toContain(expect.stringContaining('pricing'));
  });

  it('AnalyticsStack does not depend on PricingStack', () => {
    const deps = stacks.analyticsStack.dependencies;
    const depIds = deps.map((d) => d.node.id.toLowerCase());
    expect(depIds.some((id) => id.includes('pricing'))).toBe(false);
  });

  it('IngestionStack depends on StorageStack and NetworkStack', () => {
    const deps = stacks.ingestionStack.dependencies;
    expect(deps).toContain(stacks.storageStack);
    expect(deps).toContain(stacks.networkStack);
  });

  it('has no circular dependencies (app synth succeeds)', () => {
    expect(() => stacks.app.synth()).not.toThrow();
  });
});
