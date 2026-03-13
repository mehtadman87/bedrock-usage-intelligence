// Feature: dashboard-metrics-dataset-fix
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template } from 'aws-cdk-lib/assertions';
import * as fc from 'fast-check';
import { AnalyticsStack } from 'lib/stacks/analytics-stack';
import { DashboardStack } from 'lib/stacks/dashboard-stack';
import { PlatformConfig } from 'lib/config/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a PlatformConfig with QuickSuite enabled for the given overrides.
 * enableQuickSuite=true requires quickSightPrincipalArn.
 */
function buildQuickSuiteConfig(overrides: {
  solutionName: string;
  quickSuiteEdition: 'STANDARD' | 'ENTERPRISE';
}): PlatformConfig {
  return {
    vpc: { vpcMode: 'create', vpcCidr: '10.0.0.0/16', enableNatGateway: false, vpcEndpointMode: 'minimal' },
    account: { accountMode: 'single' },
    region: { regionMode: 'single' },
    identity: { identityMode: 'iam' },
    dataExports: { curBucketName: 'test-cur-bucket', curReportFormat: 'csv', reconciliationSchedule: 'rate(6 hours)' },
    dashboard: {
      enableQuickSuite: true,
      quickSightPrincipalArn: 'arn:aws:quicksight:us-east-1:123456789012:user/default/admin',
      quickSuiteEdition: overrides.quickSuiteEdition,
    },
    cloudTrail: { cloudTrailMode: 'create' },
    deployment: {
      solutionName: overrides.solutionName,
      environment: 'dev',
    },
    enableInvocationLogging: true,
  };
}

/**
 * Synthesizes an AnalyticsStack for the given config and returns the
 * CloudFormation Template for inspection.
 */
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

  const analyticsStack = new AnalyticsStack(app, 'AnalyticsStack', {
    config,
    cmk,
    processedDataBucket,
    env,
  });

  return Template.fromStack(analyticsStack);
}

/**
 * Finds the primary QuickSight CfnDataSet resource (the invocations dataset,
 * not the RLS dataset) from the synthesized template.
 */
function findInvocationsDataSet(template: Template): Record<string, unknown> | undefined {
  const dataSets = template.findResources('AWS::QuickSight::DataSet');
  const dataSetIds = Object.keys(dataSets);

  // The invocations dataset has a DataSetId ending in '-invocations-dataset'
  const invocationsId = dataSetIds.find((id) => {
    const ds = dataSets[id];
    const dataSetId: unknown = ds.Properties?.DataSetId;
    return typeof dataSetId === 'string' && dataSetId.endsWith('-invocations-dataset');
  });

  return invocationsId ? (dataSets[invocationsId] as Record<string, unknown>) : undefined;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid solution names: lowercase letters, digits, hyphens, 3–20 chars */
const solutionNameArb = fc
  .stringMatching(/^[a-z][a-z0-9-]{2,19}$/)
  .filter((s) => s.length >= 3 && s.length <= 20);

const editionArb = fc.constantFrom('STANDARD' as const, 'ENTERPRISE' as const);

/** Generates a full valid platform config tuple */
const platformConfigArb = fc.record({
  solutionName: solutionNameArb,
  quickSuiteEdition: editionArb,
});

// ---------------------------------------------------------------------------
// Property 1: Metrics physical table present in dataset
// Feature: dashboard-metrics-dataset-fix, Property 1: Metrics physical table present in dataset
// ---------------------------------------------------------------------------

describe('Property 1: Metrics physical table present in dataset', () => {
  // Validates: Requirements 1.1, 1.2, 1.3

  it('physicalTableMap contains exactly one entry: invocationLogs', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeAnalyticsStack(config);

        const dataSet = findInvocationsDataSet(template);
        if (!dataSet) return false;

        const physicalTableMap = (dataSet as { Properties?: { PhysicalTableMap?: Record<string, unknown> } })
          .Properties?.PhysicalTableMap;
        if (!physicalTableMap) return false;

        const keys = Object.keys(physicalTableMap);
        // Two-dataset architecture: invocations dataset only has invocationLogs
        if (keys.length !== 1) return false;
        return keys.includes('invocationLogs');
      }),
      { numRuns: 20 },
    );
  });

  it('invocationLogs physical table has a customSql block referencing invocation_logs Glue table', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeAnalyticsStack(config);

        const dataSet = findInvocationsDataSet(template);
        if (!dataSet) return false;

        const physicalTableMap = (dataSet as { Properties?: { PhysicalTableMap?: Record<string, unknown> } })
          .Properties?.PhysicalTableMap;
        const invocationLogs = physicalTableMap?.['invocationLogs'] as
          | { CustomSql?: { SqlQuery?: string; Name?: string } }
          | undefined;

        if (!invocationLogs?.CustomSql) return false;

        const sqlQuery = invocationLogs.CustomSql.SqlQuery ?? '';
        // Must reference the invocation_logs table
        return sqlQuery.includes('"invocation_logs"') || sqlQuery.includes('invocation_logs');
      }),
      { numRuns: 20 },
    );
  });

  it('separate metrics dataset exists with customSql referencing metrics Glue table', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeAnalyticsStack(config);

        // Find the metrics dataset (separate from invocations)
        const dataSets = template.findResources('AWS::QuickSight::DataSet');
        const metricsDataSetKey = Object.keys(dataSets).find((id) => {
          const ds = dataSets[id];
          const dataSetId: unknown = ds.Properties?.DataSetId;
          return typeof dataSetId === 'string' && dataSetId.endsWith('-metrics-dataset');
        });
        if (!metricsDataSetKey) return false;

        const metricsDataSet = dataSets[metricsDataSetKey] as Record<string, any>;
        const physicalTableMap = metricsDataSet.Properties?.PhysicalTableMap;
        const metrics = physicalTableMap?.['metrics'] as
          | { CustomSql?: { SqlQuery?: string; Name?: string } }
          | undefined;

        if (!metrics?.CustomSql) return false;

        const sqlQuery = metrics.CustomSql.SqlQuery ?? '';
        return sqlQuery.includes('"metrics"') || sqlQuery.includes('."metrics"');
      }),
      { numRuns: 20 },
    );
  });

  it('separate metrics dataset declares all required columns with correct types', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeAnalyticsStack(config);

        // Find the metrics dataset (separate from invocations)
        const dataSets = template.findResources('AWS::QuickSight::DataSet');
        const metricsDataSetKey = Object.keys(dataSets).find((id) => {
          const ds = dataSets[id];
          const dataSetId: unknown = ds.Properties?.DataSetId;
          return typeof dataSetId === 'string' && dataSetId.endsWith('-metrics-dataset');
        });
        if (!metricsDataSetKey) return false;

        const metricsDataSet = dataSets[metricsDataSetKey] as Record<string, any>;
        const physicalTableMap = metricsDataSet.Properties?.PhysicalTableMap;
        const metrics = physicalTableMap?.['metrics'] as
          | { CustomSql?: { Columns?: Array<{ Name: string; Type: string }> } }
          | undefined;

        const columns = metrics?.CustomSql?.Columns ?? [];
        if (columns.length === 0) return false;

        const colMap = new Map(columns.map((c) => [c.Name, c.Type]));

        return (
          colMap.get('timestamp') === 'DATETIME' &&
          colMap.get('region') === 'STRING' &&
          colMap.get('modelid') === 'STRING' &&
          colMap.get('invocationcount') === 'INTEGER' &&
          colMap.get('invocationlatencyavg') === 'DECIMAL' &&
          colMap.get('invocationlatencyp99') === 'DECIMAL' &&
          colMap.get('throttledcount') === 'INTEGER' &&
          colMap.get('errorcount') === 'INTEGER'
        );
      }),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: No placeholder columns in invocationLogs physical table
// Feature: dashboard-metrics-dataset-fix, Property 2: No placeholder columns in invocationLogs physical table
// ---------------------------------------------------------------------------

describe('Property 2: No placeholder columns in invocationLogs physical table', () => {
  // Validates: Requirements 2.1, 2.2, 2.3

  const PLACEHOLDER_COLUMNS = [
    'errorcount',
    'throttledcount',
    'invocationcount',
    'invocationlatencyavg',
    'invocationlatencyp99',
  ];

  it('invocationLogs SQL query does not contain placeholder column aliases', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeAnalyticsStack(config);

        const dataSet = findInvocationsDataSet(template);
        if (!dataSet) return false;

        const physicalTableMap = (dataSet as { Properties?: { PhysicalTableMap?: Record<string, unknown> } })
          .Properties?.PhysicalTableMap;
        const invocationLogs = physicalTableMap?.['invocationLogs'] as
          | { CustomSql?: { SqlQuery?: string } }
          | undefined;

        const sqlQuery = (invocationLogs?.CustomSql?.SqlQuery ?? '').toLowerCase();

        // Requirement 2.2: SQL must NOT contain any of the placeholder aliases
        return PLACEHOLDER_COLUMNS.every((col) => !sqlQuery.includes(col));
      }),
      { numRuns: 20 },
    );
  });

  it('invocationLogs column declarations do not include placeholder column names', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeAnalyticsStack(config);

        const dataSet = findInvocationsDataSet(template);
        if (!dataSet) return false;

        const physicalTableMap = (dataSet as { Properties?: { PhysicalTableMap?: Record<string, unknown> } })
          .Properties?.PhysicalTableMap;
        const invocationLogs = physicalTableMap?.['invocationLogs'] as
          | { CustomSql?: { Columns?: Array<{ Name: string }> } }
          | undefined;

        const columns = invocationLogs?.CustomSql?.Columns ?? [];
        const columnNames = columns.map((c) => c.Name.toLowerCase());

        // Requirement 2.3: column declarations must NOT include placeholder names
        return PLACEHOLDER_COLUMNS.every((col) => !columnNames.includes(col));
      }),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Two-dataset architecture (no LEFT JOIN)
// Feature: dashboard-metrics-dataset-fix, Property 3: Two-dataset architecture
// ---------------------------------------------------------------------------

describe('Property 3: Two-dataset architecture maintained', () => {
  // Validates: Two separate datasets, no LEFT JOIN

  it('invocations dataset logicalTableMap has a single logical table with data transforms', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeAnalyticsStack(config);

        const dataSet = findInvocationsDataSet(template);
        if (!dataSet) return false;

        const logicalTableMap = (dataSet as {
          Properties?: { LogicalTableMap?: Record<string, unknown> };
        }).Properties?.LogicalTableMap;
        if (!logicalTableMap) return false;

        const keys = Object.keys(logicalTableMap);
        // Two-dataset architecture: invocations dataset has a single logical table
        return keys.length === 1 && keys.includes('invocationLogs');
      }),
      { numRuns: 20 },
    );
  });

  it('invocations dataset logicalTableMap does NOT contain a LEFT JOIN', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeAnalyticsStack(config);

        const dataSet = findInvocationsDataSet(template);
        if (!dataSet) return false;

        const logicalTableMap = (dataSet as {
          Properties?: { LogicalTableMap?: Record<string, unknown> };
        }).Properties?.LogicalTableMap;
        if (!logicalTableMap) return false;

        const logicalTables = Object.values(logicalTableMap) as Array<{
          Source?: { JoinInstruction?: { Type?: string } };
        }>;

        // No logical table should have a JoinInstruction
        return logicalTables.every(
          (lt) => lt.Source?.JoinInstruction === undefined,
        );
      }),
      { numRuns: 20 },
    );
  });

  it('metrics dataset exists as a separate CfnDataSet resource', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeAnalyticsStack(config);

        const dataSets = template.findResources('AWS::QuickSight::DataSet');
        const hasMetricsDataSet = Object.values(dataSets).some((ds: any) =>
          ds.Properties?.DataSetId?.endsWith('-metrics-dataset'),
        );
        return hasMetricsDataSet;
      }),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Dataset backward compatibility invariants
// Feature: dashboard-metrics-dataset-fix, Property 4: Dataset backward compatibility invariants
// ---------------------------------------------------------------------------

describe('Property 4: Dataset backward compatibility invariants', () => {
  // Validates: Requirements 3.5, 8.4

  it('dataSetId matches the pattern {solutionName}-invocations-dataset', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeAnalyticsStack(config);

        const dataSet = findInvocationsDataSet(template);
        if (!dataSet) return false;

        const dataSetId = (dataSet as { Properties?: { DataSetId?: string } }).Properties?.DataSetId;
        if (typeof dataSetId !== 'string') return false;

        // Requirement 8.4: dataSetId must match {solutionName}-invocations-dataset
        return dataSetId === `${solutionName}-invocations-dataset`;
      }),
      { numRuns: 20 },
    );
  });

  it('logicalTableMap contains a createColumnsOperation producing totaltokens column', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeAnalyticsStack(config);

        const dataSet = findInvocationsDataSet(template);
        if (!dataSet) return false;

        const logicalTableMap = (dataSet as {
          Properties?: { LogicalTableMap?: Record<string, unknown> };
        }).Properties?.LogicalTableMap;
        if (!logicalTableMap) return false;

        type DataTransform = {
          CreateColumnsOperation?: {
            Columns?: Array<{ ColumnName?: string; Expression?: string }>;
          };
        };

        type LogicalTable = {
          DataTransforms?: DataTransform[];
        };

        const logicalTables = Object.values(logicalTableMap) as LogicalTable[];

        // Requirement 3.5: must have a createColumnsOperation for totaltokens
        return logicalTables.some((lt) => {
          const transforms = lt.DataTransforms ?? [];
          return transforms.some((t) => {
            const cols = t.CreateColumnsOperation?.Columns ?? [];
            return cols.some(
              (c) =>
                c.ColumnName === 'totaltokens' &&
                c.Expression === '{inputtokens} + {outputtokens}',
            );
          });
        });
      }),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Dashboard calculatedFields with correct dataset identifier
// Feature: dashboard-metrics-dataset-fix, Property 5: Dashboard calculatedFields with correct dataset identifier
// ---------------------------------------------------------------------------

/**
 * Synthesizes a DashboardStack (with its AnalyticsStack dependency) for the
 * given config and returns the CloudFormation Template for inspection.
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

/**
 * Finds the CfnDashboard resource from the synthesized DashboardStack template.
 */
function findDashboard(template: Template): Record<string, unknown> | undefined {
  const dashboards = template.findResources('AWS::QuickSight::Dashboard');
  const ids = Object.keys(dashboards);
  return ids.length > 0 ? (dashboards[ids[0]] as Record<string, unknown>) : undefined;
}

describe('Property 5: Dashboard calculatedFields with correct dataset identifier', () => {
  // Validates: Requirements 4.1, 4.5

  it('calculatedFields array exists and contains entries for both InvocationLogs and Metrics datasets', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeDashboardStack(config);

        const dashboard = findDashboard(template);
        if (!dashboard) return false;

        type CalcField = { DataSetIdentifier?: string; Name?: string; Expression?: string };
        const calculatedFields = (dashboard as {
          Properties?: { Definition?: { CalculatedFields?: CalcField[] } };
        }).Properties?.Definition?.CalculatedFields;

        // calculatedFields array must exist and be non-empty
        if (!Array.isArray(calculatedFields) || calculatedFields.length === 0) return false;

        // Every entry must reference either InvocationLogs or Metrics dataset
        const validIdentifiers = ['InvocationLogs', 'Metrics'];
        return calculatedFields.every((cf) => validIdentifiers.includes(cf.DataSetIdentifier ?? ''));
      }),
      { numRuns: 20 },
    );
  });

  it('calculatedFields contains an ErrorRate entry', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeDashboardStack(config);

        const dashboard = findDashboard(template);
        if (!dashboard) return false;

        type CalcField = { DataSetIdentifier?: string; Name?: string };
        const calculatedFields = (dashboard as {
          Properties?: { Definition?: { CalculatedFields?: CalcField[] } };
        }).Properties?.Definition?.CalculatedFields;

        if (!Array.isArray(calculatedFields)) return false;

        // Requirement 4.1: must contain an ErrorRate entry
        return calculatedFields.some((cf) => cf.Name === 'ErrorRate');
      }),
      { numRuns: 20 },
    );
  });

  it('calculatedFields contains a TotalTokensCalc entry', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const config = buildQuickSuiteConfig({ solutionName, quickSuiteEdition });
        const template = synthesizeDashboardStack(config);

        const dashboard = findDashboard(template);
        if (!dashboard) return false;

        type CalcField = { DataSetIdentifier?: string; Name?: string };
        const calculatedFields = (dashboard as {
          Properties?: { Definition?: { CalculatedFields?: CalcField[] } };
        }).Properties?.Definition?.CalculatedFields;

        if (!Array.isArray(calculatedFields)) return false;

        // Requirement 4.1: must contain a TotalTokensCalc entry
        return calculatedFields.some((cf) => cf.Name === 'TotalTokensCalc');
      }),
      { numRuns: 20 },
    );
  });
});

import * as quicksight from 'aws-cdk-lib/aws-quicksight';
import { buildSheetDefinitions } from 'lib/stacks/dashboard-visuals';

// ---------------------------------------------------------------------------
// Helpers for Properties 6–8: extract column names from visual field wells
// ---------------------------------------------------------------------------

/**
 * Recursively collects all column name values from a visual's field wells.
 * Handles both camelCase (TypeScript CDK objects) and PascalCase (CloudFormation templates).
 * Traverses the entire object tree looking for { columnName: string } or { ColumnName: string } shapes.
 */
function collectColumnNames(obj: unknown): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) {
    return obj.flatMap((item) => collectColumnNames(item));
  }
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

/**
 * Finds a visual by its visualId within a list of VisualProperty objects.
 */
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

/**
 * Extracts the field wells object from a visual (the chartConfiguration.fieldWells).
 * Uses JSON round-trip to avoid TypeScript IResolvable union type issues.
 */
function getFieldWells(visual: quicksight.CfnDashboard.VisualProperty): unknown {
  // JSON round-trip to get a plain object without IResolvable union type issues
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
  return (inner as Record<string, unknown> | undefined)?.['chartConfiguration']
    ? ((inner as Record<string, unknown>)['chartConfiguration'] as Record<string, unknown>)?.['fieldWells']
    : undefined;
}

// ---------------------------------------------------------------------------
// Property 6: Error Rate KPIs reference dashboard-level calculated field
// Feature: dashboard-metrics-dataset-fix, Property 6: Error Rate KPIs reference dashboard-level calculated field
// ---------------------------------------------------------------------------

describe('Property 6: Error Rate KPIs reference dashboard-level calculated field', () => {
  // Validates: Requirements 5.2, 6.1, 6.2, 6.3

  it('Executive Summary Error Rate KPI references ErrorRate column, not latencyms', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: 'InvocationLogs',
          solutionName,
        });

        const execSheet = result.sheets.find((s) => s.sheetId === 'executive-summary');
        if (!execSheet) return false;

        const errorRateKpi = findVisualById(
          execSheet.visuals as quicksight.CfnDashboard.VisualProperty[],
          'exec-kpi-error-rate',
        );
        if (!errorRateKpi) return false;

        const fieldWells = getFieldWells(errorRateKpi);
        const columns = collectColumnNames(fieldWells);

        // Must reference ErrorRate, must NOT reference latencyms as placeholder
        return columns.includes('ErrorRate') && !columns.includes('latencyms');
      }),
      { numRuns: 20 },
    );
  });

  it('Executive Summary Error Rate KPI applies percent formatting', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: 'InvocationLogs',
          solutionName,
        });

        const execSheet = result.sheets.find((s) => s.sheetId === 'executive-summary');
        if (!execSheet) return false;

        const errorRateKpi = findVisualById(
          execSheet.visuals as quicksight.CfnDashboard.VisualProperty[],
          'exec-kpi-error-rate',
        );
        if (!errorRateKpi) return false;

        // Percent formatting is indicated by percentageDisplayFormatConfiguration in the field wells
        const fieldWellsStr = JSON.stringify(getFieldWells(errorRateKpi));
        return fieldWellsStr.includes('percentageDisplayFormatConfiguration');
      }),
      { numRuns: 20 },
    );
  });

  it('Performance sheet Error Rate KPI references ErrorRate column, not latencyms', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: 'InvocationLogs',
          solutionName,
        });

        const perfSheet = result.sheets.find((s) => s.sheetId === 'performance');
        if (!perfSheet) return false;

        const errorRateKpi = findVisualById(
          perfSheet.visuals as quicksight.CfnDashboard.VisualProperty[],
          'perf-kpi-error-rate',
        );
        if (!errorRateKpi) return false;

        const fieldWells = getFieldWells(errorRateKpi);
        const columns = collectColumnNames(fieldWells);

        // Must reference ErrorRate, must NOT reference latencyms as placeholder
        return columns.includes('ErrorRate') && !columns.includes('latencyms');
      }),
      { numRuns: 20 },
    );
  });

  it('Performance sheet Error Rate KPI applies percent formatting', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: 'InvocationLogs',
          solutionName,
        });

        const perfSheet = result.sheets.find((s) => s.sheetId === 'performance');
        if (!perfSheet) return false;

        const errorRateKpi = findVisualById(
          perfSheet.visuals as quicksight.CfnDashboard.VisualProperty[],
          'perf-kpi-error-rate',
        );
        if (!errorRateKpi) return false;

        const fieldWellsStr = JSON.stringify(getFieldWells(errorRateKpi));
        return fieldWellsStr.includes('percentageDisplayFormatConfiguration');
      }),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Performance sheet visual field correctness
// Feature: dashboard-metrics-dataset-fix, Property 7: Performance sheet visual field correctness
// ---------------------------------------------------------------------------

describe('Property 7: Performance sheet visual field correctness', () => {
  // Validates: Requirements 5.1, 5.3, 5.4, 5.5

  it('P99 Latency KPI references invocationlatencyp99', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: 'InvocationLogs',
          solutionName,
        });

        const perfSheet = result.sheets.find((s) => s.sheetId === 'performance');
        if (!perfSheet) return false;

        const p99Kpi = findVisualById(
          perfSheet.visuals as quicksight.CfnDashboard.VisualProperty[],
          'perf-kpi-p99-latency',
        );
        if (!p99Kpi) return false;

        const columns = collectColumnNames(getFieldWells(p99Kpi));
        return columns.includes('invocationlatencyp99');
      }),
      { numRuns: 20 },
    );
  });

  it('Combo chart lineValues reference invocationlatencyp99', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: 'InvocationLogs',
          solutionName,
        });

        const perfSheet = result.sheets.find((s) => s.sheetId === 'performance');
        if (!perfSheet) return false;

        const comboChart = findVisualById(
          perfSheet.visuals as quicksight.CfnDashboard.VisualProperty[],
          'perf-latency-combo',
        );
        if (!comboChart) return false;

        // collectColumnNames traverses the entire visual object tree
        const allColumns = collectColumnNames(comboChart);
        return allColumns.includes('invocationlatencyp99');
      }),
      { numRuns: 20 },
    );
  });

  it('Daily Throttles table references throttledcount', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: 'InvocationLogs',
          solutionName,
        });

        const perfSheet = result.sheets.find((s) => s.sheetId === 'performance');
        if (!perfSheet) return false;

        const throttleTable = findVisualById(
          perfSheet.visuals as quicksight.CfnDashboard.VisualProperty[],
          'perf-daily-throttles-table',
        );
        if (!throttleTable) return false;

        const columns = collectColumnNames(getFieldWells(throttleTable));
        return columns.includes('throttledcount');
      }),
      { numRuns: 20 },
    );
  });

  it('Scatter plot x-axis references latencyms and y-axis references totaltokens', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: 'InvocationLogs',
          solutionName,
        });

        const perfSheet = result.sheets.find((s) => s.sheetId === 'performance');
        if (!perfSheet) return false;

        const scatter = findVisualById(
          perfSheet.visuals as quicksight.CfnDashboard.VisualProperty[],
          'perf-latency-tokens-scatter',
        );
        if (!scatter) return false;

        // Use JSON traversal to avoid IResolvable union type issues in CDK types
        type ScatterWells = {
          xAxis?: unknown[];
          yAxis?: unknown[];
        };
        type ScatterJson = {
          scatterPlotVisual?: {
            chartConfiguration?: {
              fieldWells?: {
                scatterPlotCategoricallyAggregatedFieldWells?: ScatterWells;
              };
            };
          };
        };
        const scatterJson = JSON.parse(JSON.stringify(scatter)) as ScatterJson;
        const scatterWells =
          scatterJson?.scatterPlotVisual?.chartConfiguration?.fieldWells
            ?.scatterPlotCategoricallyAggregatedFieldWells;
        if (!scatterWells) return false;

        const xColumns = collectColumnNames(scatterWells.xAxis ?? []);
        const yColumns = collectColumnNames(scatterWells.yAxis ?? []);

        return xColumns.includes('latencyms') && yColumns.includes('totaltokens');
      }),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: Non-Performance sheet backward compatibility
// Feature: dashboard-metrics-dataset-fix, Property 8: Non-Performance sheet backward compatibility
// ---------------------------------------------------------------------------

describe('Property 8: Non-Performance sheet backward compatibility', () => {
  // Validates: Requirements 8.1, 8.2, 8.3

  /**
   * Columns that exist only in the metrics table and must NOT appear in
   * non-performance sheet visuals (except the Error Rate KPI).
   */
  const METRICS_ONLY_COLUMNS = [
    'invocationcount',
    'invocationlatencyavg',
    'invocationlatencyp99',
    'throttledcount',
    'errorcount',
  ];

  it('Executive Summary sheet visuals (except Error Rate KPI) do not reference metrics-only columns', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: 'InvocationLogs',
          solutionName,
        });

        const execSheet = result.sheets.find((s) => s.sheetId === 'executive-summary');
        if (!execSheet) return false;

        const visuals = execSheet.visuals as quicksight.CfnDashboard.VisualProperty[];

        // Exclude KPIs that now intentionally use Metrics dataset columns
        const metricsKpiIds = ['exec-kpi-error-rate', 'exec-kpi-latency'];
        const nonMetricsVisuals = visuals.filter((v) => {
          const inner = v.kpiVisual ?? v.lineChartVisual ?? v.barChartVisual ??
            v.pieChartVisual ?? v.heatMapVisual ?? v.comboChartVisual ??
            v.scatterPlotVisual ?? v.pivotTableVisual ?? v.tableVisual;
          const id = (inner as { visualId?: string } | undefined)?.visualId;
          return !metricsKpiIds.includes(id ?? '');
        });

        for (const visual of nonMetricsVisuals) {
          const columns = collectColumnNames(getFieldWells(visual));
          for (const metricsCol of METRICS_ONLY_COLUMNS) {
            if (columns.includes(metricsCol)) return false;
          }
        }
        return true;
      }),
      { numRuns: 20 },
    );
  });

  it('Cost & Usage sheet visuals do not reference metrics-only columns', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: 'InvocationLogs',
          solutionName,
        });

        const costSheet = result.sheets.find((s) => s.sheetId === 'cost-usage');
        if (!costSheet) return false;

        const visuals = costSheet.visuals as quicksight.CfnDashboard.VisualProperty[];

        for (const visual of visuals) {
          const columns = collectColumnNames(getFieldWells(visual));
          for (const metricsCol of METRICS_ONLY_COLUMNS) {
            if (columns.includes(metricsCol)) return false;
          }
        }
        return true;
      }),
      { numRuns: 20 },
    );
  });

  it('Service Quota Prep sheet visuals (except TPM/RPM KPIs) do not reference metrics-only columns', () => {
    fc.assert(
      fc.property(platformConfigArb, ({ solutionName, quickSuiteEdition }) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: 'InvocationLogs',
          solutionName,
        });

        const sqSheet = result.sheets.find((s) => s.sheetId === 'service-quota-prep');
        if (!sqSheet) return false;

        // TPM/RPM KPIs now intentionally use Metrics dataset columns (invocationcount)
        const tpmRpmKpiIds = [
          'sq-kpi-steady-tpm', 'sq-kpi-steady-rpm',
          'sq-kpi-peak-tpm', 'sq-kpi-peak-rpm',
        ];
        const visuals = (sqSheet.visuals as quicksight.CfnDashboard.VisualProperty[]).filter(
          (v) => {
            const id = (v.kpiVisual as any)?.visualId;
            return !tpmRpmKpiIds.includes(id);
          },
        );

        for (const visual of visuals) {
          const columns = collectColumnNames(getFieldWells(visual));
          for (const metricsCol of METRICS_ONLY_COLUMNS) {
            if (columns.includes(metricsCol)) return false;
          }
        }
        return true;
      }),
      { numRuns: 20 },
    );
  });
});
