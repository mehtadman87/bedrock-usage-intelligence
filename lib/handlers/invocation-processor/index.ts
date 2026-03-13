import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { IdempotencyChecker } from 'lib/shared/idempotency';
import { writeParquet, INVOCATION_LOG_SCHEMA } from 'lib/shared/parquet-writer';
import { generatePartitionPath } from 'lib/shared/s3-partitioner';
import { FAILED_RECORDS_PREFIX } from 'lib/shared/constants';
import { InferenceTier, CacheType, CrossRegionType } from 'lib/shared/pricing-types';

// ─── Environment Variables (read lazily to support test overrides) ────────────

function getEnv(name: string, defaultValue = ''): string {
  return process.env[name] ?? defaultValue;
}

/**
 * Raw Bedrock invocation log JSON structure.
 * Fields are optional because different model types populate different subsets.
 */
export interface BedrockInvocationLog {
  requestId: string;
  timestamp: string;
  accountId?: string;
  region?: string;
  modelId: string;
  input?: {
    inputTokenCount?: number;
    inputBodyJson?: unknown;              // raw request body — may contain service_tier and cachePoint objects
    cacheWriteInputTokenCount?: number;   // confirmed top-level field in log
    cacheReadInputTokenCount?: number;    // confirmed top-level field in log
  };
  output?: {
    outputTokenCount?: number;
    outputBodyJson?: string;
    latencyMs?: number;
    // image/video models
    imageCount?: number;
    imageDimensions?: string;
    videoDurationSeconds?: number;
    videoResolution?: string;
  };
  identity?: {
    arn?: string;
  };
  // Agent invocations
  agentId?: string;
  agentAlias?: string;
  subInvocations?: unknown[];
  // Guardrail
  guardrailId?: string;
}

/**
 * Processed invocation record written to Parquet.
 * Cost fields are set to 0 with costStatus: 'pending' — costs are reconciled
 * asynchronously via the CUR-based Cost Reconciler.
 */
export interface InvocationRecord {
  requestId: string;
  timestamp: string;
  accountId: string;
  region: string;
  modelId: string;
  resolvedModelId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  callerArn: string;
  resolvedUserId: string;
  resolvedUserName: string;
  resolvedUserEmail: string;
  agentId?: string;
  agentAlias?: string;
  imageCount?: number;
  imageDimensions?: string;
  videoDurationSeconds?: number;
  videoResolution?: string;
  guardrailId?: string;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  costStatus: string;
  rawRequest: string;
  rawResponse: string;
  sourceRegion: string;
  executionRegion: string;
  // New fields
  inferenceTier: InferenceTier;       // default 'standard'
  cacheType: CacheType;               // default 'none'
  crossRegionType: CrossRegionType;   // default 'none'
  cacheWriteInputTokens: number;      // default 0
  cacheReadInputTokens: number;       // default 0
  audioDurationSeconds?: number;      // for speech/audio models
}

/**
 * Result of resolving a cross-region inference profile.
 */
export interface InferenceProfileResolution {
  resolvedModelId: string;
  sourceRegion: string;
  executionRegion: string;
  crossRegionType: CrossRegionType;
}

// ─── S3 Event Types ───────────────────────────────────────────────────────────

interface S3EventRecord {
  s3: {
    bucket: { name: string };
    object: { key: string };
  };
  awsRegion?: string;
}

interface S3Event {
  Records: S3EventRecord[];
}

// ─── Clients ──────────────────────────────────────────────────────────────────

const s3Client = new S3Client({});

function getIdempotencyChecker(): IdempotencyChecker {
  return new IdempotencyChecker(getEnv('IDEMPOTENCY_TABLE'));
}

// ─── Core Logic (exported for testing) ───────────────────────────────────────

/**
 * Resolves a cross-region inference profile ARN to the underlying model ID
 * and records both the source region (from ARN) and execution region (actual).
 *
 * Cross-region inference profile ARN format:
 *   arn:aws:bedrock:{region}:{account}:inference-profile/{profile-id}
 *
 * The profile-id has a regional prefix (e.g. "us.") that is stripped to get
 * the underlying model ID.
 *
 * Requirements: 5.3, 17.4
 */
export function resolveInferenceProfile(
  modelId: string,
  executionRegion: string,
): InferenceProfileResolution {
  // Check if this is a cross-region inference profile ARN
  const profileArnPattern =
    /^arn:aws:bedrock:([^:]+):[^:]*:inference-profile\/(.+)$/;
  const arnMatch = modelId.match(profileArnPattern);

  if (arnMatch) {
    const sourceRegion = arnMatch[1]!;
    const profileId = arnMatch[2]!;
    // Strip regional prefix (e.g. "us.", "eu.", "ap.") from profile ID
    const resolvedModelId = profileId.replace(/^[a-z]{2}\./, '');
    // Determine cross-region type from the profile ID prefix
    const crossRegionType = detectCrossRegionType(profileId);
    return { resolvedModelId, sourceRegion, executionRegion, crossRegionType };
  }

  // Check if this is a profile ID (not a full ARN) with a regional prefix
  // e.g. "us.anthropic.claude-3-sonnet-20240229-v1:0"
  const prefixedModelPattern = /^([a-z]{2})\.(.+)$/;
  const prefixMatch = modelId.match(prefixedModelPattern);

  if (prefixMatch) {
    const resolvedModelId = prefixMatch[2]!;
    // Geographic prefix (us., eu., ap.) indicates geo cross-region
    const crossRegionType: CrossRegionType = 'geo';
    return { resolvedModelId, sourceRegion: executionRegion, executionRegion, crossRegionType };
  }

  // Standard model ID — no resolution needed
  return { resolvedModelId: modelId, sourceRegion: executionRegion, executionRegion, crossRegionType: 'none' };
}

/**
 * Detects the cross-region inference type from a profile ID.
 * - Profile IDs with geographic prefixes (us., eu., ap.) → 'geo'
 * - Profile IDs with global prefix or no geographic prefix → 'global'
 * - Standard model IDs → 'none'
 */
function detectCrossRegionType(profileId: string): CrossRegionType {
  // Geographic prefixes indicate geo cross-region
  if (/^[a-z]{2}\./.test(profileId)) {
    return 'geo';
  }
  // If it's an inference profile without a geo prefix, it's global
  return 'global';
}

/**
 * Parses a raw Bedrock invocation log JSON object and extracts all required fields
 * into a structured InvocationRecord.
 *
 * This function is exported so it can be unit-tested without S3/DynamoDB dependencies.
 *
 * Requirements: 5.2, 5.4, 5.5, 5.7
 */
// ─── Tier / Cache extraction pure functions ───────────────────────────────────

/**
 * Extracts the inference tier from the raw Bedrock request body.
 * The service tier is NOT a top-level log field — it lives inside
 * input.inputBodyJson as "service_tier".
 *
 * Requirements: 4.5, 4.6
 */
export function extractTierFromRequestBody(inputBodyJson: unknown): InferenceTier {
  let body: Record<string, unknown>;

  if (typeof inputBodyJson === 'string') {
    try {
      const parsed = JSON.parse(inputBodyJson);
      if (typeof parsed !== 'object' || parsed === null) return 'standard';
      body = parsed as Record<string, unknown>;
    } catch {
      return 'standard';
    }
  } else if (typeof inputBodyJson === 'object' && inputBodyJson !== null) {
    body = inputBodyJson as Record<string, unknown>;
  } else {
    return 'standard';
  }

  const tier = body['service_tier'];
  switch (tier) {
    case 'priority': return 'priority';
    case 'flex':     return 'flex';
    case 'reserved': return 'standard'; // reserved billed at standard token rates
    case 'default':
    default:         return 'standard';
  }
}

/**
 * Determines the cache write TTL by scanning the serialised request body for
 * cachePoint objects containing "ttl": "1h".  Returns '5m' as the default.
 *
 * Requirements: 4.9, 4.10
 */
export function extractCacheTtlFromRequestBody(inputBodyJson: unknown): '5m' | '1h' {
  // If already a string, use it directly; otherwise serialise to JSON for scanning.
  const json = typeof inputBodyJson === 'string'
    ? inputBodyJson
    : JSON.stringify(inputBodyJson ?? '');
  if (json.includes('"ttl":"1h"') || json.includes('"ttl": "1h"')) return '1h';
  return '5m';
}

export /**
 * Extracts a human-friendly user name from an IAM ARN.
 * - "arn:aws:iam::123456789012:user/alice" → "alice"
 * - "arn:aws:sts::123456789012:assumed-role/MyRole/session-name" → "MyRole/session-name"
 * - "arn:aws:iam::123456789012:root" → "root"
 * - empty/unknown → "unknown"
 */
function extractUserNameFromArn(arn: string): string {
  if (!arn) return 'unknown';
  // Split on ':' — ARN format is arn:partition:service:region:account:resource
  const parts = arn.split(':');
  if (parts.length < 6) return arn; // not a valid ARN, return as-is
  const resource = parts.slice(5).join(':'); // everything after account
  // resource could be "user/alice", "assumed-role/RoleName/session", "root", etc.
  if (resource.startsWith('assumed-role/')) {
    // "assumed-role/RoleName/session" → "RoleName/session"
    return resource.substring('assumed-role/'.length);
  }
  if (resource.startsWith('user/')) {
    return resource.substring('user/'.length);
  }
  if (resource.startsWith('role/')) {
    return resource.substring('role/'.length);
  }
  return resource || 'unknown';
}

export function parseInvocationLog(logJson: unknown): InvocationRecord {
  if (typeof logJson !== 'object' || logJson === null) {
    throw new Error('Invalid invocation log: expected a JSON object');
  }

  const log = logJson as BedrockInvocationLog;

  if (!log.requestId) throw new Error('Missing required field: requestId');
  if (!log.timestamp) throw new Error('Missing required field: timestamp');
  if (!log.modelId) throw new Error('Missing required field: modelId');

  const executionRegion = log.region ?? process.env['AWS_REGION'] ?? 'unknown';
  const { resolvedModelId, sourceRegion, executionRegion: resolvedExecRegion, crossRegionType } =
    resolveInferenceProfile(log.modelId, executionRegion);

  const inputTokens = log.input?.inputTokenCount ?? 0;
  const outputTokens = log.output?.outputTokenCount ?? 0;

  // Latency: try top-level output.latencyMs first, then parse from outputBodyJson.metrics.latencyMs
  let latencyMs = log.output?.latencyMs ?? 0;
  if (latencyMs === 0 && log.output?.outputBodyJson) {
    try {
      const bodyStr = typeof log.output.outputBodyJson === 'string'
        ? log.output.outputBodyJson
        : JSON.stringify(log.output.outputBodyJson);
      const parsed = JSON.parse(bodyStr);
      latencyMs = parsed?.metrics?.latencyMs ?? 0;
    } catch {
      // outputBodyJson not parseable — keep latencyMs as 0
    }
  }
  const callerArn = log.identity?.arn ?? '';
  const rawRequest = typeof log.input?.inputBodyJson === 'string'
    ? log.input.inputBodyJson
    : (log.input?.inputBodyJson != null ? JSON.stringify(log.input.inputBodyJson) : '');
  const rawResponse = typeof log.output?.outputBodyJson === 'string'
    ? log.output.outputBodyJson
    : (log.output?.outputBodyJson != null ? JSON.stringify(log.output.outputBodyJson) : '');

  // ── New fields: tier, cache type, cache token counts ──────────────────────
  const inferenceTier = extractTierFromRequestBody(log.input?.inputBodyJson);
  const cacheWriteInputTokens = log.input?.cacheWriteInputTokenCount ?? 0;
  const cacheReadInputTokens = log.input?.cacheReadInputTokenCount ?? 0;

  let cacheType: CacheType = 'none';
  if (cacheWriteInputTokens > 0 && cacheReadInputTokens > 0) {
    // Both non-zero — write takes precedence; log a warning
    console.warn(
      `Both cacheWriteInputTokenCount (${cacheWriteInputTokens}) and cacheReadInputTokenCount (${cacheReadInputTokens}) are non-zero for requestId=${log.requestId}. Using write TTL for cacheType.`,
    );
    const ttl = extractCacheTtlFromRequestBody(log.input?.inputBodyJson);
    cacheType = ttl === '1h' ? 'cacheWrite1h' : 'cacheWrite5m';
  } else if (cacheWriteInputTokens > 0) {
    const ttl = extractCacheTtlFromRequestBody(log.input?.inputBodyJson);
    cacheType = ttl === '1h' ? 'cacheWrite1h' : 'cacheWrite5m';
  } else if (cacheReadInputTokens > 0) {
    cacheType = 'cacheRead';
  }

  const record: InvocationRecord = {
    requestId: log.requestId,
    timestamp: log.timestamp,
    accountId: log.accountId ?? '',
    region: executionRegion,
    modelId: log.modelId,
    resolvedModelId,
    inputTokens,
    outputTokens,
    latencyMs,
    callerArn,
    // Extract a friendly user name from the caller ARN
    // e.g. "arn:aws:iam::123456789012:user/alice" → "alice"
    // e.g. "arn:aws:sts::123456789012:assumed-role/MyRole/session" → "MyRole/session"
    // e.g. "arn:aws:iam::123456789012:root" → "root"
    resolvedUserId: callerArn,
    resolvedUserName: extractUserNameFromArn(callerArn),
    resolvedUserEmail: '',
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    costStatus: 'pending',
    rawRequest,
    rawResponse,
    sourceRegion,
    executionRegion: resolvedExecRegion,
    // New fields
    inferenceTier,
    cacheType,
    crossRegionType,
    cacheWriteInputTokens,
    cacheReadInputTokens,
  };

  // Agent invocation fields
  if (log.agentId !== undefined) {
    record.agentId = log.agentId;
  }
  if (log.agentAlias !== undefined) {
    record.agentAlias = log.agentAlias;
  }

  // Image model fields
  if (log.output?.imageCount !== undefined) {
    record.imageCount = log.output.imageCount;
  }
  if (log.output?.imageDimensions !== undefined) {
    record.imageDimensions = log.output.imageDimensions;
  }

  // Video model fields
  if (log.output?.videoDurationSeconds !== undefined) {
    record.videoDurationSeconds = log.output.videoDurationSeconds;
  }
  if (log.output?.videoResolution !== undefined) {
    record.videoResolution = log.output.videoResolution;
  }

  // Audio model fields — detect from model ID pattern (e.g. nova-sonic)
  const modelLower = log.modelId.toLowerCase();
  if (modelLower.includes('sonic') || modelLower.includes('speech') || modelLower.includes('audio')) {
    // Audio duration may come from latency or a dedicated field
    // For speech-to-speech models, the duration is typically derived from the session
    if (log.output?.latencyMs && log.output.latencyMs > 0) {
      record.audioDurationSeconds = log.output.latencyMs / 1000;
    }
  }

  // Guardrail
  if (log.guardrailId !== undefined) {
    record.guardrailId = log.guardrailId;
  }

  return record;
}

// ─── S3 Helpers ───────────────────────────────────────────────────────────────

async function getS3Object(bucket: string, key: string): Promise<string> {
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const body = response.Body;
  if (!body) throw new Error(`Empty S3 object: s3://${bucket}/${key}`);
  // Body is a ReadableStream in Node.js SDK v3
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const rawBuffer = Buffer.concat(chunks);
  // Decompress gzipped content if the key ends with .gz
  if (key.endsWith('.gz')) {
    const { gunzipSync } = await import('zlib');
    return gunzipSync(rawBuffer).toString('utf-8');
  }
  return rawBuffer.toString('utf-8');
}

async function putS3Object(bucket: string, key: string, body: Buffer | string): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
    }),
  );
}

async function writeFailedRecord(
  bucket: string,
  processorName: string,
  requestId: string,
  timestamp: string,
  error: string,
  originalContent: string,
): Promise<void> {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const key = `${FAILED_RECORDS_PREFIX}/${processorName}/${year}/${month}/${day}/${requestId}.json`;

  const failedRecord = JSON.stringify({
    requestId,
    timestamp,
    processorName,
    error,
    failedAt: new Date().toISOString(),
    originalContent,
  });

  await putS3Object(bucket, key, failedRecord);
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

/**
 * S3 event-triggered Lambda handler that processes Bedrock invocation log JSON files.
 *
 * For each S3 object in the event:
 * 1. Downloads and parses the JSON log
 * 2. Checks idempotency (skips if already processed)
 * 3. Writes processed record as Parquet to the processed data bucket
 *    (cost fields set to 0 with costStatus: 'pending' — reconciled asynchronously via CUR)
 * 4. Marks the record as processed in the idempotency table
 * 5. On failure: writes failed record to the failed records bucket
 *
 * Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 13.2, 13.4, 17.2, 17.4
 */
export const handler = async (event: S3Event): Promise<void> => {
  const processedDataBucket = getEnv('PROCESSED_DATA_BUCKET');
  const failedRecordsBucket = getEnv('FAILED_RECORDS_BUCKET');
  const regionMode = getEnv('REGION_MODE', 'single');
  const processorName = getEnv('PROCESSOR_NAME', 'invocation');
  const idempotencyChecker = getIdempotencyChecker();

  for (const record of event.Records) {
    const s3Record = record as S3EventRecord;
    const bucket = s3Record.s3.bucket.name;
    const key = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));
    const awsRegion = s3Record.awsRegion;

    let rawContent = '';
    let requestId = `unknown-${Date.now()}`;
    let timestamp = new Date().toISOString();

    try {
      rawContent = await getS3Object(bucket, key);
      const lines = rawContent.trim().split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const logJson = JSON.parse(line) as unknown;
          const invocationRecord = parseInvocationLog(logJson);

          requestId = invocationRecord.requestId;
          timestamp = invocationRecord.timestamp;

          const alreadyProcessed = await idempotencyChecker.isProcessed(requestId, timestamp);
          if (alreadyProcessed) {
            console.log(`Skipping duplicate record: requestId=${requestId}`);
            continue;
          }

          // Write Parquet to processed data bucket
          const parquetBuffer = await writeParquet([invocationRecord as unknown as Record<string, unknown>], INVOCATION_LOG_SCHEMA);
          const partitionRegion = regionMode === 'multi' ? (awsRegion ?? invocationRecord.region) : undefined;
          const partitionPath = generatePartitionPath(
            'invocation-logs',
            new Date(timestamp),
            partitionRegion,
          );
          const outputKey = `${partitionPath}${requestId}.parquet`;

          await putS3Object(processedDataBucket, outputKey, parquetBuffer);

          // Mark as processed
          await idempotencyChecker.markProcessed(requestId, timestamp, processorName);

          console.log(`Processed invocation log: requestId=${requestId}, key=${outputKey}, costStatus=pending`);
        } catch (lineErr: unknown) {
          const errorMessage = lineErr instanceof Error ? lineErr.message : String(lineErr);
          console.error(`Failed to process line in ${key}: ${errorMessage}`);
        }
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Failed to process record: key=${key}, error=${errorMessage}`);

      try {
        await writeFailedRecord(failedRecordsBucket, processorName, requestId, timestamp, errorMessage, rawContent);
      } catch (writeErr: unknown) {
        console.error('Failed to write failed record:', writeErr);
      }
      throw err;
    }
  }
};
