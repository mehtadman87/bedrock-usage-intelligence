/**
 * Admin API Lambda handler for CRUD operations on Runtime_Config DynamoDB table.
 *
 * Endpoints:
 *   GET/PUT /config/pricing
 *   GET/PUT /config/alerts
 *   GET/PUT /config/identity
 *   GET/PUT /config/accounts
 *   GET/PUT /config/retention
 *   GET/PUT /config/pricing-auto-update
 *
 * Requirements: 12.2, 12.3, 12.4, 12.5
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

// ── Inline API Gateway types (avoids @types/aws-lambda dependency) ────────────

interface APIGatewayRequestIdentity {
  userArn?: string | null;
  caller?: string | null;
}

interface APIGatewayEventRequestContext {
  identity?: APIGatewayRequestIdentity;
}

export interface APIGatewayProxyEvent {
  httpMethod: string;
  path: string;
  resource?: string;
  body: string | null;
  requestContext: APIGatewayEventRequestContext;
}

export interface APIGatewayProxyResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ field: string; message: string }>;
}

export interface AuditParams {
  tableName: string;
  configCategory: string;
  configKey: string;
  caller: string;
  previousValue: unknown;
  newValue: unknown;
}

// ── DynamoDB client (module-level singleton for Lambda reuse) ─────────────────

let _ddbClient: DynamoDBDocumentClient | undefined;

function getDdbClient(): DynamoDBDocumentClient {
  if (!_ddbClient) {
    _ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return _ddbClient;
}

/** Reset singleton (for testing). */
export function resetSingletons(): void {
  _ddbClient = undefined;
}

// ── Config category → configKey mapping ──────────────────────────────────────

const CATEGORY_KEY_MAP: Record<string, string> = {
  pricing: 'pricing-config',
  alerts: 'alerts-config',
  identity: 'identity-config',
  accounts: 'accounts-config',
  retention: 'retention-config',
  'pricing-auto-update': 'pricing-auto-update-config',
};

// ── Validation schemas ────────────────────────────────────────────────────────

/**
 * Validate a configuration update body for the given category.
 * Returns a ValidationResult with field-level errors when invalid.
 */
export function validateConfigUpdate(
  configCategory: string,
  body: unknown,
): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      valid: false,
      errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
    };
  }

  const obj = body as Record<string, unknown>;

  switch (configCategory) {
    case 'pricing': {
      // Required: at least one of inputTokenRate or outputTokenRate or imageRate or videoRate
      const hasRate =
        'inputTokenRate' in obj ||
        'outputTokenRate' in obj ||
        'imageRate' in obj ||
        'videoRate' in obj ||
        'rates' in obj;
      if (!hasRate) {
        errors.push({
          field: 'rates',
          message: 'At least one of inputTokenRate, outputTokenRate, imageRate, videoRate, or rates must be provided',
        });
      }
      if ('inputTokenRate' in obj && (typeof obj['inputTokenRate'] !== 'number' || (obj['inputTokenRate'] as number) < 0)) {
        errors.push({ field: 'inputTokenRate', message: 'inputTokenRate must be a non-negative number' });
      }
      if ('outputTokenRate' in obj && (typeof obj['outputTokenRate'] !== 'number' || (obj['outputTokenRate'] as number) < 0)) {
        errors.push({ field: 'outputTokenRate', message: 'outputTokenRate must be a non-negative number' });
      }
      break;
    }

    case 'alerts': {
      // Required: at least one threshold field
      const hasThreshold =
        'dlqThreshold' in obj ||
        'errorRateThreshold' in obj ||
        'cacheMissRateThreshold' in obj ||
        'thresholds' in obj;
      if (!hasThreshold) {
        errors.push({
          field: 'thresholds',
          message: 'At least one threshold field (dlqThreshold, errorRateThreshold, cacheMissRateThreshold) must be provided',
        });
      }
      if ('errorRateThreshold' in obj) {
        const v = obj['errorRateThreshold'] as number;
        if (typeof v !== 'number' || v < 0 || v > 1) {
          errors.push({ field: 'errorRateThreshold', message: 'errorRateThreshold must be a number between 0 and 1' });
        }
      }
      if ('cacheMissRateThreshold' in obj) {
        const v = obj['cacheMissRateThreshold'] as number;
        if (typeof v !== 'number' || v < 0 || v > 1) {
          errors.push({ field: 'cacheMissRateThreshold', message: 'cacheMissRateThreshold must be a number between 0 and 1' });
        }
      }
      break;
    }

    case 'identity': {
      // Required: identityMode
      if (!('identityMode' in obj)) {
        errors.push({ field: 'identityMode', message: 'identityMode is required' });
      } else if (!['sso', 'iam', 'auto'].includes(obj['identityMode'] as string)) {
        errors.push({ field: 'identityMode', message: 'identityMode must be one of: sso, iam, auto' });
      }
      if (
        (obj['identityMode'] === 'sso' || obj['identityMode'] === 'auto') &&
        !('identityStoreId' in obj)
      ) {
        errors.push({ field: 'identityStoreId', message: 'identityStoreId is required when identityMode is sso or auto' });
      }
      if ('identityStoreId' in obj && typeof obj['identityStoreId'] === 'string') {
        if (!/^d-[a-z0-9]+$/.test(obj['identityStoreId'] as string)) {
          errors.push({ field: 'identityStoreId', message: 'identityStoreId must match pattern d-[a-z0-9]+' });
        }
      }
      break;
    }

    case 'accounts': {
      // Required: accountMode
      if (!('accountMode' in obj)) {
        errors.push({ field: 'accountMode', message: 'accountMode is required' });
      } else if (!['single', 'multi'].includes(obj['accountMode'] as string)) {
        errors.push({ field: 'accountMode', message: 'accountMode must be one of: single, multi' });
      }
      if (obj['accountMode'] === 'multi' && !('sourceAccountIds' in obj)) {
        errors.push({ field: 'sourceAccountIds', message: 'sourceAccountIds is required when accountMode is multi' });
      }
      if ('sourceAccountIds' in obj) {
        const ids = obj['sourceAccountIds'];
        if (!Array.isArray(ids)) {
          errors.push({ field: 'sourceAccountIds', message: 'sourceAccountIds must be an array' });
        } else {
          const invalid = (ids as unknown[]).filter((id) => typeof id !== 'string' || !/^\d{12}$/.test(id as string));
          if (invalid.length > 0) {
            errors.push({ field: 'sourceAccountIds', message: 'Each sourceAccountId must be a 12-digit AWS account ID' });
          }
        }
      }
      break;
    }

    case 'retention': {
      // Required: at least one retention field
      const hasRetention =
        'rawLogsRetentionDays' in obj ||
        'processedDataRetentionDays' in obj ||
        'idempotencyTtlHours' in obj ||
        'retentionDays' in obj;
      if (!hasRetention) {
        errors.push({
          field: 'retention',
          message: 'At least one retention field (rawLogsRetentionDays, processedDataRetentionDays, idempotencyTtlHours) must be provided',
        });
      }
      for (const field of ['rawLogsRetentionDays', 'processedDataRetentionDays', 'idempotencyTtlHours', 'retentionDays'] as const) {
        if (field in obj) {
          const v = obj[field];
          if (typeof v !== 'number' || !Number.isInteger(v) || (v as number) < 1) {
            errors.push({ field, message: `${field} must be a positive integer` });
          }
        }
      }
      break;
    }

    case 'pricing-auto-update': {
      // Required: enabled flag
      if (!('enabled' in obj)) {
        errors.push({ field: 'enabled', message: 'enabled is required' });
      } else if (typeof obj['enabled'] !== 'boolean') {
        errors.push({ field: 'enabled', message: 'enabled must be a boolean' });
      }
      if ('scheduleExpression' in obj && typeof obj['scheduleExpression'] !== 'string') {
        errors.push({ field: 'scheduleExpression', message: 'scheduleExpression must be a string' });
      }
      break;
    }

    default:
      return {
        valid: false,
        errors: [{ field: 'configCategory', message: `Unknown config category: ${configCategory}` }],
      };
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ── Audit logging ─────────────────────────────────────────────────────────────

/**
 * Write an audit record to the Runtime_Config table.
 * Audit records use configCategory = "audit" and configKey = "{category}#{timestamp}".
 */
export async function writeAuditRecord(params: AuditParams): Promise<void> {
  const { tableName, configCategory, configKey, caller, previousValue, newValue } = params;
  const timestamp = new Date().toISOString();
  const auditKey = `${configCategory}#${timestamp}#${Math.random().toString(36).slice(2)}`;

  const ddb = getDdbClient();
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        configCategory: 'audit',
        configKey: auditKey,
        auditedCategory: configCategory,
        auditedKey: configKey,
        caller,
        timestamp,
        previousValue: previousValue ?? null,
        newValue,
      },
    }),
  );
}

// ── GET handler ───────────────────────────────────────────────────────────────

async function handleGet(
  tableName: string,
  configCategory: string,
  configKey: string,
): Promise<APIGatewayProxyResult> {
  const ddb = getDdbClient();
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { configCategory, configKey },
      }),
    );

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `No configuration found for category: ${configCategory}` }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.Item),
    };
  } catch (err) {
    return buildDynamoErrorResponse(err);
  }
}

// ── PUT handler ───────────────────────────────────────────────────────────────

async function handlePut(
  tableName: string,
  configCategory: string,
  configKey: string,
  body: unknown,
  caller: string,
): Promise<APIGatewayProxyResult> {
  // 1. Validate
  const validation = validateConfigUpdate(configCategory, body);
  if (!validation.valid) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Validation failed', errors: validation.errors }),
    };
  }

  const ddb = getDdbClient();
  const obj = body as Record<string, unknown>;
  const incomingVersion = typeof obj['version'] === 'number' ? (obj['version'] as number) : undefined;

  try {
    // 2. Read current value for audit + optimistic locking
    const current = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { configCategory, configKey },
      }),
    );

    const previousValue = current.Item?.value ?? null;
    const currentVersion: number = typeof current.Item?.version === 'number' ? (current.Item.version as number) : 0;

    // 3. Optimistic locking: if caller provided a version, it must match
    if (incomingVersion !== undefined && incomingVersion !== currentVersion) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Conflict: version mismatch. The resource has been modified by another request.',
          currentVersion,
          providedVersion: incomingVersion,
        }),
      };
    }

    const newVersion = currentVersion + 1;
    const updatedAt = new Date().toISOString();

    // 4. Conditional write with version check
    const conditionExpression = current.Item
      ? 'version = :currentVersion'
      : 'attribute_not_exists(configCategory)';

    const expressionAttributeValues: Record<string, unknown> = {
      ':value': obj,
      ':updatedAt': updatedAt,
      ':updatedBy': caller,
      ':newVersion': newVersion,
    };

    if (current.Item) {
      expressionAttributeValues[':currentVersion'] = currentVersion;
    }

    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { configCategory, configKey },
        UpdateExpression: 'SET #value = :value, updatedAt = :updatedAt, updatedBy = :updatedBy, version = :newVersion',
        ConditionExpression: conditionExpression,
        ExpressionAttributeNames: { '#value': 'value' },
        ExpressionAttributeValues: expressionAttributeValues,
      }),
    );

    // 5. Write audit record
    await writeAuditRecord({
      tableName,
      configCategory,
      configKey,
      caller,
      previousValue,
      newValue: obj,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Configuration updated successfully',
        configCategory,
        configKey,
        version: newVersion,
        updatedAt,
      }),
    };
  } catch (err) {
    // Optimistic locking conflict from DynamoDB
    if (isConditionalCheckFailed(err)) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Conflict: the resource was modified concurrently. Please retry with the latest version.',
        }),
      };
    }
    return buildDynamoErrorResponse(err);
  }
}

// ── Error helpers ─────────────────────────────────────────────────────────────

function isConditionalCheckFailed(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.name === 'ConditionalCheckFailedException' ||
      err.message.includes('ConditionalCheckFailedException')
    );
  }
  return false;
}

function buildDynamoErrorResponse(err: unknown): APIGatewayProxyResult {
  console.error('DynamoDB error:', err);
  return {
    statusCode: 503,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': '30',
    },
    body: JSON.stringify({
      message: 'Service temporarily unavailable. Please retry after 30 seconds.',
    }),
  };
}

// ── Route parsing ─────────────────────────────────────────────────────────────

function parseRoute(event: APIGatewayProxyEvent): { configCategory: string } | null {
  const path = event.path ?? event.resource ?? '';
  // Match /config/{category}
  const match = path.match(/\/config\/([^/]+)$/);
  if (!match) return null;
  return { configCategory: match[1] };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const tableName = process.env['RUNTIME_CONFIG_TABLE'];
  if (!tableName) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'RUNTIME_CONFIG_TABLE environment variable is required' }),
    };
  }

  const route = parseRoute(event);
  if (!route) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Route not found: ${event.path}` }),
    };
  }

  const { configCategory } = route;
  const configKey = CATEGORY_KEY_MAP[configCategory];
  if (!configKey) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Unknown config category: ${configCategory}` }),
    };
  }

  const method = event.httpMethod?.toUpperCase();

  // Caller identity from API Gateway context
  const caller =
    event.requestContext?.identity?.userArn ??
    event.requestContext?.identity?.caller ??
    'unknown';

  switch (method) {
    case 'GET':
      return handleGet(tableName, configCategory, configKey);

    case 'PUT': {
      let body: unknown;
      try {
        body = event.body ? JSON.parse(event.body) : {};
      } catch {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Invalid JSON in request body' }),
        };
      }
      return handlePut(tableName, configCategory, configKey, body, caller);
    }

    default:
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json', Allow: 'GET, PUT' },
        body: JSON.stringify({ message: `Method not allowed: ${method}` }),
      };
  }
}

// handler is already exported as a named export above
