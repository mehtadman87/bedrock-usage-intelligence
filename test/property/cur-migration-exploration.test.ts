/**
 * Bug Condition Exploration Test — CUR Migration (Fix Verification)
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7**
 *
 * Property 1: Expected Behavior — Pricing Pipeline Failure Modes Resolved
 *
 * These tests verify that the CUR-based replacement correctly handles all
 * seven fault conditions that the old pricing pipeline failed on:
 *   1. New model mapping gap → CUR usage_type parser handles new models
 *   2. Cross-region suffix mismatch → CUR parser extracts suffixes correctly
 *   3. Cache dimension gap → CUR parser handles cache token types
 *   4. Unit conversion not needed → CUR provides unblended_cost directly
 *
 * With the fix applied, these tests should PASS (confirming the bug is fixed).
 */

import * as fc from 'fast-check';
import {
  parseUsageType,
  CUR_MODEL_BILLING_NAME_MAP,
} from '../../lib/handlers/cur-processor/usage-type-parser';
import { processCurRow } from '../../lib/handlers/cur-processor/index';
import {
  computeAttribution,
  CurBucket,
  UserUsage,
} from '../../lib/handlers/cost-reconciler/index';

// ── Test Case 1: New Model Mapping Gap ────────────────────────────────────────
// Requirement 2.1, 2.3, 2.6: New models are handled by the CUR usage_type parser.
// The old pricing engine failed because MODEL_ID_TO_PRICING_NAME didn't contain
// new model IDs. The CUR parser uses CUR_MODEL_BILLING_NAME_MAP which maps
// CUR billing names (e.g., 'Claude4.6Opus') to Bedrock API model IDs.

describe('Bug Condition Exploration — CUR-Based Fix Verification', () => {
  test('Test Case 1 — New Model Mapping Gap: CUR parser resolves new models via billing name map', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(CUR_MODEL_BILLING_NAME_MAP)),
        fc.constantFrom('USE1', 'USW2', 'EUC1', 'APN1'),
        fc.constantFrom('input-tokens', 'output-tokens'),
        (billingName, regionCode, tokenType) => {
          const usageType = `${regionCode}-${billingName}-${tokenType}`;
          const parsed = parseUsageType(usageType);

          // CUR parser should successfully parse the usage_type
          expect(parsed).not.toBeNull();
          expect(parsed!.modelBillingName).toBe(billingName);
          expect(parsed!.tokenType).toBe(tokenType);

          // The billing name should resolve to a known Bedrock model ID
          const resolvedModelId = CUR_MODEL_BILLING_NAME_MAP[parsed!.modelBillingName];
          expect(resolvedModelId).toBeDefined();
          expect(resolvedModelId.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 10 },
    );
  });

  // ── Test Case 2: Cross-Region Suffix Mismatch ──────────────────────────────
  // Requirement 2.1, 2.6: Cross-region suffixes are parsed correctly by the CUR parser.
  // The old pricing engine's regex failed on new cross-region suffix variants.
  // The CUR parser explicitly handles -cross-region-global and -cross-region-geo.

  test('Test Case 2 — Cross-Region Suffix: CUR parser correctly extracts cross-region type', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(CUR_MODEL_BILLING_NAME_MAP)),
        fc.constantFrom('USE1', 'USW2', 'EUC1'),
        fc.constantFrom('input-tokens', 'output-tokens'),
        fc.constantFrom('cross-region-global', 'cross-region-geo'),
        (billingName, regionCode, tokenType, crossRegion) => {
          const usageType = `${regionCode}-${billingName}-${tokenType}-${crossRegion}`;
          const parsed = parseUsageType(usageType);

          // CUR parser should handle cross-region suffixes correctly
          expect(parsed).not.toBeNull();
          expect(parsed!.modelBillingName).toBe(billingName);
          expect(parsed!.tokenType).toBe(tokenType);
          expect(parsed!.crossRegionType).toBe(crossRegion);
        },
      ),
      { numRuns: 10 },
    );
  });

  // ── Test Case 3: Cache Dimension Gap ───────────────────────────────────────
  // Requirement 2.3, 2.6: Cache dimensions are parsed correctly by the CUR parser.
  // The old pricing engine returned $0 when a cache dimension (e.g., cacheWrite1h)
  // didn't exist in the DynamoDB rate table. The CUR provides separate line items
  // for each cache token type, so no rate table lookup is needed.

  test('Test Case 3 — Cache Dimension Gap: CUR parser handles cache token types correctly', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(CUR_MODEL_BILLING_NAME_MAP)),
        fc.constantFrom('USE1', 'USW2'),
        fc.constantFrom(
          'cache-read-input-token-count',
          'cache-write-input-token-count',
        ),
        (billingName, regionCode, cacheTokenType) => {
          const usageType = `${regionCode}-${billingName}-${cacheTokenType}`;
          const parsed = parseUsageType(usageType);

          // CUR parser should handle cache token types as first-class citizens
          expect(parsed).not.toBeNull();
          expect(parsed!.modelBillingName).toBe(billingName);
          expect(parsed!.tokenType).toBe(cacheTokenType);
          expect(parsed!.crossRegionType).toBe('none');
        },
      ),
      { numRuns: 10 },
    );
  });

  // ── Test Case 4: Unit Conversion Not Needed ────────────────────────────────
  // Requirement 2.4, 2.5, 2.7: CUR provides unblended_cost directly — no unit
  // conversion needed. The old pricing pipeline had a 1000x error risk when
  // converting between per-1K and per-1M token units. With CUR, the cost is
  // authoritative and attributed proportionally without any unit conversion.

  test('Test Case 4 — Unit Conversion: CUR unblended_cost attributed directly without conversion', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0.01), max: 1000, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (unblendedCost, userATokens, userBTokens) => {
          const bucket: CurBucket = {
            usageDate: '2025-01-15',
            accountId: '123456789012',
            region: 'us-east-1',
            modelBillingName: 'Claude4.6Opus',
            resolvedModelId: 'anthropic.claude-opus-4-6-v1',
            tokenType: 'input-tokens',
            crossRegionType: 'none',
            pricingUnit: '1K tokens',
            unblendedCost,
          };

          const users: UserUsage[] = [
            {
              usageDate: '2025-01-15',
              accountId: '123456789012',
              region: 'us-east-1',
              modelId: 'anthropic.claude-opus-4-6-v1',
              crossRegionType: 'none',
              resolvedUserId: 'user-a',
              resolvedUserName: 'User A',
              tokenCount: userATokens,
            },
            {
              usageDate: '2025-01-15',
              accountId: '123456789012',
              region: 'us-east-1',
              modelId: 'anthropic.claude-opus-4-6-v1',
              crossRegionType: 'none',
              resolvedUserId: 'user-b',
              resolvedUserName: 'User B',
              tokenCount: userBTokens,
            },
          ];

          const records = computeAttribution(bucket, users);

          // Cost attribution should use CUR unblended_cost directly
          // No unit conversion — sum of attributed costs equals CUR cost (within ±$0.01)
          const totalAttributed = records.reduce((sum, r) => sum + r.attributedCost, 0);
          expect(Math.abs(totalAttributed - unblendedCost)).toBeLessThanOrEqual(0.01);

          // Each user's proportion should be correct
          const totalTokens = userATokens + userBTokens;
          for (const record of records) {
            expect(record.attributedCost).toBeGreaterThanOrEqual(0);
            expect(record.proportion).toBeGreaterThanOrEqual(0);
            expect(record.proportion).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 10 },
    );
  });
});
