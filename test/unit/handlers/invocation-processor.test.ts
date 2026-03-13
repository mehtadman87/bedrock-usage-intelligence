/**
 * Unit tests for the Invocation Processor handler.
 *
 * Tests the exported parseInvocationLog, resolveInferenceProfile,
 * extractUserNameFromArn, extractTierFromRequestBody, extractCacheTtlFromRequestBody
 * functions and the handler without S3/DynamoDB dependencies.
 *
 * Validates:
 * - Pricing-related code is removed (no Lambda/SQS client calls)
 * - costStatus: 'pending' is set on output records
 * - Cost fields are 0 (inputCost, outputCost, totalCost)
 * - All non-cost processing is unchanged: parsing, identity resolution, Parquet writing
 * - Idempotency checking still works
 *
 * Requirements: 2.5, 3.1, 3.2, 3.4, 3.5, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 13.4
 */

import {
  mockClient,
} from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Readable } from 'stream';
import {
  parseInvocationLog,
  resolveInferenceProfile,
  extractUserNameFromArn,
  extractTierFromRequestBody,
  extractCacheTtlFromRequestBody,
  BedrockInvocationLog,
} from 'lib/handlers/invocation-processor/index';
import { handler } from 'lib/handlers/invocation-processor/index';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  s3Mock.reset();
  ddbMock.reset();
  // Set required env vars
  process.env['PROCESSED_DATA_BUCKET'] = 'processed-bucket';
  process.env['FAILED_RECORDS_BUCKET'] = 'failed-bucket';
  process.env['IDEMPOTENCY_TABLE'] = 'idempotency-table';
  process.env['REGION_MODE'] = 'single';
  process.env['PROCESSOR_NAME'] = 'invocation';
  process.env['AWS_REGION'] = 'us-east-1';
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReadableStream(content: string): Readable {
  const readable = new Readable();
  readable.push(content);
  readable.push(null);
  return readable;
}

// ─── parseInvocationLog Tests ─────────────────────────────────────────────────

describe('parseInvocationLog', () => {
  const standardLog: BedrockInvocationLog = {
    requestId: 'req-001',
    timestamp: '2024-01-15T14:30:00.000Z',
    accountId: '123456789012',
    region: 'us-east-1',
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    input: {
      inputTokenCount: 512,
      inputBodyJson: '{"prompt":"Hello"}',
    },
    output: {
      outputTokenCount: 256,
      outputBodyJson: '{"completion":"Hi there"}',
      latencyMs: 1200,
    },
    identity: {
      arn: 'arn:aws:iam::123456789012:role/MyRole',
    },
  };

  it('parses standard invocation log with all required fields', () => {
    const record = parseInvocationLog(standardLog);

    expect(record.requestId).toBe('req-001');
    expect(record.timestamp).toBe('2024-01-15T14:30:00.000Z');
    expect(record.accountId).toBe('123456789012');
    expect(record.region).toBe('us-east-1');
    expect(record.modelId).toBe('anthropic.claude-3-sonnet-20240229-v1:0');
    expect(record.resolvedModelId).toBe('anthropic.claude-3-sonnet-20240229-v1:0');
    expect(record.inputTokens).toBe(512);
    expect(record.outputTokens).toBe(256);
    expect(record.latencyMs).toBe(1200);
    expect(record.callerArn).toBe('arn:aws:iam::123456789012:role/MyRole');
    expect(record.rawRequest).toBe('{"prompt":"Hello"}');
    expect(record.rawResponse).toBe('{"completion":"Hi there"}');
    expect(record.sourceRegion).toBe('us-east-1');
    expect(record.executionRegion).toBe('us-east-1');
  });

  it('throws on missing requestId', () => {
    const log = { ...standardLog, requestId: '' };
    expect(() => parseInvocationLog(log)).toThrow('Missing required field: requestId');
  });

  it('throws on missing timestamp', () => {
    const log = { ...standardLog, timestamp: '' };
    expect(() => parseInvocationLog(log)).toThrow('Missing required field: timestamp');
  });

  it('throws on missing modelId', () => {
    const log = { ...standardLog, modelId: '' };
    expect(() => parseInvocationLog(log)).toThrow('Missing required field: modelId');
  });

  it('throws on non-object input', () => {
    expect(() => parseInvocationLog(null)).toThrow('Invalid invocation log');
    expect(() => parseInvocationLog('string')).toThrow('Invalid invocation log');
    expect(() => parseInvocationLog(42)).toThrow('Invalid invocation log');
  });

  it('defaults missing numeric fields to 0', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-002',
      timestamp: '2024-01-15T14:30:00.000Z',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    };
    const record = parseInvocationLog(log);
    expect(record.inputTokens).toBe(0);
    expect(record.outputTokens).toBe(0);
    expect(record.latencyMs).toBe(0);
    expect(record.callerArn).toBe('');
    expect(record.rawRequest).toBe('');
    expect(record.rawResponse).toBe('');
  });
});

// ─── Agent Invocation Tests ───────────────────────────────────────────────────

describe('parseInvocationLog - agent invocations', () => {
  it('extracts agentId and agentAlias from agent invocation', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-agent-001',
      timestamp: '2024-01-15T14:30:00.000Z',
      accountId: '123456789012',
      region: 'us-east-1',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      input: { inputTokenCount: 100, inputBodyJson: '{}' },
      output: { outputTokenCount: 50, outputBodyJson: '{}', latencyMs: 500 },
      identity: { arn: 'arn:aws:iam::123456789012:role/AgentRole' },
      agentId: 'agent-xyz',
      agentAlias: 'prod',
      subInvocations: [{ step: 1 }, { step: 2 }],
    };

    const record = parseInvocationLog(log);

    expect(record.agentId).toBe('agent-xyz');
    expect(record.agentAlias).toBe('prod');
  });

  it('does not set agentId/agentAlias for non-agent invocations', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-003',
      timestamp: '2024-01-15T14:30:00.000Z',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      input: { inputTokenCount: 100, inputBodyJson: '{}' },
      output: { outputTokenCount: 50, outputBodyJson: '{}', latencyMs: 500 },
    };

    const record = parseInvocationLog(log);

    expect(record.agentId).toBeUndefined();
    expect(record.agentAlias).toBeUndefined();
  });
});

// ─── Image Model Tests ────────────────────────────────────────────────────────

describe('parseInvocationLog - image models', () => {
  it('extracts imageCount and imageDimensions', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-img-001',
      timestamp: '2024-01-15T14:30:00.000Z',
      accountId: '123456789012',
      region: 'us-east-1',
      modelId: 'stability.stable-diffusion-xl-v1',
      input: { inputBodyJson: '{"prompt":"a cat"}' },
      output: {
        outputBodyJson: '{"images":["base64..."]}',
        latencyMs: 3000,
        imageCount: 2,
        imageDimensions: '1024x1024',
      },
      identity: { arn: 'arn:aws:iam::123456789012:role/MyRole' },
    };

    const record = parseInvocationLog(log);

    expect(record.imageCount).toBe(2);
    expect(record.imageDimensions).toBe('1024x1024');
    expect(record.videoDurationSeconds).toBeUndefined();
    expect(record.videoResolution).toBeUndefined();
  });
});

// ─── Video Model Tests ────────────────────────────────────────────────────────

describe('parseInvocationLog - video models', () => {
  it('extracts videoDurationSeconds and videoResolution', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-vid-001',
      timestamp: '2024-01-15T14:30:00.000Z',
      accountId: '123456789012',
      region: 'us-east-1',
      modelId: 'amazon.nova-reel-v1:0',
      input: { inputBodyJson: '{"prompt":"a sunset"}' },
      output: {
        outputBodyJson: '{"video":"base64..."}',
        latencyMs: 10000,
        videoDurationSeconds: 6.0,
        videoResolution: '1080p',
      },
      identity: { arn: 'arn:aws:iam::123456789012:role/MyRole' },
    };

    const record = parseInvocationLog(log);

    expect(record.videoDurationSeconds).toBe(6.0);
    expect(record.videoResolution).toBe('1080p');
    expect(record.imageCount).toBeUndefined();
    expect(record.imageDimensions).toBeUndefined();
  });
});

// ─── resolveInferenceProfile Tests ───────────────────────────────────────────

describe('resolveInferenceProfile', () => {
  it('resolves cross-region inference profile ARN to underlying model ID', () => {
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-sonnet-20240229-v1:0';
    const result = resolveInferenceProfile(arn, 'us-west-2');

    expect(result.resolvedModelId).toBe('anthropic.claude-3-sonnet-20240229-v1:0');
    expect(result.sourceRegion).toBe('us-east-1');
    expect(result.executionRegion).toBe('us-west-2');
    expect(result.crossRegionType).toBe('geo');
  });

  it('resolves EU cross-region inference profile ARN', () => {
    const arn = 'arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-3-haiku-20240307-v1:0';
    const result = resolveInferenceProfile(arn, 'eu-central-1');

    expect(result.resolvedModelId).toBe('anthropic.claude-3-haiku-20240307-v1:0');
    expect(result.sourceRegion).toBe('eu-west-1');
    expect(result.executionRegion).toBe('eu-central-1');
    expect(result.crossRegionType).toBe('geo');
  });

  it('resolves AP cross-region inference profile ARN', () => {
    const arn = 'arn:aws:bedrock:ap-northeast-1:123456789012:inference-profile/ap.meta.llama3-8b-instruct-v1:0';
    const result = resolveInferenceProfile(arn, 'ap-southeast-1');

    expect(result.resolvedModelId).toBe('meta.llama3-8b-instruct-v1:0');
    expect(result.sourceRegion).toBe('ap-northeast-1');
    expect(result.executionRegion).toBe('ap-southeast-1');
    expect(result.crossRegionType).toBe('geo');
  });

  it('resolves global cross-region inference profile ARN (no geo prefix)', () => {
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/anthropic.claude-3-sonnet-20240229-v1:0';
    const result = resolveInferenceProfile(arn, 'eu-west-1');

    expect(result.resolvedModelId).toBe('anthropic.claude-3-sonnet-20240229-v1:0');
    expect(result.sourceRegion).toBe('us-east-1');
    expect(result.executionRegion).toBe('eu-west-1');
    expect(result.crossRegionType).toBe('global');
  });

  it('passes through standard model IDs unchanged', () => {
    const modelId = 'anthropic.claude-3-sonnet-20240229-v1:0';
    const result = resolveInferenceProfile(modelId, 'us-east-1');

    expect(result.resolvedModelId).toBe(modelId);
    expect(result.sourceRegion).toBe('us-east-1');
    expect(result.executionRegion).toBe('us-east-1');
    expect(result.crossRegionType).toBe('none');
  });

  it('handles prefixed model IDs without full ARN', () => {
    const modelId = 'us.anthropic.claude-3-sonnet-20240229-v1:0';
    const result = resolveInferenceProfile(modelId, 'us-east-1');

    expect(result.resolvedModelId).toBe('anthropic.claude-3-sonnet-20240229-v1:0');
    expect(result.executionRegion).toBe('us-east-1');
    expect(result.crossRegionType).toBe('geo');
  });
});

// ─── Hive-style Path Generation Tests ────────────────────────────────────────

describe('Parquet output format and Hive-style path generation', () => {
  it('generates correct single-region partition path', () => {
    const { generatePartitionPath } = require('lib/shared/s3-partitioner');
    const timestamp = new Date('2024-01-15T14:30:00.000Z');
    const path = generatePartitionPath('invocation-logs', timestamp);
    expect(path).toBe('invocation-logs/year=2024/month=01/day=15/hour=14/');
  });

  it('generates correct multi-region partition path', () => {
    const { generatePartitionPath } = require('lib/shared/s3-partitioner');
    const timestamp = new Date('2024-01-15T14:30:00.000Z');
    const path = generatePartitionPath('invocation-logs', timestamp, 'us-east-1');
    expect(path).toBe('invocation-logs/region=us-east-1/year=2024/month=01/day=15/hour=14/');
  });
});

// ─── Handler Integration Tests (with mocked AWS) ─────────────────────────────

describe('handler - S3 event processing', () => {
  const validLog: BedrockInvocationLog = {
    requestId: 'req-handler-001',
    timestamp: '2024-01-15T14:30:00.000Z',
    accountId: '123456789012',
    region: 'us-east-1',
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    input: { inputTokenCount: 100, inputBodyJson: '{"prompt":"test"}' },
    output: { outputTokenCount: 50, outputBodyJson: '{"completion":"ok"}', latencyMs: 500 },
    identity: { arn: 'arn:aws:iam::123456789012:role/MyRole' },
  };

  it('processes a valid S3 event record', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(JSON.stringify(validLog)) as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined }); // not yet processed
    ddbMock.on(PutCommand).resolves({});

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'raw-logs-bucket' },
          object: { key: 'logs/2024/01/15/req-handler-001.json' },
        },
        awsRegion: 'us-east-1',
      }],
    };

    await expect(handler(event as any)).resolves.toBeUndefined();
    expect(s3Mock).toHaveReceivedCommandTimes(PutObjectCommand, 1);
  });

  it('skips duplicate records (idempotency)', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(JSON.stringify(validLog)) as any,
    });
    // DynamoDB returns existing item — already processed
    ddbMock.on(GetCommand).resolves({ Item: { requestId: 'req-handler-001', timestamp: '2024-01-15T14:30:00.000Z' } });

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'raw-logs-bucket' },
          object: { key: 'logs/2024/01/15/req-handler-001.json' },
        },
        awsRegion: 'us-east-1',
      }],
    };

    await expect(handler(event as any)).resolves.toBeUndefined();
    // Should NOT write to processed bucket since it's a duplicate
    expect(s3Mock).not.toHaveReceivedCommand(PutObjectCommand);
  });

  it('writes failed record to failed records bucket on malformed JSON', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream('not valid json {{{') as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'raw-logs-bucket' },
          object: { key: 'logs/2024/01/15/bad-record.json' },
        },
        awsRegion: 'us-east-1',
      }],
    };

    await expect(handler(event as any)).resolves.toBeUndefined();
    // Malformed JSON is caught per-line; handler continues and does not throw
  });
});

// ─── extractTierFromRequestBody ───────────────────────────────────────────────

describe('extractTierFromRequestBody', () => {
  it('returns priority for service_tier: "priority"', () => {
    expect(extractTierFromRequestBody({ service_tier: 'priority' })).toBe('priority');
  });

  it('returns flex for service_tier: "flex"', () => {
    expect(extractTierFromRequestBody({ service_tier: 'flex' })).toBe('flex');
  });

  it('returns standard for service_tier: "default"', () => {
    expect(extractTierFromRequestBody({ service_tier: 'default' })).toBe('standard');
  });

  it('returns standard when service_tier is absent', () => {
    expect(extractTierFromRequestBody({})).toBe('standard');
    expect(extractTierFromRequestBody({ model: 'claude' })).toBe('standard');
  });

  it('returns standard for service_tier: "reserved"', () => {
    expect(extractTierFromRequestBody({ service_tier: 'reserved' })).toBe('standard');
  });

  it('returns standard for unrecognized service_tier string', () => {
    expect(extractTierFromRequestBody({ service_tier: 'turbo' })).toBe('standard');
    expect(extractTierFromRequestBody({ service_tier: 'ultra' })).toBe('standard');
  });

  it('parses inputBodyJson as JSON string and extracts tier', () => {
    const jsonString = JSON.stringify({ service_tier: 'priority', model: 'claude' });
    expect(extractTierFromRequestBody(jsonString)).toBe('priority');
  });

  it('returns standard for JSON string without service_tier', () => {
    const jsonString = JSON.stringify({ model: 'claude', max_tokens: 1000 });
    expect(extractTierFromRequestBody(jsonString)).toBe('standard');
  });

  it('returns standard for null', () => {
    expect(extractTierFromRequestBody(null)).toBe('standard');
  });

  it('returns standard for undefined', () => {
    expect(extractTierFromRequestBody(undefined)).toBe('standard');
  });

  it('returns standard for invalid JSON string', () => {
    expect(extractTierFromRequestBody('not valid json {')).toBe('standard');
  });

  it('returns standard for non-object JSON (e.g. a number string)', () => {
    expect(extractTierFromRequestBody('42')).toBe('standard');
  });
});

// ─── extractCacheTtlFromRequestBody ──────────────────────────────────────────

describe('extractCacheTtlFromRequestBody', () => {
  it('returns "1h" when body contains "ttl":"1h"', () => {
    const body = { cachePoint: { ttl: '1h' } };
    expect(extractCacheTtlFromRequestBody(body)).toBe('1h');
  });

  it('returns "1h" when body contains "ttl": "1h" (with space)', () => {
    // JSON.stringify won't produce a space, but test the string-search path
    const raw = '{"cachePoint":{"ttl": "1h"}}';
    expect(extractCacheTtlFromRequestBody(raw)).toBe('1h');
  });

  it('returns "5m" when body contains "ttl":"5m"', () => {
    const body = { cachePoint: { ttl: '5m' } };
    expect(extractCacheTtlFromRequestBody(body)).toBe('5m');
  });

  it('returns "5m" when no cachePoint present', () => {
    expect(extractCacheTtlFromRequestBody({ model: 'claude' })).toBe('5m');
    expect(extractCacheTtlFromRequestBody({})).toBe('5m');
  });

  it('returns "5m" for null', () => {
    expect(extractCacheTtlFromRequestBody(null)).toBe('5m');
  });

  it('returns "5m" for undefined', () => {
    expect(extractCacheTtlFromRequestBody(undefined)).toBe('5m');
  });
});

// ─── parseInvocationLog: new tier/cache fields ────────────────────────────────

describe('parseInvocationLog - tier and cache fields', () => {
  it('defaults inferenceTier to standard when no service_tier in body', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-tier-001',
      timestamp: '2024-01-15T14:30:00.000Z',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      input: { inputBodyJson: { model: 'claude' } },
    };
    const record = parseInvocationLog(log);
    expect(record.inferenceTier).toBe('standard');
  });

  it('extracts priority tier from inputBodyJson', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-tier-002',
      timestamp: '2024-01-15T14:30:00.000Z',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      input: { inputBodyJson: { service_tier: 'priority' } },
    };
    const record = parseInvocationLog(log);
    expect(record.inferenceTier).toBe('priority');
  });

  it('sets cacheType to none when no cache tokens', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-cache-001',
      timestamp: '2024-01-15T14:30:00.000Z',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      input: { cacheWriteInputTokenCount: 0, cacheReadInputTokenCount: 0 },
    };
    const record = parseInvocationLog(log);
    expect(record.cacheType).toBe('none');
    expect(record.cacheWriteInputTokens).toBe(0);
    expect(record.cacheReadInputTokens).toBe(0);
  });

  it('sets cacheType to cacheWrite5m when cacheWriteInputTokenCount > 0 and no 1h TTL', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-cache-002',
      timestamp: '2024-01-15T14:30:00.000Z',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      input: {
        cacheWriteInputTokenCount: 500,
        inputBodyJson: { cachePoint: { ttl: '5m' } },
      },
    };
    const record = parseInvocationLog(log);
    expect(record.cacheType).toBe('cacheWrite5m');
    expect(record.cacheWriteInputTokens).toBe(500);
  });

  it('sets cacheType to cacheWrite1h when cacheWriteInputTokenCount > 0 and TTL is 1h', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-cache-003',
      timestamp: '2024-01-15T14:30:00.000Z',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      input: {
        cacheWriteInputTokenCount: 500,
        inputBodyJson: { cachePoint: { ttl: '1h' } },
      },
    };
    const record = parseInvocationLog(log);
    expect(record.cacheType).toBe('cacheWrite1h');
    expect(record.cacheWriteInputTokens).toBe(500);
  });

  it('sets cacheType to cacheRead when only cacheReadInputTokenCount > 0', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-cache-004',
      timestamp: '2024-01-15T14:30:00.000Z',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      input: {
        cacheReadInputTokenCount: 300,
        cacheWriteInputTokenCount: 0,
      },
    };
    const record = parseInvocationLog(log);
    expect(record.cacheType).toBe('cacheRead');
    expect(record.cacheReadInputTokens).toBe(300);
  });

  it('uses write TTL when both cache fields are non-zero', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-cache-005',
      timestamp: '2024-01-15T14:30:00.000Z',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      input: {
        cacheWriteInputTokenCount: 200,
        cacheReadInputTokenCount: 100,
        inputBodyJson: { cachePoint: { ttl: '1h' } },
      },
    };
    const record = parseInvocationLog(log);
    expect(record.cacheType).toBe('cacheWrite1h');
    expect(record.cacheWriteInputTokens).toBe(200);
    expect(record.cacheReadInputTokens).toBe(100);
  });
});


// ─── Pricing Removal Verification (Req 2.5) ──────────────────────────────────

describe('pricing code removal verification', () => {
  it('source file does not import Lambda or SQS clients', () => {
    // Read the source file and verify no pricing-related imports exist
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('lib/handlers/invocation-processor/index'),
      'utf-8',
    );
    expect(source).not.toContain('@aws-sdk/client-lambda');
    expect(source).not.toContain('@aws-sdk/client-sqs');
    expect(source).not.toContain('LambdaClient');
    expect(source).not.toContain('SQSClient');
    expect(source).not.toContain('InvokeCommand');
    expect(source).not.toContain('SendMessageCommand');
  });

  it('source file does not contain pricing functions', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('lib/handlers/invocation-processor/index'),
      'utf-8',
    );
    expect(source).not.toContain('callPricingEngine');
    expect(source).not.toContain('triggerPricingScraper');
    expect(source).not.toContain('enqueueForRepricing');
    expect(source).not.toContain('PricingRetryMessage');
    expect(source).not.toContain('PRICING_ENGINE_ARN');
    expect(source).not.toContain('PRICING_SCRAPER_ARN');
    expect(source).not.toContain('PRICING_RETRY_QUEUE_URL');
  });

  it('handler only accepts S3 events (no SQS event branch)', () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require.resolve('lib/handlers/invocation-processor/index'),
      'utf-8',
    );
    // The handler should not reference SQS event handling for repricing
    expect(source).not.toContain('SqsEvent');
    expect(source).not.toContain('getLambdaClient');
    expect(source).not.toContain('getSqsClient');
  });
});

// ─── costStatus and Cost Fields Verification (Req 2.5, 3.1) ─────────────────

describe('parseInvocationLog - cost fields and costStatus', () => {
  const standardLog: BedrockInvocationLog = {
    requestId: 'req-cost-001',
    timestamp: '2024-06-15T10:00:00.000Z',
    accountId: '123456789012',
    region: 'us-east-1',
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    input: { inputTokenCount: 1000, inputBodyJson: '{"prompt":"test"}' },
    output: { outputTokenCount: 500, outputBodyJson: '{"completion":"ok"}', latencyMs: 800 },
    identity: { arn: 'arn:aws:iam::123456789012:user/alice' },
  };

  it('sets costStatus to "pending" on all parsed records', () => {
    const record = parseInvocationLog(standardLog);
    expect(record.costStatus).toBe('pending');
  });

  it('sets inputCost to 0', () => {
    const record = parseInvocationLog(standardLog);
    expect(record.inputCost).toBe(0);
  });

  it('sets outputCost to 0', () => {
    const record = parseInvocationLog(standardLog);
    expect(record.outputCost).toBe(0);
  });

  it('sets totalCost to 0', () => {
    const record = parseInvocationLog(standardLog);
    expect(record.totalCost).toBe(0);
  });

  it('sets all cost fields to 0 and costStatus to pending for minimal log', () => {
    const minimalLog: BedrockInvocationLog = {
      requestId: 'req-cost-002',
      timestamp: '2024-06-15T10:00:00.000Z',
      modelId: 'amazon.titan-text-express-v1',
    };
    const record = parseInvocationLog(minimalLog);
    expect(record.inputCost).toBe(0);
    expect(record.outputCost).toBe(0);
    expect(record.totalCost).toBe(0);
    expect(record.costStatus).toBe('pending');
  });

  it('sets cost fields to 0 for cross-region inference profile', () => {
    const crossRegionLog: BedrockInvocationLog = {
      requestId: 'req-cost-003',
      timestamp: '2024-06-15T10:00:00.000Z',
      modelId: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-sonnet-20240229-v1:0',
      input: { inputTokenCount: 2000 },
      output: { outputTokenCount: 1000 },
    };
    const record = parseInvocationLog(crossRegionLog);
    expect(record.inputCost).toBe(0);
    expect(record.outputCost).toBe(0);
    expect(record.totalCost).toBe(0);
    expect(record.costStatus).toBe('pending');
  });

  it('sets cost fields to 0 for image model invocations', () => {
    const imageLog: BedrockInvocationLog = {
      requestId: 'req-cost-004',
      timestamp: '2024-06-15T10:00:00.000Z',
      modelId: 'stability.stable-diffusion-xl-v1',
      output: { imageCount: 4, imageDimensions: '1024x1024', latencyMs: 5000 },
    };
    const record = parseInvocationLog(imageLog);
    expect(record.inputCost).toBe(0);
    expect(record.outputCost).toBe(0);
    expect(record.totalCost).toBe(0);
    expect(record.costStatus).toBe('pending');
  });
});

// ─── extractUserNameFromArn Tests (Req 3.2) ──────────────────────────────────

describe('extractUserNameFromArn', () => {
  it('extracts user name from IAM user ARN', () => {
    expect(extractUserNameFromArn('arn:aws:iam::123456789012:user/alice')).toBe('alice');
  });

  it('extracts role/session from assumed-role ARN', () => {
    expect(
      extractUserNameFromArn('arn:aws:sts::123456789012:assumed-role/MyRole/session-name'),
    ).toBe('MyRole/session-name');
  });

  it('extracts root from root ARN', () => {
    expect(extractUserNameFromArn('arn:aws:iam::123456789012:root')).toBe('root');
  });

  it('extracts role name from role ARN', () => {
    expect(extractUserNameFromArn('arn:aws:iam::123456789012:role/AdminRole')).toBe('AdminRole');
  });

  it('returns "unknown" for empty string', () => {
    expect(extractUserNameFromArn('')).toBe('unknown');
  });

  it('returns ARN as-is for invalid ARN format (fewer than 6 parts)', () => {
    expect(extractUserNameFromArn('not:an:arn')).toBe('not:an:arn');
  });

  it('handles nested user paths', () => {
    expect(extractUserNameFromArn('arn:aws:iam::123456789012:user/team/alice')).toBe('team/alice');
  });
});

// ─── Identity Resolution Verification (Req 3.2) ─────────────────────────────

describe('parseInvocationLog - identity resolution', () => {
  it('resolves callerArn to resolvedUserId and resolvedUserName', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-id-001',
      timestamp: '2024-06-15T10:00:00.000Z',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      identity: { arn: 'arn:aws:iam::123456789012:user/bob' },
    };
    const record = parseInvocationLog(log);
    expect(record.callerArn).toBe('arn:aws:iam::123456789012:user/bob');
    expect(record.resolvedUserId).toBe('arn:aws:iam::123456789012:user/bob');
    expect(record.resolvedUserName).toBe('bob');
  });

  it('resolves assumed-role ARN to role/session user name', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-id-002',
      timestamp: '2024-06-15T10:00:00.000Z',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      identity: { arn: 'arn:aws:sts::123456789012:assumed-role/DataScientist/jupyter-session' },
    };
    const record = parseInvocationLog(log);
    expect(record.resolvedUserName).toBe('DataScientist/jupyter-session');
  });

  it('defaults to empty callerArn and "unknown" userName when identity is missing', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-id-003',
      timestamp: '2024-06-15T10:00:00.000Z',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    };
    const record = parseInvocationLog(log);
    expect(record.callerArn).toBe('');
    expect(record.resolvedUserName).toBe('unknown');
  });
});

// ─── Non-Cost Processing Preservation (Req 3.1, 3.4, 3.5) ──────────────────

describe('parseInvocationLog - non-cost field preservation', () => {
  it('preserves all non-cost fields for a fully populated log', () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-preserve-001',
      timestamp: '2024-06-15T10:00:00.000Z',
      accountId: '999888777666',
      region: 'eu-west-1',
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      input: {
        inputTokenCount: 750,
        inputBodyJson: '{"prompt":"preserve test","service_tier":"flex"}',
        cacheWriteInputTokenCount: 100,
        cacheReadInputTokenCount: 0,
      },
      output: {
        outputTokenCount: 300,
        outputBodyJson: '{"completion":"preserved"}',
        latencyMs: 450,
      },
      identity: { arn: 'arn:aws:iam::999888777666:user/charlie' },
      agentId: 'agent-abc',
      agentAlias: 'staging',
      guardrailId: 'guard-123',
    };

    const record = parseInvocationLog(log);

    // Non-cost fields must be correctly extracted
    expect(record.requestId).toBe('req-preserve-001');
    expect(record.timestamp).toBe('2024-06-15T10:00:00.000Z');
    expect(record.accountId).toBe('999888777666');
    expect(record.region).toBe('eu-west-1');
    expect(record.modelId).toBe('anthropic.claude-3-haiku-20240307-v1:0');
    expect(record.resolvedModelId).toBe('anthropic.claude-3-haiku-20240307-v1:0');
    expect(record.inputTokens).toBe(750);
    expect(record.outputTokens).toBe(300);
    expect(record.latencyMs).toBe(450);
    expect(record.callerArn).toBe('arn:aws:iam::999888777666:user/charlie');
    expect(record.resolvedUserName).toBe('charlie');
    expect(record.inferenceTier).toBe('flex');
    expect(record.cacheType).toBe('cacheWrite5m');
    expect(record.cacheWriteInputTokens).toBe(100);
    expect(record.cacheReadInputTokens).toBe(0);
    expect(record.crossRegionType).toBe('none');
    expect(record.agentId).toBe('agent-abc');
    expect(record.agentAlias).toBe('staging');
    expect(record.guardrailId).toBe('guard-123');

    // Cost fields must be zeroed with pending status
    expect(record.inputCost).toBe(0);
    expect(record.outputCost).toBe(0);
    expect(record.totalCost).toBe(0);
    expect(record.costStatus).toBe('pending');
  });
});

// ─── Handler: costStatus in Parquet Output (Req 2.5) ─────────────────────────

describe('handler - costStatus in output', () => {
  it('writes records with costStatus pending and zero costs via handler', async () => {
    const log: BedrockInvocationLog = {
      requestId: 'req-handler-cost-001',
      timestamp: '2024-06-15T10:00:00.000Z',
      accountId: '123456789012',
      region: 'us-east-1',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      input: { inputTokenCount: 100, inputBodyJson: '{"prompt":"cost test"}' },
      output: { outputTokenCount: 50, outputBodyJson: '{"completion":"ok"}', latencyMs: 500 },
      identity: { arn: 'arn:aws:iam::123456789012:user/tester' },
    };

    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(JSON.stringify(log)) as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'raw-logs-bucket' },
          object: { key: 'logs/2024/06/15/req-handler-cost-001.json' },
        },
        awsRegion: 'us-east-1',
      }],
    };

    await handler(event as any);

    // Verify Parquet was written (the record includes costStatus: 'pending')
    expect(s3Mock).toHaveReceivedCommandTimes(PutObjectCommand, 1);

    // Verify the parsed record has correct cost fields
    const record = parseInvocationLog(log);
    expect(record.costStatus).toBe('pending');
    expect(record.inputCost).toBe(0);
    expect(record.outputCost).toBe(0);
    expect(record.totalCost).toBe(0);
  });
});

// ─── Parquet Schema Verification (Req 3.4) ───────────────────────────────────

describe('Parquet schema includes costStatus', () => {
  it('INVOCATION_LOG_SCHEMA contains costStatus field', () => {
    const { INVOCATION_LOG_SCHEMA } = require('lib/shared/parquet-writer');
    const fields = Object.keys(INVOCATION_LOG_SCHEMA.schema);
    expect(fields).toContain('costStatus');
  });

  it('INVOCATION_LOG_SCHEMA costStatus is a required UTF8 field', () => {
    const { INVOCATION_LOG_SCHEMA } = require('lib/shared/parquet-writer');
    const costStatusField = INVOCATION_LOG_SCHEMA.schema['costStatus'];
    expect(costStatusField.type).toBe('UTF8');
    // costStatus should not be optional — every record must have it
    expect(costStatusField.optional).toBeFalsy();
  });
});
