/**
 * Unit tests for the CloudTrail Processor handler.
 *
 * Tests the exported filterBedrockEvents, extractCloudTrailRecord, and
 * isWithinCorrelationWindow functions, plus the handler itself with mocked AWS.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Readable } from 'stream';
import {
  filterBedrockEvents,
  extractCloudTrailRecord,
  isWithinCorrelationWindow,
  CloudTrailEvent,
  CloudTrailLogFile,
} from 'lib/handlers/cloudtrail-processor/index';
import { handler } from 'lib/handlers/cloudtrail-processor/index';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  s3Mock.reset();
  ddbMock.reset();
  process.env['PROCESSED_DATA_BUCKET'] = 'processed-bucket';
  process.env['FAILED_RECORDS_BUCKET'] = 'failed-bucket';
  process.env['IDEMPOTENCY_TABLE'] = 'idempotency-table';
  process.env['REGION_MODE'] = 'single';
  process.env['PROCESSOR_NAME'] = 'cloudtrail';
  process.env['CORRELATION_WINDOW_MS'] = '300000';
  process.env['AWS_REGION'] = 'us-east-1';
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReadableStream(content: string): Readable {
  const readable = new Readable();
  readable.push(content);
  readable.push(null);
  return readable;
}

function makeCloudTrailLogFile(events: CloudTrailEvent[]): string {
  const logFile: CloudTrailLogFile = { Records: events };
  return JSON.stringify(logFile);
}

// ─── Sample CloudTrail Events ─────────────────────────────────────────────────

const bedrockInvokeEvent: CloudTrailEvent = {
  eventId: 'evt-001',
  requestId: 'req-001',
  eventTime: '2024-01-15T14:30:00Z',
  awsAccountId: '123456789012',
  awsRegion: 'us-east-1',
  eventName: 'InvokeModel',
  userIdentity: {
    arn: 'arn:aws:iam::123456789012:role/MyRole',
    type: 'AssumedRole',
  },
  sourceIPAddress: '10.0.1.5',
  userAgent: 'aws-sdk-js/3.0',
  requestParameters: {
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
  },
};

const bedrockConverseEvent: CloudTrailEvent = {
  eventId: 'evt-002',
  requestId: 'req-002',
  eventTime: '2024-01-15T14:31:00Z',
  awsAccountId: '123456789012',
  awsRegion: 'us-east-1',
  eventName: 'Converse',
  userIdentity: {
    arn: 'arn:aws:iam::123456789012:user/alice',
  },
  sourceIPAddress: '10.0.1.6',
  userAgent: 'aws-cli/2.0',
  requestParameters: {
    modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
  },
};

const nonBedrockEvent: CloudTrailEvent = {
  eventId: 'evt-003',
  requestId: 'req-003',
  eventTime: '2024-01-15T14:32:00Z',
  awsAccountId: '123456789012',
  awsRegion: 'us-east-1',
  eventName: 'GetObject',
  userIdentity: {
    arn: 'arn:aws:iam::123456789012:role/MyRole',
  },
  sourceIPAddress: '10.0.1.7',
  userAgent: 'aws-sdk-js/3.0',
  requestParameters: {},
};

// ─── filterBedrockEvents Tests ────────────────────────────────────────────────

describe('filterBedrockEvents', () => {
  it('returns only Bedrock events from a mixed list', () => {
    const events = [bedrockInvokeEvent, nonBedrockEvent, bedrockConverseEvent];
    const filtered = filterBedrockEvents(events);

    expect(filtered).toHaveLength(2);
    expect(filtered.map((e) => e.eventName)).toEqual(['InvokeModel', 'Converse']);
  });

  it('returns empty array when no Bedrock events present', () => {
    const events = [nonBedrockEvent];
    const filtered = filterBedrockEvents(events);
    expect(filtered).toHaveLength(0);
  });

  it('returns all events when all are Bedrock events', () => {
    const events = [bedrockInvokeEvent, bedrockConverseEvent];
    const filtered = filterBedrockEvents(events);
    expect(filtered).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(filterBedrockEvents([])).toHaveLength(0);
  });

  it('accepts all four Bedrock event names', () => {
    const allBedrockEvents: CloudTrailEvent[] = [
      { ...bedrockInvokeEvent, eventName: 'InvokeModel', eventId: 'e1' },
      { ...bedrockInvokeEvent, eventName: 'InvokeModelWithResponseStream', eventId: 'e2' },
      { ...bedrockInvokeEvent, eventName: 'Converse', eventId: 'e3' },
      { ...bedrockInvokeEvent, eventName: 'ConverseStream', eventId: 'e4' },
    ];
    const filtered = filterBedrockEvents(allBedrockEvents);
    expect(filtered).toHaveLength(4);
  });

  it('excludes events with undefined eventName', () => {
    const eventWithNoName: CloudTrailEvent = { eventId: 'no-name' };
    const filtered = filterBedrockEvents([eventWithNoName]);
    expect(filtered).toHaveLength(0);
  });
});

// ─── extractCloudTrailRecord Tests ───────────────────────────────────────────

describe('extractCloudTrailRecord', () => {
  it('extracts all fields from a complete CloudTrail event', () => {
    const record = extractCloudTrailRecord(bedrockInvokeEvent);

    expect(record.eventId).toBe('evt-001');
    expect(record.requestId).toBe('req-001');
    expect(record.timestamp).toBe('2024-01-15T14:30:00Z');
    expect(record.accountId).toBe('123456789012');
    expect(record.region).toBe('us-east-1');
    expect(record.eventName).toBe('InvokeModel');
    expect(record.principalArn).toBe('arn:aws:iam::123456789012:role/MyRole');
    expect(record.sourceIpAddress).toBe('10.0.1.5');
    expect(record.userAgent).toBe('aws-sdk-js/3.0');
    expect(record.modelId).toBe('anthropic.claude-3-sonnet-20240229-v1:0');
  });

  it('defaults missing fields to empty strings', () => {
    const minimalEvent: CloudTrailEvent = {};
    const record = extractCloudTrailRecord(minimalEvent);

    expect(record.eventId).toBe('');
    expect(record.requestId).toBe('');
    expect(record.timestamp).toBe('');
    expect(record.accountId).toBe('');
    expect(record.region).toBe('');
    expect(record.eventName).toBe('');
    expect(record.principalArn).toBe('');
    expect(record.sourceIpAddress).toBe('');
    expect(record.userAgent).toBe('');
    expect(record.modelId).toBe('');
  });

  it('falls back to sessionContext issuer ARN when direct ARN is missing', () => {
    const eventWithSessionContext: CloudTrailEvent = {
      ...bedrockInvokeEvent,
      userIdentity: {
        type: 'AssumedRole',
        sessionContext: {
          sessionIssuer: {
            arn: 'arn:aws:iam::123456789012:role/SessionRole',
          },
        },
      },
    };
    const record = extractCloudTrailRecord(eventWithSessionContext);
    expect(record.principalArn).toBe('arn:aws:iam::123456789012:role/SessionRole');
  });

  it('initializes resolved identity fields to empty strings', () => {
    const record = extractCloudTrailRecord(bedrockInvokeEvent);
    expect(record.resolvedUserId).toBe('');
    expect(record.resolvedUserName).toBe('');
    expect(record.resolvedUserEmail).toBe('');
  });

  it('extracts modelId from requestParameters', () => {
    const record = extractCloudTrailRecord(bedrockConverseEvent);
    expect(record.modelId).toBe('anthropic.claude-3-haiku-20240307-v1:0');
  });
});

// ─── isWithinCorrelationWindow Tests ─────────────────────────────────────────

describe('isWithinCorrelationWindow', () => {
  const baseTime = '2024-01-15T14:30:00.000Z';
  const windowMs = 300_000; // 5 minutes

  it('returns true when timestamps are identical', () => {
    expect(isWithinCorrelationWindow(baseTime, baseTime, windowMs)).toBe(true);
  });

  it('returns true when timestamps are within the window', () => {
    const within = new Date(new Date(baseTime).getTime() + 60_000).toISOString(); // +1 min
    expect(isWithinCorrelationWindow(baseTime, within, windowMs)).toBe(true);
  });

  it('returns true at exactly the window boundary', () => {
    const atBoundary = new Date(new Date(baseTime).getTime() + windowMs).toISOString();
    expect(isWithinCorrelationWindow(baseTime, atBoundary, windowMs)).toBe(true);
  });

  it('returns false when timestamps are outside the window', () => {
    const outside = new Date(new Date(baseTime).getTime() + windowMs + 1).toISOString();
    expect(isWithinCorrelationWindow(baseTime, outside, windowMs)).toBe(false);
  });

  it('is symmetric: order of timestamps does not matter', () => {
    const other = new Date(new Date(baseTime).getTime() + 60_000).toISOString();
    expect(isWithinCorrelationWindow(baseTime, other, windowMs)).toBe(
      isWithinCorrelationWindow(other, baseTime, windowMs),
    );
  });

  it('returns false for invalid timestamps', () => {
    expect(isWithinCorrelationWindow('not-a-date', baseTime, windowMs)).toBe(false);
    expect(isWithinCorrelationWindow(baseTime, 'not-a-date', windowMs)).toBe(false);
  });

  it('returns false with window=0 for different timestamps', () => {
    const other = new Date(new Date(baseTime).getTime() + 1).toISOString();
    expect(isWithinCorrelationWindow(baseTime, other, 0)).toBe(false);
  });

  it('returns true with window=0 for identical timestamps', () => {
    expect(isWithinCorrelationWindow(baseTime, baseTime, 0)).toBe(true);
  });
});

// ─── Handler Integration Tests (with mocked AWS) ─────────────────────────────

describe('handler - S3 event processing', () => {
  const validLogFile = makeCloudTrailLogFile([bedrockInvokeEvent, nonBedrockEvent]);

  it('processes a valid CloudTrail log file and writes Parquet output', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(validLogFile) as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined }); // not yet processed
    ddbMock.on(PutCommand).resolves({});

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'cloudtrail-bucket' },
          object: { key: 'AWSLogs/123456789012/CloudTrail/us-east-1/2024/01/15/log.json' },
        },
        awsRegion: 'us-east-1',
      }],
    };

    await expect(handler(event as any)).resolves.toBeUndefined();
    // Should write Parquet to processed bucket (only Bedrock events)
    expect(s3Mock).toHaveReceivedCommandWith(PutObjectCommand, {
      Bucket: 'processed-bucket',
    });
  });

  it('skips files with no Bedrock events', async () => {
    const noBedrockLog = makeCloudTrailLogFile([nonBedrockEvent]);
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(noBedrockLog) as any,
    });

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'cloudtrail-bucket' },
          object: { key: 'log.json' },
        },
        awsRegion: 'us-east-1',
      }],
    };

    await expect(handler(event as any)).resolves.toBeUndefined();
    // Should NOT write to processed bucket
    expect(s3Mock).not.toHaveReceivedCommand(PutObjectCommand);
  });

  it('skips duplicate events (idempotency)', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(makeCloudTrailLogFile([bedrockInvokeEvent])) as any,
    });
    // DynamoDB returns existing item — already processed
    ddbMock.on(GetCommand).resolves({
      Item: { requestId: 'req-001', timestamp: '2024-01-15T14:30:00Z' },
    });

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'cloudtrail-bucket' },
          object: { key: 'log.json' },
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
          bucket: { name: 'cloudtrail-bucket' },
          object: { key: 'bad-log.json' },
        },
        awsRegion: 'us-east-1',
      }],
    };

    await expect(handler(event as any)).rejects.toThrow();
    // Should write to failed records bucket
    expect(s3Mock).toHaveReceivedCommandWith(PutObjectCommand, {
      Bucket: 'failed-bucket',
    });
  });

  it('writes failed record when Records array is missing', async () => {
    const invalidLog = JSON.stringify({ NotRecords: [] });
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(invalidLog) as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'cloudtrail-bucket' },
          object: { key: 'invalid-log.json' },
        },
        awsRegion: 'us-east-1',
      }],
    };

    await expect(handler(event as any)).rejects.toThrow('Invalid CloudTrail log file');
    expect(s3Mock).toHaveReceivedCommandWith(PutObjectCommand, {
      Bucket: 'failed-bucket',
    });
  });

  it('uses Hive-style partitioning for output key in single-region mode', async () => {
    process.env['REGION_MODE'] = 'single';
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(makeCloudTrailLogFile([bedrockInvokeEvent])) as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'cloudtrail-bucket' },
          object: { key: 'log.json' },
        },
        awsRegion: 'us-east-1',
      }],
    };

    await handler(event as any);

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    const processedPut = putCalls.find((c) => c.args[0].input.Bucket === 'processed-bucket');
    expect(processedPut).toBeDefined();
    // Key should follow Hive-style pattern without region prefix
    expect(processedPut!.args[0].input.Key).toMatch(
      /^cloudtrail-events\/year=\d{4}\/month=\d{2}\/day=\d{2}\/hour=\d{2}\//,
    );
  });

  it('uses region-prefixed Hive-style partitioning in multi-region mode', async () => {
    process.env['REGION_MODE'] = 'multi';
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeReadableStream(makeCloudTrailLogFile([bedrockInvokeEvent])) as any,
    });
    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      Records: [{
        s3: {
          bucket: { name: 'cloudtrail-bucket' },
          object: { key: 'log.json' },
        },
        awsRegion: 'us-east-1',
      }],
    };

    await handler(event as any);

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    const processedPut = putCalls.find((c) => c.args[0].input.Bucket === 'processed-bucket');
    expect(processedPut).toBeDefined();
    // Key should include region prefix
    expect(processedPut!.args[0].input.Key).toMatch(
      /^cloudtrail-events\/region=[^/]+\/year=\d{4}\/month=\d{2}\/day=\d{2}\/hour=\d{2}\//,
    );
  });

  it('processes multiple S3 records in a single event', async () => {
    const log1 = makeCloudTrailLogFile([bedrockInvokeEvent]);
    const log2 = makeCloudTrailLogFile([bedrockConverseEvent]);

    // Return different responses for each GetObject call
    s3Mock
      .on(GetObjectCommand, { Key: 'log1.json' })
      .resolves({ Body: makeReadableStream(log1) as any })
      .on(GetObjectCommand, { Key: 'log2.json' })
      .resolves({ Body: makeReadableStream(log2) as any });
    s3Mock.on(PutObjectCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});

    const event = {
      Records: [
        {
          s3: { bucket: { name: 'cloudtrail-bucket' }, object: { key: 'log1.json' } },
          awsRegion: 'us-east-1',
        },
        {
          s3: { bucket: { name: 'cloudtrail-bucket' }, object: { key: 'log2.json' } },
          awsRegion: 'us-east-1',
        },
      ],
    };

    await expect(handler(event as any)).resolves.toBeUndefined();
    // Should write Parquet for each file
    const processedPuts = s3Mock
      .commandCalls(PutObjectCommand)
      .filter((c) => c.args[0].input.Bucket === 'processed-bucket');
    expect(processedPuts).toHaveLength(2);
  });
});
