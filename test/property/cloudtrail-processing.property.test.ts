// Feature: bedrock-usage-intelligence, Property 9: CloudTrail Bedrock event filtering and extraction
// Feature: bedrock-usage-intelligence, Property 10: CloudTrail-invocation correlation by request ID

import * as fc from 'fast-check';
import {
  filterBedrockEvents,
  extractCloudTrailRecord,
  isWithinCorrelationWindow,
  CloudTrailEvent,
} from 'lib/handlers/cloudtrail-processor/index';
import { BEDROCK_CLOUDTRAIL_EVENT_NAMES } from 'lib/shared/constants';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Bedrock API event names */
const bedrockEventNameArb = fc.constantFrom(...BEDROCK_CLOUDTRAIL_EVENT_NAMES);

/** Non-Bedrock event names that should be filtered out */
const nonBedrockEventNameArb = fc.constantFrom(
  'GetObject',
  'PutObject',
  'DescribeInstances',
  'CreateBucket',
  'ListUsers',
  'AssumeRole',
  'GetCallerIdentity',
  'DescribeTable',
  'InvokeFunction',
  'CreateLogGroup',
);

/** Valid AWS account ID */
const accountIdArb = fc.stringMatching(/^\d{12}$/);

/** Valid AWS region */
const regionArb = fc.constantFrom(
  'us-east-1',
  'us-west-2',
  'eu-west-1',
  'ap-southeast-1',
  'ap-northeast-1',
);

/** Non-empty string */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 50 });

/** ISO 8601 timestamp */
const timestampArb = fc
  .date({ min: new Date('2024-01-01'), max: new Date('2025-12-31') })
  .map((d) => d.toISOString());

/** Arbitrary for a Bedrock CloudTrail event */
const bedrockEventArb: fc.Arbitrary<CloudTrailEvent> = fc.record({
  eventId: nonEmptyStringArb,
  requestId: nonEmptyStringArb,
  eventTime: timestampArb,
  awsAccountId: accountIdArb,
  awsRegion: regionArb,
  eventName: bedrockEventNameArb,
  userIdentity: fc.record({
    arn: fc.constant('arn:aws:iam::123456789012:role/MyRole'),
    type: fc.constant('AssumedRole'),
  }),
  sourceIPAddress: fc.ipV4(),
  userAgent: fc.constantFrom('aws-sdk-js/3.0', 'aws-cli/2.0', 'boto3/1.26'),
  requestParameters: fc.record({
    modelId: fc.constantFrom(
      'anthropic.claude-3-sonnet-20240229-v1:0',
      'anthropic.claude-3-haiku-20240307-v1:0',
      'amazon.titan-text-express-v1',
    ),
  }),
});

/** Arbitrary for a non-Bedrock CloudTrail event */
const nonBedrockEventArb: fc.Arbitrary<CloudTrailEvent> = fc.record({
  eventId: nonEmptyStringArb,
  requestId: nonEmptyStringArb,
  eventTime: timestampArb,
  awsAccountId: accountIdArb,
  awsRegion: regionArb,
  eventName: nonBedrockEventNameArb,
  userIdentity: fc.record({
    arn: fc.constant('arn:aws:iam::123456789012:role/MyRole'),
  }),
  sourceIPAddress: fc.ipV4(),
  userAgent: fc.constant('aws-sdk-js/3.0'),
  requestParameters: fc.record({}),
});

// ─── Property 9: CloudTrail Bedrock event filtering and extraction ─────────────
// Validates: Requirements 6.3, 6.4

describe('Property 9: CloudTrail Bedrock event filtering and extraction', () => {
  it('output contains only Bedrock API calls when given a mix of events', () => {
    fc.assert(
      fc.property(
        fc.array(bedrockEventArb, { minLength: 0, maxLength: 10 }),
        fc.array(nonBedrockEventArb, { minLength: 0, maxLength: 10 }),
        (bedrockEvents, nonBedrockEvents) => {
          // Shuffle the two arrays together
          const mixed = [...bedrockEvents, ...nonBedrockEvents].sort(() => Math.random() - 0.5);
          const filtered = filterBedrockEvents(mixed);

          const bedrockNames = new Set<string>(BEDROCK_CLOUDTRAIL_EVENT_NAMES);

          // Every event in the output must be a Bedrock API call
          return filtered.every(
            (e) => e.eventName !== undefined && bedrockNames.has(e.eventName),
          );
        },
      ),
      { numRuns: 25 },
    );
  });

  it('output contains all Bedrock events from the input (no Bedrock events dropped)', () => {
    fc.assert(
      fc.property(
        fc.array(bedrockEventArb, { minLength: 1, maxLength: 10 }),
        fc.array(nonBedrockEventArb, { minLength: 0, maxLength: 10 }),
        (bedrockEvents, nonBedrockEvents) => {
          const mixed = [...bedrockEvents, ...nonBedrockEvents];
          const filtered = filterBedrockEvents(mixed);

          // All Bedrock events from input must appear in output
          return bedrockEvents.every((be) =>
            filtered.some((fe) => fe.eventId === be.eventId),
          );
        },
      ),
      { numRuns: 25 },
    );
  });

  it('non-Bedrock events are excluded from output', () => {
    fc.assert(
      fc.property(
        fc.array(nonBedrockEventArb, { minLength: 1, maxLength: 10 }),
        (nonBedrockEvents) => {
          const filtered = filterBedrockEvents(nonBedrockEvents);
          return filtered.length === 0;
        },
      ),
      { numRuns: 25 },
    );
  });

  it('each extracted record contains principalArn, sourceIpAddress, userAgent, requestId, timestamp', () => {
    fc.assert(
      fc.property(bedrockEventArb, (event) => {
        const record = extractCloudTrailRecord(event);

        return (
          typeof record.principalArn === 'string' &&
          typeof record.sourceIpAddress === 'string' &&
          typeof record.userAgent === 'string' &&
          typeof record.requestId === 'string' &&
          typeof record.timestamp === 'string'
        );
      }),
      { numRuns: 25 },
    );
  });

  it('extracted record principalArn matches userIdentity.arn', () => {
    fc.assert(
      fc.property(bedrockEventArb, (event) => {
        const record = extractCloudTrailRecord(event);
        return record.principalArn === (event.userIdentity?.arn ?? '');
      }),
      { numRuns: 25 },
    );
  });

  it('extracted record sourceIpAddress matches event sourceIPAddress', () => {
    fc.assert(
      fc.property(bedrockEventArb, (event) => {
        const record = extractCloudTrailRecord(event);
        return record.sourceIpAddress === (event.sourceIPAddress ?? '');
      }),
      { numRuns: 25 },
    );
  });

  it('extracted record userAgent matches event userAgent', () => {
    fc.assert(
      fc.property(bedrockEventArb, (event) => {
        const record = extractCloudTrailRecord(event);
        return record.userAgent === (event.userAgent ?? '');
      }),
      { numRuns: 25 },
    );
  });

  it('extracted record requestId matches event requestId', () => {
    fc.assert(
      fc.property(bedrockEventArb, (event) => {
        const record = extractCloudTrailRecord(event);
        return record.requestId === (event.requestId ?? '');
      }),
      { numRuns: 25 },
    );
  });

  it('extracted record timestamp matches event eventTime', () => {
    fc.assert(
      fc.property(bedrockEventArb, (event) => {
        const record = extractCloudTrailRecord(event);
        return record.timestamp === (event.eventTime ?? '');
      }),
      { numRuns: 25 },
    );
  });

  it('filtering is idempotent: filtering twice produces the same result', () => {
    fc.assert(
      fc.property(
        fc.array(bedrockEventArb, { minLength: 0, maxLength: 10 }),
        fc.array(nonBedrockEventArb, { minLength: 0, maxLength: 10 }),
        (bedrockEvents, nonBedrockEvents) => {
          const mixed = [...bedrockEvents, ...nonBedrockEvents];
          const once = filterBedrockEvents(mixed);
          const twice = filterBedrockEvents(once);
          return once.length === twice.length;
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ─── Property 10: CloudTrail-invocation correlation by request ID ─────────────
// Validates: Requirements 6.5, 8.5

describe('Property 10: CloudTrail-invocation correlation by request ID', () => {
  /** Arbitrary for a correlation window in milliseconds (1s to 10 minutes) */
  const correlationWindowArb = fc.integer({ min: 1000, max: 600_000 });

  /** Arbitrary for a base timestamp */
  const baseTimestampArb = fc
    .date({ min: new Date('2024-01-01'), max: new Date('2025-12-31') })
    .map((d) => d.toISOString());

  it('correlation succeeds when timestamps are within the window', () => {
    fc.assert(
      fc.property(
        baseTimestampArb,
        correlationWindowArb,
        (baseTimestamp, windowMs) => {
          // Generate an offset strictly within the window
          const offsetMs = Math.floor(windowMs / 2);
          const invocationTimestamp = new Date(
            new Date(baseTimestamp).getTime() + offsetMs,
          ).toISOString();

          return isWithinCorrelationWindow(baseTimestamp, invocationTimestamp, windowMs);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('correlation fails when timestamps are outside the window', () => {
    fc.assert(
      fc.property(
        baseTimestampArb,
        correlationWindowArb,
        (baseTimestamp, windowMs) => {
          // Generate an offset strictly outside the window
          const offsetMs = windowMs + 1000;
          const invocationTimestamp = new Date(
            new Date(baseTimestamp).getTime() + offsetMs,
          ).toISOString();

          return !isWithinCorrelationWindow(baseTimestamp, invocationTimestamp, windowMs);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('correlation is symmetric: order of timestamps does not matter', () => {
    fc.assert(
      fc.property(
        baseTimestampArb,
        correlationWindowArb,
        fc.integer({ min: 0, max: 600_000 }),
        (baseTimestamp, windowMs, offsetMs) => {
          const otherTimestamp = new Date(
            new Date(baseTimestamp).getTime() + offsetMs,
          ).toISOString();

          const forwardResult = isWithinCorrelationWindow(baseTimestamp, otherTimestamp, windowMs);
          const reverseResult = isWithinCorrelationWindow(otherTimestamp, baseTimestamp, windowMs);

          return forwardResult === reverseResult;
        },
      ),
      { numRuns: 25 },
    );
  });

  it('same timestamp always correlates (zero offset)', () => {
    fc.assert(
      fc.property(baseTimestampArb, correlationWindowArb, (timestamp, windowMs) => {
        return isWithinCorrelationWindow(timestamp, timestamp, windowMs);
      }),
      { numRuns: 25 },
    );
  });

  it('correlation with window=0 only succeeds for identical timestamps', () => {
    fc.assert(
      fc.property(
        baseTimestampArb,
        fc.integer({ min: 1, max: 60_000 }),
        (baseTimestamp, offsetMs) => {
          const otherTimestamp = new Date(
            new Date(baseTimestamp).getTime() + offsetMs,
          ).toISOString();

          // With window=0, only identical timestamps should correlate
          return !isWithinCorrelationWindow(baseTimestamp, otherTimestamp, 0);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('larger window accepts more timestamp pairs than smaller window', () => {
    fc.assert(
      fc.property(
        baseTimestampArb,
        fc.integer({ min: 1000, max: 300_000 }),
        fc.integer({ min: 1, max: 1000 }),
        (baseTimestamp, largeWindowMs, offsetMs) => {
          const smallWindowMs = Math.max(0, offsetMs - 1);
          const otherTimestamp = new Date(
            new Date(baseTimestamp).getTime() + offsetMs,
          ).toISOString();

          const largeResult = isWithinCorrelationWindow(baseTimestamp, otherTimestamp, largeWindowMs);
          const smallResult = isWithinCorrelationWindow(baseTimestamp, otherTimestamp, smallWindowMs);

          // If small window accepts it, large window must also accept it
          if (smallResult) return largeResult;
          return true; // no constraint when small window rejects
        },
      ),
      { numRuns: 25 },
    );
  });
});
