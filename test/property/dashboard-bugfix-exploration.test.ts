/**
 * Bug Condition Exploration Test — Dashboard Visual & Deployment Defects
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10,
 *              2.11, 2.12, 2.13, 2.14, 2.15, 2.16, 2.17, 2.18, 2.19, 2.20, 2.21**
 *
 * This test encodes the EXPECTED (fixed) behavior. It MUST FAIL on unfixed code
 * to confirm the bugs exist. After the fix is applied, it should PASS.
 */
import * as fc from 'fast-check';
import {
  buildSheetDefinitions,
  DATASET_IDENTIFIER,
  METRICS_DATASET_IDENTIFIER,
} from 'lib/stacks/dashboard-visuals';
import type { SheetDefinitionsParams } from 'lib/stacks/dashboard-visuals';
import { ConfigSchema } from 'lib/config/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Synthesize sheet definitions with default params */
function synth(overrides?: Partial<SheetDefinitionsParams>) {
  const params: SheetDefinitionsParams = {
    dataSetIdentifier: DATASET_IDENTIFIER,
    solutionName: 'test-solution',
    ...overrides,
  };
  return buildSheetDefinitions(params);
}

function findSheet(sheetId: string) {
  const result = synth();
  return result.sheets.find((s) => s.sheetId === sheetId);
}

function findVisual(sheetId: string, visualId: string): any {
  const sheet = findSheet(sheetId);
  if (!sheet) return undefined;
  const visuals = (sheet.visuals ?? []) as any[];
  return visuals.find((v: any) => {
    const id =
      v.kpiVisual?.visualId ??
      v.barChartVisual?.visualId ??
      v.pieChartVisual?.visualId ??
      v.heatMapVisual?.visualId ??
      v.lineChartVisual?.visualId ??
      v.pivotTableVisual?.visualId ??
      v.tableVisual?.visualId ??
      v.comboChartVisual?.visualId ??
      v.scatterPlotVisual?.visualId;
    return id === visualId;
  });
}

function getVisualIds(sheetId: string): string[] {
  const sheet = findSheet(sheetId);
  if (!sheet) return [];
  return ((sheet.visuals ?? []) as any[]).map((v: any) => {
    return (
      v.kpiVisual?.visualId ??
      v.barChartVisual?.visualId ??
      v.pieChartVisual?.visualId ??
      v.heatMapVisual?.visualId ??
      v.lineChartVisual?.visualId ??
      v.pivotTableVisual?.visualId ??
      v.tableVisual?.visualId ??
      v.comboChartVisual?.visualId ??
      v.scatterPlotVisual?.visualId ??
      'unknown'
    );
  });
}

/** Recursively find all column references in a visual definition */
function findColumnReferences(obj: any, results: { dataSetIdentifier: string; columnName: string }[] = []): typeof results {
  if (obj === null || obj === undefined) return results;
  if (typeof obj !== 'object') return results;
  if (obj.dataSetIdentifier && obj.columnName) {
    results.push({ dataSetIdentifier: obj.dataSetIdentifier, columnName: obj.columnName });
  }
  for (const key of Object.keys(obj)) {
    findColumnReferences(obj[key], results);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------
const validSolutionNames = fc.constantFrom('test-solution', 'my-platform', 'bedrock-intel');

// ---------------------------------------------------------------------------
// Property 1: SPICE Always Enabled (Validates: Requirements 2.1, 2.2)
// ---------------------------------------------------------------------------

describe('Property 1: SPICE Always Enabled', () => {
  it('spiceMode should NOT exist in the config schema', () => {
    // After the fix, the schema should reject spiceMode entirely.
    // ConfigSchema is a ZodEffects (due to .refine()), so we access the inner schema.
    const innerSchema = (ConfigSchema as any)._def?.schema;
    const dashboardSchema = innerSchema?.shape?.dashboard;
    // DashboardConfigSchema is also a ZodEffects (due to .refine()), so unwrap again
    const dashboardInner = dashboardSchema?._def?.schema ?? dashboardSchema?._def?.innerType;
    const dashboardShape = dashboardInner?.shape ?? dashboardSchema?.shape;

    // spiceMode should not be a recognized key in the dashboard schema
    expect(dashboardShape).toBeDefined();
    expect(dashboardShape?.spiceMode).toBeUndefined();
  });

  it('Refresh Lambda resources should always be created (spiceMode not gating creation)', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        // After the fix, buildSheetDefinitions should work without spiceMode
        // and the DashboardStack should always create Refresh Lambda.
        // We test the visual layer here — the stack-level test is separate.
        const result = synth({ solutionName });
        // The sheet definitions should always be produced regardless
        return result.sheets.length === 4;
      }),
      { numRuns: 10 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Friendly Model Names (Validates: Requirements 2.3, 2.6, 2.7, 2.15)
// ---------------------------------------------------------------------------

describe('Property 2: Friendly Model Names', () => {
  it('all model name fields should reference FriendlyModelName instead of modelname', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = synth({ solutionName });

        // Check all sheets for model name column references
        for (const sheet of result.sheets) {
          const visuals = (sheet.visuals ?? []) as any[];
          for (const visual of visuals) {
            const refs = findColumnReferences(visual);
            for (const ref of refs) {
              // No visual should reference raw 'modelname' — they should all use 'FriendlyModelName'
              if (ref.columnName === 'modelname') {
                return false; // Bug: raw modelname still used
              }
            }
          }
        }
        return true;
      }),
      { numRuns: 10 },
    );
  });

  it('Service Quota model dropdown should reference FriendlyModelName', () => {
    const sqSheet = findSheet('service-quota-prep');
    expect(sqSheet).toBeDefined();

    const paramControls = (sqSheet!.parameterControls ?? []) as any[];
    const modelDropdown = paramControls.find(
      (c: any) => c.dropdown?.parameterControlId === 'sq-model-dropdown-control',
    );
    expect(modelDropdown).toBeDefined();
    expect(modelDropdown.dropdown.selectableValues.linkToDataSetColumn.columnName).toBe('FriendlyModelName');
  });
});

// ---------------------------------------------------------------------------
// Property 3: Correct Data Sources for Latency KPIs (Validates: Requirements 2.4, 2.11)
// ---------------------------------------------------------------------------

describe('Property 3: Correct Latency KPI Data Sources', () => {
  it('exec-kpi-latency should use invocationlatencyavg from Metrics dataset', () => {
    const visual = findVisual('executive-summary', 'exec-kpi-latency');
    expect(visual).toBeDefined();

    const kpi = visual.kpiVisual;
    const values = kpi.chartConfiguration.fieldWells.values;
    expect(values).toHaveLength(1);

    const measureField = values[0].numericalMeasureField;
    expect(measureField).toBeDefined();
    expect(measureField.column.dataSetIdentifier).toBe(METRICS_DATASET_IDENTIFIER);
    expect(measureField.column.columnName).toBe('invocationlatencyavg');
  });

  it('perf-kpi-avg-latency should use invocationlatencyavg from Metrics dataset', () => {
    const visual = findVisual('performance', 'perf-kpi-avg-latency');
    expect(visual).toBeDefined();

    const kpi = visual.kpiVisual;
    const values = kpi.chartConfiguration.fieldWells.values;
    expect(values).toHaveLength(1);

    const measureField = values[0].numericalMeasureField;
    expect(measureField).toBeDefined();
    expect(measureField.column.dataSetIdentifier).toBe(METRICS_DATASET_IDENTIFIER);
    expect(measureField.column.columnName).toBe('invocationlatencyavg');
  });
});

// ---------------------------------------------------------------------------
// Property 4: Service Quota TPM/RPM KPIs use Metrics dataset (Validates: Requirements 2.17–2.20)
// ---------------------------------------------------------------------------

describe('Property 4: Service Quota TPM/RPM KPIs use Metrics dataset', () => {
  const sqKpiIds = [
    'sq-kpi-steady-tpm',
    'sq-kpi-steady-rpm',
    'sq-kpi-peak-tpm',
    'sq-kpi-peak-rpm',
  ];

  it.each(sqKpiIds)('%s should use Metrics dataset, not InvocationLogs', (visualId) => {
    const visual = findVisual('service-quota-prep', visualId);
    expect(visual).toBeDefined();

    const kpi = visual.kpiVisual;
    const values = kpi.chartConfiguration.fieldWells.values;
    expect(values.length).toBeGreaterThan(0);

    const measureField = values[0].numericalMeasureField;
    expect(measureField).toBeDefined();
    expect(measureField.column.dataSetIdentifier).toBe(METRICS_DATASET_IDENTIFIER);
  });
});


// ---------------------------------------------------------------------------
// Property 5: Axis Labels and Legend Labels (Validates: Requirements 2.6, 2.7, 2.8)
// ---------------------------------------------------------------------------

describe('Property 5: Axis Labels and Legend Labels', () => {
  it('cu-cost-by-model-bar should have colorLabelOptions with customLabel for Input Costs / Output Costs and Y-axis label Model Name', () => {
    const visual = findVisual('cost-usage', 'cu-cost-by-model-bar');
    expect(visual).toBeDefined();

    const barChart = visual.barChartVisual;
    const config = barChart.chartConfiguration;

    // Check colorLabelOptions with customLabel for legend labels
    const colorLabelOptions = config.colorLabelOptions as any | undefined;
    expect(colorLabelOptions).toBeDefined();

    const axisLabels = colorLabelOptions!.axisLabelOptions as any[];
    expect(axisLabels).toBeDefined();

    const inputCostLabel = axisLabels.find((al: any) => al.customLabel === 'Input Costs');
    const outputCostLabel = axisLabels.find((al: any) => al.customLabel === 'Output Costs');
    expect(inputCostLabel).toBeDefined();
    expect(outputCostLabel).toBeDefined();

    // Check Y-axis label "Model Name" (category axis for horizontal bar)
    const categoryLabelOptions = config.categoryLabelOptions;
    const hasModelNameLabel = JSON.stringify(config).includes('"Model Name"');
    expect(hasModelNameLabel).toBe(true);
  });

  it('cu-cost-heatmap should have row label Model Name and column label Date', () => {
    const visual = findVisual('cost-usage', 'cu-cost-heatmap');
    expect(visual).toBeDefined();

    const heatMap = visual.heatMapVisual;
    const configStr = JSON.stringify(heatMap.chartConfiguration);

    // Should have "Model Name" as row label and "Date" as column label
    expect(configStr).toContain('"Model Name"');
    expect(configStr).toContain('"Date"');
  });

  it('cu-token-trends-area should have legend labels Input Tokens / Output Tokens and X-axis label Date', () => {
    const visual = findVisual('cost-usage', 'cu-token-trends-area');
    expect(visual).toBeDefined();

    const lineChart = visual.lineChartVisual;
    const config = lineChart.chartConfiguration;

    // Check primaryYAxisLabelOptions with customLabel for legend labels
    const yAxisLabelOptions = config.primaryYAxisLabelOptions;
    expect(yAxisLabelOptions).toBeDefined();
    expect(yAxisLabelOptions.visibility).toBe('VISIBLE');

    const axisLabelOptions = yAxisLabelOptions.axisLabelOptions as any[] | undefined;
    expect(axisLabelOptions).toBeDefined();

    const inputTokenLabel = axisLabelOptions!.find((ao: any) => ao.customLabel === 'Input Tokens');
    const outputTokenLabel = axisLabelOptions!.find((ao: any) => ao.customLabel === 'Output Tokens');
    expect(inputTokenLabel).toBeDefined();
    expect(outputTokenLabel).toBeDefined();

    // Check X-axis label "Date"
    const xAxisLabelOptions = config.xAxisLabelOptions;
    expect(xAxisLabelOptions).toBeDefined();
    expect(xAxisLabelOptions.visibility).toBe('VISIBLE');
    const xAxisLabels = xAxisLabelOptions.axisLabelOptions as any[];
    expect(xAxisLabels).toBeDefined();
    expect(xAxisLabels.some((l: any) => l.customLabel === 'Date')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 6: Pivot Table Totals Column (Validates: Requirements 2.10)
// ---------------------------------------------------------------------------

describe('Property 6: Pivot Table Totals Column', () => {
  it('cu-user-model-pivot should have totalOptions with columnTotalOptions.totalsVisibility VISIBLE', () => {
    const visual = findVisual('cost-usage', 'cu-user-model-pivot');
    expect(visual).toBeDefined();

    const pivotTable = visual.pivotTableVisual;
    const config = pivotTable.chartConfiguration;

    expect(config.totalOptions).toBeDefined();
    expect(config.totalOptions.columnTotalOptions).toBeDefined();
    expect(config.totalOptions.columnTotalOptions.totalsVisibility).toBe('VISIBLE');
  });
});

// ---------------------------------------------------------------------------
// Property 7: Visual Additions and Removals (Validates: Requirements 2.5, 2.9, 2.14, 2.16, 2.21)
// ---------------------------------------------------------------------------

describe('Property 7: Visual Additions and Removals', () => {
  it('Cost & Usage sheet should contain a cu-user-cost-donut pie chart visual', () => {
    const visualIds = getVisualIds('cost-usage');
    expect(visualIds).toContain('cu-user-cost-donut');

    const visual = findVisual('cost-usage', 'cu-user-cost-donut');
    expect(visual).toBeDefined();
    expect(visual.pieChartVisual).toBeDefined();
  });

  it('sq-kpi-input-modalities should NOT be in service-quota-prep visuals', () => {
    const visualIds = getVisualIds('service-quota-prep');
    expect(visualIds).not.toContain('sq-kpi-input-modalities');
  });

  it('sq-kpi-cris-option should NOT be in service-quota-prep visuals', () => {
    const visualIds = getVisualIds('service-quota-prep');
    expect(visualIds).not.toContain('sq-kpi-cris-option');
  });

  it('Performance sheet should have perf-daily-throttles-table table visual instead of perf-error-throttle-area', () => {
    const visualIds = getVisualIds('performance');

    // Should NOT have the old area chart
    expect(visualIds).not.toContain('perf-error-throttle-area');

    // Should have the new table visual
    expect(visualIds).toContain('perf-daily-throttles-table');

    const visual = findVisual('performance', 'perf-daily-throttles-table');
    expect(visual).toBeDefined();
    expect(visual.tableVisual).toBeDefined();
  });

  it('exec-kpi-last-refreshed should have hidden header and be first in the visuals array', () => {
    const execSheet = findSheet('executive-summary');
    expect(execSheet).toBeDefined();

    const visuals = (execSheet!.visuals ?? []) as any[];
    expect(visuals.length).toBeGreaterThan(0);

    // Should be first in the visuals array
    const firstVisual = visuals[0];
    const firstVisualId =
      firstVisual.tableVisual?.visualId ??
      firstVisual.kpiVisual?.visualId ??
      'unknown';
    expect(firstVisualId).toBe('exec-kpi-last-refreshed');

    // Should have hidden header
    const lastRefreshed = findVisual('executive-summary', 'exec-kpi-last-refreshed');
    expect(lastRefreshed).toBeDefined();
    const tableConfig = lastRefreshed.tableVisual.chartConfiguration;
    const headerVisibility = tableConfig.tableOptions?.headerStyle?.visibility;
    expect(headerVisibility).toBe('HIDDEN');

    // Should use tableUnaggregatedFieldWells (not tableAggregatedFieldWells)
    // with a single UnaggregatedFieldProperty for the timestamp column
    const fieldWells = tableConfig.fieldWells;
    expect(fieldWells.tableUnaggregatedFieldWells).toBeDefined();
    expect(fieldWells.tableAggregatedFieldWells).toBeUndefined();

    const unaggValues = fieldWells.tableUnaggregatedFieldWells.values as any[];
    expect(unaggValues).toHaveLength(1);
    const field = unaggValues[0];
    expect(field.fieldId).toBe('exec-kpi-last-refreshed-val');
    expect(field.column.columnName).toBe('timestamp');

    // Date format should be 'MMMM D, YYYY [at] HH:mm:ss'
    const dateFormat =
      field.formatConfiguration?.dateTimeFormatConfiguration?.dateTimeFormat;
    expect(dateFormat).toBe('MMMM D, YYYY [at] HH:mm:ss');

    // Should sort by timestamp DESC so the most recent row is first
    const rowSort = tableConfig.sortConfiguration?.rowSort as any[];
    expect(rowSort).toBeDefined();
    expect(rowSort).toHaveLength(1);
    expect(rowSort[0].fieldSort.fieldId).toBe('exec-kpi-last-refreshed-val');
    expect(rowSort[0].fieldSort.direction).toBe('DESC');

    // Should hide overflow rows so only the top (most recent) row is visible
    const overflowVisibility =
      tableConfig.paginatedReportOptions?.verticalOverflowVisibility;
    expect(overflowVisibility).toBe('HIDDEN');
  });
});

// ---------------------------------------------------------------------------
// Property 8: Model Dropdown Filters on Performance KPIs (Validates: Requirements 2.11–2.13)
// ---------------------------------------------------------------------------

describe('Property 8: Model Dropdown Filter on Performance KPIs', () => {
  it('Performance sheet should have a model dropdown filter control', () => {
    const perfSheet = findSheet('performance');
    expect(perfSheet).toBeDefined();

    const paramControls = (perfSheet!.parameterControls ?? []) as any[];
    const modelDropdown = paramControls.find(
      (c: any) => c.dropdown !== undefined,
    );
    expect(modelDropdown).toBeDefined();
  });

  it('Performance sheet should have a filter group scoped to KPI visuals', () => {
    const result = synth();
    const filterGroups = result.filterGroups as any[];

    // Find a filter group scoped to the performance sheet with SELECTED_VISUALS
    const perfKpiFilterGroup = filterGroups.find((fg: any) => {
      const scopeConfigs =
        fg.scopeConfiguration?.selectedSheets?.sheetVisualScopingConfigurations ?? [];
      return scopeConfigs.some(
        (sc: any) =>
          sc.sheetId === 'performance' &&
          sc.scope === 'SELECTED_VISUALS' &&
          sc.visualIds &&
          sc.visualIds.includes('perf-kpi-avg-latency') &&
          sc.visualIds.includes('perf-kpi-p99-latency') &&
          sc.visualIds.includes('perf-kpi-error-rate'),
      );
    });

    expect(perfKpiFilterGroup).toBeDefined();
  });
});
