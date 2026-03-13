// Feature: bedrock-usage-intelligence
// Unit tests for shared utilities
// Requirements: 5.6, 7.4, 8.8, 13.4, 13.5, 13.6, 17.2, 18.3

import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import {
  writeParquet,
  INVOCATION_LOG_SCHEMA,
  CLOUDTRAIL_EVENT_SCHEMA,
  METRICS_SCHEMA,
} from 'lib/shared/parquet-writer';
import { generatePartitionPath } from 'lib/shared/s3-partitioner';
import { IdempotencyChecker } from 'lib/shared/idempotency';
import { CircuitBreaker } from 'lib/shared/circuit-breaker';
import { TokenBucketRateLimiter } from 'lib/shared/rate-limiter';

// ─── 1. Parquet Writer ────────────────────────────────────────────────────────

describe('Parquet writer', () => {
  it('serializes an invocation log record (all required + some optional fields) to a non-empty Buffer', async () => {
    const record = {
      requestId: 'req-001',
      timestamp: '2024-01-15T14:30:00.000Z',
      accountId: '123456789012',
      region: 'us-east-1',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      resolvedModelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      inputTokens: 512,
      outputTokens: 256,
      latencyMs: 1200,
      callerArn: 'arn:aws:iam::123456789012:role/MyRole',
      resolvedUserId: 'user-abc',
      resolvedUserName: 'Alice',
      resolvedUserEmail: 'alice@example.com',
      // optional fields included
      agentId: 'agent-xyz',
      agentAlias: 'prod',
      inputCost: 0.0015,
      outputCost: 0.0075,
      totalCost: 0.009,
      costStatus: 'reconciled',
      rawRequest: '{"prompt":"Hello"}',
      rawResponse: '{"completion":"Hi there"}',
      sourceRegion: 'us-east-1',
      executionRegion: 'us-east-1',
    };

    const buf = await writeParquet([record], INVOCATION_LOG_SCHEMA);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('serializes a CloudTrail event record to a non-empty Buffer', async () => {
    const record = {
      eventId: 'evt-001',
      requestId: 'req-002',
      timestamp: '2024-01-15T14:31:00.000Z',
      accountId: '123456789012',
      region: 'us-east-1',
      eventName: 'InvokeModel',
      principalArn: 'arn:aws:iam::123456789012:assumed-role/MyRole/session',
      sourceIpAddress: '10.0.1.5',
      userAgent: 'aws-sdk-js/3.0',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      resolvedUserId: 'user-abc',
      resolvedUserName: 'Alice',
      resolvedUserEmail: 'alice@example.com',
    };

    const buf = await writeParquet([record], CLOUDTRAIL_EVENT_SCHEMA);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('serializes a metrics record to a non-empty Buffer', async () => {
    const record = {
      timestamp: '2024-01-15T14:35:00.000Z',
      region: 'us-east-1',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      invocationCount: 42,
      invocationLatencyAvg: 1100.5,
      invocationLatencyP99: 3200.0,
      throttledCount: 0,
      errorCount: 1,
    };

    const buf = await writeParquet([record], METRICS_SCHEMA);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('omits optional fields (null/undefined) without error', async () => {
    const record = {
      requestId: 'req-003',
      timestamp: '2024-01-15T15:00:00.000Z',
      accountId: '123456789012',
      region: 'us-east-1',
      modelId: 'amazon.titan-text-express-v1',
      resolvedModelId: 'amazon.titan-text-express-v1',
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 800,
      callerArn: 'arn:aws:iam::123456789012:user/Bob',
      resolvedUserId: '',
      resolvedUserName: '',
      resolvedUserEmail: '',
      // optional fields intentionally omitted (agentId, agentAlias, imageCount, etc.)
      inputCost: 0.0001,
      outputCost: 0.0002,
      totalCost: 0.0003,
      costStatus: 'pending',
      rawRequest: '{}',
      rawResponse: '{}',
      sourceRegion: 'us-east-1',
      executionRegion: 'us-east-1',
    };

    const buf = await writeParquet([record], INVOCATION_LOG_SCHEMA);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });
});

// ─── 2. S3 Partitioner ───────────────────────────────────────────────────────

describe('S3 partitioner', () => {
  it('midnight boundary: 2024-01-01T00:00:00.000Z → year=2024/month=01/day=01/hour=00/', () => {
    const path = generatePartitionPath('logs', new Date('2024-01-01T00:00:00.000Z'));
    expect(path).toBe('logs/year=2024/month=01/day=01/hour=00/');
  });

  it('month boundary: 2024-12-31T23:59:59.999Z → year=2024/month=12/day=31/hour=23/', () => {
    const path = generatePartitionPath('logs', new Date('2024-12-31T23:59:59.999Z'));
    expect(path).toBe('logs/year=2024/month=12/day=31/hour=23/');
  });

  it('year boundary: 2025-01-01T00:00:00.000Z → year=2025/month=01/day=01/hour=00/', () => {
    const path = generatePartitionPath('logs', new Date('2025-01-01T00:00:00.000Z'));
    expect(path).toBe('logs/year=2025/month=01/day=01/hour=00/');
  });

  it('single-region path format (no region prefix)', () => {
    const path = generatePartitionPath('invocation-logs', new Date('2024-06-15T09:00:00.000Z'));
    expect(path).toBe('invocation-logs/year=2024/month=06/day=15/hour=09/');
    expect(path).not.toContain('region=');
  });

  it('multi-region path format includes region prefix', () => {
    const path = generatePartitionPath(
      'invocation-logs',
      new Date('2024-06-15T09:00:00.000Z'),
      'us-east-1',
    );
    expect(path).toBe('invocation-logs/region=us-east-1/year=2024/month=06/day=15/hour=09/');
  });
});

// ─── 3. Idempotency Checker ───────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('Idempotency checker', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('isProcessed returns false when GetCommand returns no item', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const checker = new IdempotencyChecker('test-table');
    const result = await checker.isProcessed('req-001', '2024-01-15T14:00:00.000Z');
    expect(result).toBe(false);
  });

  it('isProcessed returns true after markProcessed writes the item', async () => {
    // First call: no item
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const checker = new IdempotencyChecker('test-table');
    await checker.markProcessed('req-002', '2024-01-15T14:01:00.000Z', 'invocation');

    // Second call: item now exists
    ddbMock.on(GetCommand).resolves({
      Item: {
        requestId: 'req-002',
        timestamp: '2024-01-15T14:01:00.000Z',
        processorName: 'invocation',
        status: 'completed',
      },
    });

    const result = await checker.isProcessed('req-002', '2024-01-15T14:01:00.000Z');
    expect(result).toBe(true);
  });

  it('second markProcessed call with ConditionalCheckFailedException does NOT throw', async () => {
    const conditionalError = Object.assign(new Error('ConditionalCheckFailedException'), {
      name: 'ConditionalCheckFailedException',
    });

    ddbMock.on(PutCommand).rejectsOnce(conditionalError);

    const checker = new IdempotencyChecker('test-table');
    // Should resolve without throwing
    await expect(
      checker.markProcessed('req-003', '2024-01-15T14:02:00.000Z', 'cloudtrail'),
    ).resolves.toBeUndefined();
  });
});

// ─── 4. Circuit Breaker ───────────────────────────────────────────────────────

describe('Circuit breaker', () => {
  it('exactly 5 failures opens the circuit', async () => {
    const cb = new CircuitBreaker(5, 60_000);
    const fail = () => Promise.reject(new Error('fail'));

    for (let i = 0; i < 4; i++) {
      await expect(cb.execute(fail)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('closed');
    }

    // 5th failure should open the circuit
    await expect(cb.execute(fail)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('open');
  });

  it('cooldown boundary: 59s → still open, 61s → half-open', async () => {
    jest.useFakeTimers();

    const cb = new CircuitBreaker(5, 60_000);
    const fail = () => Promise.reject(new Error('fail'));

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      await expect(cb.execute(fail)).rejects.toThrow();
    }
    expect(cb.getState()).toBe('open');

    // Advance 59 seconds — still open
    jest.advanceTimersByTime(59_000);
    expect(cb.getState()).toBe('open');

    // Advance 2 more seconds (total 61s) — should be half-open
    jest.advanceTimersByTime(2_000);
    expect(cb.getState()).toBe('half-open');

    jest.useRealTimers();
  });

  it('resets to closed after a successful call in half-open state', async () => {
    jest.useFakeTimers();

    const cb = new CircuitBreaker(5, 60_000);
    const fail = () => Promise.reject(new Error('fail'));
    const succeed = () => Promise.resolve('ok');

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      await expect(cb.execute(fail)).rejects.toThrow();
    }

    // Advance past cooldown to reach half-open
    jest.advanceTimersByTime(61_000);
    expect(cb.getState()).toBe('half-open');

    // Successful probe call → closed
    const result = await cb.execute(succeed);
    expect(result).toBe('ok');
    expect(cb.getState()).toBe('closed');

    jest.useRealTimers();
  });

  it('half-open → open when probe call fails', async () => {
    jest.useFakeTimers();

    const cb = new CircuitBreaker(5, 60_000);
    const fail = () => Promise.reject(new Error('fail'));

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      await expect(cb.execute(fail)).rejects.toThrow();
    }

    // Advance past cooldown to reach half-open
    jest.advanceTimersByTime(61_000);
    expect(cb.getState()).toBe('half-open');

    // Probe call fails → back to open
    await expect(cb.execute(fail)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('open');

    jest.useRealTimers();
  });

  it('throws "Circuit breaker is open" when circuit is open', async () => {
    const cb = new CircuitBreaker(1, 60_000);
    const fail = () => Promise.reject(new Error('fail'));

    // Open the circuit with 1 failure
    await expect(cb.execute(fail)).rejects.toThrow('fail');
    expect(cb.getState()).toBe('open');

    // Next call should throw circuit breaker error, not the underlying error
    await expect(cb.execute(fail)).rejects.toThrow('Circuit breaker is open');
  });
});

// ─── 5. Rate Limiter ─────────────────────────────────────────────────────────

describe('Rate limiter', () => {
  it('burst scenario: maxTokens=5, firing 10 requests → exactly 5 succeed immediately', () => {
    const limiter = new TokenBucketRateLimiter(5, 1);

    let successes = 0;
    for (let i = 0; i < 10; i++) {
      if (limiter.tryAcquire()) {
        successes++;
      }
    }

    expect(successes).toBe(5);
  });

  it('steady-state: maxTokens=1, refillRate=10, drain then wait 100ms → 1 more token available', () => {
    jest.useFakeTimers();

    const limiter = new TokenBucketRateLimiter(1, 10);

    // Drain the single token
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);

    // Advance 100ms — at 10 tokens/s, 100ms = 1 token refilled
    jest.advanceTimersByTime(100);

    expect(limiter.tryAcquire()).toBe(true);

    jest.useRealTimers();
  });
});
