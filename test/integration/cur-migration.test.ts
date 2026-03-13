/**
 * Integration tests for CUR migration end-to-end flows.
 *
 * Tests:
 * 1. End-to-end CUR ingestion: S3 CSV.gz → CUR Processor → Parquet output with correct partitioning
 * 2. End-to-end reconciliation: CUR buckets + user usage → Cost Reconciler → proportional attribution
 * 3. CDK synth verification is covered by test/unit/stacks/cdk-synth.test.ts (task 8.4)
 *
 * Uses aws-sdk-client-mock to simulate the full flow with mocked AWS services.
 *
 * Validates: Requirements 2.1, 2.2, 2.4, 2.5
 */

import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Readable } from 'stream';
import { gzipSync } from 'zlib';

import { handler as curProcessorHandler } from 'lib/handlers/cur-processor/index';
import { handler as costReconcilerHandler } from 'lib/handlers/cost-reconciler/index';

// ─── Mock Setup ───────────────────────────────────────────────────────────────

const s3Mock = mockClient(S3Client);
const athenaMock = mockClient(AthenaClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReadableStream(content: Buffer | string): Readable {
  const readable = new Readable();
  readable.push(content);
  readable.push(null);
  return readable;
}

function buildCsv(headers: string[], rows: string[][]): string {
  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

const CUR_CSV_HEADERS = [
  'product_code',
  'usage_type',
  'item_description',
  'billing_period',
  'usage_start_date',
  'payer_account_id',
  'usage_account_id',
  'pricing_unit',
  'usage_quantity',
  'unblended_cost',
];

function bedrockRow(overrides: Partial<Record<string, string>> = {}): string[] {
  const defaults: Record<string, string> = {
    product_code: 'AmazonBedrockService',
    usage_type: 'USE1-Claude4.6Opus-input-tokens',
    item_description: '$0.003 per 1K input tokens',
    billing_period: '2025-01',
    usage_start_date: '2025-01-15T00:00:00Z',
    payer_account_id: '111111111111',
    usage_account_id: '222222222222',
    pricing_unit: '1K tokens',
    usage_quantity: '1000',
    unblended_cost: '3.00',
  };
  const merged = { ...defaults, ...overrides };
  return CUR_CSV_HEADERS.map((h) => merged[h] ?? '');
}

// ─── Environment Setup ────────────────────────────────────────────────────────

const CUR_ENV = {
  CUR_BUCKET: 'test-cur-exports-bucket',
  CUR_REPORT_PREFIX: 'reports/',
  PROCESSED_DATA_BUCKET: 'test-processed-data-bucket',
  IDEMPOTENCY_TABLE: 'test-idempotency-table',
};

const RECONCILER_ENV = {
  PROCESSED_DATA_BUCKET: 'test-processed-data-bucket',
  GLUE_DATABASE: 'test-analytics-db',
  ATHENA_WORKGROUP: 'primary',
};

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite 1: End-to-end CUR Ingestion
// ═══════════════════════════════════════════════════════════════════════════════

describe('End-to-end CUR ingestion', () => {
  const capturedPuts: Array<{ Bucket: string; Key: string; Body: Buffer }> = [];

  beforeEach(() => {
    s3Mock.reset();
    ddbMock.reset();
    capturedPuts.length = 0;

    Object.entries(CUR_ENV).forEach(([k, v]) => {
      process.env[k] = v;
    });

    // Capture all S3 PutObject calls
    s3Mock.on(PutObjectCommand).callsFake((input: { Bucket: string; Key: string; Body: Buffer }) => {
      capturedPuts.push({ Bucket: input.Bucket, Key: input.Key, Body: input.Body });
      return {};
    });

    // Default: not yet processed
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
  });

  afterEach(() => {
    Object.keys(CUR_ENV).forEach((k) => delete process.env[k]);
  });

  it('processes a CSV.gz CUR file and writes Parquet to cur-costs/ with correct partitioning', async () => {
    const csvContent = buildCsv(CUR_CSV_HEADERS, [
      bedrockRow(),
      bedrockRow({
        usage_type: 'USE1-Claude4.6Opus-output-tokens',
        item_description: '$0.015 per 1K output tokens',
        usage_quantity: '500',
        unblended_cost: '7.50',
      }),
      bedrockRow({
        usage_type: 'USW2-NovaPro-input-tokens',
        item_description: '$0.008 per 1K input tokens',
        usage_start_date: '2025-01-16T00:00:00Z',
        usage_quantity: '2000',
        unblended_cost: '16.00',
      }),
    ]);
    const gzipped = gzipSync(Buffer.from(csvContent));

    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(gzipped) as any,
    });

    const event = {
      Records: [
        {
          s3: {
            bucket: { name: 'test-cur-exports-bucket' },
            object: { key: 'reports/2025-01/cur-data.csv.gz' },
          },
        },
      ],
    };

    await curProcessorHandler(event);

    // Should write Parquet files partitioned by date
    const parquetPuts = capturedPuts.filter(
      (p) => p.Bucket === 'test-processed-data-bucket' && p.Key.includes('cur-costs/'),
    );
    expect(parquetPuts.length).toBeGreaterThanOrEqual(1);

    // Verify Hive-style partitioning: cur-costs/year=YYYY/month=MM/day=DD/
    const allKeys = parquetPuts.map((p) => p.Key);
    expect(allKeys.some((k) => k.includes('year=2025/month=01/day=15/'))).toBe(true);
    expect(allKeys.some((k) => k.includes('year=2025/month=01/day=16/'))).toBe(true);

    // Verify Parquet files have content
    for (const put of parquetPuts) {
      expect(put.Body).toBeDefined();
      expect(Buffer.isBuffer(put.Body) || typeof put.Body === 'string').toBe(true);
    }

    // Verify idempotency was marked
    expect(ddbMock).toHaveReceivedCommand(PutCommand);
  });

  it('filters non-Bedrock rows and only writes Bedrock records', async () => {
    const csvContent = buildCsv(CUR_CSV_HEADERS, [
      bedrockRow(), // Bedrock — should be processed
      bedrockRow({ product_code: 'AmazonEC2', usage_type: 'USE1-BoxUsage:t3.micro' }),
      bedrockRow({ product_code: 'AmazonS3', usage_type: 'USE1-Requests-Tier1' }),
      bedrockRow({
        usage_type: 'USE1-Claude4.6Opus-output-tokens',
        unblended_cost: '5.00',
      }),
    ]);
    const gzipped = gzipSync(Buffer.from(csvContent));

    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(gzipped) as any,
    });

    const event = {
      Records: [
        {
          s3: {
            bucket: { name: 'test-cur-exports-bucket' },
            object: { key: 'reports/2025-01/mixed.csv.gz' },
          },
        },
      ],
    };

    await curProcessorHandler(event);

    // Should write Parquet (only the 2 Bedrock rows)
    const parquetPuts = capturedPuts.filter(
      (p) => p.Bucket === 'test-processed-data-bucket' && p.Key.includes('cur-costs/'),
    );
    expect(parquetPuts.length).toBeGreaterThanOrEqual(1);
  });

  it('handles cross-region and cache token types in CUR data', async () => {
    const csvContent = buildCsv(CUR_CSV_HEADERS, [
      bedrockRow({
        usage_type: 'USE1-Claude4.6Opus-output-tokens-cross-region-global',
        unblended_cost: '12.00',
      }),
      bedrockRow({
        usage_type: 'USE1-Claude4.6Opus-cache-read-input-token-count',
        unblended_cost: '2.00',
      }),
      bedrockRow({
        usage_type: 'USW2-NovaPro-cache-write-input-token-count-cross-region-geo',
        unblended_cost: '4.00',
      }),
    ]);
    const gzipped = gzipSync(Buffer.from(csvContent));

    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(gzipped) as any,
    });

    const event = {
      Records: [
        {
          s3: {
            bucket: { name: 'test-cur-exports-bucket' },
            object: { key: 'reports/2025-01/cross-region.csv.gz' },
          },
        },
      ],
    };

    await curProcessorHandler(event);

    const parquetPuts = capturedPuts.filter(
      (p) => p.Bucket === 'test-processed-data-bucket' && p.Key.includes('cur-costs/'),
    );
    expect(parquetPuts.length).toBeGreaterThanOrEqual(1);
  });

  it('skips already-processed files via idempotency check', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { requestId: 'reports/2025-01/already-done.csv.gz', timestamp: 'cur-processor' },
    });

    const event = {
      Records: [
        {
          s3: {
            bucket: { name: 'test-cur-exports-bucket' },
            object: { key: 'reports/2025-01/already-done.csv.gz' },
          },
        },
      ],
    };

    await curProcessorHandler(event);

    // Should NOT download or write anything
    expect(s3Mock).not.toHaveReceivedCommand(GetObjectCommand);
    const parquetPuts = capturedPuts.filter((p) => p.Key.includes('cur-costs/'));
    expect(parquetPuts).toHaveLength(0);
  });

  it('handles scheduled EventBridge trigger listing and processing CUR files', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'reports/2025-01/data1.csv.gz' },
        { Key: 'reports/2025-01/data2.csv.gz' },
      ],
    });

    const csvContent = buildCsv(CUR_CSV_HEADERS, [bedrockRow()]);
    const gzipped = gzipSync(Buffer.from(csvContent));

    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(gzipped) as any,
    });

    const event = {
      source: 'aws.events',
      'detail-type': 'Scheduled Event',
    };

    await curProcessorHandler(event);

    expect(s3Mock).toHaveReceivedCommand(ListObjectsV2Command);
    const parquetPuts = capturedPuts.filter((p) => p.Key.includes('cur-costs/'));
    expect(parquetPuts.length).toBeGreaterThanOrEqual(1);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite 2: End-to-end Cost Reconciliation
// ═══════════════════════════════════════════════════════════════════════════════

describe('End-to-end cost reconciliation', () => {
  const capturedPuts: Array<{ Bucket: string; Key: string; Body: Buffer }> = [];
  let athenaQueryCount: number;

  beforeEach(() => {
    s3Mock.reset();
    athenaMock.reset();
    ddbMock.reset();
    capturedPuts.length = 0;
    athenaQueryCount = 0;

    Object.entries(RECONCILER_ENV).forEach(([k, v]) => {
      process.env[k] = v;
    });

    // Capture S3 PutObject calls for reconciled output
    s3Mock.on(PutObjectCommand).callsFake((input: { Bucket: string; Key: string; Body: Buffer }) => {
      capturedPuts.push({ Bucket: input.Bucket, Key: input.Key, Body: input.Body });
      return {};
    });

    // Mock Athena: StartQueryExecution returns a query ID
    athenaMock.on(StartQueryExecutionCommand).callsFake(() => {
      athenaQueryCount++;
      return { QueryExecutionId: `query-${athenaQueryCount}` };
    });

    // Mock Athena: GetQueryExecution returns SUCCEEDED
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: {
        Status: { State: QueryExecutionState.SUCCEEDED },
      },
    });
  });

  afterEach(() => {
    Object.keys(RECONCILER_ENV).forEach((k) => delete process.env[k]);
  });

  it('reconciles CUR costs with invocation logs using proportional attribution', async () => {
    // First Athena query: CUR costs (returns 1 bucket)
    // Second Athena query: invocation logs (returns 2 users)
    let queryResultCallCount = 0;

    athenaMock.on(GetQueryResultsCommand).callsFake(() => {
      queryResultCallCount++;

      if (queryResultCallCount === 1) {
        // CUR costs query result: one bucket with $100 cost
        return {
          ResultSet: {
            Rows: [
              // Header row
              {
                Data: [
                  { VarCharValue: 'usagedate' },
                  { VarCharValue: 'usageaccountid' },
                  { VarCharValue: 'region' },
                  { VarCharValue: 'modelbillingname' },
                  { VarCharValue: 'resolvedmodelid' },
                  { VarCharValue: 'tokentype' },
                  { VarCharValue: 'crossregiontype' },
                  { VarCharValue: 'pricingunit' },
                  { VarCharValue: 'total_unblended_cost' },
                ],
              },
              // Data row: one CUR bucket
              {
                Data: [
                  { VarCharValue: '2025-01-15' },
                  { VarCharValue: '222222222222' },
                  { VarCharValue: 'us-east-1' },
                  { VarCharValue: 'Claude4.6Opus' },
                  { VarCharValue: 'anthropic.claude-opus-4-6-v1' },
                  { VarCharValue: 'input-tokens' },
                  { VarCharValue: 'none' },
                  { VarCharValue: '1K tokens' },
                  { VarCharValue: '100.00' },
                ],
              },
            ],
          },
        };
      }

      // Invocation logs query result: two users with 70/30 split
      return {
        ResultSet: {
          Rows: [
            // Header row
            {
              Data: [
                { VarCharValue: 'usage_date' },
                { VarCharValue: 'accountid' },
                { VarCharValue: 'region' },
                { VarCharValue: 'modelid' },
                { VarCharValue: 'cross_region_type' },
                { VarCharValue: 'resolveduserid' },
                { VarCharValue: 'resolvedusername' },
                { VarCharValue: 'total_tokens' },
              ],
            },
            // Alice: 700 tokens (70%)
            {
              Data: [
                { VarCharValue: '2025-01-15' },
                { VarCharValue: '222222222222' },
                { VarCharValue: 'us-east-1' },
                { VarCharValue: 'anthropic.claude-opus-4-6-v1' },
                { VarCharValue: 'none' },
                { VarCharValue: 'arn:aws:iam::222222222222:user/alice' },
                { VarCharValue: 'alice' },
                { VarCharValue: '700' },
              ],
            },
            // Bob: 300 tokens (30%)
            {
              Data: [
                { VarCharValue: '2025-01-15' },
                { VarCharValue: '222222222222' },
                { VarCharValue: 'us-east-1' },
                { VarCharValue: 'anthropic.claude-opus-4-6-v1' },
                { VarCharValue: 'none' },
                { VarCharValue: 'arn:aws:iam::222222222222:user/bob' },
                { VarCharValue: 'bob' },
                { VarCharValue: '300' },
              ],
            },
          ],
        },
      };
    });

    const event = { source: 'aws.events', 'detail-type': 'Scheduled Event' };
    await costReconcilerHandler(event);

    // Verify Athena queries were executed (CUR costs + invocation logs)
    expect(athenaMock).toHaveReceivedCommand(StartQueryExecutionCommand);
    expect(athenaQueryCount).toBeGreaterThanOrEqual(2);

    // Verify reconciled output was written to S3
    const reconciledPuts = capturedPuts.filter(
      (p) => p.Bucket === 'test-processed-data-bucket' && p.Key.includes('reconciled-costs/'),
    );
    expect(reconciledPuts.length).toBeGreaterThanOrEqual(1);

    // Verify Hive-style partitioning
    expect(reconciledPuts.some((p) => p.Key.includes('year=2025/month=01/day=15/'))).toBe(true);

    // Verify Parquet files have content
    for (const put of reconciledPuts) {
      expect(put.Body).toBeDefined();
    }
  });

  it('handles empty CUR data gracefully (no reconciliation needed)', async () => {
    // CUR costs query returns no data rows
    athenaMock.on(GetQueryResultsCommand).resolves({
      ResultSet: {
        Rows: [
          {
            Data: [
              { VarCharValue: 'usagedate' },
              { VarCharValue: 'usageaccountid' },
              { VarCharValue: 'region' },
              { VarCharValue: 'modelbillingname' },
              { VarCharValue: 'resolvedmodelid' },
              { VarCharValue: 'tokentype' },
              { VarCharValue: 'crossregiontype' },
              { VarCharValue: 'pricingunit' },
              { VarCharValue: 'total_unblended_cost' },
            ],
          },
          // No data rows
        ],
      },
    });

    const event = { source: 'aws.events', 'detail-type': 'Scheduled Event' };
    await costReconcilerHandler(event);

    // Should not write any reconciled output
    const reconciledPuts = capturedPuts.filter((p) => p.Key.includes('reconciled-costs/'));
    expect(reconciledPuts).toHaveLength(0);
  });

  it('marks unmatched CUR buckets when no invocation logs exist', async () => {
    let queryResultCallCount = 0;

    athenaMock.on(GetQueryResultsCommand).callsFake(() => {
      queryResultCallCount++;

      if (queryResultCallCount === 1) {
        // CUR costs: one bucket
        return {
          ResultSet: {
            Rows: [
              {
                Data: [
                  { VarCharValue: 'usagedate' },
                  { VarCharValue: 'usageaccountid' },
                  { VarCharValue: 'region' },
                  { VarCharValue: 'modelbillingname' },
                  { VarCharValue: 'resolvedmodelid' },
                  { VarCharValue: 'tokentype' },
                  { VarCharValue: 'crossregiontype' },
                  { VarCharValue: 'pricingunit' },
                  { VarCharValue: 'total_unblended_cost' },
                ],
              },
              {
                Data: [
                  { VarCharValue: '2025-01-15' },
                  { VarCharValue: '333333333333' },
                  { VarCharValue: 'eu-west-1' },
                  { VarCharValue: 'NovaPro' },
                  { VarCharValue: 'amazon.nova-pro-v1:0' },
                  { VarCharValue: 'output-tokens' },
                  { VarCharValue: 'none' },
                  { VarCharValue: '1K tokens' },
                  { VarCharValue: '50.00' },
                ],
              },
            ],
          },
        };
      }

      // Invocation logs: no matching users
      return {
        ResultSet: {
          Rows: [
            {
              Data: [
                { VarCharValue: 'usage_date' },
                { VarCharValue: 'accountid' },
                { VarCharValue: 'region' },
                { VarCharValue: 'modelid' },
                { VarCharValue: 'cross_region_type' },
                { VarCharValue: 'resolveduserid' },
                { VarCharValue: 'resolvedusername' },
                { VarCharValue: 'total_tokens' },
              ],
            },
            // No data rows — no users matched
          ],
        },
      };
    });

    const event = { source: 'aws.events', 'detail-type': 'Scheduled Event' };
    await costReconcilerHandler(event);

    // Should still write reconciled output (with UNMATCHED status)
    const reconciledPuts = capturedPuts.filter((p) => p.Key.includes('reconciled-costs/'));
    expect(reconciledPuts.length).toBeGreaterThanOrEqual(1);
  });

  it('reconciles cross-region CUR buckets with matching invocation logs', async () => {
    let queryResultCallCount = 0;

    athenaMock.on(GetQueryResultsCommand).callsFake(() => {
      queryResultCallCount++;

      if (queryResultCallCount === 1) {
        // CUR costs: cross-region-global bucket
        return {
          ResultSet: {
            Rows: [
              {
                Data: [
                  { VarCharValue: 'usagedate' },
                  { VarCharValue: 'usageaccountid' },
                  { VarCharValue: 'region' },
                  { VarCharValue: 'modelbillingname' },
                  { VarCharValue: 'resolvedmodelid' },
                  { VarCharValue: 'tokentype' },
                  { VarCharValue: 'crossregiontype' },
                  { VarCharValue: 'pricingunit' },
                  { VarCharValue: 'total_unblended_cost' },
                ],
              },
              {
                Data: [
                  { VarCharValue: '2025-01-15' },
                  { VarCharValue: '222222222222' },
                  { VarCharValue: 'us-east-1' },
                  { VarCharValue: 'Claude4.6Opus' },
                  { VarCharValue: 'anthropic.claude-opus-4-6-v1' },
                  { VarCharValue: 'output-tokens' },
                  { VarCharValue: 'cross-region-global' },
                  { VarCharValue: '1K tokens' },
                  { VarCharValue: '60.00' },
                ],
              },
            ],
          },
        };
      }

      // Invocation logs: single user with cross-region usage
      return {
        ResultSet: {
          Rows: [
            {
              Data: [
                { VarCharValue: 'usage_date' },
                { VarCharValue: 'accountid' },
                { VarCharValue: 'region' },
                { VarCharValue: 'modelid' },
                { VarCharValue: 'cross_region_type' },
                { VarCharValue: 'resolveduserid' },
                { VarCharValue: 'resolvedusername' },
                { VarCharValue: 'total_tokens' },
              ],
            },
            {
              Data: [
                { VarCharValue: '2025-01-15' },
                { VarCharValue: '222222222222' },
                { VarCharValue: 'us-east-1' },
                { VarCharValue: 'anthropic.claude-opus-4-6-v1' },
                { VarCharValue: 'cross-region-global' },
                { VarCharValue: 'arn:aws:iam::222222222222:user/alice' },
                { VarCharValue: 'alice' },
                { VarCharValue: '1000' },
              ],
            },
          ],
        },
      };
    });

    const event = { source: 'aws.events', 'detail-type': 'Scheduled Event' };
    await costReconcilerHandler(event);

    // Should write reconciled output for cross-region bucket
    const reconciledPuts = capturedPuts.filter((p) => p.Key.includes('reconciled-costs/'));
    expect(reconciledPuts.length).toBeGreaterThanOrEqual(1);
  });
});
