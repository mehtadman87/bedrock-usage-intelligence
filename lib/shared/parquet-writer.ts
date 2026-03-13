import { ParquetSchema, ParquetWriter } from '@dsnp/parquetjs';
import { PassThrough } from 'stream';

// ─── Schema Definitions ──────────────────────────────────────────────────────

/**
 * Parquet schema for Bedrock invocation log records.
 * Nullable fields use `optional: true`.
 */
export const INVOCATION_LOG_SCHEMA = new ParquetSchema({
  requestId: { type: 'UTF8' },
  timestamp: { type: 'UTF8' },
  accountId: { type: 'UTF8' },
  region: { type: 'UTF8' },
  modelId: { type: 'UTF8' },
  resolvedModelId: { type: 'UTF8' },
  inputTokens: { type: 'INT64' },
  outputTokens: { type: 'INT64' },
  latencyMs: { type: 'INT64' },
  callerArn: { type: 'UTF8' },
  resolvedUserId: { type: 'UTF8' },
  resolvedUserName: { type: 'UTF8' },
  resolvedUserEmail: { type: 'UTF8' },
  agentId: { type: 'UTF8', optional: true },
  agentAlias: { type: 'UTF8', optional: true },
  imageCount: { type: 'INT32', optional: true },
  imageDimensions: { type: 'UTF8', optional: true },
  videoDurationSeconds: { type: 'DOUBLE', optional: true },
  videoResolution: { type: 'UTF8', optional: true },
  guardrailId: { type: 'UTF8', optional: true },
  inputCost: { type: 'DOUBLE' },
  outputCost: { type: 'DOUBLE' },
  totalCost: { type: 'DOUBLE' },
  costStatus: { type: 'UTF8' },
  rawRequest: { type: 'UTF8' },
  rawResponse: { type: 'UTF8' },
  sourceRegion: { type: 'UTF8' },
  executionRegion: { type: 'UTF8' },
  inferenceTier: { type: 'UTF8', optional: true },
  cacheType: { type: 'UTF8', optional: true },
  cacheWriteInputTokens: { type: 'INT64', optional: true },
  cacheReadInputTokens: { type: 'INT64', optional: true },
});

/**
 * Parquet schema for CloudTrail Bedrock event records.
 */
export const CLOUDTRAIL_EVENT_SCHEMA = new ParquetSchema({
  eventId: { type: 'UTF8' },
  requestId: { type: 'UTF8' },
  timestamp: { type: 'UTF8' },
  accountId: { type: 'UTF8' },
  region: { type: 'UTF8' },
  eventName: { type: 'UTF8' },
  principalArn: { type: 'UTF8' },
  sourceIpAddress: { type: 'UTF8' },
  userAgent: { type: 'UTF8' },
  modelId: { type: 'UTF8' },
  resolvedUserId: { type: 'UTF8' },
  resolvedUserName: { type: 'UTF8' },
  resolvedUserEmail: { type: 'UTF8' },
});

/**
 * Parquet schema for CloudWatch metrics records.
 */
export const METRICS_SCHEMA = new ParquetSchema({
  timestamp: { type: 'UTF8' },
  region: { type: 'UTF8' },
  modelId: { type: 'UTF8' },
  invocationCount: { type: 'INT64' },
  invocationLatencyAvg: { type: 'DOUBLE' },
  invocationLatencyP99: { type: 'DOUBLE' },
  throttledCount: { type: 'INT64' },
  errorCount: { type: 'INT64' },
});

// ─── Writer ───────────────────────────────────────────────────────────────────

/**
 * Serializes an array of records to a Parquet-format Buffer using the given schema.
 *
 * Uses `@dsnp/parquetjs` with a PassThrough stream to collect bytes in memory,
 * keeping Lambda cold starts fast (no temp-file I/O required).
 *
 * @param records - Array of plain objects whose keys match the schema fields.
 * @param schema  - A `ParquetSchema` instance (use the exported schema constants).
 * @returns A Buffer containing the complete Parquet file bytes.
 */
export async function writeParquet(
  records: Record<string, unknown>[],
  schema: ParquetSchema,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const passThrough = new PassThrough();

  passThrough.on('data', (chunk: Buffer) => chunks.push(chunk));

  // @dsnp/parquetjs expects a WriteStreamMinimal (Pick<fs.WriteStream, 'write' | 'end'>).
  // PassThrough satisfies the runtime contract; the cast resolves the type mismatch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const writer = await ParquetWriter.openStream(schema, passThrough as any);

  for (const record of records) {
    await writer.appendRow(record);
  }

  await writer.close();

  return Buffer.concat(chunks);
}
