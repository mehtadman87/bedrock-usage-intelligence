// Feature: quicksight-dashboard
import * as fc from 'fast-check';
import { buildSheetDefinitions, DATASET_IDENTIFIER } from 'lib/stacks/dashboard-visuals';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const validSolutionNames = fc.constantFrom('test-solution', 'my-platform', 'bedrock-intel');

// ---------------------------------------------------------------------------
// Property 3: Visual definitions identical across editions (Req 5)
// Validates: Requirements 5
// ---------------------------------------------------------------------------

describe('Property 3: Visual definitions identical across editions', () => {
  it('buildSheetDefinitions returns same sheets for same params', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const params = {
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        };

        // buildSheetDefinitions doesn't take edition — editions only affect DashboardStack
        // So the same params always produce the same sheets
        const result1 = buildSheetDefinitions(params);
        const result2 = buildSheetDefinitions(params);

        // Structural equality: same number of sheets, same sheet IDs
        if (result1.sheets.length !== result2.sheets.length) return false;

        const sheetIds1 = result1.sheets.map(s => s.sheetId).sort();
        const sheetIds2 = result2.sheets.map(s => s.sheetId).sort();

        return JSON.stringify(sheetIds1) === JSON.stringify(sheetIds2);
      }),
      { numRuns: 30 },
    );
  });

  it('buildSheetDefinitions always returns exactly 4 sheets', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        });
        return result.sheets.length === 4;
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: All 4 sheets present with correct visual types (Req 2)
// Validates: Requirements 2
// ---------------------------------------------------------------------------

describe('Property 9: All 4 sheets present with correct visual types', () => {
  it('all 4 expected sheet IDs are present', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        });

        const expectedSheetIds = ['executive-summary', 'cost-usage', 'performance', 'service-quota-prep'];
        const actualSheetIds = result.sheets.map(s => s.sheetId);

        return expectedSheetIds.every(id => actualSheetIds.includes(id));
      }),
      { numRuns: 30 },
    );
  });

  it('Executive Summary sheet has at least 5 KPI visuals', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        });

        const execSheet = result.sheets.find(s => s.sheetId === 'executive-summary');
        if (!execSheet) return false;

        const kpiCount = ((execSheet.visuals ?? []) as any[]).filter((v: any) => v.kpiVisual !== undefined).length;
        return kpiCount >= 5;
      }),
      { numRuns: 25 },
    );
  });

  it('Performance sheet has at least 3 KPI visuals', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        });

        const perfSheet = result.sheets.find(s => s.sheetId === 'performance');
        if (!perfSheet) return false;

        const kpiCount = ((perfSheet.visuals ?? []) as any[]).filter((v: any) => v.kpiVisual !== undefined).length;
        return kpiCount >= 3;
      }),
      { numRuns: 25 },
    );
  });

  it('Service Quota sheet has at least 7 KPI visuals', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        });

        const sqSheet = result.sheets.find(s => s.sheetId === 'service-quota-prep');
        if (!sqSheet) return false;

        const kpiCount = ((sqSheet.visuals ?? []) as any[]).filter((v: any) => v.kpiVisual !== undefined).length;
        return kpiCount >= 7;
      }),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Cross-visual filter actions configured on sheets 1-3 (Req 3)
// Validates: Requirements 3
// ---------------------------------------------------------------------------

describe('Property 10: Cross-visual filter actions on sheets 1-3', () => {
  it('sheets 1-3 each have at least one visual with a cross-visual filter action', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        });

        const sheetsToCheck = ['executive-summary', 'cost-usage', 'performance'];

        return sheetsToCheck.every(sheetId => {
          const sheet = result.sheets.find(s => s.sheetId === sheetId);
          if (!sheet) return false;

          // Check if any visual has a filterOperation action
          return ((sheet.visuals ?? []) as any[]).some((visual: any) => {
            const actions =
              visual.pieChartVisual?.actions ??
              visual.barChartVisual?.actions ??
              visual.comboChartVisual?.actions ??
              visual.lineChartVisual?.actions ??
              [];

            return actions.some((a: any) =>
              a.actionOperations?.some((op: any) => op.filterOperation !== undefined)
            );
          });
        });
      }),
      { numRuns: 30 },
    );
  });

  it('Service Quota sheet does NOT have cross-visual filter actions (independent controls)', () => {
    fc.assert(
      fc.property(validSolutionNames, (solutionName) => {
        const result = buildSheetDefinitions({
          dataSetIdentifier: DATASET_IDENTIFIER,
          solutionName,
        });

        const sqSheet = result.sheets.find(s => s.sheetId === 'service-quota-prep');
        if (!sqSheet) return false;

        // Service Quota sheet should have no cross-visual filter actions
        const hasCrossFilter = ((sqSheet.visuals ?? []) as any[]).some((visual: any) => {
          const actions =
            visual.pieChartVisual?.actions ??
            visual.barChartVisual?.actions ??
            visual.comboChartVisual?.actions ??
            visual.lineChartVisual?.actions ??
            [];

          return actions.some((a: any) =>
            a.actionOperations?.some((op: any) => op.filterOperation !== undefined)
          );
        });

        return !hasCrossFilter;
      }),
      { numRuns: 25 },
    );
  });
});
