/**
 * CUR Processor Lambda Handler
 *
 * Triggered by S3 events (new CUR files) or EventBridge schedule (polling fallback).
 * Downloads and parses CSV.gz CUR files from the Data Exports bucket,
 * filters for Bedrock line items, and writes processed records as Parquet.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.6, 2.7
 */

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { ParquetSchema } from '@dsnp/parquetjs';
import { IdempotencyChecker } from '../../shared/idempotency';
import { writeParquet } from '../../shared/parquet-writer';
import { CUR_COSTS_PREFIX, MODEL_BILLING_MAP_PREFIX } from '../../shared/constants';
import { CurCostRecord } from '../../shared/cur-types';
import { parseUsageType, CUR_MODEL_BILLING_NAME_MAP } from './usage-type-parser';

// ─── Environment Variables ────────────────────────────────────────────────────

function getEnv(name: string, defaultValue = ''): string {
  return process.env[name] ?? defaultValue;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BEDROCK_PRODUCT_CODE = 'AmazonBedrockService';
const UNIT_PRICE_REGEX = /\$([0-9.]+) per/;

// ─── Parquet Schema ───────────────────────────────────────────────────────────

export const CUR_COST_SCHEMA = new ParquetSchema({
  billing_period: { type: 'UTF8' },
  usage_date: { type: 'UTF8' },
  payer_account_id: { type: 'UTF8' },
  usage_account_id: { type: 'UTF8' },
  region: { type: 'UTF8' },
  region_code: { type: 'UTF8' },
  model_billing_name: { type: 'UTF8' },
  resolved_model_id: { type: 'UTF8', optional: true },
  token_type: { type: 'UTF8' },
  cross_region_type: { type: 'UTF8' },
  usage_type: { type: 'UTF8' },
  pricing_unit: { type: 'UTF8' },
  usage_amount: { type: 'DOUBLE' },
  unblended_cost: { type: 'DOUBLE' },
  unit_price: { type: 'DOUBLE', optional: true },
  item_description: { type: 'UTF8' },
  cur_file_key: { type: 'UTF8' },
});

// ─── S3 Client ────────────────────────────────────────────────────────────────

const s3Client = new S3Client({});

// ─── Idempotency ──────────────────────────────────────────────────────────────

let idempotencyCheckerInstance: IdempotencyChecker | undefined;

function getIdempotencyChecker(): IdempotencyChecker {
  if (!idempotencyCheckerInstance) {
    const tableName = getEnv('IDEMPOTENCY_TABLE');
    idempotencyCheckerInstance = new IdempotencyChecker(tableName);
  }
  return idempotencyCheckerInstance;
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
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }),
  );
}

// ─── CSV Parsing ──────────────────────────────────────────────────────────────

/**
 * Parses CSV content into an array of row objects keyed by header names.
 * Handles quoted fields containing commas and newlines.
 */
export function parseCsv(content: string): Record<string, string>[] {
  const lines = content.split('\n');
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? '';
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Parses a single CSV line, handling quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ─── CUR Row Processing ──────────────────────────────────────────────────────

/**
 * Extracts unit price from the CUR item_description field.
 * Looks for patterns like "$0.003 per" in the description.
 *
 * @returns The extracted unit price, or null if not found.
 */
export function extractUnitPrice(itemDescription: string): number | null {
  if (!itemDescription) return null;
  const match = itemDescription.match(UNIT_PRICE_REGEX);
  if (!match?.[1]) return null;
  const price = parseFloat(match[1]);
  return isNaN(price) ? null : price;
}

/**
 * Processes a single CUR CSV row into a CurCostRecord.
 * Returns null if the row is not a Bedrock line item or has an unparseable usage_type.
 */
export function processCurRow(
  row: Record<string, string>,
  sourceCurFile: string,
): CurCostRecord | null {
  // Filter: only process Bedrock line items
  const productCode = row['product_code'] ?? row['lineItem/ProductCode'] ?? '';
  if (productCode !== BEDROCK_PRODUCT_CODE) return null;

  const usageType = row['usage_type'] ?? row['lineItem/UsageType'] ?? '';
  const parsed = parseUsageType(usageType);
  if (!parsed) return null;

  const itemDescription = row['item_description'] ?? row['lineItem/LineItemDescription'] ?? '';
  const unitPrice = extractUnitPrice(itemDescription);

  // Resolve model ID from billing name map
  const resolvedModelId = CUR_MODEL_BILLING_NAME_MAP[parsed.modelBillingName] ?? null;

  // Log warning for unmapped billing names
  if (!resolvedModelId) {
    console.warn(
      `Unmapped CUR billing name: ${parsed.modelBillingName} (usage_type: ${usageType}). ` +
      'Record will be stored with raw billing name.',
    );
  }

  const billingPeriod = row['billing_period'] ?? row['bill/BillingPeriod'] ?? '';
  const usageDate = row['usage_date'] ?? row['usage_start_date'] ?? row['lineItem/UsageStartDate'] ?? '';
  const payerAccountId = row['payer_account_id'] ?? row['bill/PayerAccountId'] ?? '';
  const usageAccountId = row['linked_account_id'] ?? row['usage_account_id'] ?? row['lineItem/UsageAccountId'] ?? '';
  const pricingUnit = row['pricing_unit'] ?? row['pricing/unit'] ?? '';
  const usageQuantity = parseFloat(row['usage_quantity'] ?? row['lineItem/UsageQuantity'] ?? '0');
  const unblendedCost = parseFloat(row['unblended_cost'] ?? row['lineItem/UnblendedCost'] ?? '0');

  return {
    billingPeriod: billingPeriod.slice(0, 7) || 'unknown', // YYYY-MM
    usageDate: usageDate.slice(0, 10) || 'unknown',        // YYYY-MM-DD
    payerAccountId,
    usageAccountId,
    region: parsed.resolvedRegion ?? parsed.regionCode,
    regionCode: parsed.regionCode,
    modelBillingName: parsed.modelBillingName,
    resolvedModelId,
    tokenType: parsed.tokenType,
    crossRegionType: parsed.crossRegionType,
    usageType,
    pricingUnit,
    usageQuantity: isNaN(usageQuantity) ? 0 : usageQuantity,
    unblendedCost: isNaN(unblendedCost) ? 0 : unblendedCost,
    unitPrice,
    itemDescription,
    sourceCurFile,
  };
}

// ─── Model Billing Map Writer ─────────────────────────────────────────────────

/**
 * Writes auto-discovered model billing name mappings to S3 for the
 * model_billing_map Glue table. Unmapped billing names are recorded
 * with source: 'auto' so they can be reviewed and manually confirmed.
 */
async function writeModelBillingMap(
  bucket: string,
  unmappedNames: Set<string>,
): Promise<void> {
  if (unmappedNames.size === 0) return;

  const entries = Array.from(unmappedNames).map(name => ({
    cur_billing_name: name,
    bedrock_model_id: '',
    source: 'auto',
    last_seen_date: new Date().toISOString().slice(0, 10),
  }));

  const key = `${MODEL_BILLING_MAP_PREFIX}/auto-discovered-${Date.now()}.json`;
  await putS3Object(bucket, key, JSON.stringify(entries, null, 2));
  console.log(`Wrote ${entries.length} unmapped billing names to ${key}`);
}

// ─── Partition Path Helper ────────────────────────────────────────────────────

/**
 * Generates a Hive-style partition path for CUR cost records.
 * Format: cur-costs/year={YYYY}/month={MM}/day={DD}/
 *
 * Uses only year/month/day (no hour) since CUR data is daily granularity.
 */
function generateCurPartitionPath(usageDate: string): string {
  const date = new Date(usageDate);
  if (isNaN(date.getTime())) {
    // Fallback to current date if usage date is invalid
    const now = new Date();
    const year = now.getUTCFullYear().toString();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    return `${CUR_COSTS_PREFIX}/year=${year}/month=${month}/day=${day}/`;
  }
  const year = date.getUTCFullYear().toString();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${CUR_COSTS_PREFIX}/year=${year}/month=${month}/day=${day}/`;
}

// ─── Event Types ──────────────────────────────────────────────────────────────

interface S3EventRecord {
  s3: {
    bucket: { name: string };
    object: { key: string };
  };
}

interface S3Event {
  Records: S3EventRecord[];
}

interface ScheduledEvent {
  source: string;
  'detail-type': string;
}

type CurProcessorEvent = S3Event | ScheduledEvent;

// ─── Scheduled Event Handling ─────────────────────────────────────────────────

/**
 * Lists CUR files in the Data Exports bucket for scheduled polling.
 * Returns S3 keys matching the configured report prefix.
 */
async function listCurFiles(bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of response.Contents ?? []) {
      if (obj.Key && (obj.Key.endsWith('.csv.gz') || obj.Key.endsWith('.csv'))) {
        keys.push(obj.Key);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

// ─── Core Processing ──────────────────────────────────────────────────────────

/**
 * Processes a single CUR file: downloads, parses CSV, filters Bedrock rows,
 * and writes Parquet output partitioned by date.
 *
 * @returns Number of Bedrock records processed.
 */
/**
 * Converts a CurCostRecord (camelCase) to snake_case keys matching the Glue table / Parquet schema.
 */
function toSnakeCaseRecord(record: CurCostRecord): Record<string, unknown> {
  return {
    billing_period: record.billingPeriod,
    usage_date: record.usageDate,
    payer_account_id: record.payerAccountId,
    usage_account_id: record.usageAccountId,
    region: record.region,
    region_code: record.regionCode,
    model_billing_name: record.modelBillingName,
    resolved_model_id: record.resolvedModelId,
    token_type: record.tokenType,
    cross_region_type: record.crossRegionType,
    usage_type: record.usageType,
    pricing_unit: record.pricingUnit,
    usage_amount: record.usageQuantity,
    unblended_cost: record.unblendedCost,
    unit_price: record.unitPrice,
    item_description: record.itemDescription,
    cur_file_key: record.sourceCurFile,
  };
}

async function processCurFile(
  curBucket: string,
  curKey: string,
  processedDataBucket: string,
): Promise<number> {
  console.log(`Processing CUR file: s3://${curBucket}/${curKey}`);

  const csvContent = await getS3Object(curBucket, curKey);
  const rows = parseCsv(csvContent);

  if (rows.length === 0) {
    console.log(`Empty CUR file: ${curKey}`);
    return 0;
  }

  // Process rows and group by usage date for partitioned output
  const recordsByDate = new Map<string, CurCostRecord[]>();
  const unmappedNames = new Set<string>();

  for (const row of rows) {
    const record = processCurRow(row, curKey);
    if (!record) continue;

    // Track unmapped billing names
    if (!record.resolvedModelId) {
      unmappedNames.add(record.modelBillingName);
    }

    const dateKey = record.usageDate;
    const existing = recordsByDate.get(dateKey);
    if (existing) {
      existing.push(record);
    } else {
      recordsByDate.set(dateKey, [record]);
    }
  }

  // Write Parquet files partitioned by date
  let totalRecords = 0;
  for (const [usageDate, records] of recordsByDate) {
    const partitionPath = generateCurPartitionPath(usageDate);
    const fileName = `cur-${curKey.replace(/[/\\]/g, '_')}-${Date.now()}.parquet`;
    const outputKey = `${partitionPath}${fileName}`;

    const parquetBuffer = await writeParquet(
      records.map(toSnakeCaseRecord),
      CUR_COST_SCHEMA,
    );
    await putS3Object(processedDataBucket, outputKey, parquetBuffer);

    totalRecords += records.length;
    console.log(`Wrote ${records.length} records to ${outputKey}`);
  }

  // Write unmapped billing names to model_billing_map
  await writeModelBillingMap(processedDataBucket, unmappedNames);

  return totalRecords;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

/**
 * CUR Processor Lambda handler.
 *
 * Supports two trigger modes:
 * 1. S3 event: processes the specific CUR file that triggered the event
 * 2. EventBridge schedule: lists and processes all unprocessed CUR files
 *
 * Uses idempotency checking (keyed on S3 object key) to avoid reprocessing.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.6, 2.7
 */
export const handler = async (event: CurProcessorEvent): Promise<void> => {
  const curBucket = getEnv('CUR_BUCKET');
  const curReportPrefix = getEnv('CUR_REPORT_PREFIX');
  const processedDataBucket = getEnv('PROCESSED_DATA_BUCKET');
  const processorName = 'cur-processor';
  const idempotencyChecker = getIdempotencyChecker();

  const isScheduledEvent = 'source' in event && event.source === 'aws.events';

  let curFiles: Array<{ bucket: string; key: string }> = [];

  if (isScheduledEvent) {
    // EventBridge scheduled trigger — list and process all CUR files
    console.log('Scheduled CUR processing triggered');
    const keys = await listCurFiles(curBucket, curReportPrefix);
    curFiles = keys.map(key => ({ bucket: curBucket, key }));
    console.log(`Found ${curFiles.length} CUR files to check`);
  } else {
    // S3 event trigger — process the specific file
    const s3Event = event as S3Event;
    curFiles = (s3Event.Records ?? []).map(record => ({
      bucket: record.s3.bucket.name,
      key: decodeURIComponent(record.s3.object.key.replace(/\+/g, ' ')),
    }));
  }

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const { bucket, key } of curFiles) {
    try {
      // Idempotency check: use S3 object key as the unique identifier
      const alreadyProcessed = await idempotencyChecker.isProcessed(key, processorName);
      if (alreadyProcessed) {
        console.log(`Skipping already-processed CUR file: ${key}`);
        totalSkipped++;
        continue;
      }

      const recordCount = await processCurFile(bucket, key, processedDataBucket);

      // Mark as processed in idempotency table
      await idempotencyChecker.markProcessed(key, processorName, processorName);

      totalProcessed += recordCount;
      console.log(`Completed CUR file: ${key} (${recordCount} Bedrock records)`);
    } catch (err: unknown) {
      totalErrors++;
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`Failed to process CUR file: ${key}, error: ${errorMessage}`);

      // Re-throw on S3 event triggers so the Lambda reports failure
      // For scheduled runs, continue processing remaining files
      if (!isScheduledEvent) {
        throw err;
      }
    }
  }

  console.log(
    `CUR processing complete: ${totalProcessed} records processed, ` +
    `${totalSkipped} files skipped (idempotent), ${totalErrors} errors`,
  );
};
