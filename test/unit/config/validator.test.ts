// Feature: bedrock-usage-intelligence
// Unit tests for config validation — Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigSchema } from 'lib/config/schema';
import { loadAndValidateConfig } from 'lib/config/validator';

// ---------------------------------------------------------------------------
// Minimal valid base config — all required fields, no optional fields
// ---------------------------------------------------------------------------
const base = {
  vpc: { vpcMode: 'create' },
  account: { accountMode: 'single' },
  region: { regionMode: 'single' },
  identity: { identityMode: 'iam' },
  dataExports: { curBucketName: 'test-cur-bucket' },
  dashboard: {},
  cloudTrail: { cloudTrailMode: 'create' },
  deployment: {},
};

// ---------------------------------------------------------------------------
// 1. Conditional validation rules
// ---------------------------------------------------------------------------

describe('Conditional validation rules', () => {
  // --- VPC ---
  describe('vpcMode=existing', () => {
    it('fails when existingVpcId is absent', () => {
      const result = ConfigSchema.safeParse({ ...base, vpc: { vpcMode: 'existing' } });
      expect(result.success).toBe(false);
    });

    it('fails when existingVpcId is invalid (e.g. "VPC-abc")', () => {
      const result = ConfigSchema.safeParse({
        ...base,
        vpc: { vpcMode: 'existing', existingVpcId: 'VPC-abc' },
      });
      expect(result.success).toBe(false);
    });

    it('passes when existingVpcId is valid (e.g. "vpc-abc123")', () => {
      const result = ConfigSchema.safeParse({
        ...base,
        vpc: { vpcMode: 'existing', existingVpcId: 'vpc-abc123' },
      });
      expect(result.success).toBe(true);
    });
  });

  // --- Account ---
  describe('accountMode=multi', () => {
    it('fails when sourceAccountIds is absent', () => {
      const result = ConfigSchema.safeParse({
        ...base,
        account: { accountMode: 'multi' },
      });
      expect(result.success).toBe(false);
    });

    it('fails when sourceAccountIds contains an invalid account ID (e.g. "123")', () => {
      const result = ConfigSchema.safeParse({
        ...base,
        account: { accountMode: 'multi', sourceAccountIds: ['123'] },
      });
      expect(result.success).toBe(false);
    });

    it('passes when sourceAccountIds contains valid 12-digit account IDs', () => {
      const result = ConfigSchema.safeParse({
        ...base,
        account: { accountMode: 'multi', sourceAccountIds: ['123456789012'] },
      });
      expect(result.success).toBe(true);
    });
  });

  // --- Identity ---
  describe('identityMode=sso', () => {
    it('fails when identityStoreId is absent', () => {
      const result = ConfigSchema.safeParse({
        ...base,
        identity: { identityMode: 'sso' },
      });
      expect(result.success).toBe(false);
    });

    it('fails when identityStoreId is invalid (e.g. "D-abc")', () => {
      const result = ConfigSchema.safeParse({
        ...base,
        identity: { identityMode: 'sso', identityStoreId: 'D-abc' },
      });
      expect(result.success).toBe(false);
    });

    it('passes when identityStoreId is valid (e.g. "d-abc123")', () => {
      const result = ConfigSchema.safeParse({
        ...base,
        identity: { identityMode: 'sso', identityStoreId: 'd-abc123' },
      });
      expect(result.success).toBe(true);
    });
  });

  // --- Region ---
  describe('regionMode=multi', () => {
    it('fails when sourceRegions is absent', () => {
      const result = ConfigSchema.safeParse({
        ...base,
        region: { regionMode: 'multi' },
      });
      expect(result.success).toBe(false);
    });

    it('fails when sourceRegions contains an invalid region (e.g. "US-EAST-1")', () => {
      const result = ConfigSchema.safeParse({
        ...base,
        region: { regionMode: 'multi', sourceRegions: ['US-EAST-1'] },
      });
      expect(result.success).toBe(false);
    });

    it('passes when sourceRegions contains valid region codes', () => {
      const result = ConfigSchema.safeParse({
        ...base,
        region: { regionMode: 'multi', sourceRegions: ['us-east-1', 'eu-west-1'] },
      });
      expect(result.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Default value application
// ---------------------------------------------------------------------------

describe('Default value application', () => {
  it('vpcCidr defaults to "10.0.0.0/16"', () => {
    const result = ConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success && result.data.vpc.vpcMode === 'create') {
      expect(result.data.vpc.vpcCidr).toBe('10.0.0.0/16');
    }
  });

  it('enableNatGateway defaults to false', () => {
    const result = ConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vpc.enableNatGateway).toBe(false);
    }
  });

  it('vpcEndpointMode defaults to "minimal"', () => {
    const result = ConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vpc.vpcEndpointMode).toBe('minimal');
    }
  });

  it('enableInvocationLogging defaults to true', () => {
    const result = ConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enableInvocationLogging).toBe(true);
    }
  });

  it('solutionName defaults to "bedrock-usage-intel"', () => {
    const result = ConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deployment.solutionName).toBe('bedrock-usage-intel');
    }
  });

  it('environment defaults to "dev"', () => {
    const result = ConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deployment.environment).toBe('dev');
    }
  });

  it('curReportFormat defaults to "csv"', () => {
    const result = ConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dataExports.curReportFormat).toBe('csv');
    }
  });

  it('reconciliationSchedule defaults to "rate(6 hours)"', () => {
    const result = ConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dataExports.reconciliationSchedule).toBe('rate(6 hours)');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Valid configs for all mode combinations
// ---------------------------------------------------------------------------

describe('Valid configs for all mode combinations', () => {
  it('create VPC / single account / single region / iam identity / CUR data exports / create cloudtrail', () => {
    const result = ConfigSchema.safeParse({
      vpc: { vpcMode: 'create', vpcCidr: '10.1.0.0/16' },
      account: { accountMode: 'single' },
      region: { regionMode: 'single' },
      identity: { identityMode: 'iam' },
      dataExports: { curBucketName: 'my-cur-bucket' },
      dashboard: {},
      cloudTrail: { cloudTrailMode: 'create' },
      deployment: { solutionName: 'my-platform', environment: 'production' },
    });
    expect(result.success).toBe(true);
  });

  it('existing VPC / multi account / multi region / sso identity / CUR parquet / existing cloudtrail', () => {
    const result = ConfigSchema.safeParse({
      vpc: { vpcMode: 'existing', existingVpcId: 'vpc-abc123', enableNatGateway: true },
      account: {
        accountMode: 'multi',
        sourceAccountIds: ['123456789012', '987654321098'],
        organizationId: 'o-abc123',
      },
      region: { regionMode: 'multi', sourceRegions: ['us-east-1', 'us-west-2'] },
      identity: { identityMode: 'sso', identityStoreId: 'd-abc123' },
      dataExports: { curBucketName: 'my-cur-bucket', curReportFormat: 'parquet' },
      dashboard: { enableQuickSuite: true, quickSuiteEdition: 'ENTERPRISE', quickSightPrincipalArn: 'arn:aws:quicksight:us-east-1:123456789012:user/default/admin' },
      cloudTrail: { cloudTrailMode: 'existing', existingCloudTrailBucket: 'my-ct-bucket' },
      deployment: { environment: 'staging' },
    });
    expect(result.success).toBe(true);
  });

  it('create VPC / single account / single region / auto identity / CUR with custom schedule / create cloudtrail', () => {
    const result = ConfigSchema.safeParse({
      vpc: { vpcMode: 'create' },
      account: { accountMode: 'single' },
      region: { regionMode: 'single' },
      identity: { identityMode: 'auto', identityStoreId: 'd-xyz789' },
      dataExports: { curBucketName: 'my-cur-bucket', reconciliationSchedule: 'rate(12 hours)' },
      dashboard: {},
      cloudTrail: { cloudTrailMode: 'create' },
      deployment: {},
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. DataExports validation
// ---------------------------------------------------------------------------

describe('DataExports validation', () => {
  it('fails when dataExports.curBucketName is missing', () => {
    const result = ConfigSchema.safeParse({
      ...base,
      dataExports: {},
    });
    expect(result.success).toBe(false);
  });

  it('fails when dataExports is missing entirely', () => {
    const { dataExports, ...withoutDataExports } = base;
    const result = ConfigSchema.safeParse(withoutDataExports);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. loadAndValidateConfig — file-not-found case
// ---------------------------------------------------------------------------

describe('loadAndValidateConfig', () => {
  it('throws when the config file does not exist', () => {
    const nonExistentPath = path.join(os.tmpdir(), `no-such-config-${Date.now()}.yaml`);
    expect(() => loadAndValidateConfig(nonExistentPath)).toThrow();
  });

  it('returns a valid PlatformConfig when given a valid YAML file', () => {
    const yaml = `
vpc:
  vpcMode: create
account:
  accountMode: single
region:
  regionMode: single
identity:
  identityMode: iam
dataExports:
  curBucketName: my-cur-bucket
dashboard: {}
cloudTrail:
  cloudTrailMode: create
deployment: {}
`;
    const tmpFile = path.join(os.tmpdir(), `test-config-${Date.now()}.yaml`);
    fs.writeFileSync(tmpFile, yaml, 'utf-8');
    try {
      const config = loadAndValidateConfig(tmpFile);
      expect(config.vpc.vpcMode).toBe('create');
      expect(config.deployment.environment).toBe('dev');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
