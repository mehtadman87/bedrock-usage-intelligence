/**
 * Unit tests for the QuickSight dataset structure in AnalyticsStack.
 *
 * Requirements: 1.2, 3.2, 3.3, 3.5, 7.1, 7.2, 8.4
 */
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template } from 'aws-cdk-lib/assertions';
import { AnalyticsStack } from '../../../lib/stacks/analytics-stack';
import { PlatformConfig } from '../../../lib/config/schema';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildQuickSuiteConfig(solutionName = 'test-solution'): PlatformConfig {
  return {
    vpc: { vpcMode: 'create', vpcCidr: '10.0.0.0/16', enableNatGateway: false, vpcEndpointMode: 'minimal' },
    account: { accountMode: 'single' },
    region: { regionMode: 'single' },
    identity: { identityMode: 'iam' },
    dataExports: { curBucketName: 'test-cur-bucket', curReportFormat: 'csv', reconciliationSchedule: 'rate(6 hours)' },
    dashboard: {
      enableQuickSuite: true,
      quickSightPrincipalArn: 'arn:aws:quicksight:us-east-1:123456789012:user/default/admin',
      quickSuiteEdition: 'STANDARD',
    },
    cloudTrail: { cloudTrailMode: 'create' },
    deployment: { solutionName, environment: 'dev' },
    enableInvocationLogging: true,
  };
}

function synthesizeAnalyticsStack(config: PlatformConfig): Template {
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

  return Template.fromStack(analyticsStack);
}

/** Finds the invocations dataset (the one ending in '-invocations-dataset'). */
function findInvocationsDataSet(template: Template): Record<string, unknown> | undefined {
  const dataSets = template.findResources('AWS::QuickSight::DataSet');
  const invocationsId = Object.keys(dataSets).find((id) => {
    const dataSetId: unknown = (dataSets[id] as { Properties?: { DataSetId?: string } }).Properties?.DataSetId;
    return typeof dataSetId === 'string' && dataSetId.endsWith('-invocations-dataset');
  });
  return invocationsId ? (dataSets[invocationsId] as Record<string, unknown>) : undefined;
}

/** Finds the metrics dataset (the one ending in '-metrics-dataset'). */
function findMetricsDataSet(template: Template): Record<string, unknown> | undefined {
  const dataSets = template.findResources('AWS::QuickSight::DataSet');
  const metricsId = Object.keys(dataSets).find((id) => {
    const dataSetId: unknown = (dataSets[id] as { Properties?: { DataSetId?: string } }).Properties?.DataSetId;
    return typeof dataSetId === 'string' && dataSetId.endsWith('-metrics-dataset') && !dataSetId.endsWith('-rls-dataset');
  });
  return metricsId ? (dataSets[metricsId] as Record<string, unknown>) : undefined;
}

type ColumnDecl = { Name: string; Type: string };

function getPhysicalTableColumns(dataSet: Record<string, unknown>, tableKey: string): ColumnDecl[] {
  const physicalTableMap = (dataSet as {
    Properties?: { PhysicalTableMap?: Record<string, { CustomSql?: { Columns?: ColumnDecl[] } }> };
  }).Properties?.PhysicalTableMap;
  return physicalTableMap?.[tableKey]?.CustomSql?.Columns ?? [];
}

// ── Shared stack ──────────────────────────────────────────────────────────────

let template: Template;
let dataSet: Record<string, unknown>;
let metricsDataSet: Record<string, unknown>;

beforeAll(() => {
  const config = buildQuickSuiteConfig('my-solution');
  template = synthesizeAnalyticsStack(config);
  const found = findInvocationsDataSet(template);
  if (!found) throw new Error('invocations dataset not found in synthesized template');
  dataSet = found;
  const foundMetrics = findMetricsDataSet(template);
  if (!foundMetrics) throw new Error('metrics dataset not found in synthesized template');
  metricsDataSet = foundMetrics;
});

// ── dataSetId ─────────────────────────────────────────────────────────────────

describe('dataSetId — Requirement 8.4', () => {
  it('dataSetId matches {solutionName}-invocations-dataset', () => {
    const dataSetId = (dataSet as { Properties?: { DataSetId?: string } }).Properties?.DataSetId;
    expect(dataSetId).toBe('my-solution-invocations-dataset');
  });
});

// ── invocationLogs physical table columns — Requirements 1.2, 7.1 ─────────────

describe('invocationLogs physical table columns — Requirements 1.2, 7.1', () => {
  let columns: ColumnDecl[];

  beforeAll(() => {
    columns = getPhysicalTableColumns(dataSet, 'invocationLogs');
  });

  it('declares all expected genuine invocation_logs columns', () => {
    const names = columns.map((c) => c.Name);
    const expected = [
      'requestid',
      'timestamp',
      'accountid',
      'modelid',
      'inputtokens',
      'outputtokens',
      'latencyms',
      'inputcost',
      'outputcost',
      'totalcost',
      'resolveduserid',
      'resolvedusername',
      'imagecount',
      'videodurationseconds',
      'sourceregion',
      'executionregion',
    ];
    expected.forEach((col) => expect(names).toContain(col));
  });

  it('does NOT declare placeholder columns from metrics table', () => {
    const names = columns.map((c) => c.Name);
    const placeholders = ['errorcount', 'throttledcount', 'invocationcount', 'invocationlatencyavg', 'invocationlatencyp99'];
    placeholders.forEach((col) => expect(names).not.toContain(col));
  });

  it('timestamp column has type DATETIME', () => {
    const col = columns.find((c) => c.Name === 'timestamp');
    expect(col?.Type).toBe('DATETIME');
  });

  it('inputtokens and outputtokens columns have type INTEGER', () => {
    const inputTokens = columns.find((c) => c.Name === 'inputtokens');
    const outputTokens = columns.find((c) => c.Name === 'outputtokens');
    expect(inputTokens?.Type).toBe('INTEGER');
    expect(outputTokens?.Type).toBe('INTEGER');
  });
});

// ── metrics physical table columns — Requirements 1.2, 7.2 ───────────────────

describe('metrics physical table columns — Requirements 1.2, 7.2', () => {
  let columns: ColumnDecl[];

  beforeAll(() => {
    // metrics columns live in the separate metrics dataset, not the invocations dataset
    columns = getPhysicalTableColumns(metricsDataSet, 'metrics');
  });

  it('declares exactly the 8 required metrics columns', () => {
    const names = columns.map((c) => c.Name);
    const expected = [
      'timestamp',
      'region',
      'modelid',
      'invocationcount',
      'invocationlatencyavg',
      'invocationlatencyp99',
      'throttledcount',
      'errorcount',
    ];
    expect(names.sort()).toEqual(expected.sort());
  });

  it('timestamp column has type DATETIME', () => {
    const col = columns.find((c) => c.Name === 'timestamp');
    expect(col?.Type).toBe('DATETIME');
  });

  it('modelid column has type STRING', () => {
    const col = columns.find((c) => c.Name === 'modelid');
    expect(col?.Type).toBe('STRING');
  });

  it('invocationcount column has type INTEGER', () => {
    const col = columns.find((c) => c.Name === 'invocationcount');
    expect(col?.Type).toBe('INTEGER');
  });

  it('invocationlatencyavg column has type DECIMAL', () => {
    const col = columns.find((c) => c.Name === 'invocationlatencyavg');
    expect(col?.Type).toBe('DECIMAL');
  });

  it('invocationlatencyp99 column has type DECIMAL', () => {
    const col = columns.find((c) => c.Name === 'invocationlatencyp99');
    expect(col?.Type).toBe('DECIMAL');
  });

  it('throttledcount column has type INTEGER', () => {
    const col = columns.find((c) => c.Name === 'throttledcount');
    expect(col?.Type).toBe('INTEGER');
  });

  it('errorcount column has type INTEGER', () => {
    const col = columns.find((c) => c.Name === 'errorcount');
    expect(col?.Type).toBe('INTEGER');
  });
});

// ── Two-dataset architecture — Requirements 3.1, 12 ─────────────────────────
// Dataset consolidation was evaluated and ruled out (see analytics-stack.ts comment).
// The architecture maintains separate invocations and metrics datasets.

describe('Two-dataset architecture — Requirements 3.1, 12', () => {
  it('invocations dataset has no JoinInstruction (datasets are separate)', () => {
    const logicalTableMap = (dataSet as {
      Properties?: { LogicalTableMap?: Record<string, unknown> };
    }).Properties?.LogicalTableMap;
    expect(logicalTableMap).toBeDefined();

    const hasJoin = Object.values(logicalTableMap!).some(
      (lt: any) => lt.Source?.JoinInstruction !== undefined,
    );
    expect(hasJoin).toBe(false);
  });

  it('invocations dataset has totaltokens calculated column in its own logical table', () => {
    const logicalTableMap = (dataSet as {
      Properties?: { LogicalTableMap?: Record<string, unknown> };
    }).Properties?.LogicalTableMap;

    type DataTransform = { CreateColumnsOperation?: { Columns?: Array<{ ColumnName?: string; Expression?: string }> } };
    const allColumns = Object.values(logicalTableMap!).flatMap((lt: any) =>
      (lt.DataTransforms as DataTransform[] ?? []).flatMap(
        (t) => t.CreateColumnsOperation?.Columns ?? [],
      ),
    );
    const totalTokens = allColumns.find((c) => c.ColumnName === 'totaltokens');
    expect(totalTokens).toBeDefined();
    expect(totalTokens?.Expression).toBe('{inputtokens} + {outputtokens}');
  });

  it('metrics dataset exists as a separate CfnDataSet resource', () => {
    expect(metricsDataSet).toBeDefined();
    const dataSetId = (metricsDataSet as { Properties?: { DataSetId?: string } }).Properties?.DataSetId;
    expect(dataSetId).toBe('my-solution-metrics-dataset');
  });
});

// ── calculatedFields in DashboardStack — Requirements 4.2, 4.3, 4.4, 4.5 ────

import { DashboardStack } from '../../../lib/stacks/dashboard-stack';

/**
 * Synthesizes a DashboardStack (with its AnalyticsStack dependency) and
 * returns the CloudFormation Template for inspection.
 */
function synthesizeDashboardStack(config: PlatformConfig): Template {
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
  });

  return Template.fromStack(dashboardStack);
}

type CalcField = { DataSetIdentifier?: string; Name?: string; Expression?: string };

function getCalculatedFields(dashboardTemplate: Template): CalcField[] {
  const dashboards = dashboardTemplate.findResources('AWS::QuickSight::Dashboard');
  const ids = Object.keys(dashboards);
  if (ids.length === 0) return [];
  const dashboard = dashboards[ids[0]] as Record<string, unknown>;
  return (
    (dashboard as { Properties?: { Definition?: { CalculatedFields?: CalcField[] } } })
      .Properties?.Definition?.CalculatedFields ?? []
  );
}

describe('calculatedFields — Requirements 4.2, 4.3, 4.4, 4.5', () => {
  let calculatedFields: CalcField[];

  beforeAll(() => {
    const config = buildQuickSuiteConfig('my-solution');
    const dashboardTemplate = synthesizeDashboardStack(config);
    calculatedFields = getCalculatedFields(dashboardTemplate);
  });

  it('ErrorRate expression contains ifelse zero-guard (Requirement 4.4)', () => {
    const errorRate = calculatedFields.find((cf) => cf.Name === 'ErrorRate');
    expect(errorRate).toBeDefined();
    expect(errorRate?.Expression?.toLowerCase()).toContain('ifelse');
  });

  it('ErrorRate has exact expression string (Requirement 4.2)', () => {
    const errorRate = calculatedFields.find((cf) => cf.Name === 'ErrorRate');
    expect(errorRate?.Expression).toBe(
      'ifelse(sum(invocationcount) = 0, 0, sum(errorcount) / sum(invocationcount) * 100)',
    );
  });

  it('TotalTokensCalc has exact expression string (Requirement 4.3)', () => {
    const totalTokens = calculatedFields.find((cf) => cf.Name === 'TotalTokensCalc');
    expect(totalTokens).toBeDefined();
    expect(totalTokens?.Expression).toBe('inputtokens + outputtokens');
  });

  it('ErrorRate has dataSetIdentifier === Metrics (Requirement 4.5)', () => {
    const errorRate = calculatedFields.find((cf) => cf.Name === 'ErrorRate');
    expect(errorRate?.DataSetIdentifier).toBe('Metrics');
  });

  it('TotalTokensCalc has dataSetIdentifier === InvocationLogs (Requirement 4.5)', () => {
    const totalTokens = calculatedFields.find((cf) => cf.Name === 'TotalTokensCalc');
    expect(totalTokens?.DataSetIdentifier).toBe('InvocationLogs');
  });
});

// ── Visual field reference tests — Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 8.1, 8.2, 8.3 ──

import * as quicksight from 'aws-cdk-lib/aws-quicksight';
import { buildSheetDefinitions } from '../../../lib/stacks/dashboard-visuals';

/**
 * Recursively collects all column name values from a visual's field wells.
 * Looks for { columnName: string } or { ColumnName: string } shapes.
 */
function collectColumnNames(obj: unknown): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj.flatMap((item) => collectColumnNames(item));
  const record = obj as Record<string, unknown>;
  const results: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if ((key === 'ColumnName' || key === 'columnName') && typeof value === 'string') {
      results.push(value);
    } else {
      results.push(...collectColumnNames(value));
    }
  }
  return results;
}

/** Finds a visual by its visualId within a list of VisualProperty objects. */
function findVisualById(
  visuals: quicksight.CfnDashboard.VisualProperty[],
  visualId: string,
): quicksight.CfnDashboard.VisualProperty | undefined {
  return visuals.find((v) => {
    const inner =
      v.kpiVisual ??
      v.lineChartVisual ??
      v.barChartVisual ??
      v.pieChartVisual ??
      v.heatMapVisual ??
      v.comboChartVisual ??
      v.scatterPlotVisual ??
      v.pivotTableVisual ??
      v.tableVisual;
    return (inner as { visualId?: string } | undefined)?.visualId === visualId;
  });
}

/** Extracts the fieldWells object from a visual's chartConfiguration. */
function getFieldWells(visual: quicksight.CfnDashboard.VisualProperty): unknown {
  const plain = JSON.parse(JSON.stringify(visual)) as Record<string, unknown>;
  const inner =
    plain['kpiVisual'] ??
    plain['lineChartVisual'] ??
    plain['barChartVisual'] ??
    plain['pieChartVisual'] ??
    plain['heatMapVisual'] ??
    plain['comboChartVisual'] ??
    plain['scatterPlotVisual'] ??
    plain['pivotTableVisual'] ??
    plain['tableVisual'];
  const config = (inner as Record<string, unknown> | undefined)?.['chartConfiguration'] as
    | Record<string, unknown>
    | undefined;
  return config?.['fieldWells'];
}

const FIXED_SHEET_PARAMS = {
  dataSetIdentifier: 'InvocationLogs',
  spiceMode: 'disabled' as const,
  solutionName: 'test-solution',
};

describe('Visual field references — Requirements 5.1, 5.2, 6.1, 6.2, 6.3', () => {
  const result = buildSheetDefinitions(FIXED_SHEET_PARAMS);

  // ── Error Rate KPIs ──────────────────────────────────────────────────────────

  it('exec-kpi-error-rate references ErrorRate column, not latencyms (Requirements 5.2, 6.1, 6.3)', () => {
    const execSheet = result.sheets.find((s) => s.sheetId === 'executive-summary');
    expect(execSheet).toBeDefined();

    const visual = findVisualById(
      execSheet!.visuals as quicksight.CfnDashboard.VisualProperty[],
      'exec-kpi-error-rate',
    );
    expect(visual).toBeDefined();

    const columns = collectColumnNames(getFieldWells(visual!));
    expect(columns).toContain('ErrorRate');
    expect(columns).not.toContain('latencyms');
  });

  it('exec-kpi-error-rate applies percent formatting (Requirement 6.2)', () => {
    const execSheet = result.sheets.find((s) => s.sheetId === 'executive-summary');
    const visual = findVisualById(
      execSheet!.visuals as quicksight.CfnDashboard.VisualProperty[],
      'exec-kpi-error-rate',
    );
    const fieldWellsStr = JSON.stringify(getFieldWells(visual!));
    expect(fieldWellsStr).toContain('percentageDisplayFormatConfiguration');
  });

  it('perf-kpi-error-rate references ErrorRate column, not latencyms (Requirements 5.2, 6.1, 6.3)', () => {
    const perfSheet = result.sheets.find((s) => s.sheetId === 'performance');
    expect(perfSheet).toBeDefined();

    const visual = findVisualById(
      perfSheet!.visuals as quicksight.CfnDashboard.VisualProperty[],
      'perf-kpi-error-rate',
    );
    expect(visual).toBeDefined();

    const columns = collectColumnNames(getFieldWells(visual!));
    expect(columns).toContain('ErrorRate');
    expect(columns).not.toContain('latencyms');
  });

  it('perf-kpi-error-rate applies percent formatting (Requirement 6.2)', () => {
    const perfSheet = result.sheets.find((s) => s.sheetId === 'performance');
    const visual = findVisualById(
      perfSheet!.visuals as quicksight.CfnDashboard.VisualProperty[],
      'perf-kpi-error-rate',
    );
    const fieldWellsStr = JSON.stringify(getFieldWells(visual!));
    expect(fieldWellsStr).toContain('percentageDisplayFormatConfiguration');
  });

  // ── P99 Latency KPI ──────────────────────────────────────────────────────────

  it('perf-kpi-p99-latency references invocationlatencyp99 (Requirement 5.1)', () => {
    const perfSheet = result.sheets.find((s) => s.sheetId === 'performance');
    const visual = findVisualById(
      perfSheet!.visuals as quicksight.CfnDashboard.VisualProperty[],
      'perf-kpi-p99-latency',
    );
    expect(visual).toBeDefined();

    const columns = collectColumnNames(getFieldWells(visual!));
    expect(columns).toContain('invocationlatencyp99');
  });

  // ── Area chart ───────────────────────────────────────────────────────────────

  it('perf-daily-throttles-table references throttledcount (Requirement 5.4)', () => {
    const perfSheet = result.sheets.find((s) => s.sheetId === 'performance');
    const visual = findVisualById(
      perfSheet!.visuals as quicksight.CfnDashboard.VisualProperty[],
      'perf-daily-throttles-table',
    );
    expect(visual).toBeDefined();

    const columns = collectColumnNames(getFieldWells(visual!));
    expect(columns).toContain('throttledcount');
  });

  // ── Scatter plot ─────────────────────────────────────────────────────────────

  it('perf-latency-tokens-scatter x-axis references latencyms and y-axis references totaltokens (Requirement 5.5)', () => {
    const perfSheet = result.sheets.find((s) => s.sheetId === 'performance');
    const visual = findVisualById(
      perfSheet!.visuals as quicksight.CfnDashboard.VisualProperty[],
      'perf-latency-tokens-scatter',
    );
    expect(visual).toBeDefined();

    type ScatterWells = { xAxis?: unknown[]; yAxis?: unknown[] };
    type ScatterJson = {
      scatterPlotVisual?: {
        chartConfiguration?: {
          fieldWells?: { scatterPlotCategoricallyAggregatedFieldWells?: ScatterWells };
        };
      };
    };
    const scatterJson = JSON.parse(JSON.stringify(visual)) as ScatterJson;
    const scatterWells =
      scatterJson?.scatterPlotVisual?.chartConfiguration?.fieldWells
        ?.scatterPlotCategoricallyAggregatedFieldWells;
    expect(scatterWells).toBeDefined();

    const xColumns = collectColumnNames(scatterWells!.xAxis ?? []);
    const yColumns = collectColumnNames(scatterWells!.yAxis ?? []);
    expect(xColumns).toContain('latencyms');
    expect(yColumns).toContain('totaltokens');
  });
});
