/**
 * Preservation Property Tests — CUR Migration
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
 *
 * Property 4: Preservation — Invocation Log Processing Unchanged
 *
 * These tests are written BEFORE implementing the fix. They MUST PASS on
 * unfixed code to establish the baseline behavior that must be preserved.
 *
 * For all valid Bedrock invocation log inputs, the invocation processor
 * produces identical output for all non-cost fields: requestId, timestamp,
 * modelId, accountId, inputTokens, outputTokens, cacheReadInputTokens,
 * cacheWriteInputTokens, imageCount, videoDurationSeconds, callerArn,
 * resolvedUserId, resolvedUserName, crossRegionType, inferenceTier, cacheType.
 */

import * as fc from 'fast-check';
import {
  parseInvocationLog,
  resolveInferenceProfile,
  extractUserNameFromArn,
  extractTierFromRequestBody,
  extractCacheTtlFromRequestBody,
  BedrockInvocationLog,
  InvocationRecord,
} from '../../lib/handlers/invocation-processor/index';
import { INVOCATION_LOG_SCHEMA } from '../../lib/shared/parquet-writer';

// ── Arbitraries ───────────────────────────────────────────────────────────────

const awsRegionArb = fc.constantFrom(
  'us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1',
  'ap-southeast-1', 'ap-northeast-1', 'ap-south-1',
);

const standardModelIdArb = fc.constantFrom(
  'anthropic.claude-3-sonnet-20240229-v1:0',
  'anthropic.claude-3-haiku-20240307-v1:0',
  'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'amazon.titan-text-express-v1',
  'meta.llama3-8b-instruct-v1:0',
  'amazon.nova-reel-v1:0',
  'stability.stable-diffusion-xl-v1',
);

const crossRegionModelIdArb = fc.record({
  region: awsRegionArb,
  account: fc.stringMatching(/^\d{12}$/),
  prefix: fc.constantFrom('us', 'eu', 'ap'),
  baseModel: standardModelIdArb,
}).map(({ region, account, prefix, baseModel }) =>
  `arn:aws:bedrock:${region}:${account}:inference-profile/${prefix}.${baseModel}`
);

const modelIdArb = fc.oneof(
  { weight: 3, arbitrary: standardModelIdArb },
  { weight: 1, arbitrary: crossRegionModelIdArb },
);

const accountIdArb = fc.stringMatching(/^\d{12}$/);

const timestampArb = fc.date({ min: new Date('2024-01-01'), max: new Date('2025-12-31') })
  .map((d) => d.toISOString());

const callerArnArb = fc.oneof(
  accountIdArb.map((acct) => `arn:aws:iam::${acct}:user/testuser`),
  accountIdArb.map((acct) => `arn:aws:sts::${acct}:assumed-role/MyRole/session-123`),
  accountIdArb.map((acct) => `arn:aws:iam::${acct}:root`),
  fc.constant(''),
);

const serviceTierArb = fc.constantFrom('default', 'priority', 'flex', undefined);

const inputBodyArb = serviceTierArb.map((tier) => {
  if (tier === undefined) return '{}';
  return JSON.stringify({ service_tier: tier });
});

/** Generator for standard text invocation logs with all fields populated */
const textInvocationLogArb: fc.Arbitrary<BedrockInvocationLog> = fc.record({
  requestId: fc.uuid(),
  timestamp: timestampArb,
  accountId: accountIdArb,
  region: awsRegionArb,
  modelId: modelIdArb,
  input: fc.record({
    inputTokenCount: fc.integer({ min: 0, max: 100_000 }),
    inputBodyJson: inputBodyArb,
    cacheWriteInputTokenCount: fc.oneof(fc.constant(undefined), fc.integer({ min: 0, max: 50_000 })),
    cacheReadInputTokenCount: fc.oneof(fc.constant(undefined), fc.integer({ min: 0, max: 50_000 })),
  }),
  output: fc.record({
    outputTokenCount: fc.integer({ min: 0, max: 100_000 }),
    outputBodyJson: fc.string({ minLength: 2, maxLength: 100 }),
    latencyMs: fc.integer({ min: 0, max: 60_000 }),
  }),
  identity: fc.record({
    arn: callerArnArb,
  }),
});

/** Generator for image model invocation logs */
const imageInvocationLogArb: fc.Arbitrary<BedrockInvocationLog> = fc.record({
  requestId: fc.uuid(),
  timestamp: timestampArb,
  accountId: accountIdArb,
  region: awsRegionArb,
  modelId: fc.constant('stability.stable-diffusion-xl-v1'),
  input: fc.record({
    inputBodyJson: fc.constant('{}'),
  }),
  output: fc.record({
    outputBodyJson: fc.string({ minLength: 2, maxLength: 100 }),
    latencyMs: fc.integer({ min: 0, max: 60_000 }),
    imageCount: fc.integer({ min: 1, max: 4 }),
    imageDimensions: fc.constantFrom('512x512', '1024x1024', '768x768'),
  }),
  identity: fc.record({
    arn: callerArnArb,
  }),
});

/** Generator for video model invocation logs */
const videoInvocationLogArb: fc.Arbitrary<BedrockInvocationLog> = fc.record({
  requestId: fc.uuid(),
  timestamp: timestampArb,
  accountId: accountIdArb,
  region: awsRegionArb,
  modelId: fc.constant('amazon.nova-reel-v1:0'),
  input: fc.record({
    inputBodyJson: fc.constant('{}'),
  }),
  output: fc.record({
    outputBodyJson: fc.string({ minLength: 2, maxLength: 100 }),
    latencyMs: fc.integer({ min: 0, max: 60_000 }),
    videoDurationSeconds: fc.float({ min: Math.fround(1), max: 300, noNaN: true, noDefaultInfinity: true }),
    videoResolution: fc.constantFrom('720p', '1080p'),
  }),
  identity: fc.record({
    arn: callerArnArb,
  }),
});

/** Combined arbitrary covering all invocation log types */
const anyInvocationLogArb = fc.oneof(
  { weight: 5, arbitrary: textInvocationLogArb },
  { weight: 2, arbitrary: imageInvocationLogArb },
  { weight: 2, arbitrary: videoInvocationLogArb },
);

// ── Property 4: Preservation — Invocation Log Processing Unchanged ────────────

describe('Property 4: Preservation — Invocation Log Processing Unchanged', () => {
  // **Validates: Requirements 3.1, 3.2, 3.4, 3.5**

  describe('parseInvocationLog preserves all non-cost fields', () => {
    it('requestId, timestamp, modelId, accountId are extracted correctly for all inputs', () => {
      fc.assert(
        fc.property(anyInvocationLogArb, (log) => {
          const record = parseInvocationLog(log);

          expect(record.requestId).toBe(log.requestId);
          expect(record.timestamp).toBe(log.timestamp);
          expect(record.modelId).toBe(log.modelId);
          expect(record.accountId).toBe(log.accountId ?? '');
        }),
        { numRuns: 25 },
      );
    });

    it('inputTokens, outputTokens are extracted correctly for all inputs', () => {
      fc.assert(
        fc.property(textInvocationLogArb, (log) => {
          const record = parseInvocationLog(log);

          expect(record.inputTokens).toBe(log.input?.inputTokenCount ?? 0);
          expect(record.outputTokens).toBe(log.output?.outputTokenCount ?? 0);
        }),
        { numRuns: 25 },
      );
    });

    it('cacheReadInputTokens, cacheWriteInputTokens are extracted correctly for all inputs', () => {
      fc.assert(
        fc.property(textInvocationLogArb, (log) => {
          const record = parseInvocationLog(log);

          expect(record.cacheReadInputTokens).toBe(log.input?.cacheReadInputTokenCount ?? 0);
          expect(record.cacheWriteInputTokens).toBe(log.input?.cacheWriteInputTokenCount ?? 0);
        }),
        { numRuns: 25 },
      );
    });

    it('imageCount is extracted correctly for image model invocations', () => {
      fc.assert(
        fc.property(imageInvocationLogArb, (log) => {
          const record = parseInvocationLog(log);

          expect(record.imageCount).toBe(log.output?.imageCount);
        }),
        { numRuns: 15 },
      );
    });

    it('videoDurationSeconds is extracted correctly for video model invocations', () => {
      fc.assert(
        fc.property(videoInvocationLogArb, (log) => {
          const record = parseInvocationLog(log);

          expect(record.videoDurationSeconds).toBe(log.output?.videoDurationSeconds);
        }),
        { numRuns: 15 },
      );
    });
  });

  describe('identity resolution via callerArn → resolvedUserId, resolvedUserName', () => {
    it('callerArn is preserved as resolvedUserId for all inputs', () => {
      fc.assert(
        fc.property(anyInvocationLogArb, (log) => {
          const record = parseInvocationLog(log);

          // resolvedUserId is set to callerArn in the current implementation
          expect(record.callerArn).toBe(log.identity?.arn ?? '');
          expect(record.resolvedUserId).toBe(record.callerArn);
        }),
        { numRuns: 25 },
      );
    });

    it('resolvedUserName is correctly extracted from callerArn for all ARN formats', () => {
      fc.assert(
        fc.property(callerArnArb, (arn) => {
          const userName = extractUserNameFromArn(arn);

          if (arn === '') {
            expect(userName).toBe('unknown');
          } else if (arn.includes(':user/')) {
            expect(userName).toBe(arn.split(':user/')[1]);
          } else if (arn.includes(':assumed-role/')) {
            expect(userName).toBe(arn.split(':assumed-role/')[1]);
          } else if (arn.endsWith(':root')) {
            expect(userName).toBe('root');
          }
        }),
        { numRuns: 25 },
      );
    });

    it('parseInvocationLog resolvedUserName matches extractUserNameFromArn', () => {
      fc.assert(
        fc.property(anyInvocationLogArb, (log) => {
          const record = parseInvocationLog(log);
          const expectedUserName = extractUserNameFromArn(log.identity?.arn ?? '');

          expect(record.resolvedUserName).toBe(expectedUserName);
        }),
        { numRuns: 25 },
      );
    });
  });

  describe('crossRegionType, inferenceTier, cacheType are derived correctly', () => {
    it('crossRegionType is correctly determined from model ID for all inputs', () => {
      fc.assert(
        fc.property(anyInvocationLogArb, (log) => {
          const record = parseInvocationLog(log);
          const executionRegion = log.region ?? 'unknown';
          const { crossRegionType } = resolveInferenceProfile(log.modelId, executionRegion);

          expect(record.crossRegionType).toBe(crossRegionType);
        }),
        { numRuns: 25 },
      );
    });

    it('inferenceTier is correctly extracted from request body for all inputs', () => {
      fc.assert(
        fc.property(textInvocationLogArb, (log) => {
          const record = parseInvocationLog(log);
          const expectedTier = extractTierFromRequestBody(log.input?.inputBodyJson);

          expect(record.inferenceTier).toBe(expectedTier);
        }),
        { numRuns: 25 },
      );
    });

    it('cacheType is correctly determined from cache token counts for all inputs', () => {
      fc.assert(
        fc.property(textInvocationLogArb, (log) => {
          const record = parseInvocationLog(log);
          const cacheWrite = log.input?.cacheWriteInputTokenCount ?? 0;
          const cacheRead = log.input?.cacheReadInputTokenCount ?? 0;

          if (cacheWrite > 0) {
            // cacheType should be cacheWrite5m or cacheWrite1h
            expect(['cacheWrite5m', 'cacheWrite1h']).toContain(record.cacheType);
          } else if (cacheRead > 0) {
            expect(record.cacheType).toBe('cacheRead');
          } else {
            expect(record.cacheType).toBe('none');
          }
        }),
        { numRuns: 25 },
      );
    });
  });

  describe('Parquet schema contains all expected non-cost columns', () => {
    it('INVOCATION_LOG_SCHEMA includes all non-cost fields that must be preserved', () => {
      // These are the non-cost fields that must remain in the Parquet schema
      // after the CUR migration fix is applied
      const requiredNonCostFields = [
        'requestId',
        'timestamp',
        'accountId',
        'region',
        'modelId',
        'resolvedModelId',
        'inputTokens',
        'outputTokens',
        'latencyMs',
        'callerArn',
        'resolvedUserId',
        'resolvedUserName',
        'resolvedUserEmail',
        'rawRequest',
        'rawResponse',
        'sourceRegion',
        'executionRegion',
        'inferenceTier',
        'cacheType',
        'cacheWriteInputTokens',
        'cacheReadInputTokens',
      ];

      const schemaFields = Object.keys(INVOCATION_LOG_SCHEMA.schema);

      for (const field of requiredNonCostFields) {
        expect(schemaFields).toContain(field);
      }
    });

    it('INVOCATION_LOG_SCHEMA includes optional media fields', () => {
      const optionalMediaFields = [
        'agentId',
        'agentAlias',
        'imageCount',
        'imageDimensions',
        'videoDurationSeconds',
        'videoResolution',
        'guardrailId',
      ];

      const schemaFields = Object.keys(INVOCATION_LOG_SCHEMA.schema);

      for (const field of optionalMediaFields) {
        expect(schemaFields).toContain(field);
      }
    });
  });

  describe('full record round-trip: all non-cost fields are deterministic', () => {
    it('parsing the same log twice produces identical non-cost fields', () => {
      fc.assert(
        fc.property(anyInvocationLogArb, (log) => {
          const record1 = parseInvocationLog(log);
          const record2 = parseInvocationLog(log);

          // All non-cost fields must be identical across invocations
          expect(record1.requestId).toBe(record2.requestId);
          expect(record1.timestamp).toBe(record2.timestamp);
          expect(record1.modelId).toBe(record2.modelId);
          expect(record1.accountId).toBe(record2.accountId);
          expect(record1.inputTokens).toBe(record2.inputTokens);
          expect(record1.outputTokens).toBe(record2.outputTokens);
          expect(record1.cacheReadInputTokens).toBe(record2.cacheReadInputTokens);
          expect(record1.cacheWriteInputTokens).toBe(record2.cacheWriteInputTokens);
          expect(record1.imageCount).toBe(record2.imageCount);
          expect(record1.videoDurationSeconds).toBe(record2.videoDurationSeconds);
          expect(record1.callerArn).toBe(record2.callerArn);
          expect(record1.resolvedUserId).toBe(record2.resolvedUserId);
          expect(record1.resolvedUserName).toBe(record2.resolvedUserName);
          expect(record1.crossRegionType).toBe(record2.crossRegionType);
          expect(record1.inferenceTier).toBe(record2.inferenceTier);
          expect(record1.cacheType).toBe(record2.cacheType);
          expect(record1.resolvedModelId).toBe(record2.resolvedModelId);
          expect(record1.sourceRegion).toBe(record2.sourceRegion);
          expect(record1.executionRegion).toBe(record2.executionRegion);
        }),
        { numRuns: 25 },
      );
    });
  });
});
