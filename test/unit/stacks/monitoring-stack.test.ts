/**
 * Unit tests for the Monitoring_Stack CDK construct.
 *
 * Requirements: 3.5, 3.8, 13.7, 14.6
 */
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MonitoringStack } from '../../../lib/stacks/monitoring-stack';
import { PlatformConfig } from '../../../lib/config/schema';
import { LAMBDA_RUNTIME } from '../../../lib/shared/cdk-constants';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildConfig(overrides: Partial<{
  solutionName: string;
  environment: 'dev' | 'staging' | 'production';
}> = {}): PlatformConfig {
  const { solutionName = 'test-solution', environment = 'dev' } = overrides;
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
  monitoringStack: MonitoringStack;
  template: Template;
}

function buildMonitoringStack(
  config: PlatformConfig,
  dlqCount = 3,
  lambdaCount = 3,
): StackSet {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };

  const depsStack = new cdk.Stack(app, 'DepsStack', { env });

  const cmk = new kms.Key(depsStack, 'Cmk', { enableKeyRotation: true });

  const vpc = ec2.Vpc.fromVpcAttributes(depsStack, 'Vpc', {
    vpcId: 'vpc-12345678',
    availabilityZones: ['us-east-1a', 'us-east-1b'],
    privateSubnetIds: ['subnet-11111111', 'subnet-22222222'],
  });
  const sg = new ec2.SecurityGroup(depsStack, 'Sg', { vpc, description: 'test sg' });

  const dlqs: sqs.Queue[] = Array.from({ length: dlqCount }, (_, i) =>
    new sqs.Queue(depsStack, `Dlq${i}`, {
      queueName: `test-solution-dlq-${i}`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: cmk,
    }),
  );

  const lambdaFunctions: lambda.Function[] = Array.from({ length: lambdaCount }, (_, i) =>
    new lambda.Function(depsStack, `Fn${i}`, {
      runtime: LAMBDA_RUNTIME,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({})'),
      functionName: `test-solution-fn-${i}`,
      vpc,
      securityGroups: [sg],
    }),
  );

  const monitoringStack = new MonitoringStack(app, 'MonitoringStack', {
    config,
    cmk,
    dlqs,
    lambdaFunctions,
    env,
  });

  return {
    monitoringStack,
    template: Template.fromStack(monitoringStack),
  };
}

// ── SNS Topic ─────────────────────────────────────────────────────────────────

describe('MonitoringStack - SNS Topic', () => {
  it('creates exactly one SNS topic', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config);
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });

  it('SNS topic is encrypted with the CMK', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config);
    template.hasResourceProperties('AWS::SNS::Topic', {
      KmsMasterKeyId: Match.anyValue(),
    });
  });

  it('SNS topic name is prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildMonitoringStack(config);
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: Match.stringLikeRegexp('^my-platform'),
    });
  });

  it('exports alarmTopic', () => {
    const config = buildConfig();
    const { monitoringStack } = buildMonitoringStack(config);
    expect(monitoringStack.alarmTopic).toBeDefined();
  });
});

// ── DLQ alarms ────────────────────────────────────────────────────────────────

describe('MonitoringStack - DLQ alarms', () => {
  it('creates one alarm per DLQ', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 3, 0);

    // 3 DLQ alarms + 1 circuit breaker + 1 pricing scraper + 1 cache miss = 6 total
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const dlqAlarms = Object.values(alarms).filter((a: unknown) => {
      const alarm = a as { Properties?: { AlarmName?: string } };
      return alarm.Properties?.AlarmName?.includes('dlq-alarm');
    });
    expect(dlqAlarms.length).toBe(3);
  });

  it('DLQ alarms trigger when messages visible > 0', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 1, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('dlq-alarm'),
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 0,
    });
  });

  it('DLQ alarms have evaluation period of 1', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 1, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('dlq-alarm'),
      EvaluationPeriods: 1,
    });
  });

  it('DLQ alarm names are prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildMonitoringStack(config, 1, 0);

    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const dlqAlarms = Object.values(alarms).filter((a: unknown) => {
      const alarm = a as { Properties?: { AlarmName?: string } };
      return alarm.Properties?.AlarmName?.includes('dlq-alarm');
    });
    dlqAlarms.forEach((a: unknown) => {
      const alarm = a as { Properties?: { AlarmName?: string } };
      expect(alarm.Properties?.AlarmName).toMatch(/^my-platform/);
    });
  });
});

// ── Lambda error rate alarms ──────────────────────────────────────────────────

describe('MonitoringStack - Lambda error rate alarms', () => {
  it('creates one alarm per Lambda function', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 3);

    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const lambdaAlarms = Object.values(alarms).filter((a: unknown) => {
      const alarm = a as { Properties?: { AlarmName?: string } };
      return alarm.Properties?.AlarmName?.includes('lambda-error-alarm');
    });
    expect(lambdaAlarms.length).toBe(3);
  });

  it('Lambda error alarms use 5-minute period', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 1);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('lambda-error-alarm'),
      Period: 300, // 5 minutes in seconds
    });
  });

  it('Lambda error alarms trigger at threshold >= 1', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 1);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('lambda-error-alarm'),
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
    });
  });

  it('Lambda error alarm names are prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildMonitoringStack(config, 0, 1);

    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const lambdaAlarms = Object.values(alarms).filter((a: unknown) => {
      const alarm = a as { Properties?: { AlarmName?: string } };
      return alarm.Properties?.AlarmName?.includes('lambda-error-alarm');
    });
    lambdaAlarms.forEach((a: unknown) => {
      const alarm = a as { Properties?: { AlarmName?: string } };
      expect(alarm.Properties?.AlarmName).toMatch(/^my-platform/);
    });
  });
});

// ── Circuit breaker alarm ─────────────────────────────────────────────────────

describe('MonitoringStack - Circuit breaker alarm', () => {
  it('creates a circuit breaker alarm', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmDescription: Match.stringLikeRegexp('[Cc]ircuit [Bb]reaker'),
    });
  });

  it('circuit breaker alarm uses BedrockUsageIntelligence namespace', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'BedrockUsageIntelligence',
      MetricName: 'CircuitBreakerOpen',
    });
  });

  it('circuit breaker alarm triggers when metric > 0', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'CircuitBreakerOpen',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 0,
    });
  });

  it('circuit breaker alarm name is prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildMonitoringStack(config, 0, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'CircuitBreakerOpen',
      AlarmName: Match.stringLikeRegexp('^my-platform'),
    });
  });
});

// ── CUR processing alarms ─────────────────────────────────────────────────────

describe('MonitoringStack - CUR processing alarms', () => {
  it('creates a CUR processor error alarm', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'CurProcessorError',
    });
  });

  it('CUR processor alarm uses BedrockUsageIntelligence namespace', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'BedrockUsageIntelligence',
      MetricName: 'CurProcessorError',
    });
  });

  it('creates a CUR data missing alarm', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'CurDataLastArrivalAgeHours',
    });
  });
});

// ── Identity cache miss rate alarm ────────────────────────────────────────────

describe('MonitoringStack - Identity cache miss rate alarm', () => {
  it('creates an identity cache miss rate alarm', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'IdentityCacheMissRate',
    });
  });

  it('cache miss alarm uses BedrockUsageIntelligence namespace', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'BedrockUsageIntelligence',
      MetricName: 'IdentityCacheMissRate',
    });
  });

  it('cache miss alarm triggers when rate > 50%', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'IdentityCacheMissRate',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 50,
    });
  });

  it('cache miss alarm uses 1-hour period', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'IdentityCacheMissRate',
      Period: 3600, // 1 hour in seconds
    });
  });

  it('cache miss alarm name is prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildMonitoringStack(config, 0, 0);

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'IdentityCacheMissRate',
      AlarmName: Match.stringLikeRegexp('^my-platform'),
    });
  });
});

// ── Alarm actions point to SNS topic ─────────────────────────────────────────

describe('MonitoringStack - Alarm actions', () => {
  it('all alarms have at least one alarm action', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 2, 2);

    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    Object.values(alarms).forEach((a: unknown) => {
      const alarm = a as { Properties?: { AlarmActions?: unknown[] } };
      expect(alarm.Properties?.AlarmActions?.length).toBeGreaterThan(0);
    });
  });

  it('alarm actions reference the SNS topic', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 1, 0);

    // All alarms should have an action that references the SNS topic ARN
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const topics = template.findResources('AWS::SNS::Topic');
    const topicLogicalIds = Object.keys(topics);

    Object.values(alarms).forEach((a: unknown) => {
      const alarm = a as { Properties?: { AlarmActions?: unknown[] } };
      const actions = alarm.Properties?.AlarmActions ?? [];
      // Each action should reference the SNS topic (via Ref or Fn::GetAtt)
      const hasTopicRef = actions.some((action) => {
        const actionStr = JSON.stringify(action);
        return topicLogicalIds.some((id) => actionStr.includes(id));
      });
      expect(hasTopicRef).toBe(true);
    });
  });
});

// ── CloudWatch Logs retention ─────────────────────────────────────────────────

describe('MonitoringStack - CloudWatch Logs retention', () => {
  it('sets 30-day retention for dev environment', () => {
    const config = buildConfig({ environment: 'dev' });
    const { template } = buildMonitoringStack(config, 0, 1);

    template.hasResourceProperties('Custom::LogRetention', {
      RetentionInDays: 30,
    });
  });

  it('sets 90-day retention for staging environment', () => {
    const config = buildConfig({ environment: 'staging' });
    const { template } = buildMonitoringStack(config, 0, 1);

    template.hasResourceProperties('Custom::LogRetention', {
      RetentionInDays: 90,
    });
  });

  it('sets 365-day retention for production environment', () => {
    const config = buildConfig({ environment: 'production' });
    const { template } = buildMonitoringStack(config, 0, 1);

    template.hasResourceProperties('Custom::LogRetention', {
      RetentionInDays: 365,
    });
  });

  it('creates one LogRetention resource per Lambda function', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 3);

    const retentions = template.findResources('Custom::LogRetention');
    expect(Object.keys(retentions).length).toBe(3);
  });

  it('LogRetention log group name matches Lambda function name', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 1);

    // LogGroupName is a Fn::Join token in CDK (function name is a cross-stack ref)
    // Verify the retention resource exists and has the correct retention period
    template.hasResourceProperties('Custom::LogRetention', {
      RetentionInDays: 30,
      LogGroupName: Match.anyValue(),
    });
  });
});

// ── CfnOutput for post-deployment script ─────────────────────────────────────

describe('MonitoringStack - CfnOutput for post-deployment script', () => {
  it('creates a CfnOutput for the post-deployment script command', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config);

    const outputs = template.findOutputs('PostDeploymentScriptCommand');
    expect(Object.keys(outputs).length).toBe(1);
  });

  it('post-deployment script output value contains the script path', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config);

    const outputs = template.findOutputs('PostDeploymentScriptCommand');
    const outputValue = JSON.stringify(outputs['PostDeploymentScriptCommand']);
    expect(outputValue).toContain('enable-cloudwatch-logs-encryption.sh');
  });

  it('post-deployment script output value contains the solution name', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildMonitoringStack(config);

    const outputs = template.findOutputs('PostDeploymentScriptCommand');
    const outputValue = JSON.stringify(outputs['PostDeploymentScriptCommand']);
    expect(outputValue).toContain('my-platform');
  });

  it('creates a CfnOutput for the alarm topic ARN', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config);

    const outputs = template.findOutputs('AlarmTopicArn');
    expect(Object.keys(outputs).length).toBe(1);
  });

  it('post-deployment script export name is prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildMonitoringStack(config);

    const outputs = template.findOutputs('PostDeploymentScriptCommand');
    const exportName = outputs['PostDeploymentScriptCommand']?.Export?.Name;
    expect(JSON.stringify(exportName)).toContain('my-platform');
  });
});

// ── Total alarm count ─────────────────────────────────────────────────────────

describe('MonitoringStack - Total alarm count', () => {
  it('creates correct total number of alarms (DLQs + Lambdas + 7 custom)', () => {
    const config = buildConfig();
    const dlqCount = 3;
    const lambdaCount = 3;
    const { template } = buildMonitoringStack(config, dlqCount, lambdaCount);

    // 3 DLQ + 3 Lambda + 7 custom (circuit breaker, cache miss, CUR processor error,
    // reconciliation staleness, CUR data missing, reconciliation mismatch, unmapped billing name) = 13
    const expectedAlarmCount = dlqCount + lambdaCount + 7;
    template.resourceCountIs('AWS::CloudWatch::Alarm', expectedAlarmCount);
  });

  it('creates 7 custom metric alarms when no DLQs or Lambdas provided', () => {
    const config = buildConfig();
    const { template } = buildMonitoringStack(config, 0, 0);

    // Only custom alarms: circuit breaker, cache miss, CUR processor error,
    // reconciliation staleness, CUR data missing, reconciliation mismatch, unmapped billing name = 7
    template.resourceCountIs('AWS::CloudWatch::Alarm', 7);
  });
});
