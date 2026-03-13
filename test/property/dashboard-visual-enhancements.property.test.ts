// Feature: dashboard-visual-enhancements
import * as fc from 'fast-check';
import {
  buildExecutiveSummarySheet,
  DATASET_IDENTIFIER,
  METRICS_DATASET_IDENTIFIER,
} from 'lib/stacks/dashboard-visuals';
import type { SheetDefinitionsParams } from 'lib/stacks/dashboard-visuals';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const validSolutionNames = fc.constantFrom('test-solution', 'my-platform', 'bedrock-intel');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getVisualTitle(visual: any): string | undefined {
  const v =
    visual.kpiVisual ??
    visual.pieChartVisual ??
    visual.lineChartVisual ??
    visual.tableVisual ??
    visual.barChartVisual;
  return v?.title?.formatText?.plainText;
}

function getVisualId(visual: any): string | undefined {
  const v =
    visual.kpiVisual ??
    visual.pieChartVisual ??
    visual.lineChartVisual ??
    visual.tableVisual ??
    visual.barChartVisual;
  return v?.visualId;
}

// ---------------------------------------------------------------------------
// Property 4: Executive Summary visual inventory
// Validates: Requirements 2.1, 3.1, 4.1, 5.1, 5.2, 6.1, 7.1, 8.1, 10.1, 11.1
// ---------------------------------------------------------------------------

describe('Feature: dashboard-visual-enhancements, Property 4: Executive Summary visual inventory', () => {
  it('Executive Summary sheet contains exactly the expected visuals and does NOT contain Unique Models', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const params: SheetDefinitionsParams = {
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        };

        const { sheet } = buildExecutiveSummarySheet(params);
        const visuals = (sheet.visuals ?? []) as any[];

        // Collect all visual titles and IDs
        const titles = visuals.map(getVisualTitle).filter(Boolean) as string[];
        const ids = visuals.map(getVisualId).filter(Boolean) as string[];

        // Must contain these visuals
        const requiredTitles = [
          'Total Invocations',
          'Total Cost',
          'Unique Users',
          'Avg Latency',
          'Error Rate',
          'Daily Invocations & Cost Trend',
          'Model Mix by Invocations',
          'Top 10 Users by Cost',
        ];

        const hasAllRequired = requiredTitles.every(t => titles.includes(t));

        // Must NOT contain Unique Models visual
        const hasUniqueModels = titles.includes('Unique Models');
        const hasKpiModelsId = ids.includes('exec-kpi-models');

        return hasAllRequired && !hasUniqueModels && !hasKpiModelsId;
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Date range filter scopes all Executive Summary visuals
// Validates: Requirements 2.2, 3.3, 4.2, 6.5, 8.5, 10.7, 11.5
// ---------------------------------------------------------------------------

describe('Feature: dashboard-visual-enhancements, Property 5: Date range filter scopes all Executive Summary visuals', () => {
  it('filterGroups contains a timeRangeFilter on timestamp scoped to ALL_VISUALS on the executive-summary sheet', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const params: SheetDefinitionsParams = {
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        };

        const { filterGroups } = buildExecutiveSummarySheet(params);

        // Find a filter group that:
        // 1. Contains a timeRangeFilter on the timestamp column
        // 2. Is scoped to ALL_VISUALS on the executive-summary sheet
        const dateRangeFilterGroup = filterGroups.find((fg: any) => {
          const filters: any[] = fg.filters ?? [];
          const hasTimestampTimeRangeFilter = filters.some(
            (f: any) => f.timeRangeFilter?.column?.columnName === 'timestamp',
          );
          if (!hasTimestampTimeRangeFilter) return false;

          const scopingConfigs: any[] =
            fg.scopeConfiguration?.selectedSheets?.sheetVisualScopingConfigurations ?? [];
          return scopingConfigs.some(
            (sc: any) =>
              sc.sheetId === 'executive-summary' && sc.scope === 'ALL_VISUALS',
          );
        });

        return dateRangeFilterGroup !== undefined;
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Currency 4dp format on cost visuals
// Validates: Requirements 3.2, 11.2
// ---------------------------------------------------------------------------

describe('Feature: dashboard-visual-enhancements, Property 6: Currency 4dp format on cost visuals', () => {
  it('Total Cost KPI uses currency format with exactly 4 decimal places and USD symbol', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const params: SheetDefinitionsParams = {
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        };

        const { sheet } = buildExecutiveSummarySheet(params);
        const visuals = (sheet.visuals ?? []) as any[];

        // Find the Total Cost KPI visual
        const kpiCostVisual = visuals.find(v => getVisualTitle(v) === 'Total Cost');
        if (!kpiCostVisual) return false;

        // Navigate to the format config on the KPI value field
        const values: any[] =
          kpiCostVisual.kpiVisual?.chartConfiguration?.fieldWells?.values ?? [];
        if (values.length === 0) return false;

        const formatConfig =
          values[0]?.numericalMeasureField?.formatConfiguration?.formatConfiguration
            ?.currencyDisplayFormatConfiguration;

        if (!formatConfig) return false;

        const decimalPlaces = formatConfig.decimalPlacesConfiguration?.decimalPlaces;
        const symbol = formatConfig.symbol;

        return decimalPlaces === 4 && symbol === 'USD';
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Model filter scopes Avg Latency and Error Rate KPIs
// Validates: Requirements 6.2, 6.3, 7.2, 7.3
// ---------------------------------------------------------------------------

describe('Feature: dashboard-visual-enhancements, Property 7: Model filter scopes Avg Latency and Error Rate KPIs', () => {
  it('Executive Summary sheet has model dropdown control linked to FriendlyModelName and a filter group scoped to latency and error rate KPIs', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const params: SheetDefinitionsParams = {
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        };

        const { sheet, filterGroups } = buildExecutiveSummarySheet(params);

        // 1. Verify parameterControls contains a dropdown linked to FriendlyModelName on the Metrics dataset
        const paramControls = (sheet.parameterControls ?? []) as any[];
        const modelDropdown = paramControls.find(
          (c: any) =>
            c.dropdown?.sourceParameterName === 'ExecModelFilter' &&
            c.dropdown?.selectableValues?.linkToDataSetColumn?.columnName === 'FriendlyModelName' &&
            c.dropdown?.selectableValues?.linkToDataSetColumn?.dataSetIdentifier ===
              METRICS_DATASET_IDENTIFIER,
        );
        if (!modelDropdown) return false;

        // 2. Verify a filter group exists with a categoryFilter on FriendlyModelName driven by ExecModelFilter
        const modelFilterGroup = filterGroups.find((fg: any) => {
          const filters: any[] = fg.filters ?? [];
          return filters.some(
            (f: any) =>
              f.categoryFilter?.column?.columnName === 'FriendlyModelName' &&
              f.categoryFilter?.configuration?.customFilterConfiguration?.parameterName ===
                'ExecModelFilter',
          );
        });
        if (!modelFilterGroup) return false;

        // 3. Verify that filter group is scoped to SELECTED_VISUALS targeting exec-kpi-latency and exec-kpi-error-rate
        const scopeConfig = modelFilterGroup.scopeConfiguration as any;
        const scopingConfigs: any[] =
          scopeConfig?.selectedSheets?.sheetVisualScopingConfigurations ?? [];
        const execSummaryScope = scopingConfigs.find(
          (sc: any) => sc.sheetId === 'executive-summary' && sc.scope === 'SELECTED_VISUALS',
        );
        if (!execSummaryScope) return false;

        const visualIds: string[] = execSummaryScope.visualIds ?? [];
        return visualIds.includes('exec-kpi-error-rate');
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: Dual-axis trend chart structure
// Validates: Requirements 8.2, 8.3, 8.4
// ---------------------------------------------------------------------------

describe('Feature: dashboard-visual-enhancements, Property 8: Dual-axis trend chart structure', () => {
  it('Daily Invocations & Cost Trend line chart has correct category, primary Y-axis, and secondary Y-axis configuration', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const params: SheetDefinitionsParams = {
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        };

        const { sheet } = buildExecutiveSummarySheet(params);
        const visuals = (sheet.visuals ?? []) as any[];

        // Find the trend line chart visual by title
        const trendVisual = visuals.find(
          v => getVisualTitle(v) === 'Daily Invocations & Cost Trend',
        );
        if (!trendVisual) return false;

        // Must be a lineChartVisual
        const lineChart = trendVisual.lineChartVisual;
        if (!lineChart) return false;

        const fieldWells =
          lineChart.chartConfiguration?.fieldWells?.lineChartAggregatedFieldWells;
        if (!fieldWells) return false;

        // Req 8.4: category field uses timestamp with DAY granularity
        const category: any[] = fieldWells.category ?? [];
        const categoryField = category[0]?.dateDimensionField;
        if (!categoryField) return false;
        if (categoryField.column?.columnName !== 'timestamp') return false;
        if (categoryField.dateGranularity !== 'DAY') return false;

        // Req 8.2: primary Y-axis — count aggregation on requestid (categoricalMeasureField with COUNT)
        const values: any[] = fieldWells.values ?? [];
        const countOnRequestId = values.some(
          v =>
            v.categoricalMeasureField?.column?.columnName === 'requestid' &&
            v.categoricalMeasureField?.aggregationFunction === 'COUNT',
        );
        if (!countOnRequestId) return false;

        // Req 8.3: secondary Y-axis — sum aggregation on totalcost (numericalMeasureField with SUM)
        const sumOnTotalCost = values.some(
          v =>
            v.numericalMeasureField?.column?.columnName === 'totalcost' &&
            v.numericalMeasureField?.aggregationFunction?.simpleNumericalAggregation === 'SUM',
        );
        if (!sumOnTotalCost) return false;

        // Req 8.3: the totalcost field must be bound to SECONDARY_YAXIS via series config
        const series: any[] = lineChart.chartConfiguration?.series ?? [];
        const costFieldId = values.find(
          v => v.numericalMeasureField?.column?.columnName === 'totalcost',
        )?.numericalMeasureField?.fieldId;

        const secondaryAxisBinding = series.some(
          s =>
            s.fieldSeriesItem?.fieldId === costFieldId &&
            s.fieldSeriesItem?.axisBinding === 'SECONDARY_YAXIS',
        );
        if (!secondaryAxisBinding) return false;

        return true;
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Donut chart configuration completeness
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
// ---------------------------------------------------------------------------

import { MODEL_COLOR_PALETTE } from 'lib/stacks/dashboard-visuals';

describe('Feature: dashboard-visual-enhancements, Property 9: Donut chart configuration completeness', () => {
  it('Both donut charts have tooltip VISIBLE, DATA_POINT_CLICK cross-visual filter, MODEL_COLOR_PALETTE, and legend VISIBLE', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const params: SheetDefinitionsParams = {
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        };

        const { sheet } = buildExecutiveSummarySheet(params);
        const visuals = (sheet.visuals ?? []) as any[];

        const donutTitles = ['Model Mix by Invocations', 'Model Mix by Cost'];

        for (const title of donutTitles) {
          const visual = visuals.find(v => getVisualTitle(v) === title);
          if (!visual) return false;

          const pieChart = visual.pieChartVisual;
          if (!pieChart) return false;

          const config = pieChart.chartConfiguration;

          // (a) tooltip visibility must be VISIBLE
          if (config?.tooltip?.tooltipVisibility !== 'VISIBLE') return false;

          // (b) actions must contain a DATA_POINT_CLICK action targeting ALL_VISUALS
          const actions: any[] = pieChart.actions ?? [];
          const hasFilterAction = actions.some(
            (a: any) =>
              a.trigger === 'DATA_POINT_CLICK' &&
              a.actionOperations?.some(
                (op: any) =>
                  op.filterOperation?.targetVisualsConfiguration
                    ?.sameSheetTargetVisualConfiguration?.targetVisualOptions === 'ALL_VISUALS',
              ),
          );
          if (!hasFilterAction) return false;

          // (c) visualPalette.chartColor must reference MODEL_COLOR_PALETTE[0]
          if (config?.visualPalette?.chartColor !== MODEL_COLOR_PALETTE[0]) return false;

          // (d) legend visibility must be VISIBLE
          if (config?.legend?.visibility !== 'VISIBLE') return false;
        }

        return true;
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Top Users table columns and sort order
// Validates: Requirements 11.3, 11.4
// ---------------------------------------------------------------------------

describe('Feature: dashboard-visual-enhancements, Property 10: Top Users table columns and sort order', () => {
  it('Top 10 Users by Cost table has groupBy on resolvedusername, values with count on requestid and sum on totalcost, and DESC sort on cost field', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const params: SheetDefinitionsParams = {
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        };

        const { sheet } = buildExecutiveSummarySheet(params);
        const visuals = (sheet.visuals ?? []) as any[];

        // Find the Top 10 Users by Cost table visual
        const tableVisual = visuals.find(v => getVisualTitle(v) === 'Top 10 Users by Cost');
        if (!tableVisual) return false;

        const tableConfig = tableVisual.tableVisual?.chartConfiguration;
        if (!tableConfig) return false;

        const fieldWells = tableConfig.fieldWells?.tableAggregatedFieldWells;
        if (!fieldWells) return false;

        // Req 11.3: groupBy must contain resolvedusername
        const groupBy: any[] = fieldWells.groupBy ?? [];
        const hasResolvedUsername = groupBy.some(
          (f: any) =>
            f.categoricalDimensionField?.column?.columnName === 'resolvedusername',
        );
        if (!hasResolvedUsername) return false;

        // Req 11.3: values must contain count on requestid
        const values: any[] = fieldWells.values ?? [];
        const hasCountOnRequestId = values.some(
          (f: any) =>
            f.categoricalMeasureField?.column?.columnName === 'requestid' &&
            f.categoricalMeasureField?.aggregationFunction === 'COUNT',
        );
        if (!hasCountOnRequestId) return false;

        // Req 11.3: values must contain sum on totalcost
        const hasSumOnTotalCost = values.some(
          (f: any) =>
            f.numericalMeasureField?.column?.columnName === 'totalcost' &&
            f.numericalMeasureField?.aggregationFunction?.simpleNumericalAggregation === 'SUM',
        );
        if (!hasSumOnTotalCost) return false;

        // Req 11.4: sortConfiguration must have DESC direction on the cost field
        const rowSort: any[] = tableConfig.sortConfiguration?.rowSort ?? [];
        const costFieldId = values.find(
          (f: any) => f.numericalMeasureField?.column?.columnName === 'totalcost',
        )?.numericalMeasureField?.fieldId;

        const hasDescSortOnCost = rowSort.some(
          (s: any) =>
            s.fieldSort?.fieldId === costFieldId && s.fieldSort?.direction === 'DESC',
        );
        if (!hasDescSortOnCost) return false;

        return true;
      }),
      { numRuns: 30 },
    );
  });
});
