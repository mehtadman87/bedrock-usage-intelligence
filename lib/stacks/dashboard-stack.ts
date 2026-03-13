import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as quicksight from 'aws-cdk-lib/aws-quicksight';
import * as path from 'path';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/schema';
import { AnalyticsStack } from './analytics-stack';
import { LAMBDA_RUNTIME } from '../shared/cdk-constants';
import customizedDefinition from './customized-dashboard-definition.json';

export interface DashboardStackProps extends cdk.StackProps {
  config: PlatformConfig;
  cmk: kms.Key;
  processedDataBucket: s3.Bucket;
  analyticsStack: AnalyticsStack;
  /** ARN of the Invocation Processor Lambda (for refresh pipeline orchestration) */
  invocationProcessorArn?: string;
  /** ARN of the Metrics Collector Lambda (for refresh pipeline orchestration) */
  metricsCollectorArn?: string;
}

export class DashboardStack extends cdk.Stack {
  public readonly dashboardId!: string;
  public readonly dashboardUrl!: string;
  public readonly analysisId!: string;
  public readonly analysisUrl!: string;
  public readonly refreshLambda?: nodejs.NodejsFunction;
  public readonly refreshDlq?: sqs.Queue;

  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);

    const { config, cmk, processedDataBucket, analyticsStack, invocationProcessorArn, metricsCollectorArn } = props;

    // Guard: skip all resources when QuickSight is not enabled
    if (!config.dashboard.enableQuickSuite) {
      return;
    }

    const { solutionName } = config.deployment;

    // ── QS Account Validator Custom Resource ──────────────────────────────────
    //
    // NOT in VPC: QuickSight control plane API requires internet access.
    // The VPC has no NAT gateway, so VPC Lambdas cannot reach the internet.
    // Same pattern as LoggingBootstrap in ingestion-stack.ts.
    const qsAccountValidatorFn = new nodejs.NodejsFunction(this, 'QsAccountValidatorFn', {
      runtime: LAMBDA_RUNTIME,
      environmentEncryption: cmk,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      functionName: `${solutionName}-qs-account-validator`,
      entry: path.join(__dirname, '../handlers/qs-account-validator/index.ts'),
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        AwsAccountId: this.account,
      },
    });

    // Grant permission to call DescribeAccountSubscription
    qsAccountValidatorFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowQuickSightDescribeSubscription',
        effect: iam.Effect.ALLOW,
        actions: ['quicksight:DescribeAccountSubscription'],
        resources: ['*'],
      }),
    );

    const qsAccountValidatorProvider = new cr.Provider(this, 'QsAccountValidatorProvider', {
      onEventHandler: qsAccountValidatorFn,
      providerFunctionEnvEncryption: cmk,
    });

    new cdk.CustomResource(this, 'QsAccountValidator', {
      serviceToken: qsAccountValidatorProvider.serviceToken,
      properties: {
        // Trigger re-validation if the account ID changes
        AwsAccountId: this.account,
      },
    });

    // ── CfnDashboard ──────────────────────────────────────────────────────────
    const { quickSightPrincipalArn } = config.dashboard;
    const dashboardId = `${solutionName}-dashboard`;

    // Construct the dataset ARNs from the exported dataSetIds
    const dataSetArn = `arn:aws:quicksight:${this.region}:${this.account}:dataset/${analyticsStack.dataSetId}`;
    const metricsDataSetArn = analyticsStack.metricsDataSetId
      ? `arn:aws:quicksight:${this.region}:${this.account}:dataset/${analyticsStack.metricsDataSetId}`
      : undefined;

    // Build dataset identifier declarations using the physical dataset ARNs
    // (PascalCase — injected directly into CloudFormation via addPropertyOverride)

    // ── Customized definition ─────────────────────────────────────────────────
    //
    // The definition (sheets, visuals, filters, parameters, calculated fields,
    // analysisDefaults) is loaded from a PascalCase JSON snapshot exported from
    // the customized QuickSight Analysis via describe-analysis-definition.
    //
    // We use addPropertyOverride('Definition', ...) to inject the definition
    // directly into the CloudFormation template in PascalCase, bypassing CDK's
    // camelCase-to-PascalCase conversion. This is necessary because CDK's
    // automatic conversion mangles acronym-based property names like
    // KPIVisual → kPIVisual → KPIVisual (invalid), when CloudFormation
    // expects KpiVisual.
    //
    // DataSetIdentifierDeclarations are built dynamically because they contain
    // account/region-specific dataset ARNs resolved at deploy time.
    const { Sheets, FilterGroups, CalculatedFields, ParameterDeclarations, AnalysisDefaults } = customizedDefinition;

    // Build the full Definition in PascalCase for CloudFormation
    const dataSetIdentifierDeclarationsCfn = [
      { Identifier: 'InvocationLogs', DataSetArn: dataSetArn },
      ...(metricsDataSetArn ? [{ Identifier: 'Metrics', DataSetArn: metricsDataSetArn }] : []),
    ];

    const cfnDefinition = {
      DataSetIdentifierDeclarations: dataSetIdentifierDeclarationsCfn,
      Sheets,
      FilterGroups,
      CalculatedFields,
      ParameterDeclarations,
      AnalysisDefaults,
    };

    // Owner permissions for the principal ARN
    const dashboardPermissions: quicksight.CfnDashboard.ResourcePermissionProperty[] = quickSightPrincipalArn
      ? [
          {
            principal: quickSightPrincipalArn,
            actions: [
              'quicksight:DescribeDashboard',
              'quicksight:ListDashboardVersions',
              'quicksight:UpdateDashboardPermissions',
              'quicksight:QueryDashboard',
              'quicksight:UpdateDashboard',
              'quicksight:DeleteDashboard',
              'quicksight:DescribeDashboardPermissions',
              'quicksight:UpdateDashboardPublishedVersion',
            ],
          },
        ]
      : [];

    const dashboard = new quicksight.CfnDashboard(this, 'Dashboard', {
      awsAccountId: this.account,
      dashboardId,
      name: `${solutionName} Bedrock Usage Intelligence`,
      permissions: dashboardPermissions,
      dashboardPublishOptions: {
        adHocFilteringOption: { availabilityStatus: 'ENABLED' },
        exportToCsvOption: { availabilityStatus: 'ENABLED' },
        sheetControlsOption: { visibilityState: 'EXPANDED' },
      },
    });

    // Override the Definition property with PascalCase JSON to bypass CDK's
    // camelCase conversion which mangles acronym keys like KPIVisual
    dashboard.addPropertyOverride('Definition', cfnDefinition);

    // Ensure QS account is validated before creating the dashboard
    dashboard.node.addDependency(qsAccountValidatorProvider);

    // Store dashboard ID and URL as public properties for CfnOutputs (Task 9.1)
    (this as any).dashboardId = dashboardId;
    (this as any).dashboardUrl = `https://${this.region}.quicksight.aws.amazon.com/sn/dashboards/${dashboardId}`;

    // ── CfnOutputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'QuickSightDashboardUrl', {
      value: `https://${this.region}.quicksight.aws.amazon.com/sn/dashboards/${dashboardId}`,
      description: 'QuickSight dashboard URL',
      exportName: `${solutionName}-quicksight-dashboard-url`,
    });

    new cdk.CfnOutput(this, 'QuickSightDashboardId', {
      value: dashboardId,
      description: 'QuickSight dashboard ID',
      exportName: `${solutionName}-quicksight-dashboard-id`,
    });

    // ── CfnAnalysis (editable twin of the dashboard) ─────────────────────────
    //
    // QuickSight Analyses are the editable counterpart to Dashboards. Users can
    // modify visuals, add new sheets, and experiment without affecting the
    // published dashboard. Uses the same customized definition as the Dashboard.
    const analysisId = `${solutionName}-analysis`;

    const analysisPermissions: quicksight.CfnAnalysis.ResourcePermissionProperty[] = quickSightPrincipalArn
      ? [
          {
            principal: quickSightPrincipalArn,
            actions: [
              'quicksight:DescribeAnalysis',
              'quicksight:DescribeAnalysisPermissions',
              'quicksight:UpdateAnalysis',
              'quicksight:UpdateAnalysisPermissions',
              'quicksight:DeleteAnalysis',
              'quicksight:QueryAnalysis',
              'quicksight:RestoreAnalysis',
            ],
          },
        ]
      : [];

    const analysis = new quicksight.CfnAnalysis(this, 'Analysis', {
      awsAccountId: this.account,
      analysisId,
      name: `${solutionName} Bedrock Usage Intelligence (Analysis)`,
      permissions: analysisPermissions,
    });

    // Override the Definition property with PascalCase JSON (same as Dashboard)
    analysis.addPropertyOverride('Definition', cfnDefinition);

    // Ensure QS account is validated before creating the analysis
    analysis.node.addDependency(qsAccountValidatorProvider);

    // Store analysis ID and URL as public properties
    (this as any).analysisId = analysisId;
    (this as any).analysisUrl = `https://${this.region}.quicksight.aws.amazon.com/sn/analyses/${analysisId}`;

    new cdk.CfnOutput(this, 'QuickSightAnalysisUrl', {
      value: `https://${this.region}.quicksight.aws.amazon.com/sn/analyses/${analysisId}`,
      description: 'QuickSight analysis URL (editable version of the dashboard)',
      exportName: `${solutionName}-quicksight-analysis-url`,
    });

    new cdk.CfnOutput(this, 'QuickSightAnalysisId', {
      value: analysisId,
      description: 'QuickSight analysis ID',
      exportName: `${solutionName}-quicksight-analysis-id`,
    });

    // ── Refresh Lambda (SPICE always enabled) ────────────────────────────────
    //
    // NOT in VPC: QuickSight API requires internet access.
    // DLQ for failed refresh invocations
    const dlq = new sqs.Queue(this, 'RefreshDlq', {
      queueName: `${solutionName}-dashboard-refresh-dlq`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: cmk,
      retentionPeriod: cdk.Duration.days(14),
    });

    const refreshFn = new nodejs.NodejsFunction(this, 'RefreshLambda', {
      runtime: LAMBDA_RUNTIME,
      environmentEncryption: cmk,
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      functionName: `${solutionName}-dashboard-refresh`,
      entry: path.join(__dirname, '../handlers/dashboard-refresh/index.ts'),
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: ['@aws-sdk/*'],
      },
      deadLetterQueue: dlq,
      environment: {
        SPICE_MODE: 'enabled',
        DATASET_ID: analyticsStack.dataSetId!,
        AWS_ACCOUNT_ID: this.account,
        QUICKSIGHT_EDITION: config.dashboard.quickSuiteEdition ?? 'STANDARD',
        ...(invocationProcessorArn ? { INVOCATION_PROCESSOR_ARN: invocationProcessorArn } : {}),
        ...(metricsCollectorArn ? { METRICS_COLLECTOR_ARN: metricsCollectorArn } : {}),
        ...(analyticsStack.metricsDataSetId ? { METRICS_DATASET_ID: analyticsStack.metricsDataSetId } : {}),
      },
    });

    // IAM: allow CreateIngestion and DescribeIngestion scoped to the invocations dataset
    const ingestionResources: string[] = [dataSetArn];
    if (metricsDataSetArn) {
      ingestionResources.push(metricsDataSetArn);
    }

    refreshFn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowQuickSightIngestion',
        effect: iam.Effect.ALLOW,
        actions: [
          'quicksight:CreateIngestion',
          'quicksight:DescribeIngestion',
        ],
        resources: ingestionResources,
      }),
    );

    // IAM: allow invoking Invocation Processor and Metrics Collector
    const lambdaInvokeResources: string[] = [];
    if (invocationProcessorArn) {
      lambdaInvokeResources.push(invocationProcessorArn);
    }
    if (metricsCollectorArn) {
      lambdaInvokeResources.push(metricsCollectorArn);
    }
    if (lambdaInvokeResources.length > 0) {
      refreshFn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'AllowLambdaInvoke',
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: lambdaInvokeResources,
        }),
      );
    }

    (this as any).refreshLambda = refreshFn;
    (this as any).refreshDlq = dlq;
  }
}
