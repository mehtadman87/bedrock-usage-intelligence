// Feature: quicksight-dashboard
import * as fc from 'fast-check';
import { ConfigSchema } from 'lib/config/schema';

// ---------------------------------------------------------------------------
// Helpers: minimal valid base config
// ---------------------------------------------------------------------------

function minimalValidConfig(dashboardOverrides: Record<string, unknown> = {}): unknown {
  return {
    vpc: { vpcMode: 'create' },
    account: { accountMode: 'single' },
    region: { regionMode: 'single' },
    identity: { identityMode: 'iam' },
    dataExports: { curBucketName: 'test-cur-bucket' },
    dashboard: dashboardOverrides,
    cloudTrail: { cloudTrailMode: 'create' },
    deployment: {},
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** A plausible QuickSight principal ARN */
const validPrincipalArn = fc.constantFrom(
  'arn:aws:quicksight:us-east-1:123456789012:user/default/admin',
  'arn:aws:quicksight:eu-west-1:987654321098:group/default/analysts',
  'arn:aws:quicksight:us-west-2:111122223333:user/default/operator',
);

// ---------------------------------------------------------------------------
// Property 1: spiceMode no longer exists in schema (Req 2.1)
// Validates: Requirements 2.1
// ---------------------------------------------------------------------------

describe('Property 1: spiceMode is not a valid config option', () => {
  it('dashboard config parses successfully without spiceMode', () => {
    fc.assert(
      fc.property(fc.constant({}), () => {
        const config = minimalValidConfig({});
        const result = ConfigSchema.safeParse(config);
        return result.success === true;
      }),
      { numRuns: 25 },
    );
  });

  it('parsed dashboard config does not contain spiceMode property', () => {
    fc.assert(
      fc.property(fc.constant({}), () => {
        const config = minimalValidConfig({});
        const result = ConfigSchema.safeParse(config);
        if (!result.success) return false;
        return !('spiceMode' in result.data.dashboard);
      }),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: quickSightPrincipalArn required when enableQuickSuite true (Req 9)
// Validates: Requirements 9
// ---------------------------------------------------------------------------

describe('Property 7: quickSightPrincipalArn required when enableQuickSuite is true', () => {
  it('rejects enableQuickSuite=true when quickSightPrincipalArn is absent', () => {
    fc.assert(
      fc.property(fc.constant(true), (enabled) => {
        const config = minimalValidConfig({ enableQuickSuite: enabled });
        const result = ConfigSchema.safeParse(config);
        return result.success === false;
      }),
      { numRuns: 25 },
    );
  });

  it('accepts enableQuickSuite=true when quickSightPrincipalArn is provided', () => {
    fc.assert(
      fc.property(validPrincipalArn, (arn) => {
        const config = minimalValidConfig({
          enableQuickSuite: true,
          quickSightPrincipalArn: arn,
        });
        const result = ConfigSchema.safeParse(config);
        return result.success === true;
      }),
      { numRuns: 25 },
    );
  });

  it('accepts enableQuickSuite=false without quickSightPrincipalArn', () => {
    fc.assert(
      fc.property(fc.constant(false), (enabled) => {
        const config = minimalValidConfig({ enableQuickSuite: enabled });
        const result = ConfigSchema.safeParse(config);
        return result.success === true;
      }),
      { numRuns: 25 },
    );
  });

  it('accepts enableQuickSuite omitted (defaults false) without quickSightPrincipalArn', () => {
    fc.assert(
      fc.property(fc.constant({}), (dashboardConfig) => {
        const config = minimalValidConfig(dashboardConfig);
        const result = ConfigSchema.safeParse(config);
        return result.success === true;
      }),
      { numRuns: 25 },
    );
  });
});
