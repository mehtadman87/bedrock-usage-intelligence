import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/schema';

export interface MonitoringStackProps extends cdk.StackProps {
  config: PlatformConfig;
  cmk: kms.Key;
  dlqs: sqs.Queue[];
  lambdaFunctions: lambda.Function[];
}

export class MonitoringStack extends cdk.Stack {
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { config, cmk, dlqs, lambdaFunctions } = props;
    const { solutionName, environment } = config.deployment;

    // ── SNS Topic for alarm notifications ─────────────────────────────────────
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${solutionName}-alarms`,
      displayName: `${solutionName} CloudWatch Alarms`,
      masterKey: cmk,
    });

    const snsAction = new cloudwatchActions.SnsAction(this.alarmTopic);

    // ── DLQ alarms ────────────────────────────────────────────────────────────
    dlqs.forEach((dlq, i) => {
      const alarm = new cloudwatch.Alarm(this, `DlqAlarm-${i}`, {
        metric: dlq.metricApproximateNumberOfMessagesVisible(),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        alarmDescription: `DLQ ${dlq.queueName} has messages`,
        alarmName: `${solutionName}-dlq-alarm-${i}`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(snsAction);
    });

    // ── Lambda error rate alarms ──────────────────────────────────────────────
    lambdaFunctions.forEach((fn, i) => {
      const alarm = new cloudwatch.Alarm(this, `LambdaErrorAlarm-${i}`, {
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        alarmDescription: `Lambda ${fn.functionName} has errors`,
        alarmName: `${solutionName}-lambda-error-alarm-${i}`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(snsAction);
    });

    // ── Circuit breaker alarm ─────────────────────────────────────────────────
    const circuitBreakerAlarm = new cloudwatch.Alarm(this, 'CircuitBreakerAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'BedrockUsageIntelligence',
        metricName: 'CircuitBreakerOpen',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: 'Identity Resolver circuit breaker is open',
      alarmName: `${solutionName}-circuit-breaker-alarm`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    circuitBreakerAlarm.addAlarmAction(snsAction);

    // ── CUR Processor error alarm ────────────────────────────────────────────
    const curProcessorErrorAlarm = new cloudwatch.Alarm(this, 'CurProcessorErrorAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'BedrockUsageIntelligence',
        metricName: 'CurProcessorError',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: 'CUR Processor Lambda has errors',
      alarmName: `${solutionName}-cur-processor-error-alarm`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    curProcessorErrorAlarm.addAlarmAction(snsAction);

    // ── Reconciliation staleness alarm ────────────────────────────────────────
    const reconciliationStalenessAlarm = new cloudwatch.Alarm(this, 'ReconciliationStalenessAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'BedrockUsageIntelligence',
        metricName: 'ReconciliationLastRunAgeHours',
        statistic: 'Maximum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 24,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: 'No cost reconciliation has run in over 24 hours',
      alarmName: `${solutionName}-reconciliation-staleness-alarm`,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    reconciliationStalenessAlarm.addAlarmAction(snsAction);

    // ── CUR data missing alarm ────────────────────────────────────────────────
    const curDataMissingAlarm = new cloudwatch.Alarm(this, 'CurDataMissingAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'BedrockUsageIntelligence',
        metricName: 'CurDataLastArrivalAgeHours',
        statistic: 'Maximum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 48,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: 'No new CUR data has arrived in over 48 hours',
      alarmName: `${solutionName}-cur-data-missing-alarm`,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    curDataMissingAlarm.addAlarmAction(snsAction);

    // ── Reconciliation mismatch alarm ─────────────────────────────────────────
    const reconciliationMismatchAlarm = new cloudwatch.Alarm(this, 'ReconciliationMismatchAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'BedrockUsageIntelligence',
        metricName: 'ReconciliationMismatchPercent',
        statistic: 'Maximum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: 'Sum of attributed costs differs from CUR total by more than 5%',
      alarmName: `${solutionName}-reconciliation-mismatch-alarm`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    reconciliationMismatchAlarm.addAlarmAction(snsAction);

    // ── Unmapped billing name alarm ───────────────────────────────────────────
    const unmappedBillingNameAlarm = new cloudwatch.Alarm(this, 'UnmappedBillingNameAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'BedrockUsageIntelligence',
        metricName: 'UnmappedBillingName',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: 'CUR Processor encountered billing names not in the mapping',
      alarmName: `${solutionName}-unmapped-billing-name-alarm`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    unmappedBillingNameAlarm.addAlarmAction(snsAction);

    // ── Identity cache miss rate alarm ────────────────────────────────────────
    const cacheMissAlarm = new cloudwatch.Alarm(this, 'IdentityCacheMissAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'BedrockUsageIntelligence',
        metricName: 'IdentityCacheMissRate',
        statistic: 'Average',
        period: cdk.Duration.hours(1),
      }),
      threshold: 50,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: 'Identity cache miss rate exceeds 50% over 1 hour',
      alarmName: `${solutionName}-identity-cache-miss-alarm`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    cacheMissAlarm.addAlarmAction(snsAction);

    // ── CloudWatch Logs retention by environment ──────────────────────────────
    const retentionDays = this.getLogRetention(environment);

    // Apply retention to all log groups created by the platform Lambda functions
    lambdaFunctions.forEach((fn, i) => {
      new logs.LogRetention(this, `LogRetention-${i}`, {
        logGroupName: `/aws/lambda/${fn.functionName}`,
        retention: retentionDays,
      });
    });

    // ── CfnOutput for post-deployment CloudWatch Logs encryption script ────────
    new cdk.CfnOutput(this, 'PostDeploymentScriptCommand', {
      value: [
        `bash scripts/enable-cloudwatch-logs-encryption.sh`,
        `--cmk-arn ${cmk.keyArn}`,
        `--solution-name ${solutionName}`,
      ].join(' '),
      description: 'Run this command after deployment to apply CMK encryption to CloudWatch Log Groups',
      exportName: `${solutionName}-post-deployment-script`,
    });

    // ── CfnOutput for alarm topic ARN ─────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'SNS topic ARN for CloudWatch alarm notifications',
      exportName: `${solutionName}-alarm-topic-arn`,
    });
  }

  private getLogRetention(environment: string): logs.RetentionDays {
    switch (environment) {
      case 'production':
        return logs.RetentionDays.ONE_YEAR;
      case 'staging':
        return logs.RetentionDays.THREE_MONTHS;
      case 'dev':
      default:
        return logs.RetentionDays.ONE_MONTH;
    }
  }
}
