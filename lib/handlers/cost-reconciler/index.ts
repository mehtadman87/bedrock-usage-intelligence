/**
 * Cost Reconciler Lambda Handler
 *
 * Triggered by EventBridge schedule (default every 6 hours).
 * Queries CUR cost data and invocation logs via Athena, then computes
 * proportional cost attribution per user.
 *
 * Proportional attribution formula:
 *   user_cost = (user_tokens / total_tokens_in_bucket) × cur_unblended_cost
 *
 * Where a "reconciliation bucket" is a unique key of:
 *   (account, region, model, token_type, cross_region_type, day)
 *
 * Requirements: 2.4, 2.5, 2.6, 2.7
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ParquetSchema } from '@dsnp/parquetjs';
import { writeParquet } from '../../shared/parquet-writer';
import { RECONCILED_COSTS_PREFIX } from '../../shared/constants';
import { CUR_MODEL_BILLING_NAME_MAP } from '../cur-processor/usage-type-parser';
import {
  ReconciledCostRecord,
  CurTokenType,
  CurCrossRegionType,
} from '../../shared/cur-types';

// ─── Environment Variables ────────────────────────────────────────────────────

function getEnv(name: string, defaultValue = ''): string {
  return process.env[name] ?? defaultValue;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ATHENA_POLL_INTERVAL_MS = 2000;
const ATHENA_MAX_POLL_ATTEMPTS = 150; // 5 min max at 2s intervals

/**
 * Maps CUR token types to the corresponding invocation log field used for
 * proportional attribution. Non-token pricing models use different fields.
 */
const TOKEN_TYPE_TO_INVOCATION_FIELD: Record<string, string> = {
  'input-tokens': 'inputtokens',
  'output-tokens': 'outputtokens',
  'cache-read-input-token-count': 'cachereadinputtokens',
  'cache-write-input-token-count': 'cachewriteinputtokens',
};

/**
 * Maps CUR pricing units to invocation log fields for non-token models.
 */
const PRICING_UNIT_TO_FIELD: Record<string, string> = {
  Images: 'imagecount',
  Seconds: 'videodurationseconds',
};

// ─── Parquet Schema ───────────────────────────────────────────────────────────

export const RECONCILED_COST_SCHEMA = new ParquetSchema({
  usage_date: { type: 'UTF8' },
  account_id: { type: 'UTF8' },
  region: { type: 'UTF8' },
  model_id: { type: 'UTF8' },
  model_billing_name: { type: 'UTF8' },
  token_type: { type: 'UTF8' },
  cross_region_type: { type: 'UTF8' },
  resolved_user_id: { type: 'UTF8' },
  resolved_user_name: { type: 'UTF8' },
  user_tokens: { type: 'DOUBLE' },
  total_tokens_in_bucket: { type: 'DOUBLE' },
  proportion: { type: 'DOUBLE' },
  bucket_unblended_cost: { type: 'DOUBLE' },
  attributed_cost: { type: 'DOUBLE' },
  reconciliation_status: { type: 'UTF8' },
});

// ─── AWS Clients ──────────────────────────────────────────────────────────────

const athenaClient = new AthenaClient({});
const s3Client = new S3Client({});

// ─── Athena Query Helpers ─────────────────────────────────────────────────────

/**
 * Executes an Athena query and waits for completion.
 * Returns the query execution ID for fetching results.
 */
async function executeAthenaQuery(
  query: string,
  database: string,
  workgroup: string,
  outputLocation: string,
): Promise<string> {
  const startResult = await athenaClient.send(
    new StartQueryExecutionCommand({
      QueryString: query,
      QueryExecutionContext: { Database: database },
      WorkGroup: workgroup,
      ResultConfiguration: { OutputLocation: outputLocation },
    }),
  );

  const queryExecutionId = startResult.QueryExecutionId;
  if (!queryExecutionId) {
    throw new Error('Athena StartQueryExecution returned no QueryExecutionId');
  }

  // Poll for completion
  for (let attempt = 0; attempt < ATHENA_MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(ATHENA_POLL_INTERVAL_MS);

    const statusResult = await athenaClient.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }),
    );

    const state = statusResult.QueryExecution?.Status?.State;

    if (state === QueryExecutionState.SUCCEEDED) {
      return queryExecutionId;
    }

    if (
      state === QueryExecutionState.FAILED ||
      state === QueryExecutionState.CANCELLED
    ) {
      const reason =
        statusResult.QueryExecution?.Status?.StateChangeReason ?? 'Unknown';
      throw new Error(`Athena query ${state}: ${reason}`);
    }
  }

  throw new Error(
    `Athena query timed out after ${ATHENA_MAX_POLL_ATTEMPTS * ATHENA_POLL_INTERVAL_MS / 1000}s`,
  );
}

/**
 * Fetches all result rows from a completed Athena query.
 * Skips the header row and returns data as string arrays.
 */
async function fetchAthenaResults(
  queryExecutionId: string,
): Promise<string[][]> {
  const rows: string[][] = [];
  let nextToken: string | undefined;
  let isFirstPage = true;

  do {
    const result = await athenaClient.send(
      new GetQueryResultsCommand({
        QueryExecutionId: queryExecutionId,
        NextToken: nextToken,
      }),
    );

    const resultRows = result.ResultSet?.Rows ?? [];
    // Skip header row on first page
    const startIdx = isFirstPage ? 1 : 0;
    isFirstPage = false;

    for (let i = startIdx; i < resultRows.length; i++) {
      const row = resultRows[i];
      const values = (row.Data ?? []).map((d) => d.VarCharValue ?? '');
      rows.push(values);
    }

    nextToken = result.NextToken;
  } while (nextToken);

  return rows;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── CUR Data Query ───────────────────────────────────────────────────────────

/**
 * Represents a CUR cost bucket — one line item aggregated by the reconciliation key.
 */
export interface CurBucket {
  usageDate: string;
  accountId: string;
  region: string;
  modelBillingName: string;
  resolvedModelId: string;
  tokenType: CurTokenType;
  crossRegionType: CurCrossRegionType;
  pricingUnit: string;
  unblendedCost: number;
}

/**
 * Queries the cur_costs Glue table for unreconciled CUR line items
 * in the current and previous billing periods.
 */
async function queryCurCosts(
  database: string,
  workgroup: string,
  outputLocation: string,
): Promise<CurBucket[]> {
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const prevDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevMonth = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}`;

  // AWS Data Exports delivers cumulative CUR snapshots — each new file contains
  // all line items for the billing period to date. We must use only the latest
  // file per billing period to avoid double-counting costs.
  const query = `
    WITH latest_files AS (
      SELECT billing_period, MAX(cur_file_key) AS latest_file
      FROM cur_costs
      WHERE billing_period IN ('${currentMonth}', '${prevMonth}')
      GROUP BY billing_period
    )
    SELECT
      c.usage_date,
      c.usage_account_id,
      c.region,
      c.model_billing_name,
      c.model_billing_name AS resolved_model_id,
      c.token_type,
      c.cross_region_type,
      c.pricing_unit,
      SUM(c.unblended_cost) AS total_unblended_cost
    FROM cur_costs c
    INNER JOIN latest_files lf
      ON c.billing_period = lf.billing_period AND c.cur_file_key = lf.latest_file
    GROUP BY
      c.usage_date,
      c.usage_account_id,
      c.region,
      c.model_billing_name,
      c.token_type,
      c.cross_region_type,
      c.pricing_unit
    HAVING SUM(c.unblended_cost) != 0
  `;

  const queryId = await executeAthenaQuery(query, database, workgroup, outputLocation);
  const rows = await fetchAthenaResults(queryId);

  return rows.map((row) => ({
    usageDate: row[0],
    accountId: row[1],
    region: row[2],
    modelBillingName: row[3],
    resolvedModelId: row[4],
    tokenType: row[5] as CurTokenType,
    crossRegionType: row[6] as CurCrossRegionType,
    pricingUnit: row[7],
    unblendedCost: parseFloat(row[8]) || 0,
  }));
}

// ─── Invocation Log Query ─────────────────────────────────────────────────────

/**
 * Represents aggregated user token usage within a reconciliation bucket.
 */
export interface UserUsage {
  usageDate: string;
  accountId: string;
  region: string;
  modelId: string;
  crossRegionType: string;
  resolvedUserId: string;
  resolvedUserName: string;
  tokenCount: number;
}

/**
 * Queries the invocation_logs Glue table for aggregated token counts
 * per (account, region, model, cross_region_type, day, user).
 *
 * The usageField parameter determines which token field to aggregate
 * (e.g., inputtokens, outputtokens, cachereadinputtokens).
 */
async function queryInvocationLogs(
  database: string,
  workgroup: string,
  outputLocation: string,
  usageField: string,
  dates: string[],
): Promise<UserUsage[]> {
  if (dates.length === 0) return [];

  // Build partition-based date filter for efficient Athena queries
  // Dates are in YYYY-MM-DD format; convert to partition columns (year, month, day)
  const dateConditions = dates.map((d) => {
    const [y, m, dd] = d.split('-');
    return `(year='${y}' AND month='${m}' AND day='${dd}')`;
  }).join(' OR ');

  // Map crossRegionType values from invocation logs to CUR format
  // Invocation logs use sourceregion/executionregion to detect cross-region
  // CUR uses: 'none', 'cross-region-global', 'cross-region-geo'
  const query = `
    SELECT
      CONCAT(year, '-', month, '-', day) AS usage_date,
      accountid,
      executionregion AS region,
      COALESCE(REGEXP_REPLACE(resolvedmodelid, '^(global|us|eu|ap)\.', ''), modelid) AS modelid,
      CASE
        WHEN modelid LIKE '%/global.%' OR modelid LIKE 'global.%' THEN 'cross-region-global'
        WHEN modelid LIKE '%/us.%' OR modelid LIKE '%/eu.%' OR modelid LIKE '%/ap.%'
          OR modelid LIKE 'us.%' OR modelid LIKE 'eu.%' OR modelid LIKE 'ap.%' THEN 'cross-region-geo'
        WHEN LOWER(COALESCE(sourceregion, '')) != LOWER(COALESCE(executionregion, ''))
          AND LOWER(COALESCE(sourceregion, '')) != '' AND LOWER(COALESCE(executionregion, '')) != '' THEN
          'cross-region-global'
        ELSE 'none'
      END AS cross_region_type,
      resolveduserid,
      resolvedusername,
      SUM(COALESCE(CAST(${usageField} AS DOUBLE), 0)) AS total_tokens
    FROM invocation_logs
    WHERE (${dateConditions})
      AND COALESCE(CAST(${usageField} AS DOUBLE), 0) > 0
    GROUP BY
      CONCAT(year, '-', month, '-', day),
      accountid,
      executionregion,
      COALESCE(REGEXP_REPLACE(resolvedmodelid, '^(global|us|eu|ap)\.', ''), modelid),
      CASE
        WHEN modelid LIKE '%/global.%' OR modelid LIKE 'global.%' THEN 'cross-region-global'
        WHEN modelid LIKE '%/us.%' OR modelid LIKE '%/eu.%' OR modelid LIKE '%/ap.%'
          OR modelid LIKE 'us.%' OR modelid LIKE 'eu.%' OR modelid LIKE 'ap.%' THEN 'cross-region-geo'
        WHEN LOWER(COALESCE(sourceregion, '')) != LOWER(COALESCE(executionregion, ''))
          AND LOWER(COALESCE(sourceregion, '')) != '' AND LOWER(COALESCE(executionregion, '')) != '' THEN
          'cross-region-global'
        ELSE 'none'
      END,
      resolveduserid,
      resolvedusername
  `;

  const queryId = await executeAthenaQuery(query, database, workgroup, outputLocation);
  const rows = await fetchAthenaResults(queryId);

  return rows.map((row) => ({
    usageDate: row[0],
    accountId: row[1],
    region: row[2],
    modelId: row[3],
    crossRegionType: row[4],
    resolvedUserId: row[5],
    resolvedUserName: row[6],
    tokenCount: parseFloat(row[7]) || 0,
  }));
}

// ─── Reconciliation Logic ─────────────────────────────────────────────────────

/**
 * Determines the invocation log field to use for a given CUR bucket,
 * based on token type and pricing unit.
 *
 * For non-token pricing models (Images, Seconds), uses the appropriate
 * invocation log field instead of token counts.
 */
function getUsageField(bucket: CurBucket): string {
  // Check for non-token pricing units first
  const unitField = PRICING_UNIT_TO_FIELD[bucket.pricingUnit];
  if (unitField) return unitField;

  // Default to token-type-based field
  return TOKEN_TYPE_TO_INVOCATION_FIELD[bucket.tokenType] ?? 'inputtokens';
}

/**
 * Computes proportional cost attribution for a single reconciliation bucket.
 *
 * Formula: user_cost = (user_tokens / total_tokens_in_bucket) × cur_unblended_cost
 *
 * Edge cases:
 * - Zero-token bucket: cost distributed equally among users (or marked unmatched if no users)
 * - Single-user bucket: 100% of cost attributed to that user
 * - Zero-cost line items: all users get $0 attributed cost
 */
export function computeAttribution(
  bucket: CurBucket,
  users: UserUsage[],
): ReconciledCostRecord[] {
  const { unblendedCost } = bucket;

  // No users matched this bucket — mark as unmatched
  if (users.length === 0) {
    return [
      {
        usageDate: bucket.usageDate,
        accountId: bucket.accountId,
        region: bucket.region,
        modelId: bucket.resolvedModelId,
        modelBillingName: bucket.modelBillingName,
        tokenType: bucket.tokenType,
        crossRegionType: bucket.crossRegionType,
        resolvedUserId: 'UNMATCHED',
        resolvedUserName: 'UNMATCHED',
        userTokens: 0,
        totalTokensInBucket: 0,
        proportion: 0,
        bucketUnblendedCost: unblendedCost,
        attributedCost: unblendedCost,
        reconciliationStatus: 'unmatched',
      },
    ];
  }

  const totalTokens = users.reduce((sum, u) => sum + u.tokenCount, 0);

  // Zero-token bucket: distribute cost equally among users
  if (totalTokens === 0) {
    const equalShare = unblendedCost / users.length;
    return users.map((user) => ({
      usageDate: bucket.usageDate,
      accountId: bucket.accountId,
      region: bucket.region,
      modelId: bucket.resolvedModelId,
      modelBillingName: bucket.modelBillingName,
      tokenType: bucket.tokenType,
      crossRegionType: bucket.crossRegionType,
      resolvedUserId: user.resolvedUserId,
      resolvedUserName: user.resolvedUserName,
      userTokens: 0,
      totalTokensInBucket: 0,
      proportion: 1 / users.length,
      bucketUnblendedCost: unblendedCost,
      attributedCost: roundCost(equalShare),
      reconciliationStatus: 'reconciled' as const,
    }));
  }

  // Standard proportional attribution
  const records: ReconciledCostRecord[] = [];
  let attributedSum = 0;

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const proportion = user.tokenCount / totalTokens;
    let attributedCost: number;

    if (i === users.length - 1) {
      // Last user gets the remainder to ensure sum matches exactly
      attributedCost = roundCost(unblendedCost - attributedSum);
    } else {
      attributedCost = roundCost(proportion * unblendedCost);
      attributedSum += attributedCost;
    }

    records.push({
      usageDate: bucket.usageDate,
      accountId: bucket.accountId,
      region: bucket.region,
      modelId: bucket.resolvedModelId,
      modelBillingName: bucket.modelBillingName,
      tokenType: bucket.tokenType,
      crossRegionType: bucket.crossRegionType,
      resolvedUserId: user.resolvedUserId,
      resolvedUserName: user.resolvedUserName,
      userTokens: user.tokenCount,
      totalTokensInBucket: totalTokens,
      proportion: roundProportion(proportion),
      bucketUnblendedCost: unblendedCost,
      attributedCost,
      reconciliationStatus: 'reconciled',
    });
  }

  return records;
}

/**
 * Rounds a cost value to 10 decimal places to avoid floating-point drift
 * while preserving precision for sub-cent amounts.
 */
function roundCost(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}

/**
 * Rounds a proportion to 10 decimal places.
 */
function roundProportion(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}

// ─── Output Writer ────────────────────────────────────────────────────────────

/**
 * Generates a Hive-style partition path for reconciled cost records.
 * Format: reconciled-costs/year={YYYY}/month={MM}/day={DD}/
 */
function generatePartitionPath(usageDate: string): string {
  const date = new Date(usageDate);
  if (isNaN(date.getTime())) {
    const now = new Date();
    const year = now.getUTCFullYear().toString();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    return `${RECONCILED_COSTS_PREFIX}/year=${year}/month=${month}/day=${day}/`;
  }
  const year = date.getUTCFullYear().toString();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${RECONCILED_COSTS_PREFIX}/year=${year}/month=${month}/day=${day}/`;
}

/**
 * Converts a ReconciledCostRecord (camelCase) to snake_case keys matching the Glue table / Parquet schema.
 */
function reconciledToSnakeCase(record: ReconciledCostRecord): Record<string, unknown> {
  return {
    usage_date: record.usageDate,
    account_id: record.accountId,
    region: record.region,
    model_id: record.modelId,
    model_billing_name: record.modelBillingName,
    token_type: record.tokenType,
    cross_region_type: record.crossRegionType,
    resolved_user_id: record.resolvedUserId,
    resolved_user_name: record.resolvedUserName,
    user_tokens: record.userTokens,
    total_tokens_in_bucket: record.totalTokensInBucket,
    proportion: record.proportion,
    bucket_unblended_cost: record.bucketUnblendedCost,
    attributed_cost: record.attributedCost,
    reconciliation_status: record.reconciliationStatus,
  };
}

/**
 * Writes reconciled cost records as Parquet to S3, partitioned by date.
 */
async function writeReconciledCosts(
  bucket: string,
  records: ReconciledCostRecord[],
): Promise<void> {
  if (records.length === 0) return;

  // Group records by usage date for partitioned output
  const byDate = new Map<string, ReconciledCostRecord[]>();
  for (const record of records) {
    const existing = byDate.get(record.usageDate);
    if (existing) {
      existing.push(record);
    } else {
      byDate.set(record.usageDate, [record]);
    }
  }

  for (const [usageDate, dateRecords] of byDate) {
    const partitionPath = generatePartitionPath(usageDate);
    const fileName = `reconciled-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.parquet`;
    const outputKey = `${partitionPath}${fileName}`;

    const parquetBuffer = await writeParquet(
      dateRecords.map(reconciledToSnakeCase),
      RECONCILED_COST_SCHEMA,
    );

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: outputKey,
        Body: parquetBuffer,
      }),
    );

    console.log(`Wrote ${dateRecords.length} reconciled records to ${outputKey}`);
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

/**
 * Cost Reconciler Lambda handler.
 *
 * Triggered by EventBridge schedule (default every 6 hours).
 * 1. Queries cur_costs Glue table for CUR line items (current + previous billing period)
 * 2. For each reconciliation bucket, queries invocation_logs for user token counts
 * 3. Computes proportional cost attribution per user
 * 4. Writes reconciled cost records as Parquet to reconciled-costs/ prefix
 *
 * Requirements: 2.4, 2.5, 2.6, 2.7
 */
export const handler = async (event: unknown): Promise<void> => {
  console.log('Cost Reconciler triggered', JSON.stringify(event));

  const processedDataBucket = getEnv('PROCESSED_DATA_BUCKET');
  const glueDatabase = getEnv('GLUE_DATABASE');
  const athenaWorkgroup = getEnv('ATHENA_WORKGROUP', 'primary');
  const athenaOutputLocation = `s3://${processedDataBucket}/athena-results/cost-reconciler/`;

  if (!processedDataBucket) {
    throw new Error('PROCESSED_DATA_BUCKET environment variable is required');
  }
  if (!glueDatabase) {
    throw new Error('GLUE_DATABASE environment variable is required');
  }

  // Step 1: Query CUR costs for current and previous billing periods
  console.log('Querying CUR costs from Athena...');
  const curBuckets = await queryCurCosts(
    glueDatabase,
    athenaWorkgroup,
    athenaOutputLocation,
  );

  if (curBuckets.length === 0) {
    console.log('No CUR cost data found for reconciliation. Exiting.');
    return;
  }

  console.log(`Found ${curBuckets.length} CUR reconciliation buckets`);

  // Step 2: Group buckets by usage field to minimize Athena queries
  const bucketsByField = new Map<string, CurBucket[]>();
  for (const bucket of curBuckets) {
    const field = getUsageField(bucket);
    const existing = bucketsByField.get(field);
    if (existing) {
      existing.push(bucket);
    } else {
      bucketsByField.set(field, [bucket]);
    }
  }

  // Step 3: Query invocation logs for each usage field and reconcile
  const allReconciled: ReconciledCostRecord[] = [];
  let totalBucketsReconciled = 0;
  let totalBucketsUnmatched = 0;

  for (const [usageField, fieldBuckets] of bucketsByField) {
    // Collect unique dates for this field's buckets
    const dates = [...new Set(fieldBuckets.map((b) => b.usageDate))];

    console.log(
      `Querying invocation logs for field '${usageField}' across ${dates.length} dates...`,
    );

    const userUsages = await queryInvocationLogs(
      glueDatabase,
      athenaWorkgroup,
      athenaOutputLocation,
      usageField,
      dates,
    );

    // Index user usages by a key matching the reconciliation bucket
    const usageIndex = new Map<string, UserUsage[]>();
    for (const usage of userUsages) {
      const key = `${usage.usageDate}|${usage.accountId}|${usage.region}|${usage.modelId}|${usage.crossRegionType}`;
      const existing = usageIndex.get(key);
      if (existing) {
        existing.push(usage);
      } else {
        usageIndex.set(key, [usage]);
      }
    }

    // Reconcile each bucket
    for (const bucket of fieldBuckets) {
      // Resolve CUR billing name to Bedrock model ID for matching with invocation logs
      const resolvedModelId = CUR_MODEL_BILLING_NAME_MAP[bucket.modelBillingName] ?? bucket.modelBillingName;
      // Build lookup key matching invocation log index
      const lookupKey = `${bucket.usageDate}|${bucket.accountId}|${bucket.region}|${resolvedModelId}|${bucket.crossRegionType}`;
      let matchedUsers = usageIndex.get(lookupKey) ?? [];

      // Fallback: CUR base-rate entries (cross_region_type='none') should also match
      // invocations that used cross-region profiles, since AWS bills both a base rate
      // and a cross-region surcharge for cross-region inference profile usage.
      if (matchedUsers.length === 0 && bucket.crossRegionType === 'none') {
        const globalKey = `${bucket.usageDate}|${bucket.accountId}|${bucket.region}|${resolvedModelId}|cross-region-global`;
        matchedUsers = usageIndex.get(globalKey) ?? [];
        if (matchedUsers.length === 0) {
          const geoKey = `${bucket.usageDate}|${bucket.accountId}|${bucket.region}|${resolvedModelId}|cross-region-geo`;
          matchedUsers = usageIndex.get(geoKey) ?? [];
        }
      }

      // Override resolvedModelId with the actual Bedrock model ID
      const bucketWithResolvedId = { ...bucket, resolvedModelId };
      const records = computeAttribution(bucketWithResolvedId, matchedUsers);
      allReconciled.push(...records);

      if (matchedUsers.length === 0) {
        totalBucketsUnmatched++;
      } else {
        totalBucketsReconciled++;
      }
    }
  }

  // Step 4: Write reconciled cost records to S3
  console.log(
    `Writing ${allReconciled.length} reconciled records ` +
    `(${totalBucketsReconciled} matched, ${totalBucketsUnmatched} unmatched)...`,
  );

  await writeReconciledCosts(processedDataBucket, allReconciled);

  console.log(
    `Cost reconciliation complete: ${allReconciled.length} records written, ` +
    `${totalBucketsReconciled} buckets reconciled, ${totalBucketsUnmatched} buckets unmatched`,
  );
};
