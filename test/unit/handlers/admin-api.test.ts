/**
 * Unit tests for Admin API handlers.
 *
 * Requirements: 12.2, 12.3, 12.4, 12.5
 */
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  handler,
  validateConfigUpdate,
  writeAuditRecord,
  resetSingletons,
  APIGatewayProxyEvent,
} from '../../../lib/handlers/admin-api/index';

const ddbMock = mockClient(DynamoDBDocumentClient);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
  method: string,
  path: string,
  body?: unknown,
  callerArn = 'arn:aws:iam::123456789012:user/admin',
): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    path,
    body: body !== undefined ? JSON.stringify(body) : null,
    requestContext: { identity: { userArn: callerArn } },
  };
}

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

// ── validateConfigUpdate ──────────────────────────────────────────────────────

describe('validateConfigUpdate', () => {
  describe('pricing', () => {
    it('accepts valid pricing config with inputTokenRate', () => {
      const result = validateConfigUpdate('pricing', { inputTokenRate: 0.003 });
      expect(result.valid).toBe(true);
    });

    it('accepts valid pricing config with outputTokenRate', () => {
      const result = validateConfigUpdate('pricing', { outputTokenRate: 0.015 });
      expect(result.valid).toBe(true);
    });

    it('accepts valid pricing config with imageRate', () => {
      const result = validateConfigUpdate('pricing', { imageRate: { '512x512': 0.018 } });
      expect(result.valid).toBe(true);
    });

    it('rejects pricing config with no rate fields', () => {
      const result = validateConfigUpdate('pricing', { someOtherField: 'value' });
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('rejects pricing config with negative inputTokenRate', () => {
      const result = validateConfigUpdate('pricing', { inputTokenRate: -0.001 });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'inputTokenRate')).toBe(true);
    });

    it('rejects non-object body', () => {
      const result = validateConfigUpdate('pricing', 'not-an-object');
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'body')).toBe(true);
    });

    it('rejects null body', () => {
      const result = validateConfigUpdate('pricing', null);
      expect(result.valid).toBe(false);
    });

    it('rejects array body', () => {
      const result = validateConfigUpdate('pricing', [{ inputTokenRate: 0.003 }]);
      expect(result.valid).toBe(false);
    });
  });

  describe('alerts', () => {
    it('accepts valid alerts config with dlqThreshold', () => {
      const result = validateConfigUpdate('alerts', { dlqThreshold: 5 });
      expect(result.valid).toBe(true);
    });

    it('accepts valid alerts config with errorRateThreshold in [0,1]', () => {
      const result = validateConfigUpdate('alerts', { errorRateThreshold: 0.05 });
      expect(result.valid).toBe(true);
    });

    it('rejects alerts config with no threshold fields', () => {
      const result = validateConfigUpdate('alerts', { unrelated: 'field' });
      expect(result.valid).toBe(false);
    });

    it('rejects errorRateThreshold > 1', () => {
      const result = validateConfigUpdate('alerts', { errorRateThreshold: 1.5 });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'errorRateThreshold')).toBe(true);
    });

    it('rejects errorRateThreshold < 0', () => {
      const result = validateConfigUpdate('alerts', { errorRateThreshold: -0.1 });
      expect(result.valid).toBe(false);
    });
  });

  describe('identity', () => {
    it('accepts iam mode', () => {
      const result = validateConfigUpdate('identity', { identityMode: 'iam' });
      expect(result.valid).toBe(true);
    });

    it('accepts sso mode with valid identityStoreId', () => {
      const result = validateConfigUpdate('identity', { identityMode: 'sso', identityStoreId: 'd-abc1234567' });
      expect(result.valid).toBe(true);
    });

    it('accepts auto mode with valid identityStoreId', () => {
      const result = validateConfigUpdate('identity', { identityMode: 'auto', identityStoreId: 'd-xyz9876543' });
      expect(result.valid).toBe(true);
    });

    it('rejects missing identityMode', () => {
      const result = validateConfigUpdate('identity', { identityStoreId: 'd-abc1234567' });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'identityMode')).toBe(true);
    });

    it('rejects invalid identityMode value', () => {
      const result = validateConfigUpdate('identity', { identityMode: 'ldap' });
      expect(result.valid).toBe(false);
    });

    it('rejects sso mode without identityStoreId', () => {
      const result = validateConfigUpdate('identity', { identityMode: 'sso' });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'identityStoreId')).toBe(true);
    });

    it('rejects invalid identityStoreId format', () => {
      const result = validateConfigUpdate('identity', { identityMode: 'sso', identityStoreId: 'invalid-id' });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'identityStoreId')).toBe(true);
    });
  });

  describe('accounts', () => {
    it('accepts single account mode', () => {
      const result = validateConfigUpdate('accounts', { accountMode: 'single' });
      expect(result.valid).toBe(true);
    });

    it('accepts multi account mode with valid sourceAccountIds', () => {
      const result = validateConfigUpdate('accounts', {
        accountMode: 'multi',
        sourceAccountIds: ['123456789012', '999999999999'],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects missing accountMode', () => {
      const result = validateConfigUpdate('accounts', { sourceAccountIds: ['123456789012'] });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'accountMode')).toBe(true);
    });

    it('rejects invalid accountMode', () => {
      const result = validateConfigUpdate('accounts', { accountMode: 'all' });
      expect(result.valid).toBe(false);
    });

    it('rejects multi mode without sourceAccountIds', () => {
      const result = validateConfigUpdate('accounts', { accountMode: 'multi' });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'sourceAccountIds')).toBe(true);
    });

    it('rejects non-12-digit account IDs', () => {
      const result = validateConfigUpdate('accounts', {
        accountMode: 'multi',
        sourceAccountIds: ['12345', 'not-an-id'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'sourceAccountIds')).toBe(true);
    });
  });

  describe('retention', () => {
    it('accepts valid retention config', () => {
      const result = validateConfigUpdate('retention', { rawLogsRetentionDays: 90 });
      expect(result.valid).toBe(true);
    });

    it('rejects missing retention fields', () => {
      const result = validateConfigUpdate('retention', { unrelated: 'field' });
      expect(result.valid).toBe(false);
    });

    it('rejects non-positive retention days', () => {
      const result = validateConfigUpdate('retention', { rawLogsRetentionDays: 0 });
      expect(result.valid).toBe(false);
    });

    it('rejects negative retention days', () => {
      const result = validateConfigUpdate('retention', { rawLogsRetentionDays: -30 });
      expect(result.valid).toBe(false);
    });
  });

  describe('pricing-auto-update', () => {
    it('accepts enabled: true', () => {
      const result = validateConfigUpdate('pricing-auto-update', { enabled: true });
      expect(result.valid).toBe(true);
    });

    it('accepts enabled: false', () => {
      const result = validateConfigUpdate('pricing-auto-update', { enabled: false });
      expect(result.valid).toBe(true);
    });

    it('rejects missing enabled field', () => {
      const result = validateConfigUpdate('pricing-auto-update', { scheduleExpression: 'rate(1 day)' });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'enabled')).toBe(true);
    });

    it('rejects non-boolean enabled', () => {
      const result = validateConfigUpdate('pricing-auto-update', { enabled: 'yes' });
      expect(result.valid).toBe(false);
    });
  });

  describe('unknown category', () => {
    it('rejects unknown config category', () => {
      const result = validateConfigUpdate('unknown-category', { someField: 'value' });
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.field === 'configCategory')).toBe(true);
    });
  });
});

// ── GET endpoints ─────────────────────────────────────────────────────────────

describe('GET /config/{category}', () => {
  const categories = ['pricing', 'alerts', 'identity', 'accounts', 'retention', 'pricing-auto-update'];

  categories.forEach((category) => {
    it(`GET /config/${category} returns 200 with existing config`, async () => {
      const existingItem = {
        configCategory: category,
        configKey: `${category}-config`,
        value: { someField: 'someValue' },
        version: 1,
      };
      ddbMock.on(GetCommand).resolves({ Item: existingItem });

      const event = makeEvent('GET', `/config/${category}`);
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.configCategory).toBe(category);
    });

    it(`GET /config/${category} returns 404 when no config exists`, async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = makeEvent('GET', `/config/${category}`);
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
    });
  });
});

// ── PUT endpoints ─────────────────────────────────────────────────────────────

describe('PUT /config/{category} - valid inputs', () => {
  const validBodies: Record<string, unknown> = {
    pricing: { inputTokenRate: 0.003, outputTokenRate: 0.015 },
    alerts: { dlqThreshold: 5, errorRateThreshold: 0.05 },
    identity: { identityMode: 'iam' },
    accounts: { accountMode: 'single' },
    retention: { rawLogsRetentionDays: 90 },
    'pricing-auto-update': { enabled: true },
  };

  Object.entries(validBodies).forEach(([category, body]) => {
    it(`PUT /config/${category} with valid body returns 200`, async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { configCategory: category, configKey: `${category}-config`, value: {}, version: 0 },
      });
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const event = makeEvent('PUT', `/config/${category}`, body);
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const responseBody = JSON.parse(result.body);
      expect(responseBody.configCategory).toBe(category);
      expect(responseBody.version).toBe(1);
    });
  });
});

// ── Request validation: invalid schema rejected with 400 ─────────────────────

describe('PUT /config/{category} - request validation', () => {
  it('returns 400 with field-level errors for invalid pricing config', async () => {
    const event = makeEvent('PUT', '/config/pricing', { unrelated: 'field' });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.errors).toBeDefined();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]).toHaveProperty('field');
    expect(body.errors[0]).toHaveProperty('message');
  });

  it('returns 400 for invalid identity config (missing identityMode)', async () => {
    const event = makeEvent('PUT', '/config/identity', { identityStoreId: 'd-abc123' });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.errors.some((e: { field: string }) => e.field === 'identityMode')).toBe(true);
  });

  it('returns 400 for invalid accounts config (multi without sourceAccountIds)', async () => {
    const event = makeEvent('PUT', '/config/accounts', { accountMode: 'multi' });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.errors.some((e: { field: string }) => e.field === 'sourceAccountIds')).toBe(true);
  });

  it('returns 400 for malformed JSON body', async () => {
    const event: APIGatewayProxyEvent = {
      httpMethod: 'PUT',
      path: '/config/pricing',
      body: 'not-valid-json{',
      requestContext: { identity: { userArn: 'arn:aws:iam::123456789012:user/admin' } },
    };
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.message).toContain('Invalid JSON');
  });

  it('does NOT call DynamoDB when validation fails', async () => {
    const event = makeEvent('PUT', '/config/pricing', { unrelated: 'field' });
    await handler(event);

    expect(ddbMock).not.toHaveReceivedCommand(UpdateCommand);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });
});

// ── Optimistic locking: concurrent modification returns 409 ──────────────────

describe('PUT /config/{category} - optimistic locking', () => {
  it('returns 409 when provided version does not match current version', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { configCategory: 'pricing', configKey: 'pricing-config', value: {}, version: 5 },
    });

    // Caller provides version 3, but current is 5
    const event = makeEvent('PUT', '/config/pricing', { inputTokenRate: 0.003, version: 3 });
    const result = await handler(event);

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body);
    expect(body.currentVersion).toBe(5);
    expect(body.providedVersion).toBe(3);
  });

  it('returns 409 when DynamoDB conditional check fails (concurrent modification)', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { configCategory: 'pricing', configKey: 'pricing-config', value: {}, version: 1 },
    });

    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(conditionalError);

    const event = makeEvent('PUT', '/config/pricing', { inputTokenRate: 0.003 });
    const result = await handler(event);

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body);
    expect(body.message).toContain('Conflict');
  });

  it('succeeds when provided version matches current version', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { configCategory: 'pricing', configKey: 'pricing-config', value: {}, version: 2 },
    });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const event = makeEvent('PUT', '/config/pricing', { inputTokenRate: 0.003, version: 2 });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
  });
});

// ── Audit logging ─────────────────────────────────────────────────────────────

describe('PUT /config/{category} - audit logging', () => {
  it('writes audit record with caller, timestamp, previousValue, newValue on mutation', async () => {
    const previousValue = { inputTokenRate: 0.001 };
    ddbMock.on(GetCommand).resolves({
      Item: { configCategory: 'pricing', configKey: 'pricing-config', value: previousValue, version: 0 },
    });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const callerArn = 'arn:aws:iam::123456789012:user/admin';
    const newBody = { inputTokenRate: 0.003, outputTokenRate: 0.015 };
    const event = makeEvent('PUT', '/config/pricing', newBody, callerArn);
    const result = await handler(event);

    expect(result.statusCode).toBe(200);

    // Verify audit record was written
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThan(0);

    const auditCall = putCalls.find(
      (call) => (call.args[0].input.Item as Record<string, unknown>)?.['configCategory'] === 'audit',
    );
    expect(auditCall).toBeDefined();

    const auditItem = auditCall!.args[0].input.Item as Record<string, unknown>;
    expect(auditItem['caller']).toBe(callerArn);
    expect(typeof auditItem['timestamp']).toBe('string');
    expect(auditItem['previousValue']).toBeDefined();
    expect(auditItem['newValue']).toBeDefined();
    expect(auditItem['auditedCategory']).toBe('pricing');
  });

  it('audit record is written to the same Runtime_Config table', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { configCategory: 'alerts', configKey: 'alerts-config', value: {}, version: 0 },
    });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const event = makeEvent('PUT', '/config/alerts', { dlqThreshold: 10 });
    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const auditCall = putCalls.find(
      (call) => (call.args[0].input.Item as Record<string, unknown>)?.['configCategory'] === 'audit',
    );
    expect(auditCall!.args[0].input.TableName).toBe('runtime-config-table');
  });

  it('writeAuditRecord writes correct fields', async () => {
    ddbMock.on(PutCommand).resolves({});

    await writeAuditRecord({
      tableName: 'runtime-config-table',
      configCategory: 'pricing',
      configKey: 'pricing-config',
      caller: 'arn:aws:iam::123456789012:user/admin',
      previousValue: { old: 'value' },
      newValue: { new: 'value' },
    });

    expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 1);
    const putCall = ddbMock.commandCalls(PutCommand)[0];
    const item = putCall.args[0].input.Item as Record<string, unknown>;

    expect(item['configCategory']).toBe('audit');
    expect(item['caller']).toBe('arn:aws:iam::123456789012:user/admin');
    expect(typeof item['timestamp']).toBe('string');
    expect(item['previousValue']).toEqual({ old: 'value' });
    expect(item['newValue']).toEqual({ new: 'value' });
    expect(item['auditedCategory']).toBe('pricing');
  });
});

// ── DynamoDB error handling: returns 503 with retry-after ────────────────────

describe('DynamoDB error handling', () => {
  it('returns 503 with Retry-After header when DynamoDB throws on GET', async () => {
    ddbMock.on(GetCommand).rejects(new Error('ProvisionedThroughputExceededException'));

    const event = makeEvent('GET', '/config/pricing');
    const result = await handler(event);

    expect(result.statusCode).toBe(503);
    expect(result.headers?.['Retry-After']).toBeDefined();
    const body = JSON.parse(result.body);
    expect(body.message).toContain('unavailable');
  });

  it('returns 503 with Retry-After header when DynamoDB throws on PUT', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { configCategory: 'pricing', configKey: 'pricing-config', value: {}, version: 0 },
    });
    ddbMock.on(UpdateCommand).rejects(new Error('ServiceUnavailable'));

    const event = makeEvent('PUT', '/config/pricing', { inputTokenRate: 0.003 });
    const result = await handler(event);

    expect(result.statusCode).toBe(503);
    expect(result.headers?.['Retry-After']).toBeDefined();
  });
});

// ── Route handling ────────────────────────────────────────────────────────────

describe('Route handling', () => {
  it('returns 404 for unknown path', async () => {
    const event = makeEvent('GET', '/unknown/path');
    const result = await handler(event);

    expect(result.statusCode).toBe(404);
  });

  it('returns 404 for unknown config category', async () => {
    const event = makeEvent('GET', '/config/unknown-category');
    const result = await handler(event);

    expect(result.statusCode).toBe(404);
  });

  it('returns 405 for unsupported HTTP method', async () => {
    const event = makeEvent('DELETE', '/config/pricing');
    const result = await handler(event);

    expect(result.statusCode).toBe(405);
    expect(result.headers?.['Allow']).toContain('GET');
    expect(result.headers?.['Allow']).toContain('PUT');
  });

  it('returns 500 when RUNTIME_CONFIG_TABLE env var is missing', async () => {
    delete process.env['RUNTIME_CONFIG_TABLE'];

    const event = makeEvent('GET', '/config/pricing');
    const result = await handler(event);

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.message).toContain('RUNTIME_CONFIG_TABLE');
  });
});

// ── New item creation (no existing item) ─────────────────────────────────────

describe('PUT /config/{category} - new item creation', () => {
  it('creates new config when no existing item', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const event = makeEvent('PUT', '/config/pricing', { inputTokenRate: 0.003 });
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.version).toBe(1);
  });

  it('uses attribute_not_exists condition for new items', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const event = makeEvent('PUT', '/config/pricing', { inputTokenRate: 0.003 });
    await handler(event);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(1);
    const conditionExpr = updateCalls[0].args[0].input.ConditionExpression;
    expect(conditionExpr).toContain('attribute_not_exists');
  });
});
