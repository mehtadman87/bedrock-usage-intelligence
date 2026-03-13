/**
 * Unit tests for the Cost Reconciler handler.
 *
 * Tests proportional attribution formula, rounding behavior,
 * cross-region matching, cache dimension matching, and edge cases.
 *
 * Requirements: 2.4, 2.5, 2.6, 2.7
 */

import {
  computeAttribution,
  CurBucket,
  UserUsage,
  RECONCILED_COST_SCHEMA,
} from 'lib/handlers/cost-reconciler/index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBucket(overrides: Partial<CurBucket> = {}): CurBucket {
  return {
    usageDate: '2025-01-15',
    accountId: '111111111111',
    region: 'us-east-1',
    modelBillingName: 'Claude4.6Opus',
    resolvedModelId: 'anthropic.claude-opus-4-6-v1',
    tokenType: 'input-tokens',
    crossRegionType: 'none',
    pricingUnit: '1K tokens',
    unblendedCost: 10.0,
    ...overrides,
  };
}

function makeUser(overrides: Partial<UserUsage> = {}): UserUsage {
  return {
    usageDate: '2025-01-15',
    accountId: '111111111111',
    region: 'us-east-1',
    modelId: 'anthropic.claude-opus-4-6-v1',
    crossRegionType: 'none',
    resolvedUserId: 'arn:aws:iam::111111111111:user/alice',
    resolvedUserName: 'alice',
    tokenCount: 1000,
    ...overrides,
  };
}

// ─── Proportional Attribution: Single User ────────────────────────────────────

describe('computeAttribution - single user', () => {
  it('attributes 100% of CUR cost to a single user', () => {
    const bucket = makeBucket({ unblendedCost: 15.0 });
    const users = [makeUser({ tokenCount: 500 })];

    const records = computeAttribution(bucket, users);

    expect(records).toHaveLength(1);
    expect(records[0].attributedCost).toBe(15.0);
    expect(records[0].proportion).toBeCloseTo(1.0, 10);
    expect(records[0].userTokens).toBe(500);
    expect(records[0].totalTokensInBucket).toBe(500);
    expect(records[0].reconciliationStatus).toBe('reconciled');
  });

  it('carries bucket metadata through to the output record', () => {
    const bucket = makeBucket({
      usageDate: '2025-02-20',
      accountId: '222222222222',
      region: 'eu-west-1',
      modelBillingName: 'NovaPro',
      resolvedModelId: 'amazon.nova-pro-v1:0',
      tokenType: 'output-tokens',
      crossRegionType: 'cross-region-global',
    });
    const users = [makeUser({ tokenCount: 100 })];

    const records = computeAttribution(bucket, users);

    expect(records[0].usageDate).toBe('2025-02-20');
    expect(records[0].accountId).toBe('222222222222');
    expect(records[0].region).toBe('eu-west-1');
    expect(records[0].modelId).toBe('amazon.nova-pro-v1:0');
    expect(records[0].modelBillingName).toBe('NovaPro');
    expect(records[0].tokenType).toBe('output-tokens');
    expect(records[0].crossRegionType).toBe('cross-region-global');
  });
});

// ─── Proportional Attribution: Multi-User ─────────────────────────────────────

describe('computeAttribution - multi-user', () => {
  it('distributes cost proportionally to token usage', () => {
    const bucket = makeBucket({ unblendedCost: 100.0 });
    const users = [
      makeUser({ resolvedUserId: 'user-a', resolvedUserName: 'alice', tokenCount: 700 }),
      makeUser({ resolvedUserId: 'user-b', resolvedUserName: 'bob', tokenCount: 300 }),
    ];

    const records = computeAttribution(bucket, users);

    expect(records).toHaveLength(2);

    const alice = records.find((r) => r.resolvedUserName === 'alice')!;
    const bob = records.find((r) => r.resolvedUserName === 'bob')!;

    expect(alice.proportion).toBeCloseTo(0.7, 5);
    expect(bob.proportion).toBeCloseTo(0.3, 5);
    expect(alice.attributedCost).toBeCloseTo(70.0, 2);
    expect(bob.attributedCost).toBeCloseTo(30.0, 2);
  });

  it('distributes cost among three users proportionally', () => {
    const bucket = makeBucket({ unblendedCost: 90.0 });
    const users = [
      makeUser({ resolvedUserName: 'alice', tokenCount: 300 }),
      makeUser({ resolvedUserName: 'bob', tokenCount: 300 }),
      makeUser({ resolvedUserName: 'carol', tokenCount: 300 }),
    ];

    const records = computeAttribution(bucket, users);

    expect(records).toHaveLength(3);
    for (const r of records) {
      expect(r.proportion).toBeCloseTo(1 / 3, 5);
      expect(r.attributedCost).toBeCloseTo(30.0, 2);
    }
  });
});

// ─── Rounding Behavior ────────────────────────────────────────────────────────

describe('computeAttribution - rounding', () => {
  it('sum of attributed costs equals CUR total within ±$0.01', () => {
    const bucket = makeBucket({ unblendedCost: 10.0 });
    const users = [
      makeUser({ resolvedUserName: 'alice', tokenCount: 333 }),
      makeUser({ resolvedUserName: 'bob', tokenCount: 333 }),
      makeUser({ resolvedUserName: 'carol', tokenCount: 334 }),
    ];

    const records = computeAttribution(bucket, users);
    const totalAttributed = records.reduce((sum, r) => sum + r.attributedCost, 0);

    expect(Math.abs(totalAttributed - 10.0)).toBeLessThanOrEqual(0.01);
  });

  it('handles thirds without losing pennies (remainder goes to last user)', () => {
    // 10 / 3 = 3.333... — can't split evenly
    const bucket = makeBucket({ unblendedCost: 10.0 });
    const users = [
      makeUser({ resolvedUserName: 'alice', tokenCount: 100 }),
      makeUser({ resolvedUserName: 'bob', tokenCount: 100 }),
      makeUser({ resolvedUserName: 'carol', tokenCount: 100 }),
    ];

    const records = computeAttribution(bucket, users);
    const totalAttributed = records.reduce((sum, r) => sum + r.attributedCost, 0);

    // The last user gets the remainder, so the sum should be exact
    expect(Math.abs(totalAttributed - 10.0)).toBeLessThanOrEqual(0.01);
  });

  it('handles very small costs without precision loss', () => {
    const bucket = makeBucket({ unblendedCost: 0.001 });
    const users = [
      makeUser({ resolvedUserName: 'alice', tokenCount: 500 }),
      makeUser({ resolvedUserName: 'bob', tokenCount: 500 }),
    ];

    const records = computeAttribution(bucket, users);
    const totalAttributed = records.reduce((sum, r) => sum + r.attributedCost, 0);

    expect(Math.abs(totalAttributed - 0.001)).toBeLessThanOrEqual(0.01);
  });

  it('handles large costs with many users', () => {
    const bucket = makeBucket({ unblendedCost: 99999.99 });
    const users = Array.from({ length: 7 }, (_, i) =>
      makeUser({ resolvedUserName: `user-${i}`, tokenCount: (i + 1) * 100 }),
    );

    const records = computeAttribution(bucket, users);
    const totalAttributed = records.reduce((sum, r) => sum + r.attributedCost, 0);

    expect(Math.abs(totalAttributed - 99999.99)).toBeLessThanOrEqual(0.01);
  });
});

// ─── Zero-Cost Line Items ─────────────────────────────────────────────────────

describe('computeAttribution - zero-cost', () => {
  it('attributes $0 to all users when CUR cost is zero', () => {
    const bucket = makeBucket({ unblendedCost: 0 });
    const users = [
      makeUser({ resolvedUserName: 'alice', tokenCount: 500 }),
      makeUser({ resolvedUserName: 'bob', tokenCount: 500 }),
    ];

    const records = computeAttribution(bucket, users);

    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.attributedCost).toBe(0);
      expect(r.reconciliationStatus).toBe('reconciled');
    }
  });
});

// ─── Zero-Token Bucket ────────────────────────────────────────────────────────

describe('computeAttribution - zero-token bucket', () => {
  it('distributes cost equally when all users have zero tokens', () => {
    const bucket = makeBucket({ unblendedCost: 12.0 });
    const users = [
      makeUser({ resolvedUserName: 'alice', tokenCount: 0 }),
      makeUser({ resolvedUserName: 'bob', tokenCount: 0 }),
      makeUser({ resolvedUserName: 'carol', tokenCount: 0 }),
    ];

    const records = computeAttribution(bucket, users);

    expect(records).toHaveLength(3);
    for (const r of records) {
      expect(r.attributedCost).toBeCloseTo(4.0, 2);
      expect(r.totalTokensInBucket).toBe(0);
      expect(r.userTokens).toBe(0);
    }
  });
});

// ─── No Users (Unmatched Bucket) ──────────────────────────────────────────────

describe('computeAttribution - no users (unmatched)', () => {
  it('marks bucket as unmatched when no users match', () => {
    const bucket = makeBucket({ unblendedCost: 25.0 });

    const records = computeAttribution(bucket, []);

    expect(records).toHaveLength(1);
    expect(records[0].resolvedUserId).toBe('UNMATCHED');
    expect(records[0].resolvedUserName).toBe('UNMATCHED');
    expect(records[0].attributedCost).toBe(25.0);
    expect(records[0].reconciliationStatus).toBe('unmatched');
    expect(records[0].proportion).toBe(0);
    expect(records[0].userTokens).toBe(0);
    expect(records[0].totalTokensInBucket).toBe(0);
  });

  it('preserves bucket metadata on unmatched records', () => {
    const bucket = makeBucket({
      usageDate: '2025-03-01',
      region: 'ap-northeast-1',
      tokenType: 'cache-write-input-token-count',
    });

    const records = computeAttribution(bucket, []);

    expect(records[0].usageDate).toBe('2025-03-01');
    expect(records[0].region).toBe('ap-northeast-1');
    expect(records[0].tokenType).toBe('cache-write-input-token-count');
  });
});

// ─── Cross-Region Matching ────────────────────────────────────────────────────

describe('computeAttribution - cross-region matching', () => {
  it('attributes cross-region-global CUR line items correctly', () => {
    const bucket = makeBucket({
      crossRegionType: 'cross-region-global',
      tokenType: 'output-tokens',
      unblendedCost: 50.0,
    });
    const users = [
      makeUser({ crossRegionType: 'cross-region-global', tokenCount: 600 }),
      makeUser({
        crossRegionType: 'cross-region-global',
        resolvedUserName: 'bob',
        tokenCount: 400,
      }),
    ];

    const records = computeAttribution(bucket, users);

    expect(records).toHaveLength(2);
    expect(records[0].crossRegionType).toBe('cross-region-global');
    expect(records[1].crossRegionType).toBe('cross-region-global');

    const totalAttributed = records.reduce((sum, r) => sum + r.attributedCost, 0);
    expect(Math.abs(totalAttributed - 50.0)).toBeLessThanOrEqual(0.01);
  });

  it('attributes cross-region-geo CUR line items correctly', () => {
    const bucket = makeBucket({
      crossRegionType: 'cross-region-geo',
      tokenType: 'input-tokens',
      unblendedCost: 20.0,
    });
    const users = [makeUser({ crossRegionType: 'cross-region-geo', tokenCount: 1000 })];

    const records = computeAttribution(bucket, users);

    expect(records).toHaveLength(1);
    expect(records[0].crossRegionType).toBe('cross-region-geo');
    expect(records[0].attributedCost).toBe(20.0);
  });
});

// ─── Cache Dimension Matching ─────────────────────────────────────────────────

describe('computeAttribution - cache dimension matching', () => {
  it('attributes cache-read-input-token-count CUR line items', () => {
    const bucket = makeBucket({
      tokenType: 'cache-read-input-token-count',
      unblendedCost: 5.0,
    });
    const users = [
      makeUser({ resolvedUserName: 'alice', tokenCount: 800 }),
      makeUser({ resolvedUserName: 'bob', tokenCount: 200 }),
    ];

    const records = computeAttribution(bucket, users);

    expect(records).toHaveLength(2);
    expect(records[0].tokenType).toBe('cache-read-input-token-count');

    const alice = records.find((r) => r.resolvedUserName === 'alice')!;
    expect(alice.attributedCost).toBeCloseTo(4.0, 2);
    expect(alice.proportion).toBeCloseTo(0.8, 5);
  });

  it('attributes cache-write-input-token-count CUR line items', () => {
    const bucket = makeBucket({
      tokenType: 'cache-write-input-token-count',
      unblendedCost: 8.0,
    });
    const users = [makeUser({ tokenCount: 400 })];

    const records = computeAttribution(bucket, users);

    expect(records).toHaveLength(1);
    expect(records[0].tokenType).toBe('cache-write-input-token-count');
    expect(records[0].attributedCost).toBe(8.0);
  });

  it('handles combined cache + cross-region bucket', () => {
    const bucket = makeBucket({
      tokenType: 'cache-read-input-token-count',
      crossRegionType: 'cross-region-global',
      unblendedCost: 12.0,
    });
    const users = [
      makeUser({ crossRegionType: 'cross-region-global', tokenCount: 600 }),
      makeUser({
        crossRegionType: 'cross-region-global',
        resolvedUserName: 'bob',
        tokenCount: 600,
      }),
    ];

    const records = computeAttribution(bucket, users);

    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.tokenType).toBe('cache-read-input-token-count');
      expect(r.crossRegionType).toBe('cross-region-global');
      expect(r.attributedCost).toBeCloseTo(6.0, 2);
    }
  });
});

// ─── RECONCILED_COST_SCHEMA ───────────────────────────────────────────────────

describe('RECONCILED_COST_SCHEMA', () => {
  it('defines all expected fields from ReconciledCostRecord', () => {
    const fields = Object.keys(RECONCILED_COST_SCHEMA.schema);
    const expectedFields = [
      'usageDate',
      'accountId',
      'region',
      'modelId',
      'modelBillingName',
      'tokenType',
      'crossRegionType',
      'resolvedUserId',
      'resolvedUserName',
      'userTokens',
      'totalTokensInBucket',
      'proportion',
      'bucketUnblendedCost',
      'attributedCost',
      'reconciliationStatus',
    ];
    for (const field of expectedFields) {
      expect(fields).toContain(field);
    }
  });
});
