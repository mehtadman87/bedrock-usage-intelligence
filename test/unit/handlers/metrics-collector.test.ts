/**
 * Unit tests for the Metrics Collector handler.
 *
 * Tests discoverModelIds, collectMetricsForRegion, and the main handler
 * with mocked CloudWatch and S3.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */

import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
} from '@aws-sdk/client-cloudwatch';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { collectMetricsForRegion, discoverModelIds } from 'lib/handlers/metrics-collector/index';
import { handler } from 'lib/handlers/metrics-collector/index';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const cwMock = mockClient(CloudWatchClient);
const s3Mock = mockClient(S3Client);

/** Helper: mock ListMetrics to return the given model IDs */
function mockListMetrics(modelIds: string[]): void {
  cwMock.on(ListMetricsCommand).resolves({
    Metrics: modelIds.map((id) => ({
      Namespace: 'AWS/Bedrock',
      MetricName: 'Invocations',
      Dimensions: [{ Name: 'ModelId', Value: id }],
    })),
  });
}

/** Standard set of discovered model IDs for tests */
const TEST_MODEL_IDS = [
  'anthropic.claude-3-sonnet-20240229-v1:0',
  'amazon.titan-text-express-v1',
];

beforeEach(() => {
  cwMock.reset();
  s3Mock.reset();
  process.env['PROCESSED_DATA_BUCKET'] = 'processed-bucket';
  process.env['REGION_MODE'] = 'single';
  process.env['SOURCE_REGIONS'] = '';
  process.env['AWS_REGION'] = 'us-east-1';
});

// ─── discoverModelIds Tests ───────────────────────────────────────────────────

describe('discoverModelIds', () => {
  it('returns model IDs from ListMetrics response', async () => {
    mockListMetrics(['model-a', 'model-b']);
    const client = new CloudWatchClient({ region: 'us-east-1' });
    const ids = await discoverModelIds(client);
    expect(ids).toEqual(expect.arrayContaining(['model-a', 'model-b']));
    expect(ids).toHaveLength(2);
  });

  it('returns empty array when ListMetrics returns no metrics', async () => {
    cwMock.on(ListMetricsCommand).resolves({ Metrics: [] });
    const client = new CloudWatchClient({ region: 'us-east-1' });
    const ids = await discoverModelIds(client);
    expect(ids).toHaveLength(0);
  });

  it('deduplicates model IDs', async () => {
    cwMock.on(ListMetricsCommand).resolves({
      Metrics: [
        { Namespace: 'AWS/Bedrock', MetricName: 'Invocations', Dimensions: [{ Name: 'ModelId', Value: 'model-a' }] },
        { Namespace: 'AWS/Bedrock', MetricName: 'Invocations', Dimensions: [{ Name: 'ModelId', Value: 'model-a' }] },
      ],
    });
    const client = new CloudWatchClient({ region: 'us-east-1' });
    const ids = await discoverModelIds(client);
    expect(ids).toHaveLength(1);
  });

  it('paginates through multiple pages', async () => {
    cwMock.on(ListMetricsCommand)
      .resolvesOnce({
        Metrics: [{ Namespace: 'AWS/Bedrock', MetricName: 'Invocations', Dimensions: [{ Name: 'ModelId', Value: 'model-a' }] }],
        NextToken: 'page2',
      })
      .resolvesOnce({
        Metrics: [{ Namespace: 'AWS/Bedrock', MetricName: 'Invocations', Dimensions: [{ Name: 'ModelId', Value: 'model-b' }] }],
      });
    const client = new CloudWatchClient({ region: 'us-east-1' });
    const ids = await discoverModelIds(client);
    expect(ids).toHaveLength(2);
  });
});

// ─── collectMetricsForRegion Tests ────────────────────────────────────────────

describe('collectMetricsForRegion', () => {
  const endTime = new Date('2024-01-15T14:30:00.000Z');

  beforeEach(() => {
    mockListMetrics(TEST_MODEL_IDS);
  });

  it('returns records for discovered model IDs with activity', async () => {
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_invocations', Values: [10], Timestamps: [endTime], StatusCode: 'Complete' },
      ],
    });

    const records = await collectMetricsForRegion('us-east-1', endTime);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => typeof r.modelId === 'string' && r.modelId.length > 0)).toBe(true);
  });

  it('skips models with zero activity', async () => {
    cwMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });

    const records = await collectMetricsForRegion('us-east-1', endTime);
    expect(records).toHaveLength(0);
  });

  it('tags each record with the correct region', async () => {
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_invocations', Values: [5], Timestamps: [endTime], StatusCode: 'Complete' },
        { Id: 'm1_amazon_titan_text_express_v1_invocations', Values: [3], Timestamps: [endTime], StatusCode: 'Complete' },
      ],
    });

    const records = await collectMetricsForRegion('eu-west-1', endTime);
    expect(records.every((r) => r.region === 'eu-west-1')).toBe(true);
  });

  it('tags each record with the endTime as ISO timestamp', async () => {
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_invocations', Values: [1], Timestamps: [endTime], StatusCode: 'Complete' },
      ],
    });

    const records = await collectMetricsForRegion('us-east-1', endTime);
    expect(records.every((r) => r.timestamp === endTime.toISOString())).toBe(true);
  });

  it('extracts invocationCount from CloudWatch Invocations metric', async () => {
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_invocations', Values: [42], Timestamps: [endTime], StatusCode: 'Complete' },
      ],
    });

    const records = await collectMetricsForRegion('us-east-1', endTime);
    const claudeRecord = records.find((r) => r.modelId === 'anthropic.claude-3-sonnet-20240229-v1:0');
    expect(claudeRecord).toBeDefined();
    expect(claudeRecord!.invocationCount).toBe(42);
  });

  it('extracts latency metrics (avg and p99) from CloudWatch', async () => {
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_invocations', Values: [10], Timestamps: [endTime], StatusCode: 'Complete' },
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_latency_avg', Values: [350.5], Timestamps: [endTime], StatusCode: 'Complete' },
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_latency_p99', Values: [1200.0], Timestamps: [endTime], StatusCode: 'Complete' },
      ],
    });

    const records = await collectMetricsForRegion('us-east-1', endTime);
    const claudeRecord = records.find((r) => r.modelId === 'anthropic.claude-3-sonnet-20240229-v1:0');
    expect(claudeRecord!.invocationLatencyAvg).toBe(350.5);
    expect(claudeRecord!.invocationLatencyP99).toBe(1200.0);
  });

  it('extracts throttledCount and errorCount from CloudWatch', async () => {
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_invocations', Values: [10], Timestamps: [endTime], StatusCode: 'Complete' },
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_throttled', Values: [5], Timestamps: [endTime], StatusCode: 'Complete' },
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_errors', Values: [2], Timestamps: [endTime], StatusCode: 'Complete' },
      ],
    });

    const records = await collectMetricsForRegion('us-east-1', endTime);
    const claudeRecord = records.find((r) => r.modelId === 'anthropic.claude-3-sonnet-20240229-v1:0');
    expect(claudeRecord!.throttledCount).toBe(5);
    expect(claudeRecord!.errorCount).toBe(2);
  });

  it('returns empty when ListMetrics finds no models', async () => {
    cwMock.on(ListMetricsCommand).resolves({ Metrics: [] });
    cwMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });

    const records = await collectMetricsForRegion('us-east-1', endTime);
    expect(records).toHaveLength(0);
    expect(cwMock).not.toHaveReceivedCommand(GetMetricDataCommand);
  });

  it('queries the AWS/Bedrock namespace', async () => {
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_invocations', Values: [1], Timestamps: [endTime], StatusCode: 'Complete' },
      ],
    });

    await collectMetricsForRegion('us-east-1', endTime);

    const calls = cwMock.commandCalls(GetMetricDataCommand);
    expect(calls.length).toBe(1);
    const queries = calls[0]!.args[0].input.MetricDataQueries ?? [];
    const namespaces = queries.map((q) => q.MetricStat?.Metric?.Namespace).filter(Boolean);
    expect(namespaces.every((ns) => ns === 'AWS/Bedrock')).toBe(true);
  });

  it('throws when CloudWatch API fails', async () => {
    cwMock.on(ListMetricsCommand).rejects(new Error('CloudWatch API error'));
    await expect(collectMetricsForRegion('us-east-1', endTime)).rejects.toThrow('CloudWatch API error');
  });
});

// ─── Handler Tests ────────────────────────────────────────────────────────────

describe('handler - single-region mode', () => {
  beforeEach(() => {
    mockListMetrics(TEST_MODEL_IDS);
  });

  it('collects metrics and writes Parquet to S3 when models have activity', async () => {
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_invocations', Values: [10], Timestamps: [new Date()], StatusCode: 'Complete' },
      ],
    });
    s3Mock.on(PutObjectCommand).resolves({});

    await handler({});

    expect(s3Mock).toHaveReceivedCommandTimes(PutObjectCommand, 1);
    const putCall = s3Mock.commandCalls(PutObjectCommand)[0]!;
    expect(putCall.args[0].input.Bucket).toBe('processed-bucket');
    expect(putCall.args[0].input.Key).toMatch(/^metrics\/year=\d{4}\/month=\d{2}\/day=\d{2}\/hour=\d{2}\//);
  });

  it('does not write to S3 when no models have activity', async () => {
    cwMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });
    s3Mock.on(PutObjectCommand).resolves({});

    await handler({});

    expect(s3Mock).not.toHaveReceivedCommand(PutObjectCommand);
  });
});

describe('handler - multi-region mode', () => {
  beforeEach(() => {
    process.env['REGION_MODE'] = 'multi';
    process.env['SOURCE_REGIONS'] = 'us-east-1,eu-west-1,ap-southeast-1';
    mockListMetrics(TEST_MODEL_IDS);
  });

  it('collects metrics from all configured source regions', async () => {
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_invocations', Values: [5], Timestamps: [new Date()], StatusCode: 'Complete' },
      ],
    });
    s3Mock.on(PutObjectCommand).resolves({});

    await handler({});

    expect(s3Mock).toHaveReceivedCommandTimes(PutObjectCommand, 3);
  });

  it('continues collecting from other regions when one region fails', async () => {
    let listCallCount = 0;
    cwMock.on(ListMetricsCommand).callsFake(() => {
      listCallCount++;
      if (listCallCount === 1) {
        throw new Error('CloudWatch unavailable in us-east-1');
      }
      return {
        Metrics: TEST_MODEL_IDS.map((id) => ({
          Namespace: 'AWS/Bedrock',
          MetricName: 'Invocations',
          Dimensions: [{ Name: 'ModelId', Value: id }],
        })),
      };
    });
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: 'm0_anthropic_claude_3_sonnet_20240229_v1_0_invocations', Values: [5], Timestamps: [new Date()], StatusCode: 'Complete' },
      ],
    });
    s3Mock.on(PutObjectCommand).resolves({});

    await expect(handler({})).resolves.toBeUndefined();
    expect(s3Mock).toHaveReceivedCommandTimes(PutObjectCommand, 2);
  });
});
