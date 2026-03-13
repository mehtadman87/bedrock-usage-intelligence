// Feature: bedrock-usage-intelligence, Property 25: Admin API configuration validation and audit logging
/**
 * Property 25: Admin API configuration validation and audit logging
 *
 * For any configuration update submitted to the Admin_API:
 * - Invalid updates SHALL be rejected before persisting
 * - Valid updates SHALL produce an audit record containing caller identity,
 *   timestamp, previous value, and new value
 *
 * Validates: Requirements 12.4, 12.5
 */
import * as fc from 'fast-check';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  validateConfigUpdate,
  writeAuditRecord,
  handler,
  resetSingletons,
  APIGatewayProxyEvent,
} from 'lib/handlers/admin-api/index';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  resetSingletons();
  process.env['RUNTIME_CONFIG_TABLE'] = 'runtime-config-table';
  process.env['AWS_REGION'] = 'us-east-1';
});

afterEach(() => {
  delete process.env['RUNTIME_CONFIG_TABLE'];
  delete process.env['AWS_REGION'];
});

// ── Arbitraries ───────────────────────────────────────────────────────────────

/** Generate a valid pricing config body */
const validPricingArb = fc.record({
  inputTokenRate: fc.float({ min: 0, max: Math.fround(100), noNaN: true }),
  outputTokenRate: fc.float({ min: 0, max: Math.fround(100), noNaN: true }),
});

/** Generate an invalid pricing config body (missing required rate fields) */
const invalidPricingArb = fc.record({
  someUnrelatedField: fc.string(),
  anotherField: fc.integer(),
});

/** Generate a valid alerts config body */
const validAlertsArb = fc.record({
  dlqThreshold: fc.integer({ min: 0, max: 100 }),
  errorRateThreshold: fc.float({ min: 0, max: Math.fround(1), noNaN: true }),
});

/** Generate an invalid alerts config body (errorRateThreshold out of [0,1]) */
const invalidAlertsArb = fc.record({
  errorRateThreshold: fc.oneof(
    fc.float({ min: Math.fround(1.01), max: Math.fround(100), noNaN: true }),
    fc.float({ min: Math.fround(-100), max: Math.fround(-0.01), noNaN: true }),
  ),
});

/** Generate a valid identity config body */
const validIdentityArb = fc.oneof(
  fc.record({ identityMode: fc.constant('iam') }),
  fc.record({ identityMode: fc.constant('sso'), identityStoreId: fc.constant('d-abc1234567') }),
  fc.record({ identityMode: fc.constant('auto'), identityStoreId: fc.constant('d-xyz9876543') }),
);

/** Generate an invalid identity config body */
const invalidIdentityArb = fc.oneof(
  // Missing identityMode
  fc.record({ someField: fc.string() }),
  // Invalid identityMode value
  fc.record({ identityMode: fc.constantFrom('invalid', 'none', 'ldap', '') }),
  // SSO without identityStoreId
  fc.record({ identityMode: fc.constant('sso') }),
);

/** Generate a valid accounts config body */
const validAccountsArb = fc.oneof(
  fc.record({ accountMode: fc.constant('single') }),
  fc.record({
    accountMode: fc.constant('multi'),
    sourceAccountIds: fc.array(fc.constant('123456789012'), { minLength: 1, maxLength: 3 }),
  }),
);

/** Generate an invalid accounts config body */
const invalidAccountsArb = fc.oneof(
  // Missing accountMode
  fc.record({ someField: fc.string() }),
  // Invalid accountMode
  fc.record({ accountMode: fc.constantFrom('invalid', 'all', '') }),
  // Multi without sourceAccountIds
  fc.record({ accountMode: fc.constant('multi') }),
);

/** Generate a valid retention config body */
const validRetentionArb = fc.record({
  rawLogsRetentionDays: fc.integer({ min: 1, max: 3650 }),
  processedDataRetentionDays: fc.integer({ min: 1, max: 3650 }),
});

/** Generate an invalid retention config body */
const invalidRetentionArb = fc.oneof(
  // Missing all retention fields
  fc.record({ someField: fc.string() }),
  // Non-positive retention days
  fc.record({ rawLogsRetentionDays: fc.integer({ min: -100, max: 0 }) }),
);

/** Generate a valid pricing-auto-update config body */
const validPricingAutoUpdateArb = fc.record({
  enabled: fc.boolean(),
});

/** Generate an invalid pricing-auto-update config body */
const invalidPricingAutoUpdateArb = fc.oneof(
  // Missing enabled
  fc.record({ someField: fc.string() }),
  // enabled is not boolean
  fc.record({ enabled: fc.integer() }),
);

// ── Property 25a: Invalid updates are rejected before persisting ──────────────

describe('Property 25: Invalid updates are rejected before persisting', () => {
  it('invalid pricing config is rejected with validation errors', () => {
    fc.assert(
      fc.property(invalidPricingArb, (body) => {
        const result = validateConfigUpdate('pricing', body);
        return result.valid === false && Array.isArray(result.errors) && result.errors.length > 0;
      }),
      { numRuns: 25 },
    );
  });

  it('invalid alerts config is rejected with field-level errors', () => {
    fc.assert(
      fc.property(invalidAlertsArb, (body) => {
        const result = validateConfigUpdate('alerts', body);
        return result.valid === false && Array.isArray(result.errors) && result.errors.length > 0;
      }),
      { numRuns: 25 },
    );
  });

  it('invalid identity config is rejected with field-level errors', () => {
    fc.assert(
      fc.property(invalidIdentityArb, (body) => {
        const result = validateConfigUpdate('identity', body);
        return result.valid === false && Array.isArray(result.errors) && result.errors.length > 0;
      }),
      { numRuns: 25 },
    );
  });

  it('invalid accounts config is rejected with field-level errors', () => {
    fc.assert(
      fc.property(invalidAccountsArb, (body) => {
        const result = validateConfigUpdate('accounts', body);
        return result.valid === false && Array.isArray(result.errors) && result.errors.length > 0;
      }),
      { numRuns: 25 },
    );
  });

  it('invalid retention config is rejected with field-level errors', () => {
    fc.assert(
      fc.property(invalidRetentionArb, (body) => {
        const result = validateConfigUpdate('retention', body);
        return result.valid === false && Array.isArray(result.errors) && result.errors.length > 0;
      }),
      { numRuns: 25 },
    );
  });

  it('invalid pricing-auto-update config is rejected with field-level errors', () => {
    fc.assert(
      fc.property(invalidPricingAutoUpdateArb, (body) => {
        const result = validateConfigUpdate('pricing-auto-update', body);
        return result.valid === false && Array.isArray(result.errors) && result.errors.length > 0;
      }),
      { numRuns: 25 },
    );
  });

  it('invalid updates via handler return 400 without writing to DynamoDB', async () => {
    // **Validates: Requirements 12.4**
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('pricing', 'alerts', 'identity', 'accounts', 'retention', 'pricing-auto-update'),
        invalidPricingArb,
        async (category, body) => {
          ddbMock.reset();
          ddbMock.on(GetCommand).resolves({ Item: undefined });
          ddbMock.on(PutCommand).resolves({});
          ddbMock.on(UpdateCommand).resolves({});

          const event: APIGatewayProxyEvent = {
            httpMethod: 'PUT',
            path: `/config/${category}`,
            body: JSON.stringify(body),
            requestContext: { identity: { userArn: 'arn:aws:iam::123456789012:user/test' } },
          };

          const result = await handler(event);

          // For invalid bodies, should return 400
          const validation = validateConfigUpdate(category, body);
          if (!validation.valid) {
            if (result.statusCode !== 400) return false;
            // DynamoDB UpdateCommand must NOT have been called
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            return updateCalls.length === 0;
          }
          return true; // body happened to be valid for this category, skip
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ── Property 25b: Valid updates produce audit records ─────────────────────────

describe('Property 25: Valid updates produce audit records with caller, timestamp, previousValue, newValue', () => {
  it('writeAuditRecord produces audit record with required fields', async () => {
    // **Validates: Requirements 12.5**
    await fc.assert(
      fc.asyncProperty(
        validPricingArb,
        fc.string({ minLength: 1, maxLength: 100 }),
        async (body, caller) => {
          ddbMock.reset();
          ddbMock.on(PutCommand).resolves({});

          await writeAuditRecord({
            tableName: 'runtime-config-table',
            configCategory: 'pricing',
            configKey: 'pricing-config',
            caller,
            previousValue: { old: true },
            newValue: body,
          });

          // Verify PutCommand was called
          const putCalls = ddbMock.commandCalls(PutCommand);
          if (putCalls.length === 0) return false;

          const auditItem = putCalls[0].args[0].input.Item as Record<string, unknown>;

          // Audit record must contain: caller, timestamp, previousValue, newValue
          const hasCallerField = auditItem['caller'] === caller;
          const hasTimestamp = typeof auditItem['timestamp'] === 'string' && auditItem['timestamp'].length > 0;
          const hasPreviousValue = 'previousValue' in auditItem;
          const hasNewValue = 'newValue' in auditItem;
          const isAuditCategory = auditItem['configCategory'] === 'audit';

          return hasCallerField && hasTimestamp && hasPreviousValue && hasNewValue && isAuditCategory;
        },
      ),
      { numRuns: 25 },
    );
  });

  it('valid updates via handler produce audit records', async () => {
    // **Validates: Requirements 12.5**
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('pricing', 'alerts', 'accounts', 'retention', 'pricing-auto-update'),
        fc.constantFrom(
          'arn:aws:iam::123456789012:user/alice',
          'arn:aws:sts::123456789012:assumed-role/MyRole/session',
          'arn:aws:iam::999999999999:user/bob',
        ),
        async (category, callerArn) => {
          ddbMock.reset();

          // Return existing item so optimistic locking works
          ddbMock.on(GetCommand).resolves({
            Item: {
              configCategory: category,
              configKey: `${category}-config`,
              value: { existing: true },
              version: 0,
            },
          });
          ddbMock.on(UpdateCommand).resolves({});
          ddbMock.on(PutCommand).resolves({});

          // Build a valid body for the category
          const validBodies: Record<string, unknown> = {
            pricing: { inputTokenRate: 0.003, outputTokenRate: 0.015 },
            alerts: { dlqThreshold: 5, errorRateThreshold: 0.05 },
            accounts: { accountMode: 'single' },
            retention: { rawLogsRetentionDays: 90 },
            'pricing-auto-update': { enabled: true },
          };

          const body = validBodies[category];
          const event: APIGatewayProxyEvent = {
            httpMethod: 'PUT',
            path: `/config/${category}`,
            body: JSON.stringify(body),
            requestContext: { identity: { userArn: callerArn } },
          };

          const result = await handler(event);

          if (result.statusCode !== 200) return false;

          // Audit record (PutCommand) must have been called
          const putCalls = ddbMock.commandCalls(PutCommand);
          if (putCalls.length === 0) return false;

          // Find the audit record (configCategory = 'audit')
          const auditCall = putCalls.find(
            (call) => (call.args[0].input.Item as Record<string, unknown>)?.['configCategory'] === 'audit',
          );
          if (!auditCall) return false;

          const auditItem = auditCall.args[0].input.Item as Record<string, unknown>;
          return (
            auditItem['caller'] === callerArn &&
            typeof auditItem['timestamp'] === 'string' &&
            'previousValue' in auditItem &&
            'newValue' in auditItem
          );
        },
      ),
      { numRuns: 20 },
    );
  });

  it('valid configs pass validation for all categories', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.tuple(fc.constant('pricing'), validPricingArb),
          fc.tuple(fc.constant('alerts'), validAlertsArb),
          fc.tuple(fc.constant('identity'), validIdentityArb),
          fc.tuple(fc.constant('accounts'), validAccountsArb),
          fc.tuple(fc.constant('retention'), validRetentionArb),
          fc.tuple(fc.constant('pricing-auto-update'), validPricingAutoUpdateArb),
        ),
        ([category, body]) => {
          const result = validateConfigUpdate(category, body);
          return result.valid === true;
        },
      ),
      { numRuns: 25 },
    );
  });
});
