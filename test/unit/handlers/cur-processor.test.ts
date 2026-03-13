/**
 * Unit tests for the CUR Processor handler.
 *
 * Tests CSV parsing, Bedrock row filtering, usage_type parsing integration,
 * unit price extraction, Parquet output schema, idempotency, and edge cases.
 *
 * Requirements: 2.1, 2.2, 2.3
 */

import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Readable } from 'stream';
import { gzipSync } from 'zlib';
import {
  parseCsv,
  extractUnitPrice,
  processCurRow,
  handler,
  CUR_COST_SCHEMA,
} from 'lib/handlers/cur-processor/index';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  s3Mock.reset();
  ddbMock.reset();
  process.env['CUR_BUCKET'] = 'cur-bucket';
  process.env['CUR_REPORT_PREFIX'] = 'reports/';
  process.env['PROCESSED_DATA_BUCKET'] = 'processed-bucket';
  process.env['IDEMPOTENCY_TABLE'] = 'idempotency-table';
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReadableStream(content: Buffer | string): Readable {
  const readable = new Readable();
  readable.push(content);
  readable.push(null);
  return readable;
}


/** Builds a CSV string from headers and rows. */
function buildCsv(headers: string[], rows: string[][]): string {
  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

const BEDROCK_CSV_HEADERS = [
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
  return BEDROCK_CSV_HEADERS.map(h => merged[h] ?? '');
}

// ─── parseCsv Tests ───────────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('parses a simple CSV with headers and rows', () => {
    const csv = 'name,age\nAlice,30\nBob,25';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: 'Alice', age: '30' });
    expect(rows[1]).toEqual({ name: 'Bob', age: '25' });
  });

  it('handles quoted fields containing commas', () => {
    const csv = 'desc,price\n"$0.003 per 1K tokens, input",3.00';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]['desc']).toBe('$0.003 per 1K tokens, input');
    expect(rows[0]['price']).toBe('3.00');
  });

  it('handles escaped quotes within quoted fields', () => {
    const csv = 'desc,val\n"He said ""hello""",1';
    const rows = parseCsv(csv);
    expect(rows[0]['desc']).toBe('He said "hello"');
  });

  it('returns empty array for empty content', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('returns empty array for header-only CSV', () => {
    expect(parseCsv('name,age')).toEqual([]);
  });

  it('skips blank lines', () => {
    const csv = 'a,b\n1,2\n\n3,4\n';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
  });
});

// ─── extractUnitPrice Tests ───────────────────────────────────────────────────

describe('extractUnitPrice', () => {
  it('extracts price from standard description', () => {
    expect(extractUnitPrice('$0.003 per 1K input tokens')).toBe(0.003);
  });

  it('extracts price from output token description', () => {
    expect(extractUnitPrice('$0.015 per 1K output tokens')).toBe(0.015);
  });

  it('extracts price with larger values', () => {
    expect(extractUnitPrice('$25.00 per 1M tokens')).toBe(25.0);
  });

  it('returns null for empty string', () => {
    expect(extractUnitPrice('')).toBeNull();
  });

  it('returns null for description without price pattern', () => {
    expect(extractUnitPrice('No price here')).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(extractUnitPrice(null as unknown as string)).toBeNull();
    expect(extractUnitPrice(undefined as unknown as string)).toBeNull();
  });
});

// ─── processCurRow Tests ──────────────────────────────────────────────────────

describe('processCurRow', () => {
  it('processes a valid Bedrock CUR row', () => {
    const row: Record<string, string> = {
      product_code: 'AmazonBedrockService',
      usage_type: 'USE1-Claude4.6Opus-input-tokens',
      item_description: '$0.003 per 1K input tokens',
      billing_period: '2025-01-01T00:00:00Z',
      usage_start_date: '2025-01-15T00:00:00Z',
      payer_account_id: '111111111111',
      usage_account_id: '222222222222',
      pricing_unit: '1K tokens',
      usage_quantity: '1000',
      unblended_cost: '3.00',
    };

    const result = processCurRow(row, 'test-cur-file.csv.gz');

    expect(result).not.toBeNull();
    expect(result!.modelBillingName).toBe('Claude4.6Opus');
    expect(result!.resolvedModelId).toBe('anthropic.claude-opus-4-6-v1');
    expect(result!.tokenType).toBe('input-tokens');
    expect(result!.crossRegionType).toBe('none');
    expect(result!.region).toBe('us-east-1');
    expect(result!.regionCode).toBe('USE1');
    expect(result!.usageQuantity).toBe(1000);
    expect(result!.unblendedCost).toBe(3.0);
    expect(result!.unitPrice).toBe(0.003);
    expect(result!.sourceCurFile).toBe('test-cur-file.csv.gz');
    expect(result!.billingPeriod).toBe('2025-01');
    expect(result!.usageDate).toBe('2025-01-15');
  });

  it('filters out non-Bedrock rows (returns null)', () => {
    const row: Record<string, string> = {
      product_code: 'AmazonEC2',
      usage_type: 'USE1-BoxUsage:t3.micro',
      item_description: '$0.0104 per hour',
    };
    expect(processCurRow(row, 'test.csv')).toBeNull();
  });

  it('returns null for unparseable usage_type', () => {
    const row: Record<string, string> = {
      product_code: 'AmazonBedrockService',
      usage_type: 'DataTransfer-Out-Bytes',
      item_description: 'some desc',
    };
    expect(processCurRow(row, 'test.csv')).toBeNull();
  });

  it('handles cross-region usage types', () => {
    const row: Record<string, string> = {
      product_code: 'AmazonBedrockService',
      usage_type: 'USE1-Claude4.6Opus-output-tokens-cross-region-global',
      item_description: '$0.015 per 1K output tokens',
      billing_period: '2025-01',
      usage_start_date: '2025-01-15',
      payer_account_id: '111',
      usage_account_id: '222',
      pricing_unit: '1K tokens',
      usage_quantity: '500',
      unblended_cost: '7.50',
    };

    const result = processCurRow(row, 'test.csv');
    expect(result).not.toBeNull();
    expect(result!.crossRegionType).toBe('cross-region-global');
    expect(result!.tokenType).toBe('output-tokens');
  });

  it('handles cache token types', () => {
    const row: Record<string, string> = {
      product_code: 'AmazonBedrockService',
      usage_type: 'USE1-Claude4.6Opus-cache-read-input-token-count',
      item_description: '$0.001 per 1K tokens',
      billing_period: '2025-01',
      usage_start_date: '2025-01-15',
      payer_account_id: '111',
      usage_account_id: '222',
      pricing_unit: '1K tokens',
      usage_quantity: '2000',
      unblended_cost: '2.00',
    };

    const result = processCurRow(row, 'test.csv');
    expect(result).not.toBeNull();
    expect(result!.tokenType).toBe('cache-read-input-token-count');
  });

  it('handles unmapped billing names gracefully', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    const row: Record<string, string> = {
      product_code: 'AmazonBedrockService',
      usage_type: 'USE1-FutureModel99-input-tokens',
      item_description: '$0.005 per 1K tokens',
      billing_period: '2025-01',
      usage_start_date: '2025-01-15',
      payer_account_id: '111',
      usage_account_id: '222',
      pricing_unit: '1K tokens',
      usage_quantity: '100',
      unblended_cost: '0.50',
    };

    const result = processCurRow(row, 'test.csv');
    expect(result).not.toBeNull();
    expect(result!.modelBillingName).toBe('FutureModel99');
    expect(result!.resolvedModelId).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unmapped CUR billing name: FutureModel99'),
    );
    consoleSpy.mockRestore();
  });

  it('handles alternative CUR column names (lineItem/ prefix)', () => {
    const row: Record<string, string> = {
      'lineItem/ProductCode': 'AmazonBedrockService',
      'lineItem/UsageType': 'USW2-NovaPro-output-tokens',
      'lineItem/LineItemDescription': '$0.008 per 1K output tokens',
      'bill/BillingPeriod': '2025-02',
      'lineItem/UsageStartDate': '2025-02-10',
      'bill/PayerAccountId': '333',
      'lineItem/UsageAccountId': '444',
      'pricing/unit': '1K tokens',
      'lineItem/UsageQuantity': '200',
      'lineItem/UnblendedCost': '1.60',
    };

    const result = processCurRow(row, 'test.csv');
    expect(result).not.toBeNull();
    expect(result!.modelBillingName).toBe('NovaPro');
    expect(result!.resolvedModelId).toBe('amazon.nova-pro-v1:0');
    expect(result!.region).toBe('us-west-2');
  });

  it('defaults NaN quantities to 0', () => {
    const row: Record<string, string> = {
      product_code: 'AmazonBedrockService',
      usage_type: 'USE1-Claude4.6Opus-input-tokens',
      item_description: '$0.003 per 1K tokens',
      usage_quantity: 'not-a-number',
      unblended_cost: 'also-not-a-number',
    };

    const result = processCurRow(row, 'test.csv');
    expect(result).not.toBeNull();
    expect(result!.usageQuantity).toBe(0);
    expect(result!.unblendedCost).toBe(0);
  });
});


// ─── CUR_COST_SCHEMA Tests ───────────────────────────────────────────────────

describe('CUR_COST_SCHEMA', () => {
  it('defines all expected fields from CurCostRecord', () => {
    const fields = Object.keys(CUR_COST_SCHEMA.schema);
    const expectedFields = [
      'billingPeriod',
      'usageDate',
      'payerAccountId',
      'usageAccountId',
      'region',
      'regionCode',
      'modelBillingName',
      'resolvedModelId',
      'tokenType',
      'crossRegionType',
      'usageType',
      'pricingUnit',
      'usageQuantity',
      'unblendedCost',
      'unitPrice',
      'itemDescription',
      'sourceCurFile',
    ];
    for (const field of expectedFields) {
      expect(fields).toContain(field);
    }
  });

  it('marks resolvedModelId and unitPrice as optional', () => {
    const schema = CUR_COST_SCHEMA.schema;
    expect(schema['resolvedModelId'].optional).toBe(true);
    expect(schema['unitPrice'].optional).toBe(true);
  });
});

// ─── Handler Tests ────────────────────────────────────────────────────────────

describe('handler - S3 event processing', () => {
  const csvContent = buildCsv(BEDROCK_CSV_HEADERS, [
    bedrockRow(),
    bedrockRow({
      usage_type: 'USE1-Claude4.6Opus-output-tokens',
      item_description: '$0.015 per 1K output tokens',
      usage_quantity: '500',
      unblended_cost: '7.50',
    }),
  ]);

  it('processes a valid S3 event with CSV.gz CUR file', async () => {
    const gzipped = gzipSync(Buffer.from(csvContent));

    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(gzipped) as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined }); // not yet processed
    ddbMock.on(PutCommand).resolves({});

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'cur-bucket' },
          object: { key: 'reports/2025-01/cur-data.csv.gz' },
        },
      }],
    };

    await expect(handler(event)).resolves.toBeUndefined();

    // Should write Parquet output to S3
    expect(s3Mock).toHaveReceivedCommand(PutObjectCommand);
  });

  it('skips already-processed CUR files (idempotency)', async () => {
    // DynamoDB returns existing item — already processed
    ddbMock.on(GetCommand).resolves({
      Item: { requestId: 'reports/2025-01/cur-data.csv.gz', timestamp: 'cur-processor' },
    });

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'cur-bucket' },
          object: { key: 'reports/2025-01/cur-data.csv.gz' },
        },
      }],
    };

    await expect(handler(event)).resolves.toBeUndefined();

    // Should NOT download or write anything since it's a duplicate
    expect(s3Mock).not.toHaveReceivedCommand(GetObjectCommand);
    expect(s3Mock).not.toHaveReceivedCommand(PutObjectCommand);
  });

  it('handles empty CUR file gracefully', async () => {
    const emptyCsv = BEDROCK_CSV_HEADERS.join(',') + '\n';
    const gzipped = gzipSync(Buffer.from(emptyCsv));

    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(gzipped) as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'cur-bucket' },
          object: { key: 'reports/2025-01/empty.csv.gz' },
        },
      }],
    };

    await expect(handler(event)).resolves.toBeUndefined();

    // Should still mark as processed but not write Parquet (no data rows)
    expect(ddbMock).toHaveReceivedCommand(PutCommand);
  });

  it('filters out non-Bedrock rows from CUR file', async () => {
    const mixedCsv = buildCsv(BEDROCK_CSV_HEADERS, [
      bedrockRow(), // Bedrock row — should be processed
      bedrockRow({ product_code: 'AmazonEC2', usage_type: 'USE1-BoxUsage:t3.micro' }), // EC2 — filtered
      bedrockRow({ product_code: 'AmazonS3', usage_type: 'USE1-Requests-Tier1' }), // S3 — filtered
    ]);
    const gzipped = gzipSync(Buffer.from(mixedCsv));

    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(gzipped) as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'cur-bucket' },
          object: { key: 'reports/2025-01/mixed.csv.gz' },
        },
      }],
    };

    await expect(handler(event)).resolves.toBeUndefined();

    // Should write Parquet (only the 1 Bedrock row)
    expect(s3Mock).toHaveReceivedCommand(PutObjectCommand);
  });

  it('handles CUR file with no Bedrock rows', async () => {
    const nonBedrockCsv = buildCsv(BEDROCK_CSV_HEADERS, [
      bedrockRow({ product_code: 'AmazonEC2', usage_type: 'USE1-BoxUsage:t3.micro' }),
      bedrockRow({ product_code: 'AmazonS3', usage_type: 'USE1-Requests-Tier1' }),
    ]);
    const gzipped = gzipSync(Buffer.from(nonBedrockCsv));

    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(gzipped) as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'cur-bucket' },
          object: { key: 'reports/2025-01/no-bedrock.csv.gz' },
        },
      }],
    };

    await expect(handler(event)).resolves.toBeUndefined();
    // Idempotency mark should still happen
    expect(ddbMock).toHaveReceivedCommand(PutCommand);
  });
});

describe('handler - scheduled event processing', () => {
  it('lists and processes CUR files on scheduled trigger', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'reports/2025-01/data1.csv.gz' },
        { Key: 'reports/2025-01/data2.csv.gz' },
      ],
    });

    const csvContent = buildCsv(BEDROCK_CSV_HEADERS, [bedrockRow()]);
    const gzipped = gzipSync(Buffer.from(csvContent));

    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(gzipped) as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      source: 'aws.events',
      'detail-type': 'Scheduled Event',
    };

    await expect(handler(event)).resolves.toBeUndefined();

    // Should list files and process them
    expect(s3Mock).toHaveReceivedCommand(ListObjectsV2Command);
    expect(s3Mock).toHaveReceivedCommand(PutObjectCommand);
  });

  it('continues processing remaining files when one fails on scheduled trigger', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'reports/2025-01/bad.csv.gz' },
        { Key: 'reports/2025-01/good.csv.gz' },
      ],
    });

    const goodCsv = buildCsv(BEDROCK_CSV_HEADERS, [bedrockRow()]);
    const goodGzipped = gzipSync(Buffer.from(goodCsv));

    // First call fails, second succeeds
    s3Mock
      .on(GetObjectCommand, { Key: 'reports/2025-01/bad.csv.gz' })
      .rejects(new Error('S3 access denied'))
      .on(GetObjectCommand, { Key: 'reports/2025-01/good.csv.gz' })
      .resolves({ Body: makeReadableStream(goodGzipped) as any });

    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      source: 'aws.events',
      'detail-type': 'Scheduled Event',
    };

    // Should not throw — scheduled events continue on error
    await expect(handler(event)).resolves.toBeUndefined();
  });
});

describe('handler - S3 event error propagation', () => {
  it('throws on S3 event trigger when processing fails', async () => {
    s3Mock.on(GetObjectCommand).rejects(new Error('S3 access denied'));
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'cur-bucket' },
          object: { key: 'reports/2025-01/fail.csv.gz' },
        },
      }],
    };

    await expect(handler(event)).rejects.toThrow('S3 access denied');
  });
});
