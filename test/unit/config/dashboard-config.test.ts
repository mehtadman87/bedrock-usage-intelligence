// Feature: quicksight-dashboard
// Unit tests for DashboardConfigSchema — Requirements 1, 9
import { ConfigSchema } from 'lib/config/schema';

// ---------------------------------------------------------------------------
// Minimal valid base config
// ---------------------------------------------------------------------------
const base = {
  vpc: { vpcMode: 'create' },
  account: { accountMode: 'single' },
  region: { regionMode: 'single' },
  identity: { identityMode: 'iam' },
  dataExports: { curBucketName: 'test-cur-bucket' },
  cloudTrail: { cloudTrailMode: 'create' },
  deployment: {},
};

function withDashboard(dashboard: Record<string, unknown>) {
  return { ...base, dashboard };
}

// ---------------------------------------------------------------------------
// spiceMode removed from schema (Req 2.1)
// ---------------------------------------------------------------------------

describe('spiceMode removed from schema', () => {
  it('dashboard config parses successfully without spiceMode', () => {
    const result = ConfigSchema.safeParse(withDashboard({}));
    expect(result.success).toBe(true);
  });

  it('parsed dashboard config does not contain spiceMode property', () => {
    const result = ConfigSchema.safeParse(withDashboard({}));
    expect(result.success).toBe(true);
    if (result.success) {
      expect('spiceMode' in result.data.dashboard).toBe(false);
    }
  });

  it('ignores spiceMode if provided (zod strips unknown keys)', () => {
    // Zod's default behavior strips unknown keys, so passing spiceMode should not cause failure
    const result = ConfigSchema.safeParse(withDashboard({ spiceMode: 'enabled' }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect('spiceMode' in result.data.dashboard).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// quickSightPrincipalArn — optional when enableQuickSuite is false
// ---------------------------------------------------------------------------

describe('quickSightPrincipalArn optional when enableQuickSuite is false', () => {
  it('passes when enableQuickSuite is false and quickSightPrincipalArn is absent', () => {
    const result = ConfigSchema.safeParse(withDashboard({ enableQuickSuite: false }));
    expect(result.success).toBe(true);
  });

  it('passes when enableQuickSuite is false and quickSightPrincipalArn is provided', () => {
    const result = ConfigSchema.safeParse(
      withDashboard({
        enableQuickSuite: false,
        quickSightPrincipalArn: 'arn:aws:quicksight:us-east-1:123456789012:user/default/admin',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('passes when enableQuickSuite is omitted (defaults false) and quickSightPrincipalArn is absent', () => {
    const result = ConfigSchema.safeParse(withDashboard({}));
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// quickSightPrincipalArn — required when enableQuickSuite is true (refinement)
// ---------------------------------------------------------------------------

describe('quickSightPrincipalArn required when enableQuickSuite is true', () => {
  it('fails when enableQuickSuite is true and quickSightPrincipalArn is absent', () => {
    const result = ConfigSchema.safeParse(withDashboard({ enableQuickSuite: true }));
    expect(result.success).toBe(false);
  });

  it('error message mentions quickSightPrincipalArn', () => {
    const result = ConfigSchema.safeParse(withDashboard({ enableQuickSuite: true }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ');
      expect(messages).toContain('quickSightPrincipalArn');
    }
  });

  it('passes when enableQuickSuite is true and quickSightPrincipalArn is provided', () => {
    const result = ConfigSchema.safeParse(
      withDashboard({
        enableQuickSuite: true,
        quickSightPrincipalArn: 'arn:aws:quicksight:us-east-1:123456789012:user/default/admin',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('passes with ENTERPRISE edition when enableQuickSuite is true and arn is provided', () => {
    const result = ConfigSchema.safeParse(
      withDashboard({
        enableQuickSuite: true,
        quickSuiteEdition: 'ENTERPRISE',
        quickSightPrincipalArn: 'arn:aws:quicksight:us-east-1:123456789012:group/default/analysts',
      }),
    );
    expect(result.success).toBe(true);
  });
});
