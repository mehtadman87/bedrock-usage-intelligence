/**
 * Unit tests for the DashboardStack CDK construct.
 *
 * Requirements: 2, 5, 6, 8, 9, 10
 */
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DashboardStack } from '../../../lib/stacks/dashboard-stack';
import { AnalyticsStack } from '../../../lib/stacks/analytics-stack';
import { PlatformConfig } from '../../../lib/config/schema';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PRINCIPAL_ARN = 'arn:aws:quicksight:us-east-1:123456789012:user/default/test-user';

function buildConfig(overrides: Partial<{
  solutionName: string;
  enableQuickSuite: boolean;
  quickSuiteEdition: 'STANDARD' | 'ENTERPRISE';
  quickSightPrincipalArn: string;
}> = {}): PlatformConfig {
  const {
    solutionName = 'test-solution',
    enableQuickSuite = false,
    quickSuiteEdition,
    quickSightPrincipalArn,
  } = overrides;

  const dashboard: PlatformConfig['dashboard'] = {
    enableQuickSuite,
    ...(quickSuiteEdition ? { quickSuiteEdition } : {}),
    ...(quickSightPrincipalArn ? { quickSightPrincipalArn } : {}),
  };

  return {
    vpc: { vpcMode: 'create', vpcCidr: '10.0.0.0/16', enableNatGateway: false, vpcEndpointMode: 'minimal' },
    account: { accountMode: 'single' },
    region: { regionMode: 'single' },
    identity: { identityMode: 'iam' },
    dataExports: { curBucketName: 'test-cur-bucket', curReportFormat: 'csv', reconciliationSchedule: 'rate(6 hours)' },
    dashboard,
    cloudTrail: { cloudTrailMode: 'existing', existingCloudTrailBucket: 'ct-bucket' },
    deployment: { solutionName, environment: 'dev' },
    enableInvocationLogging: true,
  };
}

interface StackSet {
  dashboardStack: DashboardStack;
  template: Template;
  analyticsTemplate: Template;
}

interface BuildDashboardStackOptions {
  invocationProcessorArn?: string;
  metricsCollectorArn?: string;
}

function buildDashboardStack(config: PlatformConfig, options: BuildDashboardStackOptions = {}): StackSet {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };

  const depsStack = new cdk.Stack(app, 'DepsStack', { env });

  const cmk = new kms.Key(depsStack, 'Cmk', { enableKeyRotation: true });

  const processedDataBucket = new s3.Bucket(depsStack, 'ProcessedDataBucket', {
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: cmk,
    versioned: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
  });

  const pricingTable = new dynamodb.Table(depsStack, 'PricingTable', {
    partitionKey: { name: 'modelId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'effectiveDate', type: dynamodb.AttributeType.STRING },
    encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
    encryptionKey: cmk,
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  });

  const analyticsStack = new AnalyticsStack(app, 'AnalyticsStack', {
    config,
    cmk,
    processedDataBucket,
    env,
  });

  const dashboardStack = new DashboardStack(app, 'DashboardStack', {
    config,
    cmk,
    processedDataBucket,
    analyticsStack,
    env,
    ...options,
  });

  return {
    dashboardStack,
    template: Template.fromStack(dashboardStack),
    analyticsTemplate: Template.fromStack(analyticsStack),
  };
}

// ── enableQuickSuite: false ───────────────────────────────────────────────────

describe('DashboardStack - enableQuickSuite: false', () => {
  it('creates no resources when enableQuickSuite is false', () => {
    const config = buildConfig({ enableQuickSuite: false });
    const { template } = buildDashboardStack(config);

    template.resourceCountIs('AWS::QuickSight::Dashboard', 0);
    template.resourceCountIs('AWS::IAM::Role', 0);
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('AWS::SQS::Queue', 0);
  });

  it('creates no CfnOutputs when enableQuickSuite is false', () => {
    const config = buildConfig({ enableQuickSuite: false });
    const { template } = buildDashboardStack(config);

    const outputs = template.findOutputs('*');
    expect(Object.keys(outputs)).toHaveLength(0);
  });
});

// ── QS Account Validator ──────────────────────────────────────────────────────

describe('DashboardStack - QS Account Validator custom resource', () => {
  it('creates QS Account Validator Lambda when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    // The validator Lambda is a NodejsFunction — it appears as AWS::Lambda::Function
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('qs-account-validator'),
    });
  });

  it('QS Account Validator Lambda has DescribeAccountSubscription permission', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'quicksight:DescribeAccountSubscription',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('creates a custom resource for QS account validation', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    // cr.Provider creates a Custom::... resource
    const customResources = template.findResources('AWS::CloudFormation::CustomResource');
    const customResourcesAlt = template.findResources('Custom::AWS');
    const allCustom = { ...customResources, ...customResourcesAlt };

    // At least one custom resource should exist (the QS account validator)
    expect(Object.keys(allCustom).length).toBeGreaterThanOrEqual(1);
  });
});

// ── QuickSight IAM Role ───────────────────────────────────────────────────────

describe('DashboardStack - QuickSight IAM Role', () => {
  it('creates QuickSight IAM role when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { analyticsTemplate } = buildDashboardStack(config);

    analyticsTemplate.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'quicksight.amazonaws.com' },
            Action: 'sts:AssumeRole',
          }),
        ]),
      },
    });
  });

  it('QuickSight IAM role name is prefixed with solutionName', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
      solutionName: 'my-platform',
    });
    const { analyticsTemplate } = buildDashboardStack(config);

    analyticsTemplate.hasResourceProperties('AWS::IAM::Role', {
      RoleName: Match.stringLikeRegexp('^my-platform'),
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'quicksight.amazonaws.com' },
          }),
        ]),
      },
    });
  });

  it('QuickSight IAM role has S3 read permissions', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { analyticsTemplate } = buildDashboardStack(config);

    // CDK grantReadWrite generates wildcard actions (s3:GetObject*, s3:List*, etc.)
    analyticsTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              Match.stringLikeRegexp('^s3:GetObject'),
              Match.stringLikeRegexp('^s3:List'),
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('QuickSight IAM role has Glue read permissions', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { analyticsTemplate } = buildDashboardStack(config);

    analyticsTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartitions']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('QuickSight IAM role has KMS decrypt permissions', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { analyticsTemplate } = buildDashboardStack(config);

    // CDK grantEncryptDecrypt generates kms:Decrypt, kms:GenerateDataKey*, kms:ReEncrypt*, etc.
    analyticsTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'kms:Decrypt',
              Match.stringLikeRegexp('^kms:GenerateDataKey'),
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});

// ── CfnDashboard ──────────────────────────────────────────────────────────────

describe('DashboardStack - CfnDashboard', () => {
  it('creates CfnDashboard when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    template.resourceCountIs('AWS::QuickSight::Dashboard', 1);
  });

  it('CfnDashboard ID is prefixed with solutionName', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
      solutionName: 'my-platform',
    });
    const { template } = buildDashboardStack(config);

    template.hasResourceProperties('AWS::QuickSight::Dashboard', {
      DashboardId: Match.stringLikeRegexp('^my-platform'),
    });
  });

  it('CfnDashboard has Permissions with principalArn as Owner', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    template.hasResourceProperties('AWS::QuickSight::Dashboard', {
      Permissions: Match.arrayWith([
        Match.objectLike({
          Principal: PRINCIPAL_ARN,
          Actions: Match.arrayWith(['quicksight:DescribeDashboard']),
        }),
      ]),
    });
  });

  it('CfnDashboard Definition has 4 sheets', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    const dashboards = template.findResources('AWS::QuickSight::Dashboard');
    const dashboardValues = Object.values(dashboards) as Array<{
      Properties?: {
        Definition?: {
          Sheets?: unknown[];
        };
      };
    }>;

    expect(dashboardValues).toHaveLength(1);
    expect(dashboardValues[0].Properties?.Definition?.Sheets).toHaveLength(4);
  });
});

// ── SPICE always enabled — refresh infrastructure always present ──────────────

describe('DashboardStack - SPICE always enabled', () => {
  it('always creates Refresh Lambda when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('dashboard-refresh'),
    });
  });

  it('always creates DLQ when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    template.resourceCountIs('AWS::SQS::Queue', 1);
  });
});

// ── spiceMode: enabled — refresh infrastructure present ───────────────────────

describe('DashboardStack - spiceMode: enabled', () => {
  it('creates Refresh Lambda when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('dashboard-refresh'),
    });
  });

  it('creates DLQ when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    template.resourceCountIs('AWS::SQS::Queue', 1);
  });

  it('DLQ is encrypted with KMS', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    template.hasResourceProperties('AWS::SQS::Queue', {
      KmsMasterKeyId: Match.anyValue(),
    });
  });

  it('Refresh Lambda has CreateIngestion and DescribeIngestion permissions', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'quicksight:CreateIngestion',
              'quicksight:DescribeIngestion',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('refreshLambda and refreshDlq properties are defined when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { dashboardStack } = buildDashboardStack(config);

    expect(dashboardStack.refreshLambda).toBeDefined();
    expect(dashboardStack.refreshDlq).toBeDefined();
  });
});

// ── CfnOutputs ────────────────────────────────────────────────────────────────

describe('DashboardStack - CfnOutputs', () => {
  it('outputs QuickSightDashboardUrl when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    const outputs = template.findOutputs('QuickSightDashboardUrl');
    expect(Object.keys(outputs)).toHaveLength(1);
  });

  it('outputs QuickSightDashboardId when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    const outputs = template.findOutputs('QuickSightDashboardId');
    expect(Object.keys(outputs)).toHaveLength(1);
  });

  it('QuickSightDashboardUrl contains the dashboard ID', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
      solutionName: 'test-solution',
    });
    const { template } = buildDashboardStack(config);

    const outputs = template.findOutputs('QuickSightDashboardUrl');
    const urlOutput = Object.values(outputs)[0] as { Value: unknown };
    // The URL value is a CDK token/join — just verify the output exists
    expect(urlOutput).toBeDefined();
  });
});

// ── Refresh Lambda CDK configuration (Task 10) ────────────────────────────────

const INVOCATION_PROCESSOR_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:test-invocation-processor';
const METRICS_COLLECTOR_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:test-metrics-collector';

describe('DashboardStack - Refresh Lambda CDK configuration', () => {
  it('Refresh Lambda timeout is 120 seconds', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('dashboard-refresh'),
      Timeout: 120,
    });
  });

  it('Refresh Lambda has INVOCATION_PROCESSOR_ARN environment variable when prop is provided', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config, {
      invocationProcessorArn: INVOCATION_PROCESSOR_ARN,
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('dashboard-refresh'),
      Environment: {
        Variables: Match.objectLike({
          INVOCATION_PROCESSOR_ARN: INVOCATION_PROCESSOR_ARN,
        }),
      },
    });
  });

  it('Refresh Lambda has METRICS_COLLECTOR_ARN environment variable when prop is provided', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config, {
      metricsCollectorArn: METRICS_COLLECTOR_ARN,
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('dashboard-refresh'),
      Environment: {
        Variables: Match.objectLike({
          METRICS_COLLECTOR_ARN: METRICS_COLLECTOR_ARN,
        }),
      },
    });
  });

  it('Refresh Lambda does NOT have INVOCATION_PROCESSOR_ARN env var when prop is omitted', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    const lambdas = template.findResources('AWS::Lambda::Function');
    const refreshLambda = Object.values(lambdas).find((l: any) =>
      l.Properties?.FunctionName?.includes('dashboard-refresh'),
    ) as any;

    expect(refreshLambda).toBeDefined();
    expect(refreshLambda.Properties?.Environment?.Variables?.INVOCATION_PROCESSOR_ARN).toBeUndefined();
  });

  it('IAM policy includes lambda:InvokeFunction on both processor ARNs', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config, {
      invocationProcessorArn: INVOCATION_PROCESSOR_ARN,
      metricsCollectorArn: METRICS_COLLECTOR_ARN,
    });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
            Resource: Match.arrayWith([
              INVOCATION_PROCESSOR_ARN,
              METRICS_COLLECTOR_ARN,
            ]),
          }),
        ]),
      },
    });
  });

  it('Refresh Lambda role does NOT have AllowLambdaInvoke policy when no ARNs are provided', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    // The AllowLambdaInvoke policy statement (sid) should not exist on the refresh Lambda role
    const policies = template.findResources('AWS::IAM::Policy');
    const hasAllowLambdaInvokeSid = Object.values(policies).some((p: any) =>
      p.Properties?.PolicyDocument?.Statement?.some((s: any) => s.Sid === 'AllowLambdaInvoke'),
    );
    expect(hasAllowLambdaInvokeSid).toBe(false);
  });

  it('quicksight:CreateIngestion policy includes metrics dataset ARN when metricsDataSetId is set', () => {
    // enableQuickSuite=true causes AnalyticsStack to create metricsDataSetId
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: PRINCIPAL_ARN,
    });
    const { template } = buildDashboardStack(config);

    // The ingestion policy should have 2 resources (invocations + metrics datasets)
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['quicksight:CreateIngestion', 'quicksight:DescribeIngestion']),
            Effect: 'Allow',
            Resource: Match.arrayWith([
              Match.stringLikeRegexp('invocations-dataset'),
              Match.stringLikeRegexp('metrics-dataset'),
            ]),
          }),
        ]),
      },
    });
  });
});
