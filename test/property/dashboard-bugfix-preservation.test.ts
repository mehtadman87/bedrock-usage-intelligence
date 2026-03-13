/**
 * Preservation Property Tests — Unchanged Visuals and Behaviors
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9,
 *              3.10, 3.11, 3.12, 3.13, 3.14, 3.15, 3.16, 3.17, 3.18**
 *
 * These tests capture the CURRENT (unfixed) baseline behavior and MUST PASS
 * on unfixed code. After the fix, they should still pass to confirm no regressions.
 *
 * Observation-first methodology: each test observes the current code output
 * and asserts that exact behavior.
 */
import * as fc from 'fast-check';
import {
  buildSheetDefinitions,
  DATASET_IDENTIFIER,
  METRICS_DATASET_IDENTIFIER,
  MODEL_COLOR_PALETTE,
} from 'lib/stacks/dashboard-visuals';
import type { SheetDefinitionsParams } from 'lib/stacks/dashboard-visuals';
import { ConfigSchema } from 'lib/config/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Arbitraries
const validSolutionNames = fc.constantFrom('test-solution', 'my-platform', 'bedrock-intel');

// ---------------------------------------------------------------------------
// Requirement 3.3: Total Invocations, Total Cost, Unique Users KPIs preserved
// ---------------------------------------------------------------------------

describe('Preservation: Executive Summary KPIs (Req 3.3)', () => {
  it('exec-kpi-invocations has countField on requestid from InvocationLogs', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = synth({ solutionName });
        const execSheet = result.sheets.find((s) => s.sheetId === 'executive-summary');
        const visuals = (execSheet!.visuals ?? []) as any[];
        const kpi = visuals.find((v: any) => v.kpiVisual?.visualId === 'exec-kpi-invocations');
        const values = kpi.kpiVisual.chartConfiguration.fieldWells.values;
        expect(values).toHaveLength(1);
        const field = values[0].categoricalMeasureField;
        expect(field).toBeDefined();
        expect(field.fieldId).toBe('exec-kpi-inv-val');
        expect(field.column.dataSetIdentifier).toBe(DATASET_IDENTIFIER);
        expect(field.column.columnName).toBe('requestid');
        expect(field.aggregationFunction).toBe('COUNT');
        return true;
      }),
      { numRuns: 5 },
    );
  });

  it('exec-kpi-cost has sumField on totalcost from InvocationLogs', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = synth({ solutionName });
        const execSheet = result.sheets.find((s) => s.sheetId === 'executive-summary');
        const visuals = (execSheet!.visuals ?? []) as any[];
        const kpi = visuals.find((v: any) => v.kpiVisual?.visualId === 'exec-kpi-cost');
        const values = kpi.kpiVisual.chartConfiguration.fieldWells.values;
        expect(values).toHaveLength(1);
        const field = values[0].numericalMeasureField;
        expect(field).toBeDefined();
        expect(field.fieldId).toBe('exec-kpi-cost-val');
        expect(field.column.dataSetIdentifier).toBe(DATASET_IDENTIFIER);
        expect(field.column.columnName).toBe('totalcost');
        expect(field.aggregationFunction.simpleNumericalAggregation).toBe('SUM');
        return true;
      }),
      { numRuns: 5 },
    );
  });

  it('exec-kpi-users has countDistinct on resolvedusername from InvocationLogs', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = synth({ solutionName });
        const execSheet = result.sheets.find((s) => s.sheetId === 'executive-summary');
        const visuals = (execSheet!.visuals ?? []) as any[];
        const kpi = visuals.find((v: any) => v.kpiVisual?.visualId === 'exec-kpi-users');
        const values = kpi.kpiVisual.chartConfiguration.fieldWells.values;
        expect(values).toHaveLength(1);
        const field = values[0].categoricalMeasureField;
        expect(field).toBeDefined();
        expect(field.fieldId).toBe('exec-kpi-users-val');
        expect(field.column.dataSetIdentifier).toBe(DATASET_IDENTIFIER);
        expect(field.column.columnName).toBe('resolvedusername');
        expect(field.aggregationFunction).toBe('DISTINCT_COUNT');
        return true;
      }),
      { numRuns: 5 },
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.4: Daily Invocations & Cost Trend dual-axis line chart preserved
// ---------------------------------------------------------------------------

describe('Preservation: Daily Invocations & Cost Trend (Req 3.4)', () => {
  it('exec-daily-trend has correct field wells, series config, and axis bindings', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = synth({ solutionName });
        const visual = findVisual('executive-summary', 'exec-daily-trend') as any;
        expect(visual).toBeDefined();

        const lineChart = visual.lineChartVisual;
        const config = lineChart.chartConfiguration;
        const fieldWells = config.fieldWells.lineChartAggregatedFieldWells;

        // Category: dateDimField on timestamp DAY from InvocationLogs
        expect(fieldWells.category).toHaveLength(1);
        const cat = fieldWells.category[0].dateDimensionField;
        expect(cat.fieldId).toBe('exec-trend-date');
        expect(cat.column.dataSetIdentifier).toBe(DATASET_IDENTIFIER);
        expect(cat.column.columnName).toBe('timestamp');
        expect(cat.dateGranularity).toBe('DAY');

        // Values: numericCountField(requestid) + sumField(totalcost)
        expect(fieldWells.values).toHaveLength(2);
        const invField = fieldWells.values[0].categoricalMeasureField;
        expect(invField.fieldId).toBe('exec-trend-inv');
        expect(invField.column.columnName).toBe('requestid');
        expect(invField.aggregationFunction).toBe('COUNT');

        const costField = fieldWells.values[1].numericalMeasureField;
        expect(costField.fieldId).toBe('exec-trend-cost');
        expect(costField.column.columnName).toBe('totalcost');
        expect(costField.aggregationFunction.simpleNumericalAggregation).toBe('SUM');

        // Series: cost on secondary Y axis
        expect(config.series).toHaveLength(1);
        expect(config.series[0].fieldSeriesItem.fieldId).toBe('exec-trend-cost');
        expect(config.series[0].fieldSeriesItem.axisBinding).toBe('SECONDARY_YAXIS');

        expect(config.type).toBe('LINE');
        return true;
      }),
      { numRuns: 5 },
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.5: Model Mix donut charts preserved
// NOTE: model name field will change from 'modelname' to 'FriendlyModelName'
// after the fix — we do NOT assert the specific column name for model fields.
// ---------------------------------------------------------------------------

describe('Preservation: Model Mix Donut Charts (Req 3.5)', () => {
  it('exec-model-mix-donut has donut options, cross-visual filter action, and MODEL_COLOR_PALETTE', () => {
    const visual = findVisual('executive-summary', 'exec-model-mix-donut') as any;
    expect(visual).toBeDefined();

    const pie = visual.pieChartVisual;
    const config = pie.chartConfiguration;

    // Donut options
    expect(config.donutOptions.arcOptions.arcThickness).toBe('MEDIUM');
    expect(config.donutOptions.donutCenterOptions.labelVisibility).toBe('VISIBLE');

    // Field wells: category (model) + values (count of requestid)
    const fieldWells = config.fieldWells.pieChartAggregatedFieldWells;
    expect(fieldWells.category).toHaveLength(1);
    expect(fieldWells.values).toHaveLength(1);
    const valField = fieldWells.values[0].categoricalMeasureField;
    expect(valField.fieldId).toBe('exec-donut-count');
    expect(valField.column.columnName).toBe('requestid');

    // Cross-visual filter action
    expect(pie.actions).toHaveLength(1);
    expect(pie.actions[0].customActionId).toBe('exec-model-filter-action');
    expect(pie.actions[0].trigger).toBe('DATA_POINT_CLICK');
    const filterOp = pie.actions[0].actionOperations[0].filterOperation;
    expect(filterOp.targetVisualsConfiguration.sameSheetTargetVisualConfiguration.targetVisualOptions).toBe('ALL_VISUALS');

    // MODEL_COLOR_PALETTE via visualPalette
    expect(config.visualPalette.chartColor).toBe(MODEL_COLOR_PALETTE[0]);
  });

  it('exec-model-mix-cost-donut has donut options, cross-visual filter action, and MODEL_COLOR_PALETTE', () => {
    const visual = findVisual('executive-summary', 'exec-model-mix-cost-donut') as any;
    expect(visual).toBeDefined();

    const pie = visual.pieChartVisual;
    const config = pie.chartConfiguration;

    // Donut options
    expect(config.donutOptions.arcOptions.arcThickness).toBe('MEDIUM');
    expect(config.donutOptions.donutCenterOptions.labelVisibility).toBe('VISIBLE');

    // Field wells: category (model) + values (sum of totalcost)
    const fieldWells = config.fieldWells.pieChartAggregatedFieldWells;
    expect(fieldWells.category).toHaveLength(1);
    expect(fieldWells.values).toHaveLength(1);
    const valField = fieldWells.values[0].numericalMeasureField;
    expect(valField.fieldId).toBe('exec-cost-donut-cost');
    expect(valField.column.columnName).toBe('totalcost');

    // Cross-visual filter action
    expect(pie.actions).toHaveLength(1);
    expect(pie.actions[0].customActionId).toBe('exec-cost-model-filter-action');
    expect(pie.actions[0].trigger).toBe('DATA_POINT_CLICK');

    // MODEL_COLOR_PALETTE
    expect(config.visualPalette.chartColor).toBe(MODEL_COLOR_PALETTE[0]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.6: Top 10 Users by Cost table preserved
// ---------------------------------------------------------------------------

describe('Preservation: Top 10 Users Table (Req 3.6)', () => {
  it('exec-top-users-table has correct field wells, sort config, and table options', () => {
    const visual = findVisual('executive-summary', 'exec-top-users-table') as any;
    expect(visual).toBeDefined();

    const table = visual.tableVisual;
    const config = table.chartConfiguration;
    const fieldWells = config.fieldWells.tableAggregatedFieldWells;

    // GroupBy: resolvedusername
    expect(fieldWells.groupBy).toHaveLength(1);
    expect(fieldWells.groupBy[0].categoricalDimensionField.column.columnName).toBe('resolvedusername');

    // Values: count(requestid) + sum(totalcost)
    expect(fieldWells.values).toHaveLength(2);
    expect(fieldWells.values[0].categoricalMeasureField.column.columnName).toBe('requestid');
    expect(fieldWells.values[1].numericalMeasureField.column.columnName).toBe('totalcost');

    // Sort: cost DESC
    const rowSort = config.sortConfiguration.rowSort;
    expect(rowSort).toHaveLength(1);
    expect(rowSort[0].fieldSort.fieldId).toBe('exec-table-cost');
    expect(rowSort[0].fieldSort.direction).toBe('DESC');

    // Table options: header style
    expect(config.tableOptions.headerStyle.fontConfiguration.fontWeight.name).toBe('BOLD');
    expect(config.tableOptions.headerStyle.backgroundColor).toBe('#F0F0F0');
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.7, 3.10, 3.13, 3.15: Date range filter groups preserved
// ---------------------------------------------------------------------------

describe('Preservation: Date Range Filter Groups (Req 3.7, 3.10, 3.13, 3.15)', () => {
  it('all date range filter groups have correct scope configurations and filter definitions', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = synth({ solutionName });
        const filterGroups = result.filterGroups as any[];

        // Executive Summary date filter group
        const execFg = filterGroups.find((fg: any) => fg.filterGroupId === 'exec-date-filter-group');
        expect(execFg).toBeDefined();
        expect(execFg.filters).toHaveLength(1);
        expect(execFg.filters[0].timeRangeFilter.filterId).toBe('exec-date-range-filter');
        expect(execFg.filters[0].timeRangeFilter.column.columnName).toBe('timestamp');
        expect(execFg.filters[0].timeRangeFilter.rangeMinimumValue.parameter).toBe('DateRangeStart');
        expect(execFg.filters[0].timeRangeFilter.rangeMaximumValue.parameter).toBe('DateRangeEnd');
        const execScope = execFg.scopeConfiguration.selectedSheets.sheetVisualScopingConfigurations;
        expect(execScope).toHaveLength(1);
        expect(execScope[0].sheetId).toBe('executive-summary');
        expect(execScope[0].scope).toBe('ALL_VISUALS');
        expect(execFg.crossDataset).toBe('SINGLE_DATASET');
        expect(execFg.status).toBe('ENABLED');

        // Cost & Usage date filter group
        const cuFg = filterGroups.find((fg: any) => fg.filterGroupId === 'cu-date-filter-group');
        expect(cuFg).toBeDefined();
        expect(cuFg.filters).toHaveLength(1);
        expect(cuFg.filters[0].timeRangeFilter.filterId).toBe('cu-date-range-filter');
        const cuScope = cuFg.scopeConfiguration.selectedSheets.sheetVisualScopingConfigurations;
        expect(cuScope).toHaveLength(1);
        expect(cuScope[0].sheetId).toBe('cost-usage');
        expect(cuScope[0].scope).toBe('ALL_VISUALS');

        // Performance date filter group
        const perfFg = filterGroups.find((fg: any) => fg.filterGroupId === 'perf-date-filter-group');
        expect(perfFg).toBeDefined();
        expect(perfFg.filters).toHaveLength(1);
        expect(perfFg.filters[0].timeRangeFilter.filterId).toBe('perf-date-range-filter');
        const perfScope = perfFg.scopeConfiguration.selectedSheets.sheetVisualScopingConfigurations;
        expect(perfScope).toHaveLength(1);
        expect(perfScope[0].sheetId).toBe('performance');
        expect(perfScope[0].scope).toBe('ALL_VISUALS');

        // Service Quota filter group (independent, has model + time range filters)
        const sqFg = filterGroups.find((fg: any) => fg.filterGroupId === 'sq-filter-group');
        expect(sqFg).toBeDefined();
        expect(sqFg.filters).toHaveLength(2);
        const sqScope = sqFg.scopeConfiguration.selectedSheets.sheetVisualScopingConfigurations;
        expect(sqScope).toHaveLength(1);
        expect(sqScope[0].sheetId).toBe('service-quota-prep');
        expect(sqScope[0].scope).toBe('ALL_VISUALS');

        return true;
      }),
      { numRuns: 5 },
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.9: Cost & Usage cross-visual filter action on bar chart preserved
// ---------------------------------------------------------------------------

describe('Preservation: Cost & Usage Cross-Visual Filter Action (Req 3.8, 3.9)', () => {
  it('cu-cost-by-model-bar has cross-visual filter action targeting ALL_VISUALS', () => {
    const visual = findVisual('cost-usage', 'cu-cost-by-model-bar') as any;
    expect(visual).toBeDefined();

    const bar = visual.barChartVisual;
    expect(bar.actions).toHaveLength(1);
    expect(bar.actions[0].customActionId).toBe('cu-model-filter-action');
    expect(bar.actions[0].trigger).toBe('DATA_POINT_CLICK');
    const filterOp = bar.actions[0].actionOperations[0].filterOperation;
    expect(filterOp.selectedFieldsConfiguration.selectedFields).toEqual(['cu-bar-model']);
    expect(filterOp.targetVisualsConfiguration.sameSheetTargetVisualConfiguration.targetVisualOptions).toBe('ALL_VISUALS');
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.11: Performance combo chart preserved
// ---------------------------------------------------------------------------

describe('Preservation: Performance Combo Chart (Req 3.11)', () => {
  it('perf-latency-combo has bar=AVG(invocationlatencyavg) and line=P99 from Metrics dataset', () => {
    const visual = findVisual('performance', 'perf-latency-combo') as any;
    expect(visual).toBeDefined();

    const combo = visual.comboChartVisual;
    const config = combo.chartConfiguration;
    const fieldWells = config.fieldWells.comboChartAggregatedFieldWells;

    // Category: model from Metrics dataset
    expect(fieldWells.category).toHaveLength(1);
    expect(fieldWells.category[0].categoricalDimensionField.column.dataSetIdentifier).toBe(METRICS_DATASET_IDENTIFIER);

    // Bar values: AVG(invocationlatencyavg)
    expect(fieldWells.barValues).toHaveLength(1);
    const barField = fieldWells.barValues[0].numericalMeasureField;
    expect(barField.fieldId).toBe('perf-combo-avg-lat');
    expect(barField.column.dataSetIdentifier).toBe(METRICS_DATASET_IDENTIFIER);
    expect(barField.column.columnName).toBe('invocationlatencyavg');
    expect(barField.aggregationFunction.simpleNumericalAggregation).toBe('AVERAGE');

    // Line values: AVG(invocationlatencyp99)
    expect(fieldWells.lineValues).toHaveLength(1);
    const lineField = fieldWells.lineValues[0].numericalMeasureField;
    expect(lineField.fieldId).toBe('perf-combo-p99-lat');
    expect(lineField.column.dataSetIdentifier).toBe(METRICS_DATASET_IDENTIFIER);
    expect(lineField.column.columnName).toBe('invocationlatencyp99');

    // Bar arrangement
    expect(config.barsArrangement).toBe('CLUSTERED');
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.12: Performance scatter plot preserved
// ---------------------------------------------------------------------------

describe('Preservation: Performance Scatter Plot (Req 3.12)', () => {
  it('perf-latency-tokens-scatter has x=AVG(latencyms), y=SUM(totaltokens) from InvocationLogs', () => {
    const visual = findVisual('performance', 'perf-latency-tokens-scatter') as any;
    expect(visual).toBeDefined();

    const scatter = visual.scatterPlotVisual;
    const fieldWells = scatter.chartConfiguration.fieldWells.scatterPlotCategoricallyAggregatedFieldWells;

    // Category: model from InvocationLogs
    expect(fieldWells.category).toHaveLength(1);
    expect(fieldWells.category[0].categoricalDimensionField.column.dataSetIdentifier).toBe(DATASET_IDENTIFIER);

    // X axis: AVG(latencyms)
    expect(fieldWells.xAxis).toHaveLength(1);
    const xField = fieldWells.xAxis[0].numericalMeasureField;
    expect(xField.fieldId).toBe('perf-scatter-x-lat');
    expect(xField.column.dataSetIdentifier).toBe(DATASET_IDENTIFIER);
    expect(xField.column.columnName).toBe('latencyms');
    expect(xField.aggregationFunction.simpleNumericalAggregation).toBe('AVERAGE');

    // Y axis: SUM(totaltokens)
    expect(fieldWells.yAxis).toHaveLength(1);
    const yField = fieldWells.yAxis[0].numericalMeasureField;
    expect(yField.fieldId).toBe('perf-scatter-y-tokens');
    expect(yField.column.dataSetIdentifier).toBe(DATASET_IDENTIFIER);
    expect(yField.column.columnName).toBe('totaltokens');
    expect(yField.aggregationFunction.simpleNumericalAggregation).toBe('SUM');
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.14: Service Quota Prep KPIs preserved (Total Output Tokens, Avg Input/Output Tokens)
// ---------------------------------------------------------------------------

describe('Preservation: Service Quota Prep KPIs (Req 3.14)', () => {
  it('sq-kpi-output-modalities (Total Output Tokens) has SUM on outputtokens from InvocationLogs', () => {
    const visual = findVisual('service-quota-prep', 'sq-kpi-output-modalities') as any;
    expect(visual).toBeDefined();

    const kpi = visual.kpiVisual;
    const values = kpi.chartConfiguration.fieldWells.values;
    expect(values).toHaveLength(1);
    const field = values[0].numericalMeasureField;
    expect(field.fieldId).toBe('sq-output-modalities-val');
    expect(field.column.dataSetIdentifier).toBe(DATASET_IDENTIFIER);
    expect(field.column.columnName).toBe('outputtokens');
    expect(field.aggregationFunction.simpleNumericalAggregation).toBe('SUM');
  });

  it('sq-kpi-avg-input-tokens has AVG on inputtokens from InvocationLogs', () => {
    const visual = findVisual('service-quota-prep', 'sq-kpi-avg-input-tokens') as any;
    expect(visual).toBeDefined();

    const kpi = visual.kpiVisual;
    const values = kpi.chartConfiguration.fieldWells.values;
    expect(values).toHaveLength(1);
    const field = values[0].numericalMeasureField;
    expect(field.fieldId).toBe('sq-avg-input-tokens-val');
    expect(field.column.dataSetIdentifier).toBe(DATASET_IDENTIFIER);
    expect(field.column.columnName).toBe('inputtokens');
    expect(field.aggregationFunction.simpleNumericalAggregation).toBe('AVERAGE');
  });

  it('sq-kpi-avg-output-tokens has AVG on outputtokens from InvocationLogs', () => {
    const visual = findVisual('service-quota-prep', 'sq-kpi-avg-output-tokens') as any;
    expect(visual).toBeDefined();

    const kpi = visual.kpiVisual;
    const values = kpi.chartConfiguration.fieldWells.values;
    expect(values).toHaveLength(1);
    const field = values[0].numericalMeasureField;
    expect(field.fieldId).toBe('sq-avg-output-tokens-val');
    expect(field.column.dataSetIdentifier).toBe(DATASET_IDENTIFIER);
    expect(field.column.columnName).toBe('outputtokens');
    expect(field.aggregationFunction.simpleNumericalAggregation).toBe('AVERAGE');
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.16: TPM & RPM Over Time line chart preserved
// ---------------------------------------------------------------------------

describe('Preservation: TPM & RPM Over Time Line Chart (Req 3.16)', () => {
  it('sq-tpm-rpm-line has correct field wells, reference lines, and series config', () => {
    const visual = findVisual('service-quota-prep', 'sq-tpm-rpm-line') as any;
    expect(visual).toBeDefined();

    const lineChart = visual.lineChartVisual;
    const config = lineChart.chartConfiguration;
    const fieldWells = config.fieldWells.lineChartAggregatedFieldWells;

    // Category: timestamp MINUTE
    expect(fieldWells.category).toHaveLength(1);
    const cat = fieldWells.category[0].dateDimensionField;
    expect(cat.column.columnName).toBe('timestamp');
    expect(cat.dateGranularity).toBe('MINUTE');

    // Values: SUM(totaltokens) + COUNT(requestid)
    expect(fieldWells.values).toHaveLength(2);

    // Series: RPM on secondary Y axis
    expect(config.series).toHaveLength(1);
    expect(config.series[0].fieldSeriesItem.fieldId).toBe('sq-line-rpm');
    expect(config.series[0].fieldSeriesItem.axisBinding).toBe('SECONDARY_YAXIS');

    // Reference lines: 2 (Steady State TPM + Peak State TPM)
    expect(config.referenceLines).toHaveLength(2);

    const steadyRef = config.referenceLines[0];
    expect(steadyRef.status).toBe('ENABLED');
    expect(steadyRef.dataConfiguration.dynamicConfiguration.calculation.simpleNumericalAggregation).toBe('AVERAGE');
    expect(steadyRef.labelConfiguration.customLabelConfiguration.customLabel).toBe('Steady State TPM');
    expect(steadyRef.styleConfiguration.pattern).toBe('DASHED');
    expect(steadyRef.styleConfiguration.color).toBe('#2CAD00');

    const peakRef = config.referenceLines[1];
    expect(peakRef.status).toBe('ENABLED');
    expect(peakRef.dataConfiguration.dynamicConfiguration.calculation.simpleNumericalAggregation).toBe('MAX');
    expect(peakRef.labelConfiguration.customLabelConfiguration.customLabel).toBe('Peak State TPM');
    expect(peakRef.styleConfiguration.pattern).toBe('DASHED');
    expect(peakRef.styleConfiguration.color).toBe('#DE3B00');
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.17: Dashboard structure — 4 sheets with correct IDs
// ---------------------------------------------------------------------------

describe('Preservation: Dashboard Structure (Req 3.17)', () => {
  it('dashboard has 4 sheets with correct sheet IDs and names', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = synth({ solutionName });
        expect(result.sheets).toHaveLength(4);

        const sheetIds = result.sheets.map((s) => s.sheetId);
        expect(sheetIds).toEqual([
          'executive-summary',
          'cost-usage',
          'performance',
          'service-quota-prep',
        ]);

        const sheetNames = result.sheets.map((s) => s.name);
        expect(sheetNames).toEqual([
          'Executive Summary',
          'Cost & Usage',
          'Performance',
          'Service Quota Prep',
        ]);

        return true;
      }),
      { numRuns: 5 },
    );
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.18: Calculated fields ErrorRate and TotalTokensCalc preserved
// NOTE: These are defined in dashboard-stack.ts, not dashboard-visuals.ts.
// We verify the ErrorRate calc field is used by the error rate KPI visuals.
// ---------------------------------------------------------------------------

describe('Preservation: Calculated Fields (Req 3.18)', () => {
  it('exec-kpi-error-rate uses ErrorRate calculated field from Metrics dataset', () => {
    const visual = findVisual('executive-summary', 'exec-kpi-error-rate') as any;
    expect(visual).toBeDefined();

    const kpi = visual.kpiVisual;
    const values = kpi.chartConfiguration.fieldWells.values;
    expect(values).toHaveLength(1);
    const field = values[0].numericalMeasureField;
    expect(field.fieldId).toBe('exec-kpi-error-rate-val');
    expect(field.column.dataSetIdentifier).toBe(METRICS_DATASET_IDENTIFIER);
    expect(field.column.columnName).toBe('ErrorRate');
    // calcField has no aggregationFunction
    expect(field.aggregationFunction).toBeUndefined();
  });

  it('perf-kpi-error-rate uses ErrorRate calculated field from Metrics dataset', () => {
    const visual = findVisual('performance', 'perf-kpi-error-rate') as any;
    expect(visual).toBeDefined();

    const kpi = visual.kpiVisual;
    const values = kpi.chartConfiguration.fieldWells.values;
    expect(values).toHaveLength(1);
    const field = values[0].numericalMeasureField;
    expect(field.fieldId).toBe('perf-kpi-error-rate-val');
    expect(field.column.dataSetIdentifier).toBe(METRICS_DATASET_IDENTIFIER);
    expect(field.column.columnName).toBe('ErrorRate');
    expect(field.aggregationFunction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.1: enableQuickSuite: false produces no QuickSight resources
// NOTE: This is a stack-level behavior. We verify at the visual layer that
// buildSheetDefinitions still works regardless (it doesn't check enableQuickSuite).
// The actual guard is in DashboardStack constructor.
// ---------------------------------------------------------------------------

describe('Preservation: enableQuickSuite: false (Req 3.1)', () => {
  it('ConfigSchema accepts enableQuickSuite: false without requiring quickSightPrincipalArn', () => {
    const result = ConfigSchema.safeParse({
      vpc: { vpcMode: 'create' },
      account: { accountMode: 'single' },
      region: { regionMode: 'single' },
      identity: { identityMode: 'iam' },
      dataExports: { curBucketName: 'test-cur-bucket' },
      dashboard: { enableQuickSuite: false },
      cloudTrail: { cloudTrailMode: 'create' },
      deployment: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dashboard.enableQuickSuite).toBe(false);
    }
  });

  it('ConfigSchema rejects enableQuickSuite: true without quickSightPrincipalArn', () => {
    const result = ConfigSchema.safeParse({
      vpc: { vpcMode: 'create' },
      account: { accountMode: 'single' },
      region: { regionMode: 'single' },
      identity: { identityMode: 'iam' },
      dataExports: { curBucketName: 'test-cur-bucket' },
      dashboard: { enableQuickSuite: true },
      cloudTrail: { cloudTrailMode: 'create' },
      deployment: {},
    });
    expect(result.success).toBe(false);
  });
});
