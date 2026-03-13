import * as quicksight from 'aws-cdk-lib/aws-quicksight';

/**
 * The logical identifier used to reference the invocation logs dataset
 * within the CfnDashboard Definition. Must match across all visual definitions.
 */
export const DATASET_IDENTIFIER = 'InvocationLogs';

/**
 * Logical identifier for the Metrics dataset within the dashboard definition.
 */
export const METRICS_DATASET_IDENTIFIER = 'Metrics';

/**
 * Fixed color palette for model-based charts. Applied consistently across all sheets
 * so each model always renders in the same color regardless of which visual is shown.
 * Requirements: 4.1
 */
export const MODEL_COLOR_PALETTE = [
  '#1F77B4',
  '#FF7F0E',
  '#2CA02C',
  '#D62728',
  '#9467BD',
  '#8C564B',
  '#E377C2',
  '#7F7F7F',
  '#BCBD22',
  '#17BECF',
];

/**
 * Builds a colorScale using the MODEL_COLOR_PALETTE for charts that group by modelid.
 * Since model names are not known at deploy time, we use visualPalette.chartColor
 * on charts that group by model to provide a consistent base color.
 * For field-based coloring, use visualPalette.colorMap with DataPathColorProperty.
 */

/**
 * Builds a USD currency format: $1,234.56
 * Requirements: 4.3
 */
function buildCurrencyFormat(): quicksight.CfnDashboard.NumberFormatConfigurationProperty {
  return {
    formatConfiguration: {
      currencyDisplayFormatConfiguration: {
        symbol: 'USD',
        numberScale: 'NONE',
        negativeValueConfiguration: { displayMode: 'NEGATIVE' },
        decimalPlacesConfiguration: { decimalPlaces: 2 },
        separatorConfiguration: {
          thousandsSeparator: { symbol: 'COMMA', visibility: 'VISIBLE' },
          decimalSeparator: 'DOT',
        },
      },
    },
  };
}

/**
 * Builds a USD currency format with 4 decimal places (e.g. $1.2345).
 * Requirements: 3.2, 11.2
 */
function buildCurrencyFormat4dp(): quicksight.CfnDashboard.NumberFormatConfigurationProperty {
  return {
    formatConfiguration: {
      currencyDisplayFormatConfiguration: {
        symbol: 'USD',
        numberScale: 'NONE',
        negativeValueConfiguration: { displayMode: 'NEGATIVE' },
        decimalPlacesConfiguration: { decimalPlaces: 4 },
        separatorConfiguration: {
          thousandsSeparator: { symbol: 'COMMA', visibility: 'VISIBLE' },
          decimalSeparator: 'DOT',
        },
      },
    },
  };
}

/**
 * Builds an abbreviated token format: 1.2M
 * Requirements: 4.3
 */
function buildTokenFormat(): quicksight.CfnDashboard.NumberFormatConfigurationProperty {
  return {
    formatConfiguration: {
      numberDisplayFormatConfiguration: {
        numberScale: 'AUTO',
        negativeValueConfiguration: { displayMode: 'NEGATIVE' },
        decimalPlacesConfiguration: { decimalPlaces: 1 },
        separatorConfiguration: {
          thousandsSeparator: { symbol: 'COMMA', visibility: 'VISIBLE' },
          decimalSeparator: 'DOT',
        },
      },
    },
  };
}

/**
 * Builds a latency format with "ms" suffix: 45.3ms
 * Requirements: 4.3
 */
function buildLatencyFormat(): quicksight.CfnDashboard.NumberFormatConfigurationProperty {
  return {
    formatConfiguration: {
      numberDisplayFormatConfiguration: {
        suffix: 'ms',
        numberScale: 'NONE',
        negativeValueConfiguration: { displayMode: 'NEGATIVE' },
        decimalPlacesConfiguration: { decimalPlaces: 1 },
        separatorConfiguration: {
          thousandsSeparator: { symbol: 'COMMA', visibility: 'VISIBLE' },
          decimalSeparator: 'DOT',
        },
      },
    },
  };
}

/**
 * Builds a percentage format: 2.1%
 * Requirements: 4.3
 */
function buildPercentFormat(): quicksight.CfnDashboard.NumberFormatConfigurationProperty {
  return {
    formatConfiguration: {
      percentageDisplayFormatConfiguration: {
        negativeValueConfiguration: { displayMode: 'NEGATIVE' },
        decimalPlacesConfiguration: { decimalPlaces: 1 },
        separatorConfiguration: {
          thousandsSeparator: { symbol: 'COMMA', visibility: 'VISIBLE' },
          decimalSeparator: 'DOT',
        },
      },
    },
  };
}

/**
 * Builds the DataSetIdentifierDeclaration array for the CfnDashboard Definition.
 * Maps the logical DATASET_IDENTIFIER to the physical dataset ARN.
 */
export function buildDataSetIdentifierDeclarations(
  dataSetArn: string,
  metricsDataSetArn?: string,
): quicksight.CfnDashboard.DataSetIdentifierDeclarationProperty[] {
  const declarations: quicksight.CfnDashboard.DataSetIdentifierDeclarationProperty[] = [
    {
      identifier: DATASET_IDENTIFIER,
      dataSetArn,
    },
  ];
  if (metricsDataSetArn) {
    declarations.push({
      identifier: METRICS_DATASET_IDENTIFIER,
      dataSetArn: metricsDataSetArn,
    });
  }
  return declarations;
}

export interface SheetDefinitionsParams {
  /** Logical dataset identifier (use DATASET_IDENTIFIER constant) */
  dataSetIdentifier: string;
  /** Solution name prefix used for naming resources */
  solutionName: string;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Returns a ColumnIdentifierProperty for the given field name. */
function col(
  dataSetIdentifier: string,
  columnName: string,
): quicksight.CfnDashboard.ColumnIdentifierProperty {
  return { dataSetIdentifier, columnName };
}

/** Builds a MeasureField using SUM aggregation. */
function sumField(
  fieldId: string,
  dataSetIdentifier: string,
  columnName: string,
  formatConfiguration?: quicksight.CfnDashboard.NumberFormatConfigurationProperty,
): quicksight.CfnDashboard.MeasureFieldProperty {
  return {
    numericalMeasureField: {
      fieldId,
      column: col(dataSetIdentifier, columnName),
      aggregationFunction: { simpleNumericalAggregation: 'SUM' },
      ...(formatConfiguration ? { formatConfiguration } : {}),
    },
  };
}

/**
 * Builds a MeasureField for an aggregated calculated field (no additional aggregation).
 * Use this for dashboard-level calculatedFields that already contain aggregation in their expression.
 */
function calcField(
  fieldId: string,
  dataSetIdentifier: string,
  columnName: string,
  formatConfiguration?: quicksight.CfnDashboard.NumberFormatConfigurationProperty,
): quicksight.CfnDashboard.MeasureFieldProperty {
  return {
    numericalMeasureField: {
      fieldId,
      column: col(dataSetIdentifier, columnName),
      // No aggregationFunction — calculated field already contains aggregation
      ...(formatConfiguration ? { formatConfiguration } : {}),
    },
  };
}

/** Builds a MeasureField using COUNT aggregation (for STRING columns in KPI visuals). */
function countField(
  fieldId: string,
  dataSetIdentifier: string,
  columnName: string,
): quicksight.CfnDashboard.MeasureFieldProperty {
  return {
    categoricalMeasureField: {
      fieldId,
      column: col(dataSetIdentifier, columnName),
      aggregationFunction: 'COUNT',
    },
  };
}

/** Builds a MeasureField using COUNT aggregation (numericalMeasureField for charts). */
function numericCountField(
  fieldId: string,
  dataSetIdentifier: string,
  columnName: string,
): quicksight.CfnDashboard.MeasureFieldProperty {
  return {
    categoricalMeasureField: {
      fieldId,
      column: col(dataSetIdentifier, columnName),
      aggregationFunction: 'COUNT',
    },
  };
}

/** Builds a MeasureField using AVG aggregation. */
function avgField(
  fieldId: string,
  dataSetIdentifier: string,
  columnName: string,
  formatConfiguration?: quicksight.CfnDashboard.NumberFormatConfigurationProperty,
): quicksight.CfnDashboard.MeasureFieldProperty {
  return {
    numericalMeasureField: {
      fieldId,
      column: col(dataSetIdentifier, columnName),
      aggregationFunction: { simpleNumericalAggregation: 'AVERAGE' },
      ...(formatConfiguration ? { formatConfiguration } : {}),
    },
  };
}
/** Builds a MeasureField using MAX aggregation. */
function maxField(
  fieldId: string,
  dataSetIdentifier: string,
  columnName: string,
  formatConfiguration?: quicksight.CfnDashboard.NumberFormatConfigurationProperty,
): quicksight.CfnDashboard.MeasureFieldProperty {
  return {
    numericalMeasureField: {
      fieldId,
      column: col(dataSetIdentifier, columnName),
      aggregationFunction: { simpleNumericalAggregation: 'MAX' },
      ...(formatConfiguration ? { formatConfiguration } : {}),
    },
  };
}

/** Builds a COUNT_DISTINCT MeasureField (for STRING columns). */
function countDistinctField(
  fieldId: string,
  dataSetIdentifier: string,
  columnName: string,
): quicksight.CfnDashboard.MeasureFieldProperty {
  return {
    categoricalMeasureField: {
      fieldId,
      column: col(dataSetIdentifier, columnName),
      aggregationFunction: 'DISTINCT_COUNT',
    },
  };
}

/** Builds a DimensionField for a categorical column. */
function dimField(
  fieldId: string,
  dataSetIdentifier: string,
  columnName: string,
): quicksight.CfnDashboard.DimensionFieldProperty {
  return {
    categoricalDimensionField: {
      fieldId,
      column: col(dataSetIdentifier, columnName),
    },
  };
}

/** Builds a date DimensionField. */
function dateDimField(
  fieldId: string,
  dataSetIdentifier: string,
  columnName: string,
  dateGranularity: string = 'DAY',
): quicksight.CfnDashboard.DimensionFieldProperty {
  return {
    dateDimensionField: {
      fieldId,
      column: col(dataSetIdentifier, columnName),
      dateGranularity,
    },
  };
}

// ── KPI visual builder ────────────────────────────────────────────────────────

interface KpiVisualParams {
  visualId: string;
  title: string;
  primaryValueField: quicksight.CfnDashboard.MeasureFieldProperty;
}

function buildKpiVisual(params: KpiVisualParams): quicksight.CfnDashboard.VisualProperty {
  const { visualId, title, primaryValueField } = params;

  return {
    kpiVisual: {
      visualId,
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: title },
      },
      chartConfiguration: {
        fieldWells: {
          values: [primaryValueField],
        },
      },
    },
  };
}

// ── Executive Summary Sheet ───────────────────────────────────────────────────

/**
 * Result of building the Executive Summary sheet.
 * filterGroups must be placed at the DashboardVersionDefinitionProperty level.
 */
export interface ExecutiveSummarySheetResult {
  sheet: quicksight.CfnDashboard.SheetDefinitionProperty;
  filterGroups: quicksight.CfnDashboard.FilterGroupProperty[];
}

/**
 * Builds the Executive Summary sheet definition (Sheet 1).
 *
 * Contains:
 *  - 6 KPI cards with period-over-period comparison and conditional formatting
 *  - Dual-axis line chart: daily invocations (left) + daily cost (right)
 *  - Donut chart: model mix by invocation count
 *  - Top 5 users table sorted by cost desc
 *  - Global date range picker filter control
 *  - Cross-visual filter action on model click
 *  - "Refresh Data" URL action (SPICE modes only)
 *
 * Requirements: 2.2, 3, 4, 6.6
 */
export function buildExecutiveSummarySheet(
  params: SheetDefinitionsParams,
): ExecutiveSummarySheetResult {
  const { dataSetIdentifier } = params;
  const ds = dataSetIdentifier;

  // ── KPI: Total Invocations ──────────────────────────────────────────────────
  const kpiInvocations = buildKpiVisual({
    visualId: 'exec-kpi-invocations',
    title: 'Total Invocations',
    primaryValueField: numericCountField('exec-kpi-inv-val', ds, 'requestid'),
  });

  // ── KPI: Total Cost ─────────────────────────────────────────────────────────
  const kpiCost = buildKpiVisual({
    visualId: 'exec-kpi-cost',
    title: 'Total Cost',
    primaryValueField: sumField('exec-kpi-cost-val', ds, 'totalcost', buildCurrencyFormat4dp()),
  });

  // ── KPI: Unique Users ───────────────────────────────────────────────────────
  const kpiUsers = buildKpiVisual({
    visualId: 'exec-kpi-users',
    title: 'Unique Users',
    primaryValueField: countDistinctField('exec-kpi-users-val', ds, 'resolvedusername'),
  });

  // ── KPI: Avg Latency ────────────────────────────────────────────────────────
  const kpiLatency = buildKpiVisual({
    visualId: 'exec-kpi-latency',
    title: 'Avg Latency',
    primaryValueField: avgField('exec-kpi-latency-val', METRICS_DATASET_IDENTIFIER, 'invocationlatencyavg', buildLatencyFormat()),
  });

  // ── KPI: Error Rate ─────────────────────────────────────────────────────────
  // References the dashboard-level ErrorRate calculated field (ifelse zero-guard).
  // Use calcField (no aggregation) since ErrorRate already contains sum() in its expression.
  // ErrorRate is a calculated field on the metrics dataset.
  const kpiErrorRate = buildKpiVisual({
    visualId: 'exec-kpi-error-rate',
    title: 'Error Rate',
    primaryValueField: calcField('exec-kpi-error-rate-val', METRICS_DATASET_IDENTIFIER, 'ErrorRate', buildPercentFormat()),
  });

  // ── Dual-axis line chart: daily invocations + daily cost ────────────────────
  const trendLineChart: quicksight.CfnDashboard.VisualProperty = {
    lineChartVisual: {
      visualId: 'exec-daily-trend',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Daily Invocations & Cost Trend' },
      },
      chartConfiguration: {
        fieldWells: {
          lineChartAggregatedFieldWells: {
            category: [dateDimField('exec-trend-date', ds, 'timestamp', 'DAY')],
            values: [
              numericCountField('exec-trend-inv', ds, 'requestid'),
              sumField('exec-trend-cost', ds, 'totalcost'),
            ],
          },
        },
        type: 'LINE',
        dataLabels: { visibility: 'HIDDEN' },
        legend: { visibility: 'VISIBLE' },
        // Assign cost field to secondary (right) axis
        series: [
          {
            fieldSeriesItem: {
              fieldId: 'exec-trend-cost',
              axisBinding: 'SECONDARY_YAXIS',
            },
          },
        ],
      },
    },
  };

  // ── Donut chart: model mix by invocation count ──────────────────────────────
  // Cross-visual filter action: clicking a model filters all other visuals on the sheet.
  const crossVisualFilterAction: quicksight.CfnDashboard.VisualCustomActionProperty = {
    customActionId: 'exec-model-filter-action',
    name: 'Filter by Model',
    status: 'ENABLED',
    trigger: 'DATA_POINT_CLICK',
    actionOperations: [
      {
        filterOperation: {
          selectedFieldsConfiguration: {
            selectedFields: ['exec-donut-model'],
          },
          targetVisualsConfiguration: {
            sameSheetTargetVisualConfiguration: {
              targetVisualOptions: 'ALL_VISUALS',
            },
          },
        },
      },
    ],
  };

  const modelMixDonut: quicksight.CfnDashboard.VisualProperty = {
    pieChartVisual: {
      visualId: 'exec-model-mix-donut',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Model Mix by Invocations' },
      },
      chartConfiguration: {
        fieldWells: {
          pieChartAggregatedFieldWells: {
            category: [dimField('exec-donut-model', ds, 'FriendlyModelName')],
            values: [numericCountField('exec-donut-count', ds, 'requestid')],
          },
        },
        donutOptions: {
          arcOptions: {
            arcThickness: 'MEDIUM',
          },
          donutCenterOptions: {
            labelVisibility: 'VISIBLE',
          },
        },
        dataLabels: { visibility: 'VISIBLE', overlap: 'DISABLE_OVERLAP' },
        legend: {
          visibility: 'VISIBLE',
          title: { customLabel: 'Model Name', visibility: 'VISIBLE' },
        },
        tooltip: { tooltipVisibility: 'VISIBLE' },
        categoryLabelOptions: { visibility: 'HIDDEN' },
        valueLabelOptions: { visibility: 'HIDDEN' },
        // Consistent model colors via visualPalette (Req 4.1)
        visualPalette: {
          chartColor: MODEL_COLOR_PALETTE[0],
        },
      },
      actions: [crossVisualFilterAction],
    },
  };

  // ── Donut chart: model mix by cost ─────────────────────────────────────────
  const costCrossVisualFilterAction: quicksight.CfnDashboard.VisualCustomActionProperty = {
    customActionId: 'exec-cost-model-filter-action',
    name: 'Filter by Model',
    status: 'ENABLED',
    trigger: 'DATA_POINT_CLICK',
    actionOperations: [
      {
        filterOperation: {
          selectedFieldsConfiguration: {
            selectedFields: ['exec-cost-donut-model'],
          },
          targetVisualsConfiguration: {
            sameSheetTargetVisualConfiguration: {
              targetVisualOptions: 'ALL_VISUALS',
            },
          },
        },
      },
    ],
  };

  const modelMixCostDonut: quicksight.CfnDashboard.VisualProperty = {
    pieChartVisual: {
      visualId: 'exec-model-mix-cost-donut',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Model Mix by Cost' },
      },
      chartConfiguration: {
        fieldWells: {
          pieChartAggregatedFieldWells: {
            category: [dimField('exec-cost-donut-model', ds, 'FriendlyModelName')],
            values: [sumField('exec-cost-donut-cost', ds, 'totalcost')],
          },
        },
        donutOptions: {
          arcOptions: { arcThickness: 'MEDIUM' },
          donutCenterOptions: { labelVisibility: 'VISIBLE' },
        },
        dataLabels: { visibility: 'VISIBLE', overlap: 'DISABLE_OVERLAP' },
        legend: {
          visibility: 'VISIBLE',
          title: { customLabel: 'Model Name', visibility: 'VISIBLE' },
        },
        tooltip: { tooltipVisibility: 'VISIBLE' },
        categoryLabelOptions: { visibility: 'HIDDEN' },
        valueLabelOptions: { visibility: 'HIDDEN' },
        visualPalette: { chartColor: MODEL_COLOR_PALETTE[0] },
      },
      actions: [costCrossVisualFilterAction],
    },
  };

  // ── Top 10 users table ──────────────────────────────────────────────────────
  const topUsersTable: quicksight.CfnDashboard.VisualProperty = {
    tableVisual: {
      visualId: 'exec-top-users-table',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Top 10 Users by Cost' },
      },
      chartConfiguration: {
        fieldWells: {
          tableAggregatedFieldWells: {
            groupBy: [dimField('exec-table-user', ds, 'resolvedusername')],
            values: [
              numericCountField('exec-table-inv', ds, 'requestid'),
              sumField('exec-table-cost', ds, 'totalcost', buildCurrencyFormat4dp()),
            ],
          },
        },
        fieldOptions: {
          selectedFieldOptions: [
            { fieldId: 'exec-table-user', customLabel: 'User' },
            { fieldId: 'exec-table-inv', customLabel: 'Invocations' },
            { fieldId: 'exec-table-cost', customLabel: 'Total Cost' },
          ],
        },
        sortConfiguration: {
          rowSort: [
            {
              fieldSort: {
                fieldId: 'exec-table-cost',
                direction: 'DESC',
              },
            },
          ],
        },
        tableOptions: {
          headerStyle: {
            fontConfiguration: { fontWeight: { name: 'BOLD' } },
            backgroundColor: '#F0F0F0',
            textWrap: 'NONE',
            verticalTextAlignment: 'MIDDLE',
          },
          rowAlternateColorOptions: {
            status: 'ENABLED',
            rowAlternateColors: ['#F9F9F9'],
          },
        },
        paginatedReportOptions: {
          verticalOverflowVisibility: 'HIDDEN',
          overflowColumnHeaderVisibility: 'HIDDEN',
        },
      },
    },
  };

  // ── Filter control: model dropdown (directly connected to model filter) ──
  const modelFilterDropdown: quicksight.CfnDashboard.FilterControlProperty = {
    dropdown: {
      filterControlId: 'exec-model-filter-control',
      title: 'Model',
      sourceFilterId: 'exec-model-filter',
      type: 'SINGLE_SELECT',
      displayOptions: {
        selectAllOptions: { visibility: 'VISIBLE' },
        titleOptions: { visibility: 'VISIBLE' },
      },
    },
  };

  // ── Filter control: global date range picker ────────────────────────────────
  const dateRangeFilterId = 'exec-date-range-filter';
  // ── Parameter controls for date range (filters use parameters) ──────────────
  const dateStartControl: quicksight.CfnDashboard.ParameterControlProperty = {
    dateTimePicker: {
      parameterControlId: 'exec-date-start-control',
      title: 'Start Date',
      sourceParameterName: 'DateRangeStart',
      displayOptions: {
        titleOptions: {
          visibility: 'VISIBLE',
          fontConfiguration: { fontWeight: { name: 'BOLD' } },
        },
        dateTimeFormat: 'YYYY/MM/DD',
      },
    },
  };
  const dateEndControl: quicksight.CfnDashboard.ParameterControlProperty = {
    dateTimePicker: {
      parameterControlId: 'exec-date-end-control',
      title: 'End Date',
      sourceParameterName: 'DateRangeEnd',
      displayOptions: {
        titleOptions: {
          visibility: 'VISIBLE',
          fontConfiguration: { fontWeight: { name: 'BOLD' } },
        },
        dateTimeFormat: 'YYYY/MM/DD',
      },
    },
  };

  // ── Filter definition: date range applied to all visuals on this sheet ──────
  // FilterGroups live at the DashboardVersionDefinitionProperty level, not the sheet level.
  const dateRangeFilter: quicksight.CfnDashboard.FilterProperty = {
    timeRangeFilter: {
      filterId: dateRangeFilterId,
      column: col(ds, 'timestamp'),
      nullOption: 'NON_NULLS_ONLY',
      rangeMinimumValue: {
        parameter: 'DateRangeStart',
      },
      rangeMaximumValue: {
        parameter: 'DateRangeEnd',
      },
      includeMinimum: true,
      includeMaximum: true,
      timeGranularity: 'DAY',
    },
  };

  const filterGroup: quicksight.CfnDashboard.FilterGroupProperty = {
    filterGroupId: 'exec-date-filter-group',
    filters: [dateRangeFilter],
    scopeConfiguration: {
      selectedSheets: {
        sheetVisualScopingConfigurations: [
          {
            sheetId: 'executive-summary',
            scope: 'ALL_VISUALS',
          },
        ],
      },
    },
    crossDataset: 'SINGLE_DATASET',
    status: 'ENABLED',
  };

  // ── Filter group: model filter scoped to Avg Latency + Error Rate KPIs ──────
  const modelFilter: quicksight.CfnDashboard.FilterProperty = {
    categoryFilter: {
      filterId: 'exec-model-filter',
      column: { dataSetIdentifier: METRICS_DATASET_IDENTIFIER, columnName: 'FriendlyModelName' },
      configuration: {
        filterListConfiguration: {
          matchOperator: 'CONTAINS',
          nullOption: 'NON_NULLS_ONLY',
          selectAllOptions: 'FILTER_ALL_VALUES',
        },
      },
    },
  };

  const modelFilterGroup: quicksight.CfnDashboard.FilterGroupProperty = {
    filterGroupId: 'exec-model-filter-group',
    filters: [modelFilter],
    scopeConfiguration: {
      selectedSheets: {
        sheetVisualScopingConfigurations: [
          {
            sheetId: 'executive-summary',
            scope: 'SELECTED_VISUALS',
            visualIds: ['exec-kpi-latency', 'exec-kpi-error-rate'],
          },
        ],
      },
    },
    crossDataset: 'SINGLE_DATASET',
    status: 'ENABLED',
  };

  // ── Last Refreshed: single-row table visual ──────────────────────────────────
  // KPI visuals only support COUNT/DISTINCT_COUNT for date fields, so we use a
  // minimal table visual. We use tableUnaggregatedFieldWells with the timestamp
  // as a date dimension field, sorted DESC, with overflow hidden — so only the
  // most recent row (the MAX timestamp) is visible.
  const kpiLastRefreshed: quicksight.CfnDashboard.VisualProperty = {
    tableVisual: {
      visualId: 'exec-kpi-last-refreshed',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Last Refreshed' },
      },
      chartConfiguration: {
        fieldWells: {
          tableUnaggregatedFieldWells: {
            values: [
              {
                fieldId: 'exec-kpi-last-refreshed-val',
                column: col(ds, 'timestamp'),
                formatConfiguration: {
                  dateTimeFormatConfiguration: {
                    dateTimeFormat: 'MMMM D, YYYY [at] HH:mm:ss',
                  },
                },
              },
            ],
          },
        },
        sortConfiguration: {
          rowSort: [
            {
              fieldSort: {
                fieldId: 'exec-kpi-last-refreshed-val',
                direction: 'DESC',
              },
            },
          ],
        },
        fieldOptions: {
          selectedFieldOptions: [
            { fieldId: 'exec-kpi-last-refreshed-val', customLabel: 'Last Refreshed' },
          ],
        },
        tableOptions: {
          headerStyle: {
            visibility: 'HIDDEN',
            fontConfiguration: { fontWeight: { name: 'BOLD' } },
            backgroundColor: '#F0F0F0',
            textWrap: 'NONE',
            verticalTextAlignment: 'MIDDLE',
          },
        },
        paginatedReportOptions: {
          verticalOverflowVisibility: 'HIDDEN',
        },
      },
    },
  };

  // ── Assemble visuals list ───────────────────────────────────────────────────
  const visuals: quicksight.CfnDashboard.VisualProperty[] = [
    kpiLastRefreshed,
    kpiInvocations,
    kpiCost,
    kpiUsers,
    kpiLatency,
    kpiErrorRate,
    trendLineChart,
    modelMixDonut,
    modelMixCostDonut,
    topUsersTable,
  ];

  return {
    sheet: {
      sheetId: 'executive-summary',
      name: 'Executive Summary',
      visuals,
      filterControls: [modelFilterDropdown],
      parameterControls: [dateStartControl, dateEndControl],
    },
    filterGroups: [filterGroup, modelFilterGroup],
  };
}

// ── Cost & Usage Sheet ────────────────────────────────────────────────────────

/**
 * Result of building the Cost & Usage sheet.
 * filterGroups must be placed at the DashboardVersionDefinitionProperty level.
 */
export interface CostUsageSheetResult {
  sheet: quicksight.CfnDashboard.SheetDefinitionProperty;
  filterGroups: quicksight.CfnDashboard.FilterGroupProperty[];
}

/**
 * Builds the Cost & Usage deep-dive sheet definition (Sheet 2).
 *
 * Contains:
 *  - Horizontal stacked bar chart: cost by model (inputcost vs outputcost)
 *  - Heat map: model (rows) x day (columns), value = SUM(totalcost)
 *  - Stacked area chart: daily SUM(inputtokens) + SUM(outputtokens)
 *  - Pivot table: user x model with invocations, input tokens, output tokens, cost
 *  - Global date range picker filter control
 *  - Cross-visual filter action on model click
 *
 * Requirements: 2.3, 3, 4
 */
export function buildCostUsageSheet(
  params: SheetDefinitionsParams,
): CostUsageSheetResult {
  const { dataSetIdentifier } = params;
  const ds = dataSetIdentifier;

  // ── Horizontal stacked bar: cost by model (inputcost + outputcost) ──────────
  const crossVisualFilterAction: quicksight.CfnDashboard.VisualCustomActionProperty = {
    customActionId: 'cu-model-filter-action',
    name: 'Filter by Model',
    status: 'ENABLED',
    trigger: 'DATA_POINT_CLICK',
    actionOperations: [
      {
        filterOperation: {
          selectedFieldsConfiguration: {
            selectedFields: ['cu-bar-model'],
          },
          targetVisualsConfiguration: {
            sameSheetTargetVisualConfiguration: {
              targetVisualOptions: 'ALL_VISUALS',
            },
          },
        },
      },
    ],
  };

  const costByModelBar: quicksight.CfnDashboard.VisualProperty = {
    barChartVisual: {
      visualId: 'cu-cost-by-model-bar',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Cost by Model (Input vs Output)' },
      },
      chartConfiguration: {
        fieldWells: {
          barChartAggregatedFieldWells: {
            category: [dimField('cu-bar-model', ds, 'FriendlyModelName')],
            values: [
              sumField('cu-bar-inputcost', ds, 'inputcost', buildCurrencyFormat()),
              sumField('cu-bar-outputcost', ds, 'outputcost', buildCurrencyFormat()),
            ],
          },
        },
        orientation: 'HORIZONTAL',
        barsArrangement: 'STACKED',
        dataLabels: { visibility: 'HIDDEN' },
        legend: { visibility: 'VISIBLE' },
        categoryLabelOptions: {
          visibility: 'VISIBLE',
          axisLabelOptions: [
            {
              customLabel: 'Model Name',
              applyTo: {
                fieldId: 'cu-bar-model',
                column: col(ds, 'FriendlyModelName'),
              },
            },
          ],
        },
        colorLabelOptions: {
          visibility: 'VISIBLE',
          axisLabelOptions: [
            {
              customLabel: 'Input Costs',
              applyTo: {
                fieldId: 'cu-bar-inputcost',
                column: col(ds, 'inputcost'),
              },
            },
            {
              customLabel: 'Output Costs',
              applyTo: {
                fieldId: 'cu-bar-outputcost',
                column: col(ds, 'outputcost'),
              },
            },
          ],
        },
        // Consistent model colors via visualPalette (Req 4.1)
        visualPalette: {
          colorMap: MODEL_COLOR_PALETTE.map((color, index) => ({
            element: { dataPathType: { pivotTableDataPathType: 'MULTIPLE_ROW_METRICS_COLUMN' }, fieldId: `cu-bar-model`, fieldValue: String(index) },
            color,
          })),
        },
      },
      actions: [crossVisualFilterAction],
    },
  };

  // ── Heat map: model (rows) x day (columns), value = SUM(totalcost) ──────────
  const costHeatMap: quicksight.CfnDashboard.VisualProperty = {
    heatMapVisual: {
      visualId: 'cu-cost-heatmap',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Cost Heat Map (Model × Day)' },
      },
      chartConfiguration: {
        fieldWells: {
          heatMapAggregatedFieldWells: {
            rows: [dimField('cu-heatmap-model', ds, 'FriendlyModelName')],
            columns: [dateDimField('cu-heatmap-day', ds, 'timestamp', 'DAY')],
            values: [sumField('cu-heatmap-cost', ds, 'totalcost')],
          },
        },
        colorScale: {
          colors: [
            { color: '#2CAD00' }, // green = low cost
            { color: '#FFFFFF' }, // white = mid
            { color: '#DE3B00' }, // red = high cost
          ],
          colorFillType: 'GRADIENT',
          nullValueColor: { color: '#F0F0F0' },
        },
        dataLabels: { visibility: 'HIDDEN' },
        legend: { visibility: 'VISIBLE' },
        rowLabelOptions: {
          visibility: 'VISIBLE',
          axisLabelOptions: [{
            customLabel: 'Model Name',
            applyTo: {
              fieldId: 'cu-heatmap-model',
              column: col(ds, 'FriendlyModelName'),
            },
          }],
        },
        columnLabelOptions: {
          visibility: 'VISIBLE',
          axisLabelOptions: [{
            customLabel: 'Date',
            applyTo: {
              fieldId: 'cu-heatmap-day',
              column: col(ds, 'timestamp'),
            },
          }],
        },
      },
    },
  };

  // ── Stacked area chart: daily inputtokens + outputtokens ────────────────────
  const tokenTrendsArea: quicksight.CfnDashboard.VisualProperty = {
    lineChartVisual: {
      visualId: 'cu-token-trends-area',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Daily Token Usage (Input vs Output)' },
      },
      chartConfiguration: {
        fieldWells: {
          lineChartAggregatedFieldWells: {
            category: [dateDimField('cu-area-date', ds, 'timestamp', 'DAY')],
            values: [
              sumField('cu-area-inputtokens', ds, 'inputtokens', buildTokenFormat()),
              sumField('cu-area-outputtokens', ds, 'outputtokens', buildTokenFormat()),
            ],
          },
        },
        type: 'AREA',
        dataLabels: { visibility: 'HIDDEN' },
        legend: { visibility: 'VISIBLE' },
        primaryYAxisLabelOptions: {
          visibility: 'VISIBLE',
          axisLabelOptions: [
            {
              customLabel: 'Input Tokens',
              applyTo: {
                fieldId: 'cu-area-inputtokens',
                column: col(ds, 'inputtokens'),
              },
            },
            {
              customLabel: 'Output Tokens',
              applyTo: {
                fieldId: 'cu-area-outputtokens',
                column: col(ds, 'outputtokens'),
              },
            },
          ],
        },
        xAxisLabelOptions: {
          visibility: 'VISIBLE',
          axisLabelOptions: [{
            customLabel: 'Date',
            applyTo: {
              fieldId: 'cu-area-date',
              column: col(ds, 'timestamp'),
            },
          }],
        },
      },
    },
  };

  // ── Pivot table: user x model with invocations, tokens, cost ────────────────
  const userModelPivot: quicksight.CfnDashboard.VisualProperty = {
    pivotTableVisual: {
      visualId: 'cu-user-model-pivot',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'User × Model Breakdown' },
      },
      chartConfiguration: {
        fieldWells: {
          pivotTableAggregatedFieldWells: {
            rows: [dimField('cu-pivot-user', ds, 'resolvedusername')],
            columns: [dimField('cu-pivot-model', ds, 'FriendlyModelName')],
            values: [
              numericCountField('cu-pivot-invocations', ds, 'requestid'),
              sumField('cu-pivot-inputtokens', ds, 'inputtokens', buildTokenFormat()),
              sumField('cu-pivot-outputtokens', ds, 'outputtokens', buildTokenFormat()),
              sumField('cu-pivot-cost', ds, 'totalcost', buildCurrencyFormat()),
            ],
          },
        },
        fieldOptions: {
          selectedFieldOptions: [
            { fieldId: 'cu-pivot-user', customLabel: 'User' },
            { fieldId: 'cu-pivot-model', customLabel: 'Model' },
            { fieldId: 'cu-pivot-invocations', customLabel: 'Invocations' },
            { fieldId: 'cu-pivot-inputtokens', customLabel: 'Input Tokens' },
            { fieldId: 'cu-pivot-outputtokens', customLabel: 'Output Tokens' },
            { fieldId: 'cu-pivot-cost', customLabel: 'Total Cost' },
          ],
        },
        sortConfiguration: {},
        tableOptions: {
          metricPlacement: 'ROW',
          singleMetricVisibility: 'HIDDEN',
          columnNamesVisibility: 'VISIBLE',
          toggleButtonsVisibility: 'VISIBLE',
          columnHeaderStyle: {
            fontConfiguration: { fontWeight: { name: 'BOLD' } },
            backgroundColor: '#F0F0F0',
            textWrap: 'NONE',
            verticalTextAlignment: 'MIDDLE',
          },
          rowHeaderStyle: {
            fontConfiguration: { fontWeight: { name: 'BOLD' } },
            backgroundColor: '#F0F0F0',
            textWrap: 'NONE',
            verticalTextAlignment: 'MIDDLE',
          },
          rowAlternateColorOptions: {
            status: 'ENABLED',
            rowAlternateColors: ['#F9F9F9'],
          },
        },
        totalOptions: {
          columnTotalOptions: {
            totalsVisibility: 'VISIBLE',
            placement: 'END',
            totalCellStyle: {
              fontConfiguration: { fontWeight: { name: 'BOLD' } },
              backgroundColor: '#F0F0F0',
            },
          },
        },
      },
    },
  };

  // ── Filter control: global date range picker ────────────────────────────────
  const dateRangeFilterId = 'cu-date-range-filter';
  // Parameter controls for date range (filters use parameters)
  const dateStartControl: quicksight.CfnDashboard.ParameterControlProperty = {
    dateTimePicker: {
      parameterControlId: 'cu-date-start-control',
      title: 'Start Date',
      sourceParameterName: 'DateRangeStart',
      displayOptions: {
        titleOptions: {
          visibility: 'VISIBLE',
          fontConfiguration: { fontWeight: { name: 'BOLD' } },
        },
        dateTimeFormat: 'YYYY/MM/DD',
      },
    },
  };
  const dateEndControl: quicksight.CfnDashboard.ParameterControlProperty = {
    dateTimePicker: {
      parameterControlId: 'cu-date-end-control',
      title: 'End Date',
      sourceParameterName: 'DateRangeEnd',
      displayOptions: {
        titleOptions: {
          visibility: 'VISIBLE',
          fontConfiguration: { fontWeight: { name: 'BOLD' } },
        },
        dateTimeFormat: 'YYYY/MM/DD',
      },
    },
  };

  // ── Filter definition: date range applied to all visuals on this sheet ──────
  const dateRangeFilter: quicksight.CfnDashboard.FilterProperty = {
    timeRangeFilter: {
      filterId: dateRangeFilterId,
      column: col(ds, 'timestamp'),
      nullOption: 'NON_NULLS_ONLY',
      rangeMinimumValue: {
        parameter: 'DateRangeStart',
      },
      rangeMaximumValue: {
        parameter: 'DateRangeEnd',
      },
      includeMinimum: true,
      includeMaximum: true,
      timeGranularity: 'DAY',
    },
  };

  const filterGroup: quicksight.CfnDashboard.FilterGroupProperty = {
    filterGroupId: 'cu-date-filter-group',
    filters: [dateRangeFilter],
    scopeConfiguration: {
      selectedSheets: {
        sheetVisualScopingConfigurations: [
          {
            sheetId: 'cost-usage',
            scope: 'ALL_VISUALS',
          },
        ],
      },
    },
    crossDataset: 'SINGLE_DATASET',
    status: 'ENABLED',
  };

  // ── Donut chart: per-user cost breakdown ────────────────────────────────────
  const userCostDonut: quicksight.CfnDashboard.VisualProperty = {
    pieChartVisual: {
      visualId: 'cu-user-cost-donut',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'User × Costs' },
      },
      chartConfiguration: {
        fieldWells: {
          pieChartAggregatedFieldWells: {
            category: [dimField('cu-donut-user', ds, 'resolvedusername')],
            values: [sumField('cu-donut-cost', ds, 'totalcost', buildCurrencyFormat())],
          },
        },
        donutOptions: {
          arcOptions: { arcThickness: 'MEDIUM' },
          donutCenterOptions: { labelVisibility: 'VISIBLE' },
        },
        dataLabels: { visibility: 'VISIBLE', overlap: 'DISABLE_OVERLAP' },
        legend: { visibility: 'VISIBLE' },
        tooltip: {
          tooltipVisibility: 'VISIBLE',
          fieldBasedTooltip: {
            aggregationVisibility: 'VISIBLE',
            tooltipFields: [
              { fieldTooltipItem: { fieldId: 'cu-donut-user', visibility: 'VISIBLE' } },
              { fieldTooltipItem: { fieldId: 'cu-donut-cost', visibility: 'VISIBLE' } },
            ],
          },
        },
      },
    },
  };

  // ── Donut chart: reconciliation status breakdown ──────────────────────────
  const reconciliationStatusDonut: quicksight.CfnDashboard.VisualProperty = {
    pieChartVisual: {
      visualId: 'cu-reconciliation-status-donut',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Reconciliation Status' },
      },
      chartConfiguration: {
        fieldWells: {
          pieChartAggregatedFieldWells: {
            category: [dimField('cu-recon-status', ds, 'reconciliation_status')],
            values: [countField('cu-recon-count', ds, 'reconciliation_status')],
          },
        },
        donutOptions: {
          arcOptions: { arcThickness: 'MEDIUM' },
          donutCenterOptions: { labelVisibility: 'VISIBLE' },
        },
        dataLabels: { visibility: 'VISIBLE', overlap: 'DISABLE_OVERLAP' },
        legend: { visibility: 'VISIBLE' },
        tooltip: {
          tooltipVisibility: 'VISIBLE',
          fieldBasedTooltip: {
            aggregationVisibility: 'VISIBLE',
            tooltipFields: [
              { fieldTooltipItem: { fieldId: 'cu-recon-status', visibility: 'VISIBLE' } },
              { fieldTooltipItem: { fieldId: 'cu-recon-count', visibility: 'VISIBLE' } },
            ],
          },
        },
        // Color-code statuses: green=reconciled, yellow=estimated, grey=pending, red=unmatched
        visualPalette: {
          colorMap: [
            { element: { fieldId: 'cu-recon-status', fieldValue: 'reconciled' }, color: '#2CA02C' },
            { element: { fieldId: 'cu-recon-status', fieldValue: 'estimated' }, color: '#FF7F0E' },
            { element: { fieldId: 'cu-recon-status', fieldValue: 'pending' }, color: '#7F7F7F' },
            { element: { fieldId: 'cu-recon-status', fieldValue: 'unmatched' }, color: '#D62728' },
          ],
        },
      },
    },
  };

  return {
    sheet: {
      sheetId: 'cost-usage',
      name: 'Cost & Usage',
      visuals: [costByModelBar, costHeatMap, tokenTrendsArea, userCostDonut, reconciliationStatusDonut, userModelPivot],
      filterControls: [],
      parameterControls: [dateStartControl, dateEndControl],
    },
    filterGroups: [filterGroup],
  };
}

// ── Performance Sheet ─────────────────────────────────────────────────────────

/**
 * Result of building the Performance sheet.
 * filterGroups must be placed at the DashboardVersionDefinitionProperty level.
 */
export interface PerformanceSheetResult {
  sheet: quicksight.CfnDashboard.SheetDefinitionProperty;
  filterGroups: quicksight.CfnDashboard.FilterGroupProperty[];
}

/**
 * Builds the Performance sheet definition (Sheet 3).
 *
 * Contains:
 *  - 3 KPI cards: Avg Latency, P99 Latency, Error Rate (period-over-period)
 *  - Combo chart: bar = AVG(latencyms) by model, line overlay = P99 latency
 *  - Stacked area chart: daily SUM(errorcount) + SUM(throttledcount)
 *  - Scatter plot: x = AVG(latencyms), y = SUM(inputtokens+outputtokens), color = modelid
 *  - Global date range picker filter control
 *  - Cross-visual filter action on model click
 *
 * Requirements: 2.4, 3, 4
 */
export function buildPerformanceSheet(
  params: SheetDefinitionsParams,
): PerformanceSheetResult {
  const { dataSetIdentifier } = params;
  const ds = dataSetIdentifier;
  const mds = METRICS_DATASET_IDENTIFIER; // metrics dataset for metrics-specific visuals

  // ── KPI: Avg Latency (metrics dataset) ───────────────────────────────────────
  const kpiAvgLatency = buildKpiVisual({
    visualId: 'perf-kpi-avg-latency',
    title: 'Avg Latency',
    primaryValueField: avgField('perf-kpi-avg-lat-val', mds, 'invocationlatencyavg', buildLatencyFormat()),
  });

  // ── KPI: P99 Latency (metrics dataset) ──────────────────────────────────────
  const kpiP99Latency = buildKpiVisual({
    visualId: 'perf-kpi-p99-latency',
    title: 'P99 Latency',
    primaryValueField: avgField('perf-kpi-p99-lat-val', mds, 'invocationlatencyp99'),
  });

  // ── KPI: Error Rate (metrics dataset) ───────────────────────────────────────
  const kpiErrorRate = buildKpiVisual({
    visualId: 'perf-kpi-error-rate',
    title: 'Error Rate',
    primaryValueField: calcField('perf-kpi-error-rate-val', mds, 'ErrorRate', buildPercentFormat()),
  });

  // ── Cross-visual filter action: clicking a model filters all visuals ─────────
  const crossVisualFilterAction: quicksight.CfnDashboard.VisualCustomActionProperty = {
    customActionId: 'perf-model-filter-action',
    name: 'Filter by Model',
    status: 'ENABLED',
    trigger: 'DATA_POINT_CLICK',
    actionOperations: [
      {
        filterOperation: {
          selectedFieldsConfiguration: {
            selectedFields: ['perf-combo-model'],
          },
          targetVisualsConfiguration: {
            sameSheetTargetVisualConfiguration: {
              targetVisualOptions: 'ALL_VISUALS',
            },
          },
        },
      },
    ],
  };

  // ── Combo chart: bar = AVG(invocationlatencyavg) by model, line = P99 latency (metrics dataset) ──
  const latencyByModelCombo: quicksight.CfnDashboard.VisualProperty = {
    comboChartVisual: {
      visualId: 'perf-latency-combo',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Latency by Model (Avg vs P99)' },
      },
      chartConfiguration: {
        fieldWells: {
          comboChartAggregatedFieldWells: {
            category: [dimField('perf-combo-model', mds, 'FriendlyModelName')],
            barValues: [avgField('perf-combo-avg-lat', mds, 'invocationlatencyavg', buildLatencyFormat())],
            lineValues: [avgField('perf-combo-p99-lat', mds, 'invocationlatencyp99', buildLatencyFormat())],
          },
        },
        barsArrangement: 'CLUSTERED',
        barDataLabels: { visibility: 'HIDDEN' },
        lineDataLabels: { visibility: 'HIDDEN' },
        legend: { visibility: 'VISIBLE' },
        // Consistent model colors via visualPalette (Req 4.1)
        visualPalette: {
          chartColor: MODEL_COLOR_PALETTE[0],
        },
      },
      actions: [crossVisualFilterAction],
    },
  };

  // ── Table: Daily Throttles (metrics dataset) ──────────────────────────────────
  const dailyThrottlesTable: quicksight.CfnDashboard.VisualProperty = {
    tableVisual: {
      visualId: 'perf-daily-throttles-table',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Daily Throttles' },
      },
      chartConfiguration: {
        fieldWells: {
          tableAggregatedFieldWells: {
            groupBy: [
              dateDimField('perf-throttle-date', mds, 'timestamp', 'DAY'),
              dimField('perf-throttle-model', mds, 'FriendlyModelName'),
            ],
            values: [
              sumField('perf-throttle-count', mds, 'throttledcount'),
            ],
          },
        },
        fieldOptions: {
          selectedFieldOptions: [
            { fieldId: 'perf-throttle-date', customLabel: 'Date' },
            { fieldId: 'perf-throttle-model', customLabel: 'Model' },
            { fieldId: 'perf-throttle-count', customLabel: 'Total Throttles' },
          ],
        },
        sortConfiguration: {
          rowSort: [
            {
              fieldSort: {
                fieldId: 'perf-throttle-count',
                direction: 'DESC',
              },
            },
          ],
        },
        tableOptions: {
          headerStyle: {
            fontConfiguration: { fontWeight: { name: 'BOLD' } },
            backgroundColor: '#F0F0F0',
            textWrap: 'NONE',
            verticalTextAlignment: 'MIDDLE',
          },
          rowAlternateColorOptions: {
            status: 'ENABLED',
            rowAlternateColors: ['#F9F9F9'],
          },
        },
        totalOptions: {
          totalsVisibility: 'VISIBLE',
          placement: 'END',
          totalCellStyle: {
            fontConfiguration: { fontWeight: { name: 'BOLD' } },
            backgroundColor: '#F0F0F0',
          },
        },
      },
    },
  };

  // ── Scatter plot: latency (x) vs token count (y), colored by model ──────────
  const latencyVsTokensScatter: quicksight.CfnDashboard.VisualProperty = {
    scatterPlotVisual: {
      visualId: 'perf-latency-tokens-scatter',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Latency vs Token Count by Model' },
      },
      chartConfiguration: {
        fieldWells: {
          scatterPlotCategoricallyAggregatedFieldWells: {
            category: [dimField('perf-scatter-model', ds, 'FriendlyModelName')],
            xAxis: [avgField('perf-scatter-x-lat', ds, 'latencyms', buildLatencyFormat())],
            yAxis: [sumField('perf-scatter-y-tokens', ds, 'totaltokens')],
          },
        },
        dataLabels: { visibility: 'HIDDEN' },
        legend: { visibility: 'VISIBLE' },
        // Consistent model colors via visualPalette (Req 4.1)
        visualPalette: {
          chartColor: MODEL_COLOR_PALETTE[0],
        },
      },
    },
  };

  // ── Filter control: global date range picker ────────────────────────────────
  const dateRangeFilterId = 'perf-date-range-filter';
  // Parameter controls for date range (filters use parameters)
  const dateStartControl: quicksight.CfnDashboard.ParameterControlProperty = {
    dateTimePicker: {
      parameterControlId: 'perf-date-start-control',
      title: 'Start Date',
      sourceParameterName: 'DateRangeStart',
      displayOptions: {
        titleOptions: {
          visibility: 'VISIBLE',
          fontConfiguration: { fontWeight: { name: 'BOLD' } },
        },
        dateTimeFormat: 'YYYY/MM/DD',
      },
    },
  };
  const dateEndControl: quicksight.CfnDashboard.ParameterControlProperty = {
    dateTimePicker: {
      parameterControlId: 'perf-date-end-control',
      title: 'End Date',
      sourceParameterName: 'DateRangeEnd',
      displayOptions: {
        titleOptions: {
          visibility: 'VISIBLE',
          fontConfiguration: { fontWeight: { name: 'BOLD' } },
        },
        dateTimeFormat: 'YYYY/MM/DD',
      },
    },
  };

  // ── Filter definition: date range applied to all visuals on this sheet ──────
  const dateRangeFilter: quicksight.CfnDashboard.FilterProperty = {
    timeRangeFilter: {
      filterId: dateRangeFilterId,
      column: col(ds, 'timestamp'),
      nullOption: 'NON_NULLS_ONLY',
      rangeMinimumValue: {
        parameter: 'DateRangeStart',
      },
      rangeMaximumValue: {
        parameter: 'DateRangeEnd',
      },
      includeMinimum: true,
      includeMaximum: true,
      timeGranularity: 'DAY',
    },
  };

  const filterGroup: quicksight.CfnDashboard.FilterGroupProperty = {
    filterGroupId: 'perf-date-filter-group',
    filters: [dateRangeFilter],
    scopeConfiguration: {
      selectedSheets: {
        sheetVisualScopingConfigurations: [
          {
            sheetId: 'performance',
            scope: 'ALL_VISUALS',
          },
        ],
      },
    },
    crossDataset: 'SINGLE_DATASET',
    status: 'ENABLED',
  };

  // ── Model dropdown filter control: filter KPIs by model ───────────────────
  const modelFilterDropdown: quicksight.CfnDashboard.FilterControlProperty = {
    dropdown: {
      filterControlId: 'perf-model-filter-control',
      title: 'Model',
      sourceFilterId: 'perf-model-filter',
      type: 'SINGLE_SELECT',
      displayOptions: {
        selectAllOptions: { visibility: 'VISIBLE' },
        titleOptions: { visibility: 'VISIBLE' },
      },
    },
  };

  // ── Filter: model filter scoped to KPI visuals ──────────────────────────────
  const perfModelFilter: quicksight.CfnDashboard.FilterProperty = {
    categoryFilter: {
      filterId: 'perf-model-filter',
      column: { dataSetIdentifier: METRICS_DATASET_IDENTIFIER, columnName: 'FriendlyModelName' },
      configuration: {
        filterListConfiguration: {
          matchOperator: 'CONTAINS',
          nullOption: 'NON_NULLS_ONLY',
          selectAllOptions: 'FILTER_ALL_VALUES',
        },
      },
    },
  };

  const perfModelFilterGroup: quicksight.CfnDashboard.FilterGroupProperty = {
    filterGroupId: 'perf-model-filter-group',
    filters: [perfModelFilter],
    scopeConfiguration: {
      selectedSheets: {
        sheetVisualScopingConfigurations: [
          {
            sheetId: 'performance',
            scope: 'SELECTED_VISUALS',
            visualIds: ['perf-kpi-avg-latency', 'perf-kpi-p99-latency', 'perf-kpi-error-rate'],
          },
        ],
      },
    },
    crossDataset: 'SINGLE_DATASET',
    status: 'ENABLED',
  };

  return {
    sheet: {
      sheetId: 'performance',
      name: 'Performance',
      visuals: [
        kpiAvgLatency,
        kpiP99Latency,
        kpiErrorRate,
        latencyByModelCombo,
        dailyThrottlesTable,
        latencyVsTokensScatter,
      ],
      filterControls: [modelFilterDropdown],
      parameterControls: [dateStartControl, dateEndControl],
    },
    filterGroups: [filterGroup, perfModelFilterGroup],
  };
}

// ── Service Quota Prep Sheet ──────────────────────────────────────────────────

/**
 * Result of building the Service Quota Prep sheet.
 * filterGroups must be placed at the DashboardVersionDefinitionProperty level.
 */
export interface ServiceQuotaSheetResult {
  sheet: quicksight.CfnDashboard.SheetDefinitionProperty;
  filterGroups: quicksight.CfnDashboard.FilterGroupProperty[];
}

/**
 * Builds the Service Quota Prep sheet definition (Sheet 4).
 *
 * Contains:
 *  - Model dropdown parameter control (independent, not linked to other sheets)
 *  - Time range parameter control with "Last 24 Hours" quick-select
 *  - 9 KPI/text visuals: Input Modalities, Output Modalities, Steady State TPM,
 *    Steady State RPM, Peak State TPM, Peak State RPM, Avg Input Tokens,
 *    Avg Output Tokens, CRIS Option
 *  - Dual-axis line chart: TPM (left) + RPM (right) over time, with reference
 *    lines for steady state and peak values
 *  - Independent FilterGroup scoped only to this sheet
 *
 * Requirements: 11
 */
export function buildServiceQuotaSheet(
  params: SheetDefinitionsParams,
): ServiceQuotaSheetResult {
  const { dataSetIdentifier } = params;
  const ds = dataSetIdentifier;
  const mds = METRICS_DATASET_IDENTIFIER;

  // ── Parameter names (independent — not shared with sheets 1-3) ──────────────
  const modelParamName = 'SqModelId';
  const timeStartParamName = 'SqTimeRangeStart';
  const timeEndParamName = 'SqTimeRangeEnd';

  // ── Parameter controls ───────────────────────────────────────────────────────
  // Model dropdown: distinct modelid values from the dataset
  const modelDropdownControl: quicksight.CfnDashboard.ParameterControlProperty = {
    dropdown: {
      parameterControlId: 'sq-model-dropdown-control',
      title: 'Model',
      sourceParameterName: modelParamName,
      displayOptions: {
        titleOptions: {
          visibility: 'VISIBLE',
          fontConfiguration: { fontWeight: { name: 'BOLD' } },
        },
        selectAllOptions: { visibility: 'HIDDEN' },
      },
      selectableValues: {
        linkToDataSetColumn: {
          dataSetIdentifier: ds,
          columnName: 'FriendlyModelName',
        },
      },
    },
  };

  // Time range picker — uses parameter controls since the filter is parameter-driven
  const timeStartControl: quicksight.CfnDashboard.ParameterControlProperty = {
    dateTimePicker: {
      parameterControlId: 'sq-time-start-control',
      title: 'Start Time',
      sourceParameterName: timeStartParamName,
      displayOptions: {
        titleOptions: {
          visibility: 'VISIBLE',
          fontConfiguration: { fontWeight: { name: 'BOLD' } },
        },
        dateTimeFormat: 'YYYY/MM/DD HH:mm',
      },
    },
  };
  const timeEndControl: quicksight.CfnDashboard.ParameterControlProperty = {
    dateTimePicker: {
      parameterControlId: 'sq-time-end-control',
      title: 'End Time',
      sourceParameterName: timeEndParamName,
      displayOptions: {
        titleOptions: {
          visibility: 'VISIBLE',
          fontConfiguration: { fontWeight: { name: 'BOLD' } },
        },
        dateTimeFormat: 'YYYY/MM/DD HH:mm',
      },
    },
  };

  // ── Filter: model equality filter (independent, scoped to this sheet only) ───
  const modelFilterId = 'sq-model-filter';
  const modelFilter: quicksight.CfnDashboard.FilterProperty = {
    categoryFilter: {
      filterId: modelFilterId,
      column: col(ds, 'FriendlyModelName'),
      configuration: {
        filterListConfiguration: {
          matchOperator: 'CONTAINS',
          nullOption: 'NON_NULLS_ONLY',
          selectAllOptions: 'FILTER_ALL_VALUES',
        },
      },
    },
  };

  // ── Filter: time range filter (independent, scoped to this sheet only) ───────
  const timeRangeFilterId = 'sq-time-range-filter';
  const timeRangeFilter: quicksight.CfnDashboard.FilterProperty = {
    timeRangeFilter: {
      filterId: timeRangeFilterId,
      column: col(ds, 'timestamp'),
      nullOption: 'NON_NULLS_ONLY',
      rangeMinimumValue: { parameter: timeStartParamName },
      rangeMaximumValue: { parameter: timeEndParamName },
      includeMinimum: true,
      includeMaximum: true,
      timeGranularity: 'MINUTE',
    },
  };

  // Single FilterGroup scoped ONLY to this sheet (independent from sheets 1-3)
  const filterGroup: quicksight.CfnDashboard.FilterGroupProperty = {
    filterGroupId: 'sq-filter-group',
    filters: [modelFilter, timeRangeFilter],
    scopeConfiguration: {
      selectedSheets: {
        sheetVisualScopingConfigurations: [
          {
            sheetId: 'service-quota-prep',
            scope: 'ALL_VISUALS',
          },
        ],
      },
    },
    crossDataset: 'SINGLE_DATASET',
    status: 'ENABLED',
  };

  // ── KPI 2: Output Modalities (constant 1 = TEXT) ─────────────────────────────
  const kpiOutputModalities: quicksight.CfnDashboard.VisualProperty = {
    kpiVisual: {
      visualId: 'sq-kpi-output-modalities',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Total Output Tokens' },
      },
      chartConfiguration: {
        fieldWells: {
          values: [
            {
              numericalMeasureField: {
                fieldId: 'sq-output-modalities-val',
                column: col(ds, 'outputtokens'),
                aggregationFunction: { simpleNumericalAggregation: 'SUM' },
              },
            },
          ],
        },
      },
    },
  };

  // ── KPI 3: Steady State TPM (AVG invocationcount from Metrics) ─────────────
  const kpiSteadyStateTpm: quicksight.CfnDashboard.VisualProperty = {
    kpiVisual: {
      visualId: 'sq-kpi-steady-tpm',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Steady State TPM' },
      },
      chartConfiguration: {
        fieldWells: {
          values: [avgField('sq-steady-tpm-val', mds, 'invocationcount')],
          trendGroups: [dateDimField('sq-steady-tpm-trend', mds, 'timestamp', 'MINUTE')],
        },
      },
    },
  };

  // ── KPI 4: Steady State RPM (AVG invocationcount from Metrics) ─────────────
  const kpiSteadyStateRpm: quicksight.CfnDashboard.VisualProperty = {
    kpiVisual: {
      visualId: 'sq-kpi-steady-rpm',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Steady State RPM' },
      },
      chartConfiguration: {
        fieldWells: {
          values: [avgField('sq-steady-rpm-val', mds, 'invocationcount')],
          trendGroups: [dateDimField('sq-steady-rpm-trend', mds, 'timestamp', 'MINUTE')],
        },
      },
    },
  };

  // ── KPI 5: Peak State TPM (MAX invocationcount from Metrics) ───────────────
  const kpiPeakStateTpm: quicksight.CfnDashboard.VisualProperty = {
    kpiVisual: {
      visualId: 'sq-kpi-peak-tpm',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Peak State TPM' },
      },
      chartConfiguration: {
        fieldWells: {
          values: [maxField('sq-peak-tpm-val', mds, 'invocationcount')],
          trendGroups: [dateDimField('sq-peak-tpm-trend', mds, 'timestamp', 'MINUTE')],
        },
      },
    },
  };

  // ── KPI 6: Peak State RPM (MAX invocationcount from Metrics) ───────────────
  const kpiPeakStateRpm: quicksight.CfnDashboard.VisualProperty = {
    kpiVisual: {
      visualId: 'sq-kpi-peak-rpm',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Peak State RPM' },
      },
      chartConfiguration: {
        fieldWells: {
          values: [maxField('sq-peak-rpm-val', mds, 'invocationcount')],
          trendGroups: [dateDimField('sq-peak-rpm-trend', mds, 'timestamp', 'MINUTE')],
        },
      },
    },
  };

  // ── KPI 7: Avg Input Tokens ───────────────────────────────────────────────────
  const kpiAvgInputTokens: quicksight.CfnDashboard.VisualProperty = {
    kpiVisual: {
      visualId: 'sq-kpi-avg-input-tokens',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Avg Input Tokens' },
      },
      chartConfiguration: {
        fieldWells: {
          values: [avgField('sq-avg-input-tokens-val', ds, 'inputtokens')],
        },
      },
    },
  };

  // ── KPI 8: Avg Output Tokens ──────────────────────────────────────────────────
  const kpiAvgOutputTokens: quicksight.CfnDashboard.VisualProperty = {
    kpiVisual: {
      visualId: 'sq-kpi-avg-output-tokens',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'Avg Output Tokens' },
      },
      chartConfiguration: {
        fieldWells: {
          values: [avgField('sq-avg-output-tokens-val', ds, 'outputtokens')],
        },
      },
    },
  };

  // ── Dual-axis line chart: TPM (left) + RPM (right) over time ─────────────────
  // Reference lines for steady state (AVG) and peak (MAX) values
  const tpmRpmLineChart: quicksight.CfnDashboard.VisualProperty = {
    lineChartVisual: {
      visualId: 'sq-tpm-rpm-line',
      title: {
        visibility: 'VISIBLE',
        formatText: { plainText: 'TPM & RPM Over Time' },
      },
      chartConfiguration: {
        fieldWells: {
          lineChartAggregatedFieldWells: {
            category: [dateDimField('sq-line-time', ds, 'timestamp', 'MINUTE')],
            values: [
              sumField('sq-line-tpm', ds, 'totaltokens'),
              numericCountField('sq-line-rpm', ds, 'requestid'),
            ],
          },
        },
        type: 'LINE',
        dataLabels: { visibility: 'HIDDEN' },
        legend: { visibility: 'VISIBLE' },
        // Assign RPM to secondary (right) axis
        series: [
          {
            fieldSeriesItem: {
              fieldId: 'sq-line-rpm',
              axisBinding: 'SECONDARY_YAXIS',
            },
          },
        ],
        // Reference lines: steady state (AVG) and peak (MAX) for TPM
        referenceLines: [
          {
            status: 'ENABLED',
            dataConfiguration: {
              dynamicConfiguration: {
                column: col(ds, 'totaltokens'),
                calculation: {
                  simpleNumericalAggregation: 'AVERAGE',
                },
              },
            },
            styleConfiguration: {
              pattern: 'DASHED',
              color: '#2CAD00',
            },
            labelConfiguration: {
              customLabelConfiguration: {
                customLabel: 'Steady State TPM',
              },
              fontConfiguration: { fontWeight: { name: 'NORMAL' } },
              horizontalPosition: 'LEFT',
              verticalPosition: 'ABOVE',
            },
          },
          {
            status: 'ENABLED',
            dataConfiguration: {
              dynamicConfiguration: {
                column: col(ds, 'totaltokens'),
                calculation: {
                  simpleNumericalAggregation: 'MAX',
                },
              },
            },
            styleConfiguration: {
              pattern: 'DASHED',
              color: '#DE3B00',
            },
            labelConfiguration: {
              customLabelConfiguration: {
                customLabel: 'Peak State TPM',
              },
              fontConfiguration: { fontWeight: { name: 'NORMAL' } },
              horizontalPosition: 'LEFT',
              verticalPosition: 'ABOVE',
            },
          },
        ],
      },
    },
  };

  return {
    sheet: {
      sheetId: 'service-quota-prep',
      name: 'Service Quota Prep',
      visuals: [
        kpiOutputModalities,
        kpiSteadyStateTpm,
        kpiSteadyStateRpm,
        kpiPeakStateTpm,
        kpiPeakStateRpm,
        kpiAvgInputTokens,
        kpiAvgOutputTokens,
        tpmRpmLineChart,
      ],
      filterControls: [],
      parameterControls: [modelDropdownControl, timeStartControl, timeEndControl],
    },
    filterGroups: [filterGroup],
  };
}

// ── Sheet definitions ─────────────────────────────────────────────────────────

export interface SheetDefinitionsResult {
  sheets: quicksight.CfnDashboard.SheetDefinitionProperty[];
  filterGroups: quicksight.CfnDashboard.FilterGroupProperty[];
}

/**
 * Builds the 4-sheet scaffold for the CfnDashboard Definition.
 *
 * Sheet 1 (Executive Summary) is fully populated by buildExecutiveSummarySheet.
 * Tasks 6.4–6.6 will populate the remaining sheets.
 *
 * Returns both sheets and filterGroups (which must be placed at the
 * DashboardVersionDefinitionProperty level, not the sheet level).
 */
export function buildSheetDefinitions(
  params: SheetDefinitionsParams,
): SheetDefinitionsResult {
  const execResult = buildExecutiveSummarySheet(params);
  const costUsageResult = buildCostUsageSheet(params);
  const performanceResult = buildPerformanceSheet(params);
  const serviceQuotaResult = buildServiceQuotaSheet(params);

  return {
    sheets: [
      execResult.sheet,
      costUsageResult.sheet,
      performanceResult.sheet,
      serviceQuotaResult.sheet,
    ],
    filterGroups: [
      ...execResult.filterGroups,
      ...costUsageResult.filterGroups,
      ...performanceResult.filterGroups,
      ...serviceQuotaResult.filterGroups,
    ],
  };
}
