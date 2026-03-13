/**
 * Property-Based Tests — Proportional Cost Attribution
 *
 * **Validates: Requirements 2.4, 2.7**
 *
 * Property 2: Fault Condition — Proportional Cost Attribution Correctness
 *
 * For any reconciliation bucket (account, region, model, token_type, cross_region_type, day)
 * where CUR data exists, the sum of all users' attributed_cost values SHALL equal the CUR
 * unblended_cost for that bucket (within ±$0.01 tolerance), and each user's attributed cost
 * SHALL equal (user_tokens / total_tokens_in_bucket) × cur_unblended_cost.
 *
 * Properties tested:
 * 1. Sum of attributed costs equals CUR unblended_cost (within ±$0.01)
 * 2. Each user's proportion is in [0, 1]
 * 3. Zero tokens yields zero cost
 * 4. Single-user bucket attributes 100% of CUR cost to that user
 */

import * as fc from 'fast-check';
import {
  computeAttribution,
  CurBucket,
  UserUsage,
} from 'lib/handlers/cost-reconciler/index';
import { CurTokenType, CurCrossRegionType } from 'lib/shared/cur-types';

// ─── Generators ───────────────────────────────────────────────────────────────

const tokenTypeArb: fc.Arbitrary<CurTokenType> = fc.constantFrom(
  'input-tokens',
  'output-tokens',
  'cache-read-input-token-count',
  'cache-write-input-token-count',
);

const crossRegionTypeArb: fc.Arbitrary<CurCrossRegionType> = fc.constantFrom(
  'none',
  'cross-region-global',
  'cross-region-geo',
);

const usageDateArb = fc.date({
  min: new Date('2024-01-01'),
  max: new Date('2026-12-31'),
}).map((d) => d.toISOString().slice(0, 10));

const accountIdArb = fc.stringOf(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'), {
  minLength: 12,
  maxLength: 12,
});

const regionArb = fc.constantFrom(
  'us-east-1', 'us-west-2', 'eu-west-1', 'ap-northeast-1',
);

const modelBillingNameArb = fc.constantFrom(
  'Claude4.6Opus', 'Claude3.5Sonnet', 'NovaPro', 'NovaMicro', 'TitanText',
);

const modelIdArb = fc.constantFrom(
  'anthropic.claude-opus-4-6-v1',
  'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'amazon.nova-pro-v1:0',
  'amazon.nova-micro-v1:0',
  'amazon.titan-text-express-v1',
);

/**
 * Generates a CurBucket with a positive unblended cost.
 * Cost range: $0.001 to $100,000 to cover sub-cent through large enterprise costs.
 */
function curBucketArb(): fc.Arbitrary<CurBucket> {
  return fc.record({
    usageDate: usageDateArb,
    accountId: accountIdArb,
    region: regionArb,
    modelBillingName: modelBillingNameArb,
    resolvedModelId: modelIdArb,
    tokenType: tokenTypeArb,
    crossRegionType: crossRegionTypeArb,
    pricingUnit: fc.constant('1K tokens'),
    unblendedCost: fc.double({ min: 0.001, max: 100_000, noNaN: true, noDefaultInfinity: true }),
  });
}

/**
 * Generates a UserUsage with a positive token count.
 */
function userUsageArb(bucket: CurBucket): fc.Arbitrary<UserUsage> {
  return fc.record({
    usageDate: fc.constant(bucket.usageDate),
    accountId: fc.constant(bucket.accountId),
    region: fc.constant(bucket.region),
    modelId: fc.constant(bucket.resolvedModelId),
    crossRegionType: fc.constant(bucket.crossRegionType),
    resolvedUserId: fc.hexaString({ minLength: 8, maxLength: 16 }).map((s) => `user-${s}`),
    resolvedUserName: fc.hexaString({ minLength: 4, maxLength: 8 }),
    tokenCount: fc.integer({ min: 1, max: 10_000_000 }),
  });
}

/**
 * Generates a UserUsage with zero tokens.
 */
function zeroTokenUserArb(bucket: CurBucket): fc.Arbitrary<UserUsage> {
  return fc.record({
    usageDate: fc.constant(bucket.usageDate),
    accountId: fc.constant(bucket.accountId),
    region: fc.constant(bucket.region),
    modelId: fc.constant(bucket.resolvedModelId),
    crossRegionType: fc.constant(bucket.crossRegionType),
    resolvedUserId: fc.hexaString({ minLength: 8, maxLength: 16 }).map((s) => `user-${s}`),
    resolvedUserName: fc.hexaString({ minLength: 4, maxLength: 8 }),
    tokenCount: fc.constant(0),
  });
}

// ─── Properties ───────────────────────────────────────────────────────────────

describe('Property-Based Tests — Proportional Cost Attribution', () => {
  /**
   * Property 1: Sum Conservation
   *
   * For any reconciliation bucket with multiple users, the sum of all users'
   * attributed_cost equals the CUR unblended_cost within ±$0.01 tolerance.
   *
   * **Validates: Requirements 2.4, 2.7**
   */
  test('sum of attributed costs equals CUR unblended_cost (within ±$0.01)', () => {
    fc.assert(
      fc.property(
        curBucketArb().chain((bucket) =>
          fc.tuple(
            fc.constant(bucket),
            fc.array(userUsageArb(bucket), { minLength: 1, maxLength: 20 }),
          ),
        ),
        ([bucket, users]) => {
          const records = computeAttribution(bucket, users);
          const totalAttributed = records.reduce((sum, r) => sum + r.attributedCost, 0);

          expect(Math.abs(totalAttributed - bucket.unblendedCost)).toBeLessThanOrEqual(0.01);
        },
      ),
      { numRuns: 25 },
    );
  });

  /**
   * Property 2: Proportion Bounds
   *
   * Each user's proportion is in [0, 1] for any reconciliation bucket.
   *
   * **Validates: Requirements 2.4, 2.7**
   */
  test('each user proportion is in [0, 1]', () => {
    fc.assert(
      fc.property(
        curBucketArb().chain((bucket) =>
          fc.tuple(
            fc.constant(bucket),
            fc.array(userUsageArb(bucket), { minLength: 1, maxLength: 20 }),
          ),
        ),
        ([bucket, users]) => {
          const records = computeAttribution(bucket, users);

          for (const record of records) {
            expect(record.proportion).toBeGreaterThanOrEqual(0);
            expect(record.proportion).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  /**
   * Property 3: Zero Tokens Yields Zero Cost
   *
   * When all users in a bucket have zero tokens and the CUR cost is zero,
   * every user gets $0 attributed cost.
   *
   * **Validates: Requirements 2.4, 2.7**
   */
  test('zero tokens with zero cost yields zero attributed cost', () => {
    fc.assert(
      fc.property(
        curBucketArb()
          .map((b) => ({ ...b, unblendedCost: 0 }))
          .chain((bucket) =>
            fc.tuple(
              fc.constant(bucket),
              fc.array(zeroTokenUserArb(bucket), { minLength: 1, maxLength: 10 }),
            ),
          ),
        ([bucket, users]) => {
          const records = computeAttribution(bucket, users);

          for (const record of records) {
            expect(record.attributedCost).toBe(0);
          }
        },
      ),
      { numRuns: 15 },
    );
  });

  /**
   * Property 4: Single-User Full Attribution
   *
   * A single-user bucket attributes 100% of CUR cost to that user.
   *
   * **Validates: Requirements 2.4, 2.7**
   */
  test('single-user bucket attributes 100% of CUR cost to that user', () => {
    fc.assert(
      fc.property(
        curBucketArb().chain((bucket) =>
          fc.tuple(fc.constant(bucket), userUsageArb(bucket)),
        ),
        ([bucket, user]) => {
          const records = computeAttribution(bucket, [user]);

          expect(records).toHaveLength(1);
          expect(records[0].attributedCost).toBeCloseTo(bucket.unblendedCost, 2);
          expect(records[0].proportion).toBeCloseTo(1.0, 5);
        },
      ),
      { numRuns: 25 },
    );
  });
});
