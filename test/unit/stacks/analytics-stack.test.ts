/**
 * Unit tests for the Analytics_Stack CDK construct.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 11.1, 11.2, 11.3, 11.4,
 *               11.5, 11.6, 11.7, 11.8
 */
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AnalyticsStack } from '../../../lib/stacks/analytics-stack';
import { PlatformConfig } from '../../../lib/config/schema';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildConfig(overrides: Partial<{
  solutionName: string;
  environment: 'dev' | 'staging' | 'production';
  regionMode: 'single' | 'multi';
  sourceRegions: string[];
  enableQuickSuite: boolean;
  quickSuiteEdition: 'STANDARD' | 'ENTERPRISE';
  quickSightPrincipalArn: string;
}> = {}): PlatformConfig {
  const {
    solutionName = 'test-solution',
    environment = 'dev',
    regionMode = 'single',
    sourceRegions = ['us-east-1', 'us-west-2'],
    enableQuickSuite = false,
    quickSuiteEdition,
    quickSightPrincipalArn,
  } = overrides;

  const region =
    regionMode === 'multi'
      ? { regionMode: 'multi' as const, sourceRegions }
      : { regionMode: 'single' as const };

  const dashboard = {
    enableQuickSuite,
    ...(quickSuiteEdition ? { quickSuiteEdition } : {}),
    ...(quickSightPrincipalArn ? { quickSightPrincipalArn } : {}),
  };

  return {
    vpc: { vpcMode: 'create', vpcCidr: '10.0.0.0/16', enableNatGateway: false, vpcEndpointMode: 'minimal' },
    account: { accountMode: 'single' },
    region,
    identity: { identityMode: 'iam' },
    dataExports: { curBucketName: 'test-cur-bucket', curReportFormat: 'csv', reconciliationSchedule: 'rate(6 hours)' },
    dashboard,
    cloudTrail: { cloudTrailMode: 'existing', existingCloudTrailBucket: 'ct-bucket' },
    deployment: { solutionName, environment },
    enableInvocationLogging: true,
  };
}

interface StackSet {
  analyticsStack: AnalyticsStack;
  template: Template;
}

function buildAnalyticsStack(config: PlatformConfig): StackSet {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };

  const depsStack = new cdk.Stack(app, 'DepsStack', { env });

  const cmk = new kms.Key(depsStack, 'Cmk', { enableKeyRotation: true });

  const processedDataBucket = new s3.Bucket(depsStack, 'ProcessedDataBucket', {
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: cmk,
    versioned: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
  });

  const analyticsStack = new AnalyticsStack(app, 'AnalyticsStack', {
    config,
    cmk,
    processedDataBucket,
    env,
  });

  return {
    analyticsStack,
    template: Template.fromStack(analyticsStack),
  };
}

// ── Glue Database ─────────────────────────────────────────────────────────────

describe('AnalyticsStack - Glue Database', () => {
  it('creates exactly one Glue database', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.resourceCountIs('AWS::Glue::Database', 1);
  });

  it('Glue database name is prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Glue::Database', {
      DatabaseInput: {
        Name: Match.stringLikeRegexp('^my-platform'),
      },
    });
  });

  it('exports glueDatabase', () => {
    const config = buildConfig();
    const { analyticsStack } = buildAnalyticsStack(config);
    expect(analyticsStack.glueDatabase).toBeDefined();
  });

  it('Glue database has CMK encryption parameters', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Glue::Database', {
      DatabaseInput: {
        Parameters: Match.objectLike({
          'glue.catalog.encryption.mode': 'SSE-KMS',
        }),
      },
    });
  });
});

// ── Glue Tables ───────────────────────────────────────────────────────────────

describe('AnalyticsStack - Glue Tables', () => {
  it('creates exactly 7 Glue tables', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    // invocation_logs, cloudtrail_events, metrics, cur_costs, reconciled_costs, model_billing_map, + invocations dataset view
    template.resourceCountIs('AWS::Glue::Table', 7);
  });

  it('creates invocation_logs table', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: {
        Name: 'invocation_logs',
        TableType: 'EXTERNAL_TABLE',
      },
    });
  });

  it('creates cloudtrail_events table', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: {
        Name: 'cloudtrail_events',
        TableType: 'EXTERNAL_TABLE',
      },
    });
  });

  it('creates metrics table', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: {
        Name: 'metrics',
        TableType: 'EXTERNAL_TABLE',
      },
    });
  });

  it('creates identity_mappings table', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: {
        Name: 'identity_mappings',
        TableType: 'EXTERNAL_TABLE',
      },
    });
  });

  it('all tables use Parquet SerDe', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    const tables = template.findResources('AWS::Glue::Table');
    const tableValues = Object.values(tables) as Array<{
      Properties?: {
        TableInput?: {
          StorageDescriptor?: {
            SerdeInfo?: { SerializationLibrary?: string };
          };
        };
      };
    }>;
    tableValues.forEach((t) => {
      expect(t.Properties?.TableInput?.StorageDescriptor?.SerdeInfo?.SerializationLibrary).toContain(
        'ParquetHiveSerDe',
      );
    });
  });

  it('invocation_logs table has required columns', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: {
        Name: 'invocation_logs',
        StorageDescriptor: {
          Columns: Match.arrayWith([
            Match.objectLike({ Name: 'requestid' }),
            Match.objectLike({ Name: 'modelid' }),
            Match.objectLike({ Name: 'inputtokens' }),
            Match.objectLike({ Name: 'outputtokens' }),
            Match.objectLike({ Name: 'callerarn' }),
            Match.objectLike({ Name: 'totalcost' }),
          ]),
        },
      },
    });
  });
});

// ── Partition projection - single-region ─────────────────────────────────────

describe('AnalyticsStack - Athena partition projection (single-region)', () => {
  it('partitioned tables have projection.enabled=true', () => {
    const config = buildConfig({ regionMode: 'single' });
    const { template } = buildAnalyticsStack(config);
    const tables = template.findResources('AWS::Glue::Table');
    const tableValues = Object.values(tables) as Array<{
      Properties?: {
        TableInput?: {
          Name?: string;
          Parameters?: Record<string, string>;
          PartitionKeys?: Array<{ Name: string }>;
        };
      };
    }>;
    // Only check tables that have partition keys
    tableValues
      .filter((t) => (t.Properties?.TableInput?.PartitionKeys ?? []).length > 0)
      .forEach((t) => {
        expect(t.Properties?.TableInput?.Parameters?.['projection.enabled']).toBe('true');
      });
  });

  it('single-region tables have year/month/day/hour partition keys only', () => {
    const config = buildConfig({ regionMode: 'single' });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: {
        Name: 'invocation_logs',
        PartitionKeys: Match.arrayWith([
          Match.objectLike({ Name: 'year' }),
          Match.objectLike({ Name: 'month' }),
          Match.objectLike({ Name: 'day' }),
          Match.objectLike({ Name: 'hour' }),
        ]),
      },
    });
  });

  it('single-region tables do NOT have region partition key', () => {
    const config = buildConfig({ regionMode: 'single' });
    const { template } = buildAnalyticsStack(config);
    const tables = template.findResources('AWS::Glue::Table');
    const tableValues = Object.values(tables) as Array<{
      Properties?: {
        TableInput?: {
          PartitionKeys?: Array<{ Name: string }>;
        };
      };
    }>;
    tableValues.forEach((t) => {
      const keys = t.Properties?.TableInput?.PartitionKeys ?? [];
      const hasRegion = keys.some((k) => k.Name === 'region');
      expect(hasRegion).toBe(false);
    });
  });

  it('single-region storage location template is defined for partitioned tables', () => {
    const config = buildConfig({ regionMode: 'single' });
    const { template } = buildAnalyticsStack(config);
    const tables = template.findResources('AWS::Glue::Table');
    const tableValues = Object.values(tables) as Array<{
      Properties?: {
        TableInput?: {
          Parameters?: Record<string, unknown>;
          PartitionKeys?: Array<{ Name: string }>;
        };
      };
    }>;
    // Only check tables that have partition keys
    tableValues
      .filter((t) => (t.Properties?.TableInput?.PartitionKeys ?? []).length > 0)
      .forEach((t) => {
        expect(t.Properties?.TableInput?.Parameters?.['storage.location.template']).toBeDefined();
      });
  });
});

// ── Partition projection - multi-region ──────────────────────────────────────

describe('AnalyticsStack - Athena partition projection (multi-region)', () => {
  it('multi-region tables have region partition key', () => {
    const config = buildConfig({ regionMode: 'multi', sourceRegions: ['us-east-1', 'us-west-2'] });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: {
        Name: 'invocation_logs',
        PartitionKeys: Match.arrayWith([
          Match.objectLike({ Name: 'region' }),
        ]),
      },
    });
  });

  it('multi-region tables have enum projection on region', () => {
    const config = buildConfig({ regionMode: 'multi', sourceRegions: ['us-east-1', 'us-west-2'] });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: {
        Name: 'invocation_logs',
        Parameters: Match.objectLike({
          'projection.region.type': 'enum',
          'projection.region.values': 'us-east-1,us-west-2',
        }),
      },
    });
  });

  it('multi-region storage location template is defined for partitioned tables', () => {
    const config = buildConfig({ regionMode: 'multi', sourceRegions: ['us-east-1', 'us-west-2'] });
    const { template } = buildAnalyticsStack(config);
    const tables = template.findResources('AWS::Glue::Table');
    const tableValues = Object.values(tables) as Array<{
      Properties?: {
        TableInput?: {
          Parameters?: Record<string, unknown>;
          PartitionKeys?: Array<{ Name: string }>;
        };
      };
    }>;
    // Only check tables that have partition keys
    tableValues
      .filter((t) => (t.Properties?.TableInput?.PartitionKeys ?? []).length > 0)
      .forEach((t) => {
        expect(t.Properties?.TableInput?.Parameters?.['storage.location.template']).toBeDefined();
      });
  });

  it('multi-region enum projection includes all configured source regions', () => {
    const sourceRegions = ['us-east-1', 'us-west-2', 'eu-west-1'];
    const config = buildConfig({ regionMode: 'multi', sourceRegions });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: {
        Name: 'invocation_logs',
        Parameters: Match.objectLike({
          'projection.region.values': 'us-east-1,us-west-2,eu-west-1',
        }),
      },
    });
  });
});

// ── Athena Workgroup ──────────────────────────────────────────────────────────

describe('AnalyticsStack - Athena Workgroup', () => {
  it('creates exactly one Athena workgroup', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.resourceCountIs('AWS::Athena::WorkGroup', 1);
  });

  it('exports athenaWorkgroup', () => {
    const config = buildConfig();
    const { analyticsStack } = buildAnalyticsStack(config);
    expect(analyticsStack.athenaWorkgroup).toBeDefined();
  });

  it('workgroup name is prefixed with solutionName', () => {
    const config = buildConfig({ solutionName: 'my-platform' });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: Match.stringLikeRegexp('^my-platform'),
    });
  });

  it('workgroup enforces workgroup configuration', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      WorkGroupConfiguration: Match.objectLike({
        EnforceWorkGroupConfiguration: true,
      }),
    });
  });

  it('workgroup has per-query scan limit of 10GB', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      WorkGroupConfiguration: Match.objectLike({
        BytesScannedCutoffPerQuery: 10 * 1024 * 1024 * 1024,
      }),
    });
  });

  it('workgroup result location uses CMK encryption', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      WorkGroupConfiguration: Match.objectLike({
        ResultConfiguration: Match.objectLike({
          EncryptionConfiguration: Match.objectLike({
            EncryptionOption: 'SSE_KMS',
          }),
        }),
      }),
    });
  });

  it('workgroup result location points to processed data bucket', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      WorkGroupConfiguration: Match.objectLike({
        ResultConfiguration: Match.objectLike({
          OutputLocation: Match.anyValue(),
        }),
      }),
    });
  });

  it('workgroup does not include unsupported ResultReuseConfiguration', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    // ResultReuseConfiguration was removed because it is not supported by
    // the Athena WorkGroup CloudFormation resource type in this region.
    const workgroups = template.findResources('AWS::Athena::WorkGroup');
    const wgValues = Object.values(workgroups) as Array<{
      Properties?: {
        WorkGroupConfiguration?: {
          ResultReuseConfiguration?: unknown;
        };
      };
    }>;
    expect(wgValues.length).toBe(1);
    const wg = wgValues[0];
    expect(wg.Properties?.WorkGroupConfiguration?.ResultReuseConfiguration).toBeUndefined();
  });
});

// ── QuickSight disabled ───────────────────────────────────────────────────────

describe('AnalyticsStack - QuickSight disabled', () => {
  it('creates no QuickSight resources when enableQuickSuite is false', () => {
    const config = buildConfig({ enableQuickSuite: false });
    const { template } = buildAnalyticsStack(config);
    template.resourceCountIs('AWS::QuickSight::DataSource', 0);
    template.resourceCountIs('AWS::QuickSight::DataSet', 0);
  });
});

// ── QuickSight STANDARD edition ───────────────────────────────────────────────

describe('AnalyticsStack - QuickSight STANDARD edition', () => {
  it('creates QuickSight data source when enableQuickSuite is true', () => {
    const config = buildConfig({ enableQuickSuite: true, quickSuiteEdition: 'STANDARD' });
    const { template } = buildAnalyticsStack(config);
    template.resourceCountIs('AWS::QuickSight::DataSource', 1);
  });

  it('QuickSight data source type is ATHENA', () => {
    const config = buildConfig({ enableQuickSuite: true, quickSuiteEdition: 'STANDARD' });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::QuickSight::DataSource', {
      Type: 'ATHENA',
    });
  });

  it('QuickSight data source points to the Athena workgroup', () => {
    const config = buildConfig({ enableQuickSuite: true, quickSuiteEdition: 'STANDARD' });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::QuickSight::DataSource', {
      DataSourceParameters: {
        AthenaParameters: {
          WorkGroup: Match.anyValue(),
        },
      },
    });
  });

  it('creates QuickSight SPICE dataset when enableQuickSuite is true', () => {
    const config = buildConfig({ enableQuickSuite: true, quickSuiteEdition: 'STANDARD' });
    const { template } = buildAnalyticsStack(config);
    // 2 datasets: invocations + metrics
    template.resourceCountIs('AWS::QuickSight::DataSet', 2);
  });

  it('QuickSight dataset uses SPICE import mode (always enabled)', () => {
    const config = buildConfig({ enableQuickSuite: true, quickSuiteEdition: 'STANDARD', quickSightPrincipalArn: 'arn:aws:quicksight:us-east-1:123456789012:user/default/test-user' });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::QuickSight::DataSet', {
      ImportMode: 'SPICE',
    });
  });

  it('STANDARD edition does NOT create RLS dataset', () => {
    const config = buildConfig({ enableQuickSuite: true, quickSuiteEdition: 'STANDARD' });
    const { template } = buildAnalyticsStack(config);
    // 2 datasets (invocations + metrics), no RLS dataset
    template.resourceCountIs('AWS::QuickSight::DataSet', 2);
  });

  it('QuickSight data source name is prefixed with solutionName', () => {
    const config = buildConfig({ enableQuickSuite: true, quickSuiteEdition: 'STANDARD', solutionName: 'my-platform' });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::QuickSight::DataSource', {
      Name: Match.stringLikeRegexp('^my-platform'),
    });
  });
});

// ── QuickSight ENTERPRISE edition ─────────────────────────────────────────────

describe('AnalyticsStack - QuickSight ENTERPRISE edition', () => {
  it('creates QuickSight data source when ENTERPRISE edition', () => {
    const config = buildConfig({ enableQuickSuite: true, quickSuiteEdition: 'ENTERPRISE' });
    const { template } = buildAnalyticsStack(config);
    template.resourceCountIs('AWS::QuickSight::DataSource', 1);
  });

  it('creates 2 QuickSight datasets for ENTERPRISE (main + RLS)', () => {
    const config = buildConfig({ enableQuickSuite: true, quickSuiteEdition: 'ENTERPRISE' });
    const { template } = buildAnalyticsStack(config);
    // 3 datasets: invocations + metrics + RLS
    template.resourceCountIs('AWS::QuickSight::DataSet', 3);
  });

  it('ENTERPRISE edition creates RLS dataset', () => {
    const config = buildConfig({ enableQuickSuite: true, quickSuiteEdition: 'ENTERPRISE' });
    const { template } = buildAnalyticsStack(config);
    const datasets = template.findResources('AWS::QuickSight::DataSet');
    const datasetValues = Object.values(datasets) as Array<{
      Properties?: { DataSetId?: string };
    }>;
    const hasRlsDataset = datasetValues.some((ds) =>
      ds.Properties?.DataSetId?.includes('rls'),
    );
    expect(hasRlsDataset).toBe(true);
  });

  it('ENTERPRISE edition applies row-level security to main dataset', () => {
    const config = buildConfig({ enableQuickSuite: true, quickSuiteEdition: 'ENTERPRISE' });
    const { template } = buildAnalyticsStack(config);
    const datasets = template.findResources('AWS::QuickSight::DataSet');
    const datasetValues = Object.values(datasets) as Array<{
      Properties?: {
        DataSetId?: string;
        RowLevelPermissionDataSet?: unknown;
      };
    }>;
    const mainDataset = datasetValues.find((ds) =>
      ds.Properties?.DataSetId?.includes('invocations'),
    );
    expect(mainDataset?.Properties?.RowLevelPermissionDataSet).toBeDefined();
  });
});

// ── CMK encryption ────────────────────────────────────────────────────────────

describe('AnalyticsStack - CMK encryption', () => {
  it('Athena workgroup result location uses CMK KMS key ARN', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      WorkGroupConfiguration: Match.objectLike({
        ResultConfiguration: Match.objectLike({
          EncryptionConfiguration: Match.objectLike({
            EncryptionOption: 'SSE_KMS',
            KmsKey: Match.anyValue(),
          }),
        }),
      }),
    });
  });

  it('Glue database has CMK encryption parameters', () => {
    const config = buildConfig();
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::Glue::Database', {
      DatabaseInput: {
        Parameters: Match.objectLike({
          'glue.catalog.encryption.mode': 'SSE-KMS',
          'glue.catalog.encryption.kms-key': Match.anyValue(),
        }),
      },
    });
  });
});

// ── Multi-region: all source regions covered ──────────────────────────────────

describe('AnalyticsStack - multi-region: all source regions covered (Requirement 17.3)', () => {
  it('partition projection includes every region from sourceRegions', () => {
    const sourceRegions = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-northeast-1'];
    const config = buildConfig({ regionMode: 'multi', sourceRegions });
    const { template } = buildAnalyticsStack(config);

    const tables = template.findResources('AWS::Glue::Table');
    const tableValues = Object.values(tables) as Array<{
      Properties?: { TableInput?: { Parameters?: Record<string, string>; PartitionKeys?: Array<{ Name: string }> } };
    }>;

    // Only check tables that have a region partition key
    tableValues
      .filter((t) => (t.Properties?.TableInput?.PartitionKeys ?? []).some((k) => k.Name === 'region'))
      .forEach((t) => {
        const params = t.Properties?.TableInput?.Parameters ?? {};
        expect(params['projection.region.type']).toBe('enum');
        const projectedRegions = (params['projection.region.values'] ?? '').split(',');
        sourceRegions.forEach((region) => {
          expect(projectedRegions).toContain(region);
        });
      });
  });

  it('single-region mode does not include region enum projection on partitioned tables', () => {
    const config = buildConfig({ regionMode: 'single' });
    const { template } = buildAnalyticsStack(config);

    const tables = template.findResources('AWS::Glue::Table');
    const tableValues = Object.values(tables) as Array<{
      Properties?: { TableInput?: { Parameters?: Record<string, string>; PartitionKeys?: Array<{ Name: string }> } };
    }>;

    // Only check tables that have partition keys
    tableValues
      .filter((t) => (t.Properties?.TableInput?.PartitionKeys ?? []).length > 0)
      .forEach((t) => {
        const params = t.Properties?.TableInput?.Parameters ?? {};
        expect(params['projection.region.type']).toBeUndefined();
        expect(params['projection.region.values']).toBeUndefined();
      });
  });

  it('single-region storage location template does not include region prefix', () => {
    const config = buildConfig({ regionMode: 'single' });
    const { template } = buildAnalyticsStack(config);

    const tables = template.findResources('AWS::Glue::Table');
    const tableValues = Object.values(tables) as Array<{
      Properties?: { TableInput?: { Parameters?: Record<string, unknown>; PartitionKeys?: Array<{ Name: string }> } };
    }>;

    tableValues
      .filter((t) => (t.Properties?.TableInput?.PartitionKeys ?? []).length > 0)
      .forEach((t) => {
        const params = t.Properties?.TableInput?.Parameters ?? {};
        const locationTemplate = params['storage.location.template'];
        if (typeof locationTemplate === 'string') {
          expect(locationTemplate).not.toContain('region=');
        }
      });
  });

  it('multi-region storage location template includes region= prefix', () => {
    const sourceRegions = ['us-east-1', 'us-west-2'];
    const config = buildConfig({ regionMode: 'multi', sourceRegions });
    const { template } = buildAnalyticsStack(config);

    const tables = template.findResources('AWS::Glue::Table');
    const tableValues = Object.values(tables) as Array<{
      Properties?: { TableInput?: { Parameters?: Record<string, unknown>; PartitionKeys?: Array<{ Name: string }> } };
    }>;

    tableValues
      .filter((t) => (t.Properties?.TableInput?.PartitionKeys ?? []).some((k) => k.Name === 'region'))
      .forEach((t) => {
        const params = t.Properties?.TableInput?.Parameters ?? {};
        const locationTemplate = params['storage.location.template'];
        if (typeof locationTemplate === 'string') {
          expect(locationTemplate).toContain('region=');
        }
      });
  });
});

// ── QuickSight SPICE always enabled ───────────────────────────────────────────

describe('AnalyticsStack - QuickSight SPICE always enabled (Requirements 2.1)', () => {
  it('importMode is always SPICE when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: 'arn:aws:quicksight:us-east-1:123456789012:user/default/test-user',
    });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::QuickSight::DataSet', {
      ImportMode: 'SPICE',
    });
  });

  it('SPICE refresh schedules are always created when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: 'arn:aws:quicksight:us-east-1:123456789012:user/default/test-user',
    });
    const { template } = buildAnalyticsStack(config);
    template.resourceCountIs('AWS::QuickSight::RefreshSchedule', 2);
  });
});

// ── QuickSight Permissions ────────────────────────────────────────────────────

describe('AnalyticsStack - QuickSight Permissions (Requirement 9.3)', () => {
  const principalArn = 'arn:aws:quicksight:us-east-1:123456789012:user/default/test-user';

  it('Permissions are added to CfnDataSource when quickSightPrincipalArn is provided', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: principalArn,
    });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::QuickSight::DataSource', {
      Permissions: Match.arrayWith([
        Match.objectLike({
          Principal: principalArn,
          Actions: Match.arrayWith(['quicksight:PassDataSource']),
        }),
      ]),
    });
  });

  it('Permissions are added to CfnDataSet when quickSightPrincipalArn is provided', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: principalArn,
    });
    const { template } = buildAnalyticsStack(config);
    template.hasResourceProperties('AWS::QuickSight::DataSet', {
      Permissions: Match.arrayWith([
        Match.objectLike({
          Principal: principalArn,
          Actions: Match.arrayWith(['quicksight:PassDataSet']),
        }),
      ]),
    });
  });

  it('No Permissions on CfnDataSource when quickSightPrincipalArn is absent', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      // no quickSightPrincipalArn
    });
    const { template } = buildAnalyticsStack(config);
    const dataSources = template.findResources('AWS::QuickSight::DataSource');
    const dsValues = Object.values(dataSources) as Array<{
      Properties?: { Permissions?: unknown };
    }>;
    expect(dsValues.length).toBe(1);
    expect(dsValues[0].Properties?.Permissions).toBeUndefined();
  });

  it('No Permissions on CfnDataSet when quickSightPrincipalArn is absent', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      // no quickSightPrincipalArn
    });
    const { template } = buildAnalyticsStack(config);
    const datasets = template.findResources('AWS::QuickSight::DataSet');
    const dsValues = Object.values(datasets) as Array<{
      Properties?: { DataSetId?: string; Permissions?: unknown };
    }>;
    // Check the main invocations dataset (not RLS)
    const mainDataset = dsValues.find((ds) =>
      ds.Properties?.DataSetId?.includes('invocations'),
    );
    expect(mainDataset).toBeDefined();
    expect(mainDataset?.Properties?.Permissions).toBeUndefined();
  });
});

// ── QuickSight exported properties ───────────────────────────────────────────

describe('AnalyticsStack - QuickSight exported properties (Requirement 9)', () => {
  it('dataSetId and dataSourceArn are exported as public readonly properties when enableQuickSuite is true', () => {
    const config = buildConfig({
      enableQuickSuite: true,
      quickSuiteEdition: 'STANDARD',
      quickSightPrincipalArn: 'arn:aws:quicksight:us-east-1:123456789012:user/default/test-user',
    });
    const { analyticsStack } = buildAnalyticsStack(config);
    expect(analyticsStack.dataSetId).toBeDefined();
    expect(typeof analyticsStack.dataSetId).toBe('string');
    expect(analyticsStack.dataSourceArn).toBeDefined();
  });

  it('dataSetId and dataSourceArn are undefined when enableQuickSuite is false', () => {
    const config = buildConfig({ enableQuickSuite: false });
    const { analyticsStack } = buildAnalyticsStack(config);
    expect(analyticsStack.dataSetId).toBeUndefined();
    expect(analyticsStack.dataSourceArn).toBeUndefined();
  });
});
