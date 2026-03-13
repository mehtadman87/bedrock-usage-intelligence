// Feature: bedrock-usage-intelligence, Property 27: Idempotent processing
// Feature: bedrock-usage-intelligence, Property 18: Circuit breaker state transitions
// Feature: bedrock-usage-intelligence, Property 32: Identity Store API rate limiting
// Feature: bedrock-usage-intelligence, Property 26: Failed record persistence
import * as fc from 'fast-check';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import 'aws-sdk-client-mock-jest';
import { IdempotencyChecker } from 'lib/shared/idempotency';
import { CircuitBreaker } from 'lib/shared/circuit-breaker';
import { TokenBucketRateLimiter } from 'lib/shared/rate-limiter';
import { FAILED_RECORDS_PREFIX } from 'lib/shared/constants';
import { handler as invocationProcessorHandler } from 'lib/handlers/invocation-processor/index';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

// ---------------------------------------------------------------------------
// Property 27: Idempotent processing
// Validates: Requirements 13.4
// ---------------------------------------------------------------------------

describe('Property 27: Idempotent processing', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  it('markProcessed N times does not throw and isProcessed returns true', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate random requestId/timestamp pairs
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        // N ≥ 1 calls to markProcessed
        fc.integer({ min: 1, max: 5 }),
        async (requestId, timestamp, n) => {
          ddbMock.reset();

          const conditionalCheckError = new Error('ConditionalCheckFailedException');
          conditionalCheckError.name = 'ConditionalCheckFailedException';

          // PutCommand: first call succeeds, subsequent calls throw ConditionalCheckFailedException
          // (simulates DynamoDB conditional write — only the first write wins)
          ddbMock
            .on(PutCommand)
            .resolvesOnce({})
            .rejects(conditionalCheckError);

          // GetCommand: always returns the item as present
          // (called after markProcessed, so the record exists in the table)
          ddbMock
            .on(GetCommand)
            .resolves({ Item: { requestId, timestamp } });

          const checker = new IdempotencyChecker('test-idempotency-table');

          // Call markProcessed N times — must not throw
          for (let i = 0; i < n; i++) {
            await checker.markProcessed(requestId, timestamp, 'test-processor');
          }

          // isProcessed must return true after markProcessed was called
          const processed = await checker.isProcessed(requestId, timestamp);
          return processed === true;
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 18: Circuit breaker state transitions
// Validates: Requirements 8.8, 13.5, 13.6
// ---------------------------------------------------------------------------

describe('Property 18: Circuit breaker state transitions', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Scenario 1: exactly 5 consecutive failures → open ───────────────────
  it('after exactly 5 consecutive failures, state transitions to open', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 5, max: 20 }),
        async (numFailures) => {
          const cb = new CircuitBreaker(5, 60_000);
          const failFn = (): Promise<never> => Promise.reject(new Error('fail'));

          for (let i = 0; i < numFailures; i++) {
            await cb.execute(failFn).catch(() => {/* expected */});
          }

          return cb.getState() === 'open';
        },
      ),
      { numRuns: 25 },
    );
  });

  // ── Scenario 2: fewer than 5 consecutive failures → still closed ─────────
  it('after fewer than 5 consecutive failures, state remains closed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        async (numFailures) => {
          const cb = new CircuitBreaker(5, 60_000);
          const failFn = (): Promise<never> => Promise.reject(new Error('fail'));

          for (let i = 0; i < numFailures; i++) {
            await cb.execute(failFn).catch(() => {/* expected */});
          }

          return cb.getState() === 'closed';
        },
      ),
      { numRuns: 25 },
    );
  });

  // ── Scenario 3: success resets failure counter ───────────────────────────
  it('a success resets the failure counter (4 failures + 1 success + 4 failures = still closed)', async () => {
    const cb = new CircuitBreaker(5, 60_000);
    const failFn = (): Promise<never> => Promise.reject(new Error('fail'));
    const successFn = (): Promise<string> => Promise.resolve('ok');

    // 4 failures
    for (let i = 0; i < 4; i++) {
      await cb.execute(failFn).catch(() => {/* expected */});
    }
    expect(cb.getState()).toBe('closed');

    // 1 success — resets counter
    await cb.execute(successFn);
    expect(cb.getState()).toBe('closed');

    // 4 more failures — still below threshold
    for (let i = 0; i < 4; i++) {
      await cb.execute(failFn).catch(() => {/* expected */});
    }
    expect(cb.getState()).toBe('closed');
  });

  // ── Scenario 4: when open, execute() throws without calling wrapped fn ───
  it('when open, execute() throws without calling the wrapped function', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 5, max: 20 }),
        async (numFailures) => {
          const cb = new CircuitBreaker(5, 60_000);
          const failFn = (): Promise<never> => Promise.reject(new Error('fail'));

          // Trip the circuit open
          for (let i = 0; i < numFailures; i++) {
            await cb.execute(failFn).catch(() => {/* expected */});
          }

          expect(cb.getState()).toBe('open');

          // The wrapped function must NOT be called when open
          let wasCalled = false;
          const probe = (): Promise<string> => {
            wasCalled = true;
            return Promise.resolve('should not reach here');
          };

          let threw = false;
          try {
            await cb.execute(probe);
          } catch {
            threw = true;
          }

          return threw && !wasCalled;
        },
      ),
      { numRuns: 25 },
    );
  });

  // ── Scenario 5: after cooldown elapses, state transitions to half-open ───
  it('after cooldown elapses, state transitions to half-open', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 5, max: 20 }),
        async (numFailures) => {
          const cb = new CircuitBreaker(5, 60_000);
          const failFn = (): Promise<never> => Promise.reject(new Error('fail'));

          // Trip the circuit open
          for (let i = 0; i < numFailures; i++) {
            await cb.execute(failFn).catch(() => {/* expected */});
          }

          expect(cb.getState()).toBe('open');

          // Advance time past the 60s cooldown
          jest.advanceTimersByTime(60_001);

          return cb.getState() === 'half-open';
        },
      ),
      { numRuns: 25 },
    );
  });

  // ── Scenario 6: HalfOpen + success → closed ─────────────────────────────
  it('HalfOpen + success transitions to closed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (_unused) => {
          const cb = new CircuitBreaker(5, 60_000);
          const failFn = (): Promise<never> => Promise.reject(new Error('fail'));
          const successFn = (): Promise<string> => Promise.resolve('ok');

          // Trip open
          for (let i = 0; i < 5; i++) {
            await cb.execute(failFn).catch(() => {/* expected */});
          }

          // Advance to half-open
          jest.advanceTimersByTime(60_001);
          expect(cb.getState()).toBe('half-open');

          // Probe succeeds → closed
          await cb.execute(successFn);
          return cb.getState() === 'closed';
        },
      ),
      { numRuns: 25 },
    );
  });

  // ── Scenario 7: HalfOpen + failure → open ───────────────────────────────
  it('HalfOpen + failure transitions back to open', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (_unused) => {
          const cb = new CircuitBreaker(5, 60_000);
          const failFn = (): Promise<never> => Promise.reject(new Error('fail'));

          // Trip open
          for (let i = 0; i < 5; i++) {
            await cb.execute(failFn).catch(() => {/* expected */});
          }

          // Advance to half-open
          jest.advanceTimersByTime(60_001);
          expect(cb.getState()).toBe('half-open');

          // Probe fails → back to open
          await cb.execute(failFn).catch(() => {/* expected */});
          return cb.getState() === 'open';
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 32: Identity Store API rate limiting
// Validates: Requirements 18.3
// ---------------------------------------------------------------------------

describe('Property 32: Identity Store API rate limiting', () => {
  it('burst requests are throttled to maxTokens within the initial bucket capacity', () => {
    fc.assert(
      fc.property(
        // Random maxTokens (1-10) and refillRate (1-10 tokens/second)
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (maxTokens, refillRate) => {
          // Burst size is always larger than maxTokens so we exceed capacity
          const burstSize = maxTokens + fc.sample(fc.integer({ min: 1, max: 5 }), 1)[0];

          const limiter = new TokenBucketRateLimiter(maxTokens, refillRate);

          // Call tryAcquire burstSize times in rapid succession (no time passes)
          let successCount = 0;
          for (let i = 0; i < burstSize; i++) {
            if (limiter.tryAcquire()) {
              successCount++;
            }
          }

          // The number of successful acquires must equal maxTokens (initial bucket capacity)
          return successCount === maxTokens;
        },
      ),
      { numRuns: 25 },
    );
  });

  it('tryAcquire returns false when bucket is empty and true after refill', () => {
    jest.useFakeTimers();
    try {
      // Create limiter with maxTokens=1, refillRate=10 tokens/second
      const limiter = new TokenBucketRateLimiter(1, 10);

      // Drain the bucket — first acquire should succeed
      expect(limiter.tryAcquire()).toBe(true);

      // Bucket is now empty — next acquire should fail
      expect(limiter.tryAcquire()).toBe(false);

      // Advance time by 100ms → at 10 tokens/second, 0.1s adds 1 token
      jest.advanceTimersByTime(100);

      // Bucket should have 1 token again
      expect(limiter.tryAcquire()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Property 26: Failed record persistence
// Validates: Requirements 13.2
// ---------------------------------------------------------------------------

describe('Property 26: Failed record persistence', () => {
  // Feature: bedrock-usage-intelligence, Property 26: Failed record persistence

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

  afterEach(() => {
    delete process.env['PROCESSED_DATA_BUCKET'];
    delete process.env['FAILED_RECORDS_BUCKET'];
    delete process.env['IDEMPOTENCY_TABLE'];
    delete process.env['REGION_MODE'];
    delete process.env['PROCESSOR_NAME'];
    delete process.env['AWS_REGION'];
  });

  it('failed records are written to Failed_Records_Prefix with error metadata', async () => {
    // **Validates: Requirements 13.2**
    await fc.assert(
      fc.asyncProperty(
        // Generate random processor names
        fc.constantFrom('invocation', 'cloudtrail'),
        async (processorName) => {
          s3Mock.reset();
          ddbMock.reset();

          process.env['PROCESSOR_NAME'] = processorName;

          // Mock S3 GetObject to return malformed JSON (triggers processing failure)
          s3Mock.on(GetObjectCommand).rejects(new Error('Simulated S3 read failure'));
          // Mock S3 PutObject to succeed (captures the failed record write)
          s3Mock.on(PutObjectCommand).resolves({});

          const { default: handler } = { default: invocationProcessorHandler };

          const event = {
            Records: [
              {
                s3: {
                  bucket: { name: 'raw-logs-bucket' },
                  object: { key: 'logs/test-record.json' },
                },
                awsRegion: 'us-east-1',
              },
            ],
          };

          // Handler should throw (re-throws after writing failed record)
          await handler(event as Parameters<typeof handler>[0]).catch(() => {/* expected */});
          const putCalls = s3Mock.commandCalls(PutObjectCommand);
          const failedRecordPut = putCalls.find(
            (call) => call.args[0].input.Bucket === 'failed-bucket',
          );

          if (!failedRecordPut) return false;

          // Key must start with the failed-records prefix
          const key = failedRecordPut.args[0].input.Key ?? '';
          const keyStartsWithPrefix = key.startsWith(FAILED_RECORDS_PREFIX);

          // Body must be valid JSON with error metadata
          let bodyValid = false;
          try {
            const bodyStr = failedRecordPut.args[0].input.Body;
            const body = JSON.parse(
              typeof bodyStr === 'string' ? bodyStr : Buffer.from(bodyStr as Uint8Array).toString(),
            ) as Record<string, unknown>;
            bodyValid =
              typeof body['error'] === 'string' &&
              typeof body['processorName'] === 'string' &&
              typeof body['failedAt'] === 'string';
          } catch {
            bodyValid = false;
          }

          return keyStartsWithPrefix && bodyValid;
        },
      ),
      { numRuns: 20 },
    );
  });

  it('failed record key follows the pattern: failed-records/{processorName}/{year}/{month}/{day}/{requestId}.json', async () => {
    // **Validates: Requirements 13.2**
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('invocation', 'cloudtrail'),
        async (processorName) => {
          s3Mock.reset();
          ddbMock.reset();

          process.env['PROCESSOR_NAME'] = processorName;

          s3Mock.on(GetObjectCommand).rejects(new Error('Simulated processing failure'));
          s3Mock.on(PutObjectCommand).resolves({});

          const handler = invocationProcessorHandler;

          const event = {
            Records: [
              {
                s3: {
                  bucket: { name: 'raw-logs-bucket' },
                  object: { key: 'logs/test-record.json' },
                },
                awsRegion: 'us-east-1',
              },
            ],
          };

          await handler(event as Parameters<typeof handler>[0]).catch(() => {/* expected */});

          const putCalls = s3Mock.commandCalls(PutObjectCommand);
          const failedKey = putCalls.find(
            (call) => call.args[0].input.Bucket === 'failed-bucket',
          )?.args[0].input.Key;

          if (!failedKey) return false;

          // Pattern: failed-records/{processorName}/{year}/{month}/{day}/{requestId}.json
          const keyPattern = new RegExp(
            `^${FAILED_RECORDS_PREFIX}/${processorName}/\\d{4}/\\d{2}/\\d{2}/[^/]+\\.json$`,
          );

          return keyPattern.test(failedKey);
        },
      ),
      { numRuns: 20 },
    );
  });
});
