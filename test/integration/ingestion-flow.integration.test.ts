/**
 * Integration test for end-to-end ingestion flow.
 *
 * Tests the complete pipeline:
 *   S3 event → Invocation_Processor → Identity_Resolver → Parquet output to S3
 *
 * With the CUR migration, the pricing engine is removed. Invocation records
 * are written with costStatus: 'pending' and $0 costs. Cost reconciliation
 * happens asynchronously via the Cost Reconciler Lambda.
 *
 * Uses aws-sdk-client-mock to mock all AWS SDK v3 clients.
 *
 * Requirements: 5.2, 8.1, 9.4
 */

import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  IdentitystoreClient as IdentityStoreClient,
  ListUsersCommand,
} from '@aws-sdk/client-identitystore';
import { Readable } from 'stream';
import { sdkStreamMixin } from '@smithy/util-stream';

// ── Handler imports ───────────────────────────────────────────────────────────

import { handler as invocationProcessorHandler } from 'lib/handlers/invocation-processor/index';
import { handler as identityResolverHandler, resetSingletons as resetIdentitySingletons } from 'lib/handlers/identity-resolver/index';
import { ParquetReader } from '@dsnp/parquetjs';

// ── Mock setup ────────────────────────────────────────────────────────────────

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBClient);
const ddbDocMock = mockClient(DynamoDBDocumentClient);
const identityStoreMock = mockClient(IdentityStoreClient);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wrap a string as a Node.js Readable stream (SDK v3 body format). */
function stringToSdkStream(content: string): ReturnType<typeof sdkStreamMixin> {
  const readable = new Readable();
  readable.push(content);
  readable.push(null);
  return sdkStreamMixin(readable);
}

// ── Sample data ───────────────────────────────────────────────────────────────

const SAMPLE_REQUEST_ID = 'req-integration-test-001';
const SAMPLE_TIMESTAMP = '2024-03-15T14:30:00.000Z';
const SAMPLE_MODEL_ID = 'anthropic.claude-3-sonnet-20240229-v1:0';
const SAMPLE_CALLER_ARN = 'arn:aws:sts::123456789012:assumed-role/DevRole/alice';
const SAMPLE_ACCOUNT_ID = '123456789012';
const SAMPLE_REGION = 'us-east-1';

/** A realistic Bedrock invocation log JSON. */
const SAMPLE_INVOCATION_LOG = {
  requestId: SAMPLE_REQUEST_ID,
  timestamp: SAMPLE_TIMESTAMP,
  accountId: SAMPLE_ACCOUNT_ID,
  region: SAMPLE_REGION,
  modelId: SAMPLE_MODEL_ID,
  input: {
    inputTokenCount: 150,
    inputBodyJson: JSON.stringify({ prompt: 'Hello, how are you?' }),
  },
  output: {
    outputTokenCount: 75,
    outputBodyJson: JSON.stringify({ completion: 'I am doing well, thank you!' }),
    latencyMs: 1200,
  },
  identity: {
    arn: SAMPLE_CALLER_ARN,
  },
};

// ── Environment setup ─────────────────────────────────────────────────────────

const ENV = {
  PROCESSED_DATA_BUCKET: 'processed-data-bucket',
  FAILED_RECORDS_BUCKET: 'failed-records-bucket',
  IDEMPOTENCY_TABLE: 'idempotency-table',
  REGION_MODE: 'single',
  PROCESSOR_NAME: 'invocation',
  AWS_REGION: SAMPLE_REGION,
  IDENTITY_MODE: 'iam',
  IDENTITY_CACHE_TABLE: 'identity-cache-table',
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('End-to-end ingestion flow integration tests', () => {
  let capturedParquetBuffer: Buffer | undefined;
  let capturedS3Key: string | undefined;

  beforeEach(() => {
    s3Mock.reset();
    ddbMock.reset();
    ddbDocMock.reset();
    identityStoreMock.reset();
    resetIdentitySingletons();

    capturedParquetBuffer = undefined;
    capturedS3Key = undefined;

    Object.entries(ENV).forEach(([key, value]) => {
      process.env[key] = value;
    });

    // ── S3 GetObject: return the sample invocation log ──────────────────────
    s3Mock.on(GetObjectCommand, {
      Bucket: 'raw-logs-bucket',
      Key: 'invocation-logs/2024/03/15/14/req-integration-test-001.json',
    }).resolves({
      Body: stringToSdkStream(JSON.stringify(SAMPLE_INVOCATION_LOG)),
    });

    // ── S3 PutObject: capture the Parquet output ────────────────────────────
    s3Mock.on(PutObjectCommand).callsFake((input: { Bucket: string; Key: string; Body: Buffer | string }) => {
      if (input.Bucket === ENV.PROCESSED_DATA_BUCKET) {
        capturedS3Key = input.Key;
        capturedParquetBuffer = Buffer.isBuffer(input.Body)
          ? input.Body
          : Buffer.from(input.Body as string);
      }
      return {};
    });

    // ── DynamoDB idempotency: not yet processed ─────────────────────────────
    ddbDocMock.on(GetCommand, {
      TableName: ENV.IDEMPOTENCY_TABLE,
    }).resolves({ Item: undefined });

    ddbDocMock.on(PutCommand, {
      TableName: ENV.IDEMPOTENCY_TABLE,
    }).resolves({});

    // ── DynamoDB identity cache: cache miss ─────────────────────────────────
    ddbDocMock.on(GetCommand, {
      TableName: ENV.IDENTITY_CACHE_TABLE,
    }).resolves({ Item: undefined });

    ddbDocMock.on(PutCommand, {
      TableName: ENV.IDENTITY_CACHE_TABLE,
    }).resolves({});
  });

  afterEach(() => {
    Object.keys(ENV).forEach((key) => {
      delete process.env[key];
    });
  });

  // ── Test 1: Invocation Processor writes Parquet to correct S3 path ─────────

  describe('Invocation_Processor handler', () => {
    it('processes S3 event and writes Parquet to Hive-style S3 path', async () => {
      const s3Event = {
        Records: [{
          s3: {
            bucket: { name: 'raw-logs-bucket' },
            object: { key: 'invocation-logs/2024/03/15/14/req-integration-test-001.json' },
          },
          awsRegion: SAMPLE_REGION,
        }],
      };

      await invocationProcessorHandler(s3Event);

      expect(s3Mock).toHaveReceivedCommandWith(PutObjectCommand, {
        Bucket: ENV.PROCESSED_DATA_BUCKET,
      });

      expect(capturedS3Key).toBeDefined();
      expect(capturedS3Key).toMatch(/^invocation-logs\/year=2024\/month=03\/day=15\/hour=14\//);
      expect(capturedS3Key).toContain(SAMPLE_REQUEST_ID);
      expect(capturedS3Key).toMatch(/\.parquet$/);
    });

    it('marks the record as processed in the idempotency table', async () => {
      const s3Event = {
        Records: [{
          s3: {
            bucket: { name: 'raw-logs-bucket' },
            object: { key: 'invocation-logs/2024/03/15/14/req-integration-test-001.json' },
          },
          awsRegion: SAMPLE_REGION,
        }],
      };

      await invocationProcessorHandler(s3Event);

      expect(ddbDocMock).toHaveReceivedCommandWith(GetCommand, {
        TableName: ENV.IDEMPOTENCY_TABLE,
        Key: { requestId: SAMPLE_REQUEST_ID, timestamp: SAMPLE_TIMESTAMP },
      });

      expect(ddbDocMock).toHaveReceivedCommandWith(PutCommand, {
        TableName: ENV.IDEMPOTENCY_TABLE,
      });
    });

    it('skips duplicate records (idempotency)', async () => {
      ddbDocMock.on(GetCommand, {
        TableName: ENV.IDEMPOTENCY_TABLE,
      }).resolves({
        Item: {
          requestId: SAMPLE_REQUEST_ID,
          timestamp: SAMPLE_TIMESTAMP,
          status: 'completed',
        },
      });

      const s3Event = {
        Records: [{
          s3: {
            bucket: { name: 'raw-logs-bucket' },
            object: { key: 'invocation-logs/2024/03/15/14/req-integration-test-001.json' },
          },
          awsRegion: SAMPLE_REGION,
        }],
      };

      await invocationProcessorHandler(s3Event);
      expect(capturedParquetBuffer).toBeUndefined();
    });
  });

  // ── Test 2: Identity Resolver resolves IAM principal ───────────────────────

  describe('Identity_Resolver handler', () => {
    it('resolves IAM assumed-role ARN to role name (IAM mode)', async () => {
      process.env['IDENTITY_MODE'] = 'iam';

      const result = await identityResolverHandler({
        principalArn: SAMPLE_CALLER_ARN,
        sessionName: 'alice',
      });

      expect(result.resolved).toBe(true);
      expect(result.source).toBe('iam');
      expect(result.iamRoleName).toBe('DevRole');
    });

    it('resolves SSO identity via Identity Store (SSO mode)', async () => {
      process.env['IDENTITY_MODE'] = 'sso';
      process.env['IDENTITY_STORE_ID'] = 'd-1234567890';

      identityStoreMock.on(ListUsersCommand).resolves({
        Users: [{
          UserId: 'sso-user-001',
          UserName: 'alice',
          DisplayName: 'Alice Smith',
          IdentityStoreId: 'd-1234567890',
          Emails: [{ Value: 'alice@example.com', Primary: true }],
        }],
      });

      const result = await identityResolverHandler({
        principalArn: SAMPLE_CALLER_ARN,
        sessionName: 'alice',
      });

      expect(result.resolved).toBe(true);
      expect(result.source).toBe('sso');
      expect(result.displayName).toBe('Alice Smith');
      expect(result.email).toBe('alice@example.com');
      expect(result.userId).toBe('sso-user-001');

      delete process.env['IDENTITY_STORE_ID'];
    });

    it('caches resolved identity in DynamoDB', async () => {
      process.env['IDENTITY_MODE'] = 'iam';

      await identityResolverHandler({
        principalArn: SAMPLE_CALLER_ARN,
        sessionName: 'alice',
      });

      expect(ddbDocMock).toHaveReceivedCommandWith(GetCommand, {
        TableName: ENV.IDENTITY_CACHE_TABLE,
        Key: { principalArn: SAMPLE_CALLER_ARN, sourceType: 'resolved' },
      });

      expect(ddbDocMock).toHaveReceivedCommandWith(PutCommand, {
        TableName: ENV.IDENTITY_CACHE_TABLE,
      });
    });
  });

  // ── Test 3: Full pipeline — Invocation Processor → Identity Resolver ───────

  describe('Full end-to-end pipeline', () => {
    it('produces a complete record with identity fields and pending cost status', async () => {
      const s3Event = {
        Records: [{
          s3: {
            bucket: { name: 'raw-logs-bucket' },
            object: { key: 'invocation-logs/2024/03/15/14/req-integration-test-001.json' },
          },
          awsRegion: SAMPLE_REGION,
        }],
      };

      await invocationProcessorHandler(s3Event);

      expect(capturedParquetBuffer).toBeDefined();
      expect(capturedParquetBuffer!.length).toBeGreaterThan(0);

      const reader = await ParquetReader.openBuffer(capturedParquetBuffer!);
      const cursor = reader.getCursor();
      const rows: Record<string, unknown>[] = [];
      while (true) {
        const row = await cursor.next() as Record<string, unknown> | null;
        if (row === null) break;
        rows.push(row);
      }
      await reader.close();

      expect(rows).toHaveLength(1);
      const record = rows[0]!;

      // Verify base invocation fields
      expect(record['requestId']).toBe(SAMPLE_REQUEST_ID);
      expect(record['timestamp']).toBe(SAMPLE_TIMESTAMP);
      expect(record['modelId']).toBe(SAMPLE_MODEL_ID);
      expect(Number(record['inputTokens'])).toBe(150);
      expect(Number(record['outputTokens'])).toBe(75);
      expect(Number(record['latencyMs'])).toBe(1200);
      expect(record['callerArn']).toBe(SAMPLE_CALLER_ARN);

      // Verify CUR migration: costs are $0 with pending status
      expect(Number(record['inputCost'])).toBe(0);
      expect(Number(record['outputCost'])).toBe(0);
      expect(Number(record['totalCost'])).toBe(0);
      expect(record['costStatus']).toBe('pending');
    });

    it('produces correct Hive-style S3 path for single-region mode', async () => {
      process.env['REGION_MODE'] = 'single';

      const s3Event = {
        Records: [{
          s3: {
            bucket: { name: 'raw-logs-bucket' },
            object: { key: 'invocation-logs/2024/03/15/14/req-integration-test-001.json' },
          },
          awsRegion: SAMPLE_REGION,
        }],
      };

      await invocationProcessorHandler(s3Event);

      expect(capturedS3Key).toMatch(/^invocation-logs\/year=2024\/month=03\/day=15\/hour=14\//);
      expect(capturedS3Key).not.toMatch(/region=/);
    });

    it('produces correct Hive-style S3 path for multi-region mode', async () => {
      process.env['REGION_MODE'] = 'multi';

      const s3Event = {
        Records: [{
          s3: {
            bucket: { name: 'raw-logs-bucket' },
            object: { key: 'invocation-logs/2024/03/15/14/req-integration-test-001.json' },
          },
          awsRegion: SAMPLE_REGION,
        }],
      };

      await invocationProcessorHandler(s3Event);

      expect(capturedS3Key).toMatch(/^invocation-logs\/region=us-east-1\/year=2024\/month=03\/day=15\/hour=14\//);
    });

    it('verifies Parquet output contains all required invocation fields', async () => {
      const s3Event = {
        Records: [{
          s3: {
            bucket: { name: 'raw-logs-bucket' },
            object: { key: 'invocation-logs/2024/03/15/14/req-integration-test-001.json' },
          },
          awsRegion: SAMPLE_REGION,
        }],
      };

      await invocationProcessorHandler(s3Event);

      expect(capturedParquetBuffer).toBeDefined();

      const reader = await ParquetReader.openBuffer(capturedParquetBuffer!);
      const cursor = reader.getCursor();
      const row = await cursor.next() as Record<string, unknown> | null;
      await reader.close();

      expect(row).not.toBeNull();

      const requiredFields = [
        'requestId', 'timestamp', 'accountId', 'region',
        'modelId', 'resolvedModelId',
        'inputTokens', 'outputTokens', 'latencyMs',
        'callerArn',
        'resolvedUserId', 'resolvedUserName', 'resolvedUserEmail',
        'inputCost', 'outputCost', 'totalCost', 'costStatus',
        'rawRequest', 'rawResponse',
        'sourceRegion', 'executionRegion',
      ];

      for (const field of requiredFields) {
        expect(row).toHaveProperty(field);
      }
    });
  });
});
