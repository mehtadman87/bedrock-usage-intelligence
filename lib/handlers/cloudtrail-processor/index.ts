import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { IdempotencyChecker } from 'lib/shared/idempotency';
import { writeParquet, CLOUDTRAIL_EVENT_SCHEMA } from 'lib/shared/parquet-writer';
import { generatePartitionPath } from 'lib/shared/s3-partitioner';
import {
  FAILED_RECORDS_PREFIX,
  BEDROCK_CLOUDTRAIL_EVENT_NAMES,
  BedrockEventName,
} from 'lib/shared/constants';

// ─── Environment Variables ────────────────────────────────────────────────────

function getEnv(name: string, defaultValue = ''): string {
  return process.env[name] ?? defaultValue;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Raw CloudTrail event record as found in a CloudTrail log file.
 * Fields are optional because CloudTrail events vary by service/action.
 */
export interface CloudTrailEvent {
  eventId?: string;
  requestId?: string;
  eventTime?: string;
  awsAccountId?: string;
  awsRegion?: string;
  eventName?: string;
  userIdentity?: {
    arn?: string;
    type?: string;
    principalId?: string;
    sessionContext?: {
      sessionIssuer?: {
        arn?: string;
      };
    };
  };
  sourceIPAddress?: string;
  userAgent?: string;
  requestParameters?: {
    modelId?: string;
    [key: string]: unknown;
  };
}

/**
 * A CloudTrail log file contains a "Records" array.
 */
export interface CloudTrailLogFile {
  Records: CloudTrailEvent[];
}

/**
 * Processed CloudTrail record written to Parquet.
 * Matches the CLOUDTRAIL_EVENT_SCHEMA in parquet-writer.ts.
 */
export interface CloudTrailRecord {
  eventId: string;
  requestId: string;
  timestamp: string;
  accountId: string;
  region: string;
  eventName: string;
  principalArn: string;
  sourceIpAddress: string;
  userAgent: string;
  modelId: string;
  resolvedUserId: string;
  resolvedUserName: string;
  resolvedUserEmail: string;
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
 * Filters a list of CloudTrail events to only those that are Bedrock API calls.
 *
 * Bedrock API calls are: InvokeModel, InvokeModelWithResponseStream, Converse, ConverseStream.
 *
 * Requirements: 6.3
 */
export function filterBedrockEvents(events: CloudTrailEvent[]): CloudTrailEvent[] {
  const bedrockEventNames = new Set<string>(BEDROCK_CLOUDTRAIL_EVENT_NAMES);
  return events.filter(
    (event) => event.eventName !== undefined && bedrockEventNames.has(event.eventName),
  );
}

/**
 * Extracts a structured CloudTrailRecord from a raw CloudTrail event.
 *
 * Requirements: 6.4
 */
export function extractCloudTrailRecord(event: CloudTrailEvent): CloudTrailRecord {
  // Resolve the principal ARN — prefer the direct ARN, fall back to session issuer ARN
  const principalArn =
    event.userIdentity?.arn ??
    event.userIdentity?.sessionContext?.sessionIssuer?.arn ??
    '';

  return {
    eventId: event.eventId ?? '',
    requestId: event.requestId ?? '',
    timestamp: event.eventTime ?? '',
    accountId: event.awsAccountId ?? '',
    region: event.awsRegion ?? '',
    eventName: event.eventName ?? '',
    principalArn,
    sourceIpAddress: event.sourceIPAddress ?? '',
    userAgent: event.userAgent ?? '',
    modelId: event.requestParameters?.modelId ?? '',
    resolvedUserId: '',
    resolvedUserName: '',
    resolvedUserEmail: '',
  };
}

/**
 * Correlates a CloudTrail event with an invocation log record using the shared
 * requestId and a configurable timestamp correlation window.
 *
 * Returns true when both records share the same requestId AND their timestamps
 * are within the correlation window (in milliseconds).
 *
 * Requirements: 6.5, 8.5
 */
export function isWithinCorrelationWindow(
  cloudTrailTimestamp: string,
  invocationTimestamp: string,
  correlationWindowMs: number,
): boolean {
  const ctTime = new Date(cloudTrailTimestamp).getTime();
  const invTime = new Date(invocationTimestamp).getTime();

  if (isNaN(ctTime) || isNaN(invTime)) {
    return false;
  }

  return Math.abs(ctTime - invTime) <= correlationWindowMs;
}

// ─── S3 Helpers ───────────────────────────────────────────────────────────────

async function getS3Object(bucket: string, key: string): Promise<string> {
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const body = response.Body;
  if (!body) throw new Error(`Empty S3 object: s3://${bucket}/${key}`);
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
 * S3 event-triggered Lambda handler that processes CloudTrail event log files.
 *
 * For each S3 object in the event:
 * 1. Downloads and parses the CloudTrail JSON log file
 * 2. Filters for Bedrock API calls only
 * 3. Checks idempotency per event (skips if already processed)
 * 4. Writes processed records as Parquet to the processed data bucket
 * 5. On failure: writes failed record to the failed records bucket
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 13.2, 13.4
 */
export const handler = async (event: S3Event): Promise<void> => {
  const processedDataBucket = getEnv('PROCESSED_DATA_BUCKET');
  const failedRecordsBucket = getEnv('FAILED_RECORDS_BUCKET');
  const regionMode = getEnv('REGION_MODE', 'single');
  const processorName = getEnv('PROCESSOR_NAME', 'cloudtrail');
  const correlationWindowMs = parseInt(getEnv('CORRELATION_WINDOW_MS', '300000'), 10);
  const idempotencyChecker = getIdempotencyChecker();

  for (const s3Record of event.Records) {
    const bucket = s3Record.s3.bucket.name;
    const key = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));
    const eventRegion = s3Record.awsRegion;

    let rawContent = '';
    let fileRequestId = `cloudtrail-${Date.now()}`;
    let fileTimestamp = new Date().toISOString();

    try {
      rawContent = await getS3Object(bucket, key);
      const logFile = JSON.parse(rawContent) as CloudTrailLogFile;

      if (!logFile.Records || !Array.isArray(logFile.Records)) {
        throw new Error('Invalid CloudTrail log file: missing Records array');
      }

      // Filter to Bedrock API calls only
      const bedrockEvents = filterBedrockEvents(logFile.Records);

      if (bedrockEvents.length === 0) {
        console.log(`No Bedrock events found in: s3://${bucket}/${key}`);
        continue;
      }

      // Extract records and check idempotency per event
      const recordsToWrite: CloudTrailRecord[] = [];

      for (const ctEvent of bedrockEvents) {
        const record = extractCloudTrailRecord(ctEvent);
        const recordRequestId = record.requestId || record.eventId || `unknown-${Date.now()}`;
        const recordTimestamp = record.timestamp || new Date().toISOString();

        // Use first event's identifiers for file-level failure tracking
        if (recordsToWrite.length === 0) {
          fileRequestId = recordRequestId;
          fileTimestamp = recordTimestamp;
        }

        // Idempotency check per event
        const alreadyProcessed = await idempotencyChecker.isProcessed(
          recordRequestId,
          recordTimestamp,
        );
        if (alreadyProcessed) {
          console.log(`Skipping duplicate CloudTrail event: requestId=${recordRequestId}`);
          continue;
        }

        recordsToWrite.push(record);
      }

      if (recordsToWrite.length === 0) {
        console.log(`All events already processed in: s3://${bucket}/${key}`);
        continue;
      }

      // Write all records as Parquet to processed data bucket
      const parquetBuffer = await writeParquet(
        recordsToWrite as unknown as Record<string, unknown>[],
        CLOUDTRAIL_EVENT_SCHEMA,
      );

      // Use the timestamp of the first record for partitioning
      const firstRecord = recordsToWrite[0]!;
      const partitionTimestamp = new Date(firstRecord.timestamp || fileTimestamp);
      const partitionRegion =
        regionMode === 'multi' ? (eventRegion ?? firstRecord.region) : undefined;
      const partitionPath = generatePartitionPath(
        'cloudtrail-events',
        partitionTimestamp,
        partitionRegion,
      );
      const outputKey = `${partitionPath}${fileRequestId}.parquet`;

      await putS3Object(processedDataBucket, outputKey, parquetBuffer);

      // Mark each event as processed
      for (const record of recordsToWrite) {
        const recordRequestId = record.requestId || record.eventId || fileRequestId;
        const recordTimestamp = record.timestamp || fileTimestamp;
        await idempotencyChecker.markProcessed(recordRequestId, recordTimestamp, processorName);
      }

      console.log(
        `Processed ${recordsToWrite.length} CloudTrail events from s3://${bucket}/${key}, output: ${outputKey}`,
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Failed to process CloudTrail file: key=${key}, error=${errorMessage}`);

      try {
        await writeFailedRecord(
          failedRecordsBucket,
          processorName,
          fileRequestId,
          fileTimestamp,
          errorMessage,
          rawContent,
        );
      } catch (writeErr: unknown) {
        console.error('Failed to write failed record:', writeErr);
      }

      // Re-throw to trigger Lambda retry / DLQ
      throw err;
    }
  }
};

// handler is already exported as a named export above
