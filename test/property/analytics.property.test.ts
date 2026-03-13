/**
 * Property-based tests for Analytics Layer computations.
 * Feature: bedrock-usage-intelligence
 *
 * Properties covered:
 *   Property 23: Trend analysis computation
 *   Property 24: Efficiency metrics computation
 */

import * as fc from 'fast-check';

// ── Analytics computation functions ──────────────────────────────────────────
// These functions implement the analytics layer computation logic.

/**
 * Compute week-over-week growth rate.
 * Returns 0 when previousWeek is 0 to avoid division by zero.
 */
function computeWeekOverWeekGrowth(currentWeek: number, previousWeek: number): number {
  if (previousWeek === 0) return 0;
  return (currentWeek - previousWeek) / previousWeek;
}

/**
 * Compute month-over-month growth rate.
 * Returns 0 when previousMonth is 0 to avoid division by zero.
 */
function computeMonthOverMonthGrowth(currentMonth: number, previousMonth: number): number {
  if (previousMonth === 0) return 0;
  return (currentMonth - previousMonth) / previousMonth;
}

/**
 * Compute average tokens per invocation.
 * Returns 0 when invocationCount is 0 to avoid division by zero.
 */
function computeAverageTokensPerInvocation(totalTokens: number, invocationCount: number): number {
  if (invocationCount === 0) return 0;
  return totalTokens / invocationCount;
}

/**
 * Compute cost per token.
 * Returns 0 when totalTokens is 0 to avoid division by zero.
 */
function computeCostPerToken(totalCost: number, totalTokens: number): number {
  if (totalTokens === 0) return 0;
  return totalCost / totalTokens;
}

/** Represents a single day's usage data point */
interface DailyUsage {
  date: Date;
  tokens: number;
  invocations: number;
  cost: number;
}

/**
 * Aggregate daily usage into weekly totals.
 * Week 0 = oldest week, week N = most recent week.
 */
function aggregateByWeek(dailyData: DailyUsage[]): number[] {
  if (dailyData.length === 0) return [];
  const sorted = [...dailyData].sort((a, b) => a.date.getTime() - b.date.getTime());
  const weeks: number[] = [];
  for (let i = 0; i < sorted.length; i += 7) {
    const weekSlice = sorted.slice(i, i + 7);
    weeks.push(weekSlice.reduce((sum, d) => sum + d.tokens, 0));
  }
  return weeks;
}

/**
 * Aggregate daily usage into monthly totals.
 */
function aggregateByMonth(dailyData: DailyUsage[]): Map<string, number> {
  const months = new Map<string, number>();
  for (const day of dailyData) {
    const key = `${day.date.getFullYear()}-${String(day.date.getMonth() + 1).padStart(2, '0')}`;
    months.set(key, (months.get(key) ?? 0) + day.tokens);
  }
  return months;
}

// ── Arbitraries ───────────────────────────────────────────────────────────────

/** Non-negative integer token count */
const tokenCount = fc.integer({ min: 0, max: 1_000_000 });

/** Non-negative float cost */
const cost = fc.float({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true });

/** Positive integer invocation count */
const positiveInvocationCount = fc.integer({ min: 1, max: 10_000 });

/** Non-negative integer usage value (for week/month aggregates) */
const usageValue = fc.integer({ min: 0, max: 1_000_000 });

/** Positive usage value (non-zero previous period) */
const positiveUsageValue = fc.integer({ min: 1, max: 1_000_000 });

/** Generate a time-series of daily usage spanning at least 14 days (two weeks) */
const twoWeekTimeSeries = fc
  .integer({ min: 14, max: 60 })
  .chain((numDays) => {
    const baseDate = new Date('2024-01-01');
    return fc.array(
      fc.record({
        tokens: tokenCount,
        invocations: fc.integer({ min: 0, max: 1000 }),
        cost,
      }),
      { minLength: numDays, maxLength: numDays },
    ).map((days) =>
      days.map((d, i) => ({
        date: new Date(baseDate.getTime() + i * 24 * 60 * 60 * 1000),
        tokens: d.tokens,
        invocations: d.invocations,
        cost: d.cost,
      })),
    );
  });

// ── Property 23: Trend analysis computation ───────────────────────────────────

describe('Property 23: Trend analysis computation', () => {
  // Feature: bedrock-usage-intelligence, Property 23: Trend analysis computation
  // Validates: Requirements 10.4

  it('week-over-week growth rate = (currentWeek - previousWeek) / previousWeek', () => {
    fc.assert(
      fc.property(usageValue, positiveUsageValue, (current, previous) => {
        const rate = computeWeekOverWeekGrowth(current, previous);
        const expected = (current - previous) / previous;
        expect(rate).toBeCloseTo(expected, 10);
      }),
      { numRuns: 25 },
    );
  });

  it('week-over-week growth is 0 when previous week is 0', () => {
    fc.assert(
      fc.property(usageValue, (current) => {
        const rate = computeWeekOverWeekGrowth(current, 0);
        expect(rate).toBe(0);
      }),
      { numRuns: 25 },
    );
  });

  it('week-over-week growth is positive when current > previous', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (a, b) => {
          const current = Math.max(a, b) + 1;
          const previous = Math.min(a, b);
          if (previous === 0) return; // skip zero previous
          const rate = computeWeekOverWeekGrowth(current, previous);
          expect(rate).toBeGreaterThan(0);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('week-over-week growth is negative when current < previous', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (a, b) => {
          const current = Math.min(a, b);
          const previous = Math.max(a, b) + 1;
          const rate = computeWeekOverWeekGrowth(current, previous);
          expect(rate).toBeLessThan(0);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('week-over-week growth is 0 when current equals previous', () => {
    fc.assert(
      fc.property(positiveUsageValue, (value) => {
        const rate = computeWeekOverWeekGrowth(value, value);
        expect(rate).toBeCloseTo(0, 10);
      }),
      { numRuns: 25 },
    );
  });

  it('month-over-month growth rate = (currentMonth - previousMonth) / previousMonth', () => {
    fc.assert(
      fc.property(usageValue, positiveUsageValue, (current, previous) => {
        const rate = computeMonthOverMonthGrowth(current, previous);
        const expected = (current - previous) / previous;
        expect(rate).toBeCloseTo(expected, 10);
      }),
      { numRuns: 25 },
    );
  });

  it('month-over-month growth is 0 when previous month is 0', () => {
    fc.assert(
      fc.property(usageValue, (current) => {
        const rate = computeMonthOverMonthGrowth(current, 0);
        expect(rate).toBe(0);
      }),
      { numRuns: 25 },
    );
  });

  it('time-series spanning at least two weeks produces at least two weekly aggregates', () => {
    fc.assert(
      fc.property(twoWeekTimeSeries, (series) => {
        expect(series.length).toBeGreaterThanOrEqual(14);
        const weeks = aggregateByWeek(series);
        expect(weeks.length).toBeGreaterThanOrEqual(2);
      }),
      { numRuns: 25 },
    );
  });

  it('week-over-week growth computed from time-series matches formula', () => {
    fc.assert(
      fc.property(twoWeekTimeSeries, (series) => {
        const weeks = aggregateByWeek(series);
        if (weeks.length < 2) return;

        const previousWeek = weeks[weeks.length - 2];
        const currentWeek = weeks[weeks.length - 1];
        const rate = computeWeekOverWeekGrowth(currentWeek, previousWeek);

        if (previousWeek === 0) {
          expect(rate).toBe(0);
        } else {
          const expected = (currentWeek - previousWeek) / previousWeek;
          expect(rate).toBeCloseTo(expected, 10);
        }
      }),
      { numRuns: 25 },
    );
  });

  it('month-over-month growth computed from time-series matches formula', () => {
    fc.assert(
      fc.property(twoWeekTimeSeries, (series) => {
        const monthMap = aggregateByMonth(series);
        const monthKeys = [...monthMap.keys()].sort();
        if (monthKeys.length < 2) return;

        const previousMonth = monthMap.get(monthKeys[monthKeys.length - 2]) ?? 0;
        const currentMonth = monthMap.get(monthKeys[monthKeys.length - 1]) ?? 0;
        const rate = computeMonthOverMonthGrowth(currentMonth, previousMonth);

        if (previousMonth === 0) {
          expect(rate).toBe(0);
        } else {
          const expected = (currentMonth - previousMonth) / previousMonth;
          expect(rate).toBeCloseTo(expected, 10);
        }
      }),
      { numRuns: 25 },
    );
  });
});

// ── Property 24: Efficiency metrics computation ───────────────────────────────

describe('Property 24: Efficiency metrics computation', () => {
  // Feature: bedrock-usage-intelligence, Property 24: Efficiency metrics computation
  // Validates: Requirements 10.5

  it('average tokens per invocation = totalTokens / invocationCount', () => {
    fc.assert(
      fc.property(tokenCount, positiveInvocationCount, (total, count) => {
        const avg = computeAverageTokensPerInvocation(total, count);
        const expected = total / count;
        expect(avg).toBeCloseTo(expected, 10);
      }),
      { numRuns: 25 },
    );
  });

  it('average tokens per invocation is 0 when invocationCount is 0', () => {
    fc.assert(
      fc.property(tokenCount, (total) => {
        const avg = computeAverageTokensPerInvocation(total, 0);
        expect(avg).toBe(0);
      }),
      { numRuns: 25 },
    );
  });

  it('average tokens per invocation is non-negative for non-negative inputs', () => {
    fc.assert(
      fc.property(tokenCount, positiveInvocationCount, (total, count) => {
        const avg = computeAverageTokensPerInvocation(total, count);
        expect(avg).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 25 },
    );
  });

  it('average tokens per invocation equals total when invocationCount is 1', () => {
    fc.assert(
      fc.property(tokenCount, (total) => {
        const avg = computeAverageTokensPerInvocation(total, 1);
        expect(avg).toBeCloseTo(total, 10);
      }),
      { numRuns: 25 },
    );
  });

  it('cost per token = totalCost / totalTokens', () => {
    fc.assert(
      fc.property(
        cost,
        fc.integer({ min: 1, max: 1_000_000 }),
        (totalCost, totalTokens) => {
          const cpt = computeCostPerToken(totalCost, totalTokens);
          const expected = totalCost / totalTokens;
          expect(cpt).toBeCloseTo(expected, 10);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('cost per token is 0 when totalTokens is 0', () => {
    fc.assert(
      fc.property(cost, (totalCost) => {
        const cpt = computeCostPerToken(totalCost, 0);
        expect(cpt).toBe(0);
      }),
      { numRuns: 25 },
    );
  });

  it('cost per token is non-negative for non-negative inputs', () => {
    fc.assert(
      fc.property(
        cost,
        fc.integer({ min: 1, max: 1_000_000 }),
        (totalCost, totalTokens) => {
          const cpt = computeCostPerToken(totalCost, totalTokens);
          expect(cpt).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('cost per token equals totalCost when totalTokens is 1', () => {
    fc.assert(
      fc.property(cost, (totalCost) => {
        const cpt = computeCostPerToken(totalCost, 1);
        expect(cpt).toBeCloseTo(totalCost, 10);
      }),
      { numRuns: 25 },
    );
  });

  it('efficiency metrics computed from a set of invocations match formulas', () => {
    /** Invocation record with token counts and cost */
    const invocationArb = fc.record({
      inputTokens: tokenCount,
      outputTokens: tokenCount,
      totalCost: cost,
    });

    fc.assert(
      fc.property(
        fc.array(invocationArb, { minLength: 1, maxLength: 100 }),
        (invocations) => {
          const totalTokens = invocations.reduce(
            (sum, inv) => sum + inv.inputTokens + inv.outputTokens,
            0,
          );
          const totalCost = invocations.reduce((sum, inv) => sum + inv.totalCost, 0);
          const invocationCount = invocations.length;

          const avgTokens = computeAverageTokensPerInvocation(totalTokens, invocationCount);
          const cpt = computeCostPerToken(totalCost, totalTokens);

          // Verify formulas
          expect(avgTokens).toBeCloseTo(totalTokens / invocationCount, 8);
          if (totalTokens > 0) {
            expect(cpt).toBeCloseTo(totalCost / totalTokens, 8);
          } else {
            expect(cpt).toBe(0);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
