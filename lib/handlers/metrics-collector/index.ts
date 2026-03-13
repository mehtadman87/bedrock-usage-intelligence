import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
  MetricDataQuery,
  MetricDataResult,
} from '@aws-sdk/client-cloudwatch';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { writeParquet, METRICS_SCHEMA } from 'lib/shared/parquet-writer';
import { generatePartitionPath } from 'lib/shared/s3-partitioner';

// ─── Environment Variables ────────────────────────────────────────────────────

function getEnv(name: string, defaultValue = ''): string {
  return process.env[name] ?? defaultValue;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Processed metrics record written to Parquet.
 * Matches the METRICS_SCHEMA in parquet-writer.ts.
 */
export interface MetricsRecord {
  timestamp: string;
  region: string;
  modelId: string;
  invocationCount: number;
  invocationLatencyAvg: number;
  invocationLatencyP99: number;
  throttledCount: number;
  errorCount: number;
}

// ─── CloudWatch Metric Queries ────────────────────────────────────────────────

/** CloudWatch metric period: 5 minutes (matches the EventBridge schedule) */
const METRIC_PERIOD = 300;

/**
 * Dynamically discovers Bedrock model IDs that have reported CloudWatch metrics
 * in the past two weeks by calling ListMetrics on the AWS/Bedrock namespace.
 *
 * Falls back to a minimal hardcoded set if ListMetrics returns no results
 * (e.g. brand-new account with no Bedrock usage yet).
 */
export async function discoverModelIds(cwClient: CloudWatchClient): Promise<string[]> {
  const modelIds = new Set<string>();
  let nextToken: string | undefined;

  do {
    const response = await cwClient.send(
      new ListMetricsCommand({
        Namespace: 'AWS/Bedrock',
        MetricName: 'Invocations',
        NextToken: nextToken,
      }),
    );

    for (const metric of response.Metrics ?? []) {
      const modelDim = metric.Dimensions?.find((d) => d.Name === 'ModelId');
      if (modelDim?.Value) {
        modelIds.add(modelDim.Value);
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  if (modelIds.size === 0) {
    console.log('ListMetrics returned no Bedrock model IDs; no metrics to collect');
    return [];
  }

  console.log(`Discovered ${modelIds.size} active Bedrock model IDs`);
  return Array.from(modelIds);
}

/**
 * Builds the GetMetricData queries for a single model ID.
 * Returns queries for: Invocations (Sum), InvocationLatency (Average + p99),
 * InvocationThrottles (Sum), InvocationClientErrors (Sum).
 */
function buildMetricQueries(modelId: string, index: number): MetricDataQuery[] {
  // CloudWatch metric query IDs must be lowercase alphanumeric + underscore, max 256 chars
  const safeId = `m${index}_${modelId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`.slice(0, 200);

  const dimension = { Name: 'ModelId', Value: modelId };

  return [
    {
      Id: `${safeId}_invocations`,
      MetricStat: {
        Metric: { Namespace: 'AWS/Bedrock', MetricName: 'Invocations', Dimensions: [dimension] },
        Period: METRIC_PERIOD,
        Stat: 'Sum',
      },
      ReturnData: true,
    },
    {
      Id: `${safeId}_latency_avg`,
      MetricStat: {
        Metric: { Namespace: 'AWS/Bedrock', MetricName: 'InvocationLatency', Dimensions: [dimension] },
        Period: METRIC_PERIOD,
        Stat: 'Average',
      },
      ReturnData: true,
    },
    {
      Id: `${safeId}_latency_p99`,
      MetricStat: {
        Metric: { Namespace: 'AWS/Bedrock', MetricName: 'InvocationLatency', Dimensions: [dimension] },
        Period: METRIC_PERIOD,
        Stat: 'p99',
      },
      ReturnData: true,
    },
    {
      Id: `${safeId}_throttled`,
      MetricStat: {
        Metric: { Namespace: 'AWS/Bedrock', MetricName: 'InvocationThrottles', Dimensions: [dimension] },
        Period: METRIC_PERIOD,
        Stat: 'Sum',
      },
      ReturnData: true,
    },
    {
      Id: `${safeId}_errors`,
      MetricStat: {
        Metric: { Namespace: 'AWS/Bedrock', MetricName: 'InvocationClientErrors', Dimensions: [dimension] },
        Period: METRIC_PERIOD,
        Stat: 'Sum',
      },
      ReturnData: true,
    },
  ];
}

/**
 * Extracts the first (most recent) datapoint value from a MetricDataResult.
 * Returns 0 if no datapoints are available.
 */
function extractValue(result: MetricDataResult | undefined): number {
  if (!result || !result.Values || result.Values.length === 0) return 0;
  return result.Values[0] ?? 0;
}

// ─── Core Logic (exported for testing) ───────────────────────────────────────

/**
 * Collects Bedrock CloudWatch metrics for dynamically discovered model IDs
 * from a single region.
 *
 * First discovers active model IDs via ListMetrics, then queries:
 * - Invocations (Sum)
 * - InvocationLatency (Average, p99)
 * - InvocationThrottles (Sum)
 * - InvocationClientErrors (Sum)
 *
 * Only returns records for models that have at least some activity.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */
export async function collectMetricsForRegion(
  region: string,
  endTime: Date,
): Promise<MetricsRecord[]> {
  const cwClient = new CloudWatchClient({ region });

  // Dynamically discover which models have CloudWatch metrics
  const modelIds = await discoverModelIds(cwClient);
  if (modelIds.length === 0) {
    return [];
  }

  const startTime = new Date(endTime.getTime() - METRIC_PERIOD * 1000);

  // Build all queries (5 queries per model)
  const allQueries: MetricDataQuery[] = modelIds.flatMap((modelId, index) =>
    buildMetricQueries(modelId, index),
  );

  // CloudWatch GetMetricData supports up to 500 queries per call.
  // Batch into chunks of 500 if needed.
  const BATCH_SIZE = 500;
  const resultMap = new Map<string, MetricDataResult>();

  for (let i = 0; i < allQueries.length; i += BATCH_SIZE) {
    const batch = allQueries.slice(i, i + BATCH_SIZE);
    const command = new GetMetricDataCommand({
      MetricDataQueries: batch,
      StartTime: startTime,
      EndTime: endTime,
      ScanBy: 'TimestampDescending',
    });

    const response = await cwClient.send(command);
    for (const result of response.MetricDataResults ?? []) {
      if (result.Id) {
        resultMap.set(result.Id, result);
      }
    }
  }

  // Assemble MetricsRecord per model — only include models with activity
  const records: MetricsRecord[] = [];

  for (let index = 0; index < modelIds.length; index++) {
    const modelId = modelIds[index]!;
    const safeId = `m${index}_${modelId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`.slice(0, 200);

    const invocationCount = extractValue(resultMap.get(`${safeId}_invocations`));
    const invocationLatencyAvg = extractValue(resultMap.get(`${safeId}_latency_avg`));
    const invocationLatencyP99 = extractValue(resultMap.get(`${safeId}_latency_p99`));
    const throttledCount = extractValue(resultMap.get(`${safeId}_throttled`));
    const errorCount = extractValue(resultMap.get(`${safeId}_errors`));

    // Skip models with zero activity in this period
    if (invocationCount === 0 && invocationLatencyAvg === 0 && throttledCount === 0 && errorCount === 0) {
      continue;
    }

    records.push({
      timestamp: endTime.toISOString(),
      region,
      modelId,
      invocationCount,
      invocationLatencyAvg,
      invocationLatencyP99,
      throttledCount,
      errorCount,
    });
  }

  return records;
}

// ─── S3 Helper ────────────────────────────────────────────────────────────────

async function putS3Object(
  s3Client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }),
  );
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

/**
 * EventBridge-triggered Lambda handler that collects Bedrock CloudWatch metrics
 * on a 5-minute schedule.
 *
 * Dynamically discovers active model IDs via ListMetrics, then collects
 * performance metrics for each.
 *
 * In single-region mode: collects metrics from the deployment region.
 * In multi-region mode: iterates over each configured sourceRegion.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */
export const handler = async (_event: unknown): Promise<void> => {
  const processedDataBucket = getEnv('PROCESSED_DATA_BUCKET');
  const regionMode = getEnv('REGION_MODE', 'single');
  const sourceRegionsEnv = getEnv('SOURCE_REGIONS', '');
  const deploymentRegion = getEnv('AWS_REGION', 'us-east-1');

  const endTime = new Date();
  const s3Client = new S3Client({});

  // Determine which regions to collect from
  const regions: string[] =
    regionMode === 'multi' && sourceRegionsEnv
      ? sourceRegionsEnv.split(',').map((r) => r.trim()).filter(Boolean)
      : [deploymentRegion];

  for (const region of regions) {
    try {
      const records = await collectMetricsForRegion(region, endTime);

      if (records.length === 0) {
        console.log(`No metrics records for region: ${region}`);
        continue;
      }

      const parquetBuffer = await writeParquet(
        records as unknown as Record<string, unknown>[],
        METRICS_SCHEMA,
      );

      const partitionRegion = regionMode === 'multi' ? region : undefined;
      const partitionPath = generatePartitionPath('metrics', endTime, partitionRegion);
      const outputKey = `${partitionPath}metrics-${region}-${endTime.getTime()}.parquet`;

      await putS3Object(s3Client, processedDataBucket, outputKey, parquetBuffer);

      console.log(`Collected ${records.length} metrics for region ${region}, output: ${outputKey}`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Failed to collect metrics for region ${region}: ${errorMessage}`);
      // Continue with other regions rather than failing the entire invocation
    }
  }
};
