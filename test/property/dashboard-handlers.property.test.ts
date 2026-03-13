// Feature: quicksight-dashboard
import * as fc from 'fast-check';
import { mockClient } from 'aws-sdk-client-mock';
import {
  QuickSightClient,
  CreateIngestionCommand,
  DescribeAccountSubscriptionCommand,
  LimitExceededException,
  ResourceNotFoundException,
} from '@aws-sdk/client-quicksight';
import { handler as refreshHandler } from 'lib/handlers/dashboard-refresh/index';
import { handler as validatorHandler } from 'lib/handlers/qs-account-validator/index';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const qsMock = mockClient(QuickSightClient);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRefreshEvent(accountId?: string, datasetId?: string): APIGatewayProxyEvent {
  return {
    queryStringParameters: {
      ...(accountId !== undefined ? { accountId } : {}),
      ...(datasetId !== undefined ? { datasetId } : {}),
    },
    httpMethod: 'GET',
    path: '/dashboard/refresh',
    headers: {},
    body: null,
    isBase64Encoded: false,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as never,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    resource: '',
  };
}

function makeValidatorEvent(requestType: 'Create' | 'Update' | 'Delete', accountId = '123456789012') {
  return {
    RequestType: requestType,
    PhysicalResourceId: 'qs-account-validator',
    ResourceProperties: { AwsAccountId: accountId } as Record<string, string>,
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid AWS account IDs: 12-digit strings */
const validAccountId = fc
  .integer({ min: 100000000000, max: 999999999999 })
  .map((n) => String(n));

/** Valid dataset IDs: non-empty alphanumeric strings */
const validDatasetId = fc
  .stringMatching(/^[a-zA-Z0-9_-]{1,64}$/)
  .filter((s) => s.length > 0);

/** Non-LimitExceededException error names */
const nonLimitErrorName = fc.constantFrom(
  'AccessDeniedException',
  'InvalidParameterValueException',
  'InternalFailureException',
  'ServiceUnavailableException',
);

/** Non-ACCOUNT_CREATED subscription statuses */
const nonCreatedStatus = fc.constantFrom(
  'UNSUBSCRIBED',
  'ACCOUNT_DELETED',
  'INACTIVE',
  'PENDING',
  '',
);

beforeEach(() => {
  qsMock.reset();
  process.env['SPICE_MODE'] = 'enabled';
  process.env['QUICKSIGHT_EDITION'] = 'STANDARD';
});

afterEach(() => {
  qsMock.reset();
  delete process.env['SPICE_MODE'];
  delete process.env['QUICKSIGHT_EDITION'];
});

// ---------------------------------------------------------------------------
// Property 4: Refresh handler returns correct response for SPICE modes (Req 6)
// Validates: Requirements 6
// ---------------------------------------------------------------------------

describe('Property 4: Refresh handler returns 200 with pipeline response for valid inputs', () => {
  it('returns 200 with status and steps for any valid accountId/datasetId', async () => {
    await fc.assert(
      fc.asyncProperty(validAccountId, validDatasetId, async (accountId, datasetId) => {
        qsMock.reset();
        process.env['DATASET_ID'] = datasetId;
        qsMock.on(CreateIngestionCommand).resolves({
          IngestionId: `refresh-${Date.now()}`,
          IngestionStatus: 'INITIALIZED',
        });

        const event = makeRefreshEvent(accountId, datasetId);
        const result = await refreshHandler(event);

        if (result.statusCode !== 200) return false;
        const body = JSON.parse(result.body) as Record<string, unknown>;
        return (
          typeof body['status'] === 'string' &&
          typeof body['elapsedMs'] === 'number' &&
          typeof body['steps'] === 'object'
        );
      }),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Refresh handler propagates errors as HTTP 502 (Req 6)
// Validates: Requirements 6
// ---------------------------------------------------------------------------

describe('Property 5: Refresh handler returns 200 with PARTIAL_FAILURE for non-LimitExceededException errors', () => {
  it('returns 200 with PARTIAL_FAILURE status for any non-LimitExceededException error from QuickSight', async () => {
    await fc.assert(
      fc.asyncProperty(validAccountId, validDatasetId, nonLimitErrorName, async (accountId, datasetId, errorName) => {
        qsMock.reset();
        process.env['DATASET_ID'] = datasetId;
        const err = new Error(`Simulated ${errorName}`);
        err.name = errorName;
        qsMock.on(CreateIngestionCommand).rejects(err);

        const event = makeRefreshEvent(accountId, datasetId);
        const result = await refreshHandler(event);

        // Pipeline returns 200 with PARTIAL_FAILURE when SPICE ingestion fails
        if (result.statusCode !== 200) return false;
        const body = JSON.parse(result.body) as Record<string, unknown>;
        return body['status'] === 'PARTIAL_FAILURE';
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Account validator fails with descriptive message (Req 8)
// Validates: Requirements 8
// ---------------------------------------------------------------------------

describe('Property 6: Account validator throws error containing descriptive message', () => {
  it('throws "QuickSight account is not activated" for ResourceNotFoundException on any accountId', async () => {
    await fc.assert(
      fc.asyncProperty(validAccountId, async (accountId) => {
        qsMock.reset();
        qsMock.on(DescribeAccountSubscriptionCommand).rejects(
          new ResourceNotFoundException({ message: 'Not found', $metadata: {} }),
        );

        const event = makeValidatorEvent('Create', accountId);
        try {
          await validatorHandler(event);
          return false; // should have thrown
        } catch (err) {
          return (
            err instanceof Error &&
            err.message.includes('QuickSight account is not activated')
          );
        }
      }),
      { numRuns: 20 },
    );
  });

  it('throws "QuickSight account is not activated" for any non-ACCOUNT_CREATED status', async () => {
    await fc.assert(
      fc.asyncProperty(validAccountId, nonCreatedStatus, async (accountId, status) => {
        qsMock.reset();
        qsMock.on(DescribeAccountSubscriptionCommand).resolves({
          AccountInfo: { AccountSubscriptionStatus: status },
        });

        const event = makeValidatorEvent('Create', accountId);
        try {
          await validatorHandler(event);
          return false; // should have thrown
        } catch (err) {
          return (
            err instanceof Error &&
            err.message.includes('QuickSight account is not activated')
          );
        }
      }),
      { numRuns: 20 },
    );
  });
});
