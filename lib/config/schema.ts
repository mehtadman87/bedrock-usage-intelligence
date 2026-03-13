import { z } from 'zod';

// Stub schema — full implementation in task 1.2
// This file is intentionally minimal so that bin/app.ts compiles
// while the complete schema is built out in the next task.

const VpcConfigSchema = z.discriminatedUnion('vpcMode', [
  z.object({
    vpcMode: z.literal('create'),
    vpcCidr: z.string().default('10.0.0.0/16'),
    enableNatGateway: z.boolean().default(false),
    vpcEndpointMode: z.enum(['minimal', 'full']).default('minimal'),
  }),
  z.object({
    vpcMode: z.literal('existing'),
    existingVpcId: z.string().regex(/^vpc-[a-z0-9]+$/),
    enableNatGateway: z.boolean().default(false),
    vpcEndpointMode: z.enum(['minimal', 'full']).default('minimal'),
  }),
]);

const AccountConfigSchema = z.discriminatedUnion('accountMode', [
  z.object({ accountMode: z.literal('single') }),
  z.object({
    accountMode: z.literal('multi'),
    sourceAccountIds: z.array(z.string().regex(/^\d{12}$/)).min(1),
    organizationId: z.string().optional(),
  }),
]);

const RegionConfigSchema = z.discriminatedUnion('regionMode', [
  z.object({ regionMode: z.literal('single') }),
  z.object({
    regionMode: z.literal('multi'),
    sourceRegions: z.array(z.string().regex(/^[a-z]{2}-[a-z]+-\d+$/)).min(1),
  }),
]);

const IdentityConfigSchema = z.discriminatedUnion('identityMode', [
  z.object({ identityMode: z.literal('iam') }),
  z.object({
    identityMode: z.literal('sso'),
    identityStoreId: z.string().regex(/^d-[a-z0-9]+$/),
  }),
  z.object({
    identityMode: z.literal('auto'),
    identityStoreId: z.string().regex(/^d-[a-z0-9]+$/),
  }),
]);


const DashboardConfigSchema = z
  .object({
    enableQuickSuite: z.boolean().default(false),
    quickSuiteEdition: z.enum(['STANDARD', 'ENTERPRISE']).optional(),
    quickSightPrincipalArn: z.string().optional(),
  })
  .refine(
    (cfg) => !cfg.enableQuickSuite || !!cfg.quickSightPrincipalArn,
    { message: 'quickSightPrincipalArn required when enableQuickSuite is true' },
  );

const CloudTrailConfigSchema = z.discriminatedUnion('cloudTrailMode', [
  z.object({ cloudTrailMode: z.literal('create') }),
  z.object({
    cloudTrailMode: z.literal('existing'),
    existingCloudTrailBucket: z.string(),
  }),
]);

const DeploymentConfigSchema = z.object({
  solutionName: z.string().default('bedrock-usage-intel'),
  environment: z.enum(['dev', 'staging', 'production']).default('dev'),
  tags: z.record(z.string()).optional(),
});

const DataExportsConfigSchema = z.object({
  curBucketName: z.string(),
  curReportPrefix: z.string().optional(),
  curReportFormat: z.enum(['csv', 'parquet']).default('csv'),
  reconciliationSchedule: z.string().default('rate(6 hours)'),
});

export const ConfigSchema = z.object({
  vpc: VpcConfigSchema,
  account: AccountConfigSchema,
  region: RegionConfigSchema,
  identity: IdentityConfigSchema,
  dataExports: DataExportsConfigSchema,
  dashboard: DashboardConfigSchema,
  cloudTrail: CloudTrailConfigSchema,
  deployment: DeploymentConfigSchema,
  enableInvocationLogging: z.boolean().default(true),
});

export type PlatformConfig = z.infer<typeof ConfigSchema>;
