// Feature: bedrock-usage-intelligence, Property 8: Hive-style partitioning output paths
import * as fc from 'fast-check';
import { generatePartitionPath } from 'lib/shared/s3-partitioner';

// ---------------------------------------------------------------------------
// Property 8: Hive-style partitioning output paths
// Validates: Requirements 5.6, 7.4, 17.2
// ---------------------------------------------------------------------------

describe('Property 8: Hive-style partitioning output paths', () => {
  // Validates: Requirements 5.6, 7.4, 17.2

  /** Arbitrary for valid prefix strings (lowercase alphanumeric, hyphens, and internal slashes).
   *  Must not start or end with a slash — mirrors real S3 key prefix semantics. */
  const prefixArb = fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => /^[a-z0-9][a-z0-9-/]*[a-z0-9]$/.test(s) || /^[a-z0-9]$/.test(s));

  /** Arbitrary for valid region strings (lowercase alphanumeric and hyphens) */
  const regionArb = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => /^[a-z0-9-]+$/.test(s));

  /** Arbitrary for timestamps as Date objects, constrained to 4-digit years (1000–9999)
   *  to match the Hive partition format which uses zero-padded 4-digit year components. */
  const timestampArb = fc.date({
    min: new Date('1000-01-01T00:00:00.000Z'),
    max: new Date('9999-12-31T23:59:59.999Z'),
  });

  it('single-region path matches the expected Hive-style pattern', () => {
    fc.assert(
      fc.property(prefixArb, timestampArb, (prefix, timestamp) => {
        const path = generatePartitionPath(prefix, timestamp);
        return /^.+\/year=\d{4}\/month=\d{2}\/day=\d{2}\/hour=\d{2}\/$/.test(path);
      }),
      { numRuns: 25 },
    );
  });

  it('multi-region path matches the expected Hive-style pattern', () => {
    fc.assert(
      fc.property(prefixArb, timestampArb, regionArb, (prefix, timestamp, region) => {
        const path = generatePartitionPath(prefix, timestamp, region);
        return /^.+\/region=[^/]+\/year=\d{4}\/month=\d{2}\/day=\d{2}\/hour=\d{2}\/$/.test(path);
      }),
      { numRuns: 25 },
    );
  });

  it('year component matches the UTC year of the timestamp', () => {
    fc.assert(
      fc.property(prefixArb, timestampArb, (prefix, timestamp) => {
        const path = generatePartitionPath(prefix, timestamp);
        const match = path.match(/year=(\d{4})/);
        if (!match) return false;
        return parseInt(match[1], 10) === timestamp.getUTCFullYear();
      }),
      { numRuns: 25 },
    );
  });

  it('month component matches the UTC month (1-indexed, zero-padded)', () => {
    fc.assert(
      fc.property(prefixArb, timestampArb, (prefix, timestamp) => {
        const path = generatePartitionPath(prefix, timestamp);
        const match = path.match(/month=(\d{2})/);
        if (!match) return false;
        const expectedMonth = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
        return match[1] === expectedMonth;
      }),
      { numRuns: 25 },
    );
  });

  it('day component matches the UTC day (zero-padded)', () => {
    fc.assert(
      fc.property(prefixArb, timestampArb, (prefix, timestamp) => {
        const path = generatePartitionPath(prefix, timestamp);
        const match = path.match(/day=(\d{2})/);
        if (!match) return false;
        const expectedDay = String(timestamp.getUTCDate()).padStart(2, '0');
        return match[1] === expectedDay;
      }),
      { numRuns: 25 },
    );
  });

  it('hour component matches the UTC hour (zero-padded)', () => {
    fc.assert(
      fc.property(prefixArb, timestampArb, (prefix, timestamp) => {
        const path = generatePartitionPath(prefix, timestamp);
        const match = path.match(/hour=(\d{2})/);
        if (!match) return false;
        const expectedHour = String(timestamp.getUTCHours()).padStart(2, '0');
        return match[1] === expectedHour;
      }),
      { numRuns: 25 },
    );
  });

  it('path ends with a trailing slash', () => {
    fc.assert(
      fc.property(prefixArb, timestampArb, fc.option(regionArb), (prefix, timestamp, region) => {
        const path = region !== null
          ? generatePartitionPath(prefix, timestamp, region)
          : generatePartitionPath(prefix, timestamp);
        return path.endsWith('/');
      }),
      { numRuns: 25 },
    );
  });
});

// Feature: bedrock-usage-intelligence, Property 6: Invocation log field extraction
// Validates: Requirements 5.2, 5.4, 5.5, 5.7
import {
  parseInvocationLog,
  resolveInferenceProfile,
  BedrockInvocationLog,
} from 'lib/handlers/invocation-processor/index';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Valid AWS region string */
const regionArb2 = fc.constantFrom(
  'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1', 'ap-northeast-1',
);

/** Valid model ID */
const modelIdArb = fc.constantFrom(
  'anthropic.claude-3-sonnet-20240229-v1:0',
  'anthropic.claude-3-haiku-20240307-v1:0',
  'amazon.titan-text-express-v1',
  'meta.llama3-8b-instruct-v1:0',
);

/** Non-empty string arbitrary */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 50 });

/** Standard invocation log arbitrary */
const standardLogArb: fc.Arbitrary<BedrockInvocationLog> = fc.record({
  requestId: nonEmptyStringArb,
  timestamp: fc.date({ min: new Date('2024-01-01'), max: new Date('2025-12-31') })
    .map((d) => d.toISOString()),
  accountId: fc.stringMatching(/^\d{12}$/),
  region: regionArb2,
  modelId: modelIdArb,
  input: fc.record({
    inputTokenCount: fc.integer({ min: 0, max: 100000 }),
    inputBodyJson: fc.string({ minLength: 2, maxLength: 200 }),
  }),
  output: fc.record({
    outputTokenCount: fc.integer({ min: 0, max: 100000 }),
    outputBodyJson: fc.string({ minLength: 2, maxLength: 200 }),
    latencyMs: fc.integer({ min: 0, max: 60000 }),
  }),
  identity: fc.record({
    arn: fc.constant('arn:aws:iam::123456789012:role/MyRole'),
  }),
});

/** Agent invocation log arbitrary */
const agentLogArb: fc.Arbitrary<BedrockInvocationLog> = standardLogArb.map((log) => ({
  ...log,
  agentId: 'agent-xyz',
  agentAlias: 'prod',
  subInvocations: [],
}));

/** Image model invocation log arbitrary */
const imageLogArb: fc.Arbitrary<BedrockInvocationLog> = fc.record({
  requestId: nonEmptyStringArb,
  timestamp: fc.date({ min: new Date('2024-01-01'), max: new Date('2025-12-31') })
    .map((d) => d.toISOString()),
  accountId: fc.stringMatching(/^\d{12}$/),
  region: regionArb2,
  modelId: fc.constant('stability.stable-diffusion-xl-v1'),
  input: fc.record({
    inputBodyJson: fc.string({ minLength: 2, maxLength: 200 }),
  }),
  output: fc.record({
    outputBodyJson: fc.string({ minLength: 2, maxLength: 200 }),
    latencyMs: fc.integer({ min: 0, max: 60000 }),
    imageCount: fc.integer({ min: 1, max: 4 }),
    imageDimensions: fc.constantFrom('512x512', '1024x1024', '768x768'),
  }),
  identity: fc.record({
    arn: fc.constant('arn:aws:iam::123456789012:role/MyRole'),
  }),
});

/** Video model invocation log arbitrary */
const videoLogArb: fc.Arbitrary<BedrockInvocationLog> = fc.record({
  requestId: nonEmptyStringArb,
  timestamp: fc.date({ min: new Date('2024-01-01'), max: new Date('2025-12-31') })
    .map((d) => d.toISOString()),
  accountId: fc.stringMatching(/^\d{12}$/),
  region: regionArb2,
  modelId: fc.constant('amazon.nova-reel-v1:0'),
  input: fc.record({
    inputBodyJson: fc.string({ minLength: 2, maxLength: 200 }),
  }),
  output: fc.record({
    outputBodyJson: fc.string({ minLength: 2, maxLength: 200 }),
    latencyMs: fc.integer({ min: 0, max: 60000 }),
    videoDurationSeconds: fc.float({ min: 1, max: 300, noNaN: true }),
    videoResolution: fc.constantFrom('720p', '1080p'),
  }),
  identity: fc.record({
    arn: fc.constant('arn:aws:iam::123456789012:role/MyRole'),
  }),
});

// ─── Property 6: Invocation log field extraction ──────────────────────────────

describe('Property 6: Invocation log field extraction', () => {
  // Validates: Requirements 5.2, 5.4, 5.5, 5.7

  it('standard invocation log contains all required fields', () => {
    fc.assert(
      fc.property(standardLogArb, (log) => {
        const record = parseInvocationLog(log);
        return (
          typeof record.modelId === 'string' &&
          typeof record.inputTokens === 'number' &&
          typeof record.outputTokens === 'number' &&
          typeof record.latencyMs === 'number' &&
          typeof record.requestId === 'string' &&
          typeof record.timestamp === 'string' &&
          typeof record.callerArn === 'string'
        );
      }),
      { numRuns: 25 },
    );
  });

  it('standard invocation log field values match input', () => {
    fc.assert(
      fc.property(standardLogArb, (log) => {
        const record = parseInvocationLog(log);
        return (
          record.requestId === log.requestId &&
          record.timestamp === log.timestamp &&
          record.modelId === log.modelId &&
          record.inputTokens === (log.input?.inputTokenCount ?? 0) &&
          record.outputTokens === (log.output?.outputTokenCount ?? 0) &&
          record.latencyMs === (log.output?.latencyMs ?? 0) &&
          record.callerArn === (log.identity?.arn ?? '') &&
          record.rawRequest === (log.input?.inputBodyJson ?? '') &&
          record.rawResponse === (log.output?.outputBodyJson ?? '')
        );
      }),
      { numRuns: 25 },
    );
  });

  it('agent invocation log contains agentId and agentAlias', () => {
    fc.assert(
      fc.property(agentLogArb, (log) => {
        const record = parseInvocationLog(log);
        return (
          record.agentId === log.agentId &&
          record.agentAlias === log.agentAlias
        );
      }),
      { numRuns: 25 },
    );
  });

  it('image invocation log contains imageCount and imageDimensions', () => {
    fc.assert(
      fc.property(imageLogArb, (log) => {
        const record = parseInvocationLog(log);
        return (
          record.imageCount === log.output?.imageCount &&
          record.imageDimensions === log.output?.imageDimensions
        );
      }),
      { numRuns: 25 },
    );
  });

  it('video invocation log contains videoDurationSeconds and videoResolution', () => {
    fc.assert(
      fc.property(videoLogArb, (log) => {
        const record = parseInvocationLog(log);
        return (
          record.videoDurationSeconds === log.output?.videoDurationSeconds &&
          record.videoResolution === log.output?.videoResolution
        );
      }),
      { numRuns: 25 },
    );
  });

  it('rawRequest and rawResponse match original payloads', () => {
    fc.assert(
      fc.property(standardLogArb, (log) => {
        const record = parseInvocationLog(log);
        return (
          record.rawRequest === (log.input?.inputBodyJson ?? '') &&
          record.rawResponse === (log.output?.outputBodyJson ?? '')
        );
      }),
      { numRuns: 25 },
    );
  });
});

// ─── Property 7: Inference profile resolution ─────────────────────────────────
// Feature: bedrock-usage-intelligence, Property 7: Inference profile resolution
// Validates: Requirements 5.3, 17.4

describe('Property 7: Inference profile resolution', () => {
  // Validates: Requirements 5.3, 17.4

  /** Arbitrary for cross-region inference profile ARNs */
  const profileArnArb = fc.record({
    region: regionArb2,
    account: fc.stringMatching(/^\d{12}$/),
    regionPrefix: fc.constantFrom('us', 'eu', 'ap'),
    baseModelId: modelIdArb,
  }).map(({ region, account, regionPrefix, baseModelId }) => ({
    arn: `arn:aws:bedrock:${region}:${account}:inference-profile/${regionPrefix}.${baseModelId}`,
    sourceRegion: region,
    baseModelId,
  }));

  it('resolves cross-region inference profile ARN to underlying model ID', () => {
    fc.assert(
      fc.property(profileArnArb, regionArb2, ({ arn, baseModelId }, executionRegion) => {
        const result = resolveInferenceProfile(arn, executionRegion);
        return result.resolvedModelId === baseModelId;
      }),
      { numRuns: 25 },
    );
  });

  it('records sourceRegion from the ARN and executionRegion from the actual region', () => {
    fc.assert(
      fc.property(profileArnArb, regionArb2, ({ arn, sourceRegion }, executionRegion) => {
        const result = resolveInferenceProfile(arn, executionRegion);
        return (
          result.sourceRegion === sourceRegion &&
          result.executionRegion === executionRegion
        );
      }),
      { numRuns: 25 },
    );
  });

  it('standard model IDs pass through unchanged', () => {
    fc.assert(
      fc.property(modelIdArb, regionArb2, (modelId, region) => {
        const result = resolveInferenceProfile(modelId, region);
        return (
          result.resolvedModelId === modelId &&
          result.sourceRegion === region &&
          result.executionRegion === region
        );
      }),
      { numRuns: 25 },
    );
  });

  it('invocation log with cross-region profile records both sourceRegion and executionRegion', () => {
    fc.assert(
      fc.property(profileArnArb, regionArb2, ({ arn, sourceRegion, baseModelId }, execRegion) => {
        const log: BedrockInvocationLog = {
          requestId: 'req-001',
          timestamp: '2024-01-15T14:30:00.000Z',
          accountId: '123456789012',
          region: execRegion,
          modelId: arn,
          input: { inputTokenCount: 100, inputBodyJson: '{}' },
          output: { outputTokenCount: 50, outputBodyJson: '{}', latencyMs: 500 },
          identity: { arn: 'arn:aws:iam::123456789012:role/MyRole' },
        };
        const record = parseInvocationLog(log);
        return (
          record.resolvedModelId === baseModelId &&
          record.sourceRegion === sourceRegion &&
          record.executionRegion === execRegion
        );
      }),
      { numRuns: 25 },
    );
  });
});

// Feature: bedrock-usage-intelligence, Property 11: Multi-region metrics collection
// Validates: Requirements 7.3
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { collectMetricsForRegion } from 'lib/handlers/metrics-collector/index';

const cwMock = mockClient(CloudWatchClient);

beforeEach(() => {
  cwMock.reset();
});

// ─── Property 11: Multi-region metrics collection ─────────────────────────────

describe('Property 11: Multi-region metrics collection', () => {
  // Validates: Requirements 7.3

  /** Arbitrary for a valid AWS region code */
  const awsRegionArb = fc.constantFrom(
    'us-east-1',
    'us-west-2',
    'eu-west-1',
    'eu-central-1',
    'ap-southeast-1',
    'ap-northeast-1',
    'ap-south-1',
  );

  /** Arbitrary for a set of 2–5 distinct regions */
  const sourceRegionsArb = fc
    .uniqueArray(awsRegionArb, { minLength: 2, maxLength: 5 })
    .filter((regions) => regions.length >= 2);

  it('collectMetricsForRegion is called for every region in the set', async () => {
    // For each generated set of regions, verify that calling collectMetricsForRegion
    // for each region returns records tagged with that region.
    await fc.assert(
      fc.asyncProperty(sourceRegionsArb, async (regions) => {
        // Mock CloudWatch to return empty results (no datapoints) for any region
        cwMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });

        const allRecords = await Promise.all(
          regions.map((region) => collectMetricsForRegion(region, new Date('2024-01-15T14:30:00.000Z'))),
        );

        // Every region must have produced records
        if (allRecords.length !== regions.length) return false;

        // Each batch of records must be tagged with the correct region
        for (let i = 0; i < regions.length; i++) {
          const regionRecords = allRecords[i]!;
          if (regionRecords.length === 0) return false;
          if (!regionRecords.every((r) => r.region === regions[i])) return false;
        }

        return true;
      }),
      { numRuns: 25 },
    );
  });

  it('records from each region contain all required MetricsRecord fields', async () => {
    await fc.assert(
      fc.asyncProperty(awsRegionArb, async (region) => {
        cwMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });

        const records = await collectMetricsForRegion(region, new Date('2024-01-15T14:30:00.000Z'));

        return records.every(
          (r) =>
            typeof r.timestamp === 'string' &&
            typeof r.region === 'string' &&
            typeof r.modelId === 'string' &&
            typeof r.invocationCount === 'number' &&
            typeof r.invocationLatencyAvg === 'number' &&
            typeof r.invocationLatencyP99 === 'number' &&
            typeof r.throttledCount === 'number' &&
            typeof r.errorCount === 'number',
        );
      }),
      { numRuns: 25 },
    );
  });

  it('records from different regions are independent (no cross-region contamination)', async () => {
    await fc.assert(
      fc.asyncProperty(sourceRegionsArb, async (regions) => {
        cwMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });

        const endTime = new Date('2024-06-01T12:00:00.000Z');
        const allRecords = await Promise.all(
          regions.map((region) => collectMetricsForRegion(region, endTime)),
        );

        // Records for region[i] must all have region === regions[i]
        for (let i = 0; i < regions.length; i++) {
          const regionRecords = allRecords[i]!;
          if (!regionRecords.every((r) => r.region === regions[i])) return false;
        }

        return true;
      }),
      { numRuns: 25 },
    );
  });
});
