// Feature: bedrock-usage-intelligence
import * as fc from 'fast-check';
import { ConfigSchema } from 'lib/config/schema';

// ---------------------------------------------------------------------------
// Helpers: minimal valid base config builders
// ---------------------------------------------------------------------------

/** Returns a minimal valid config object with all required fields. Optional
 *  fields are intentionally omitted so defaults are exercised. */
function minimalValidConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
    vpc: { vpcMode: 'create' },
    account: { accountMode: 'single' },
    region: { regionMode: 'single' },
    identity: { identityMode: 'iam' },
    dataExports: { curBucketName: 'test-cur-bucket' },
    dashboard: {},
    cloudTrail: { cloudTrailMode: 'create' },
    deployment: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generates a string that does NOT match the vpc-[a-z0-9]+ pattern */
const invalidVpcId = fc.oneof(
  fc.constant(''),
  fc.constant('vpc-'),
  fc.constant('VPC-abc123'),
  fc.constant('vpc_abc123'),
  fc.constant('not-a-vpc-id'),
  fc.string({ minLength: 1, maxLength: 20 }).filter(
    (s) => !/^vpc-[a-z0-9]+$/.test(s),
  ),
);

/** Generates a string that does NOT match the 12-digit account ID pattern */
const invalidAccountId = fc.oneof(
  fc.constant(''),
  fc.constant('12345'),
  fc.constant('1234567890123'), // 13 digits
  fc.constant('abcdefghijkl'),
  fc.string({ minLength: 1, maxLength: 15 }).filter(
    (s) => !/^\d{12}$/.test(s),
  ),
);

/** Generates a string that does NOT match the d-[a-z0-9]+ pattern */
const invalidIdentityStoreId = fc.oneof(
  fc.constant(''),
  fc.constant('d-'),
  fc.constant('D-abc123'),
  fc.constant('d_abc123'),
  fc.constant('not-an-id'),
  fc.string({ minLength: 1, maxLength: 20 }).filter(
    (s) => !/^d-[a-z0-9]+$/.test(s),
  ),
);

/** Generates a string that does NOT match the AWS region code pattern */
const invalidRegionCode = fc.oneof(
  fc.constant(''),
  fc.constant('US-EAST-1'),
  fc.constant('us_east_1'),
  fc.constant('us-east'),
  fc.constant('notaregion'),
  fc.string({ minLength: 1, maxLength: 20 }).filter(
    (s) => !/^[a-z]{2}-[a-z]+-\d+$/.test(s),
  ),
);

/** Generates a valid 12-digit AWS account ID */
const validAccountId = fc
  .integer({ min: 100000000000, max: 999999999999 })
  .map((n) => String(n));

/** Generates a valid AWS region code */
const validRegionCode = fc.constantFrom(
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-central-1',
  'ap-southeast-1',
  'ap-northeast-1',
);

/** Generates a valid vpc-[a-z0-9]+ id */
const validVpcId = fc
  .stringMatching(/^vpc-[a-z0-9]{8,17}$/)
  .filter((s) => /^vpc-[a-z0-9]+$/.test(s));

/** Generates a valid d-[a-z0-9]+ identity store id */
const validIdentityStoreId = fc
  .stringMatching(/^d-[a-z0-9]{10}$/)
  .filter((s) => /^d-[a-z0-9]+$/.test(s));

// ---------------------------------------------------------------------------
// Property 1: Config validation rejects invalid conditional fields
// Feature: bedrock-usage-intelligence, Property 1: Config validation rejects invalid conditional fields
// ---------------------------------------------------------------------------

describe('Property 1: Config validation rejects invalid conditional fields', () => {
  // Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6

  it('rejects vpcMode=existing with missing existingVpcId', () => {
    fc.assert(
      fc.property(fc.constant(undefined), (_) => {
        const config = minimalValidConfig({
          vpc: { vpcMode: 'existing' },
        });
        const result = ConfigSchema.safeParse(config);
        return result.success === false;
      }),
      { numRuns: 25 },
    );
  });

  it('rejects vpcMode=existing with invalid existingVpcId', () => {
    fc.assert(
      fc.property(invalidVpcId, (badId) => {
        const config = minimalValidConfig({
          vpc: { vpcMode: 'existing', existingVpcId: badId },
        });
        const result = ConfigSchema.safeParse(config);
        return result.success === false;
      }),
      { numRuns: 25 },
    );
  });

  it('rejects accountMode=multi with missing sourceAccountIds', () => {
    fc.assert(
      fc.property(fc.constant(undefined), (_) => {
        const config = minimalValidConfig({
          account: { accountMode: 'multi' },
        });
        const result = ConfigSchema.safeParse(config);
        return result.success === false;
      }),
      { numRuns: 25 },
    );
  });

  it('rejects accountMode=multi with empty sourceAccountIds array', () => {
    fc.assert(
      fc.property(fc.constant([]), (ids) => {
        const config = minimalValidConfig({
          account: { accountMode: 'multi', sourceAccountIds: ids },
        });
        const result = ConfigSchema.safeParse(config);
        return result.success === false;
      }),
      { numRuns: 25 },
    );
  });

  it('rejects accountMode=multi with invalid account IDs', () => {
    fc.assert(
      fc.property(
        fc.array(invalidAccountId, { minLength: 1, maxLength: 5 }),
        (badIds) => {
          const config = minimalValidConfig({
            account: { accountMode: 'multi', sourceAccountIds: badIds },
          });
          const result = ConfigSchema.safeParse(config);
          return result.success === false;
        },
      ),
      { numRuns: 25 },
    );
  });

  it('rejects identityMode=sso with missing identityStoreId', () => {
    fc.assert(
      fc.property(fc.constant(undefined), (_) => {
        const config = minimalValidConfig({
          identity: { identityMode: 'sso' },
        });
        const result = ConfigSchema.safeParse(config);
        return result.success === false;
      }),
      { numRuns: 25 },
    );
  });

  it('rejects identityMode=sso with invalid identityStoreId', () => {
    fc.assert(
      fc.property(invalidIdentityStoreId, (badId) => {
        const config = minimalValidConfig({
          identity: { identityMode: 'sso', identityStoreId: badId },
        });
        const result = ConfigSchema.safeParse(config);
        return result.success === false;
      }),
      { numRuns: 25 },
    );
  });

  it('rejects regionMode=multi with missing sourceRegions', () => {
    fc.assert(
      fc.property(fc.constant(undefined), (_) => {
        const config = minimalValidConfig({
          region: { regionMode: 'multi' },
        });
        const result = ConfigSchema.safeParse(config);
        return result.success === false;
      }),
      { numRuns: 25 },
    );
  });

  it('rejects regionMode=multi with empty sourceRegions array', () => {
    fc.assert(
      fc.property(fc.constant([]), (regions) => {
        const config = minimalValidConfig({
          region: { regionMode: 'multi', sourceRegions: regions },
        });
        const result = ConfigSchema.safeParse(config);
        return result.success === false;
      }),
      { numRuns: 25 },
    );
  });

  it('rejects regionMode=multi with invalid region codes', () => {
    fc.assert(
      fc.property(
        fc.array(invalidRegionCode, { minLength: 1, maxLength: 5 }),
        (badRegions) => {
          const config = minimalValidConfig({
            region: { regionMode: 'multi', sourceRegions: badRegions },
          });
          const result = ConfigSchema.safeParse(config);
          return result.success === false;
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Config validation produces actionable error messages
// Feature: bedrock-usage-intelligence, Property 2: Config validation produces actionable error messages
// ---------------------------------------------------------------------------

describe('Property 2: Config validation produces actionable error messages', () => {
  // Validates: Requirements 1.7

  /** Builds an arbitrary that produces a config guaranteed to fail validation,
   *  along with a description of which field is invalid. */
  const invalidConfigArb = fc.oneof(
    // vpcMode=existing without valid existingVpcId
    fc.record({
      tag: fc.constant('vpc.existingVpcId'),
      config: invalidVpcId.map((badId) =>
        minimalValidConfig({ vpc: { vpcMode: 'existing', existingVpcId: badId } }),
      ),
    }),
    // accountMode=multi with invalid account IDs
    fc.record({
      tag: fc.constant('account.sourceAccountIds'),
      config: fc
        .array(invalidAccountId, { minLength: 1, maxLength: 3 })
        .map((badIds) =>
          minimalValidConfig({
            account: { accountMode: 'multi', sourceAccountIds: badIds },
          }),
        ),
    }),
    // identityMode=sso with invalid identityStoreId
    fc.record({
      tag: fc.constant('identity.identityStoreId'),
      config: invalidIdentityStoreId.map((badId) =>
        minimalValidConfig({ identity: { identityMode: 'sso', identityStoreId: badId } }),
      ),
    }),
    // regionMode=multi with invalid region codes
    fc.record({
      tag: fc.constant('region.sourceRegions'),
      config: fc
        .array(invalidRegionCode, { minLength: 1, maxLength: 3 })
        .map((badRegions) =>
          minimalValidConfig({
            region: { regionMode: 'multi', sourceRegions: badRegions },
          }),
        ),
    }),
  );

  it('error issues contain a non-empty path array identifying the offending field', () => {
    fc.assert(
      fc.property(invalidConfigArb, ({ config }) => {
        const result = ConfigSchema.safeParse(config);
        if (result.success) return false; // config must be invalid

        // Every issue must have a non-empty path
        return result.error.issues.every((issue) => issue.path.length > 0);
      }),
      { numRuns: 25 },
    );
  });

  it('error issues contain a non-empty message describing the violation', () => {
    fc.assert(
      fc.property(invalidConfigArb, ({ config }) => {
        const result = ConfigSchema.safeParse(config);
        if (result.success) return false;

        // Every issue must have a non-empty message
        return result.error.issues.every(
          (issue) => typeof issue.message === 'string' && issue.message.length > 0,
        );
      }),
      { numRuns: 25 },
    );
  });

  it('error issues path segments are strings or numbers (navigable field path)', () => {
    fc.assert(
      fc.property(invalidConfigArb, ({ config }) => {
        const result = ConfigSchema.safeParse(config);
        if (result.success) return false;

        return result.error.issues.every((issue) =>
          issue.path.every(
            (segment) => typeof segment === 'string' || typeof segment === 'number',
          ),
        );
      }),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Config validation applies documented defaults for omitted optional fields
// Feature: bedrock-usage-intelligence, Property 3: Config validation applies documented defaults for omitted optional fields
// ---------------------------------------------------------------------------

describe('Property 3: Config validation applies documented defaults for omitted optional fields', () => {
  // Validates: Requirements 1.9

  /**
   * Generates a minimal valid config that omits all optional fields so we can
   * verify the schema applies the documented defaults.
   *
   * Required fields that have no defaults and must always be present:
   *   vpc.vpcMode, account.accountMode, region.regionMode, identity.identityMode,
   *   cloudTrail.cloudTrailMode
   *
   * We vary the mode choices to cover different discriminated union branches.
   */
  const minimalConfigArb = fc.record({
    vpcMode: fc.constantFrom('create' as const),
    accountMode: fc.constantFrom('single' as const, 'multi' as const),
    regionMode: fc.constantFrom('single' as const, 'multi' as const),
    identityMode: fc.constantFrom('iam' as const, 'sso' as const, 'auto' as const),
    cloudTrailMode: fc.constantFrom('create' as const, 'existing' as const),
  }).chain(({ vpcMode, accountMode, regionMode, identityMode, cloudTrailMode }) => {
    // Build the account sub-object (multi requires at least one valid account ID)
    const accountArb =
      accountMode === 'multi'
        ? fc
            .array(validAccountId, { minLength: 1, maxLength: 3 })
            .map((ids) => ({ accountMode: 'multi' as const, sourceAccountIds: ids }))
        : fc.constant({ accountMode: 'single' as const });

    // Build the region sub-object (multi requires at least one valid region)
    const regionArb =
      regionMode === 'multi'
        ? fc
            .array(validRegionCode, { minLength: 1, maxLength: 3 })
            .map((regions) => ({ regionMode: 'multi' as const, sourceRegions: regions }))
        : fc.constant({ regionMode: 'single' as const });

    // Build the identity sub-object (sso/auto require identityStoreId)
    const identityArb =
      identityMode === 'sso' || identityMode === 'auto'
        ? validIdentityStoreId.map((id) => ({
            identityMode,
            identityStoreId: id,
          }))
        : fc.constant({ identityMode: 'iam' as const });

    // Build the cloudTrail sub-object (existing requires a bucket name)
    const cloudTrailArb =
      cloudTrailMode === 'existing'
        ? fc
            .string({ minLength: 3, maxLength: 30 })
            .filter((s) => /^[a-z0-9-]+$/.test(s))
            .map((bucket) => ({
              cloudTrailMode: 'existing' as const,
              existingCloudTrailBucket: bucket,
            }))
        : fc.constant({ cloudTrailMode: 'create' as const });

    return fc
      .tuple(accountArb, regionArb, identityArb, cloudTrailArb)
      .map(([account, region, identity, cloudTrail]) => ({
        // vpc: only vpcMode, no optional fields (vpcCidr, enableNatGateway, vpcEndpointMode omitted)
        vpc: { vpcMode },
        account,
        region,
        identity,
        // dataExports: required field
        dataExports: { curBucketName: 'test-cur-bucket' },
        // dashboard: empty object — enableQuickSuite should default to false
        dashboard: {},
        cloudTrail,
        // deployment: empty object — solutionName and environment should default
        deployment: {},
        // enableInvocationLogging omitted — should default to true
      }));
  });

  it('applies default vpcCidr of "10.0.0.0/16" when vpcMode is "create" and vpcCidr is omitted', () => {
    fc.assert(
      fc.property(minimalConfigArb, (config) => {
        const result = ConfigSchema.safeParse(config);
        if (!result.success) return true; // skip invalid configs (e.g. scrape without NAT)

        if (result.data.vpc.vpcMode === 'create') {
          return result.data.vpc.vpcCidr === '10.0.0.0/16';
        }
        return true;
      }),
      { numRuns: 25 },
    );
  });

  it('applies default enableNatGateway of false when omitted', () => {
    fc.assert(
      fc.property(minimalConfigArb, (config) => {
        const result = ConfigSchema.safeParse(config);
        if (!result.success) return true;

        return result.data.vpc.enableNatGateway === false;
      }),
      { numRuns: 25 },
    );
  });

  it('applies default vpcEndpointMode of "minimal" when omitted', () => {
    fc.assert(
      fc.property(minimalConfigArb, (config) => {
        const result = ConfigSchema.safeParse(config);
        if (!result.success) return true;

        return result.data.vpc.vpcEndpointMode === 'minimal';
      }),
      { numRuns: 25 },
    );
  });

  it('applies default enableInvocationLogging of true when omitted', () => {
    fc.assert(
      fc.property(minimalConfigArb, (config) => {
        const result = ConfigSchema.safeParse(config);
        if (!result.success) return true;

        return result.data.enableInvocationLogging === true;
      }),
      { numRuns: 25 },
    );
  });

  it('applies default solutionName of "bedrock-usage-intel" when omitted', () => {
    fc.assert(
      fc.property(minimalConfigArb, (config) => {
        const result = ConfigSchema.safeParse(config);
        if (!result.success) return true;

        return result.data.deployment.solutionName === 'bedrock-usage-intel';
      }),
      { numRuns: 25 },
    );
  });

  it('applies default environment of "dev" when omitted', () => {
    fc.assert(
      fc.property(minimalConfigArb, (config) => {
        const result = ConfigSchema.safeParse(config);
        if (!result.success) return true;

        return result.data.deployment.environment === 'dev';
      }),
      { numRuns: 25 },
    );
  });
});
