// Feature: cur-migration
// Unit tests for config schema changes — Requirements 2.1, 2.2
import { ConfigSchema } from 'lib/config/schema';

// ---------------------------------------------------------------------------
// Minimal valid base config (uses dataExports instead of pricing)
// ---------------------------------------------------------------------------
const base = {
  vpc: { vpcMode: 'create' as const, enableNatGateway: false },
  account: { accountMode: 'single' as const },
  region: { regionMode: 'single' as const },
  identity: { identityMode: 'iam' as const },
  dataExports: { curBucketName: 'my-cur-bucket' },
  dashboard: {},
  cloudTrail: { cloudTrailMode: 'create' as const },
  deployment: {},
};

// ---------------------------------------------------------------------------
// DataExportsConfigSchema required fields
// ---------------------------------------------------------------------------
describe('DataExportsConfigSchema', () => {
  it('accepts valid dataExports with only required curBucketName', () => {
    const result = ConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('rejects dataExports when curBucketName is missing', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      dataExports: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects config when dataExports section is missing entirely', () => {
    const { dataExports, ...noDataExports } = base;
    const result = ConfigSchema.safeParse(noDataExports);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DataExportsConfigSchema default values
// ---------------------------------------------------------------------------
describe('DataExportsConfigSchema default values', () => {
  it('defaults curReportFormat to csv', () => {
    const result = ConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dataExports.curReportFormat).toBe('csv');
    }
  });

  it('defaults reconciliationSchedule to rate(6 hours)', () => {
    const result = ConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dataExports.reconciliationSchedule).toBe('rate(6 hours)');
    }
  });

  it('allows overriding curReportFormat to parquet', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      dataExports: { curBucketName: 'my-cur-bucket', curReportFormat: 'parquet' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dataExports.curReportFormat).toBe('parquet');
    }
  });

  it('allows overriding reconciliationSchedule', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      dataExports: { curBucketName: 'my-cur-bucket', reconciliationSchedule: 'rate(12 hours)' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dataExports.reconciliationSchedule).toBe('rate(12 hours)');
    }
  });

  it('allows optional curReportPrefix', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      dataExports: { curBucketName: 'my-cur-bucket', curReportPrefix: 'reports/bedrock' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dataExports.curReportPrefix).toBe('reports/bedrock');
    }
  });
});

// ---------------------------------------------------------------------------
// Pricing config section is no longer accepted
// ---------------------------------------------------------------------------
describe('pricing config removal', () => {
  it('does not accept a pricing field in the config', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      pricing: { pricingSource: 'manual' },
    });
    // Zod strict mode would reject, but by default extra keys are stripped.
    // The key assertion is that the parsed output has no pricing field.
    if (result.success) {
      expect((result.data as Record<string, unknown>)['pricing']).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// NAT Gateway refinements for pricing are removed
// ---------------------------------------------------------------------------
describe('NAT Gateway pricing refinements removed', () => {
  it('accepts enableNatGateway: false without any pricing-related constraint', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      vpc: { vpcMode: 'create', enableNatGateway: false },
    });
    expect(result.success).toBe(true);
  });

  it('accepts enableNatGateway: true without any pricing-related constraint', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      vpc: { vpcMode: 'create', enableNatGateway: true },
    });
    expect(result.success).toBe(true);
  });

  it('NAT Gateway setting has no cross-validation with dataExports', () => {
    // Both combinations should pass — no refine() ties NAT to dataExports
    const withNat = ConfigSchema.safeParse({
      ...base,
      vpc: { vpcMode: 'create', enableNatGateway: true },
    });
    const withoutNat = ConfigSchema.safeParse({
      ...base,
      vpc: { vpcMode: 'create', enableNatGateway: false },
    });
    expect(withNat.success).toBe(true);
    expect(withoutNat.success).toBe(true);
  });
});
