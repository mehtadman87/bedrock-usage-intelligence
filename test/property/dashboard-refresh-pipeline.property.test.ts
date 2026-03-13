// Feature: dashboard-visual-enhancements
// Property-based tests for the Refresh Lambda pipeline orchestration
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.6

import * as fc from 'fast-check';
import { mockClient } from 'aws-sdk-client-mock';
import {
  QuickSightClient,
  CreateIngestionCommand,
  LimitExceededException,
} from '@aws-sdk/client-quicksight';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { RefreshPipelineResponse } from 'lib/handlers/dashboard-refresh/index';

const qsMock = mockClient(QuickSightClient);
const lambdaMock = mockClient(LambdaClient);

// Lazy import so mocks are set up before the module loads clients
let handlerModule: typeof import('lib/handlers/dashboard-refresh/index');

beforeAll(async () => {
  handlerModule = await import('lib/handlers/dashboard-refresh/index');
});

const ACCOUNT_ID = '123456789012';
const DATASET_ID = 'invocations-dataset';
const INV_PROC_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:InvocationProcessor';
const METRICS_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:MetricsCollector';

function makeEvent(accountId: string): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/dashboard/refresh',
    queryStringParameters: { accountId },
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

beforeEach(() => {
  qsMock.reset();
  lambdaMock.reset();
  process.env['DATASET_ID'] = DATASET_ID;
  process.env['INVOCATION_PROCESSOR_ARN'] = INV_PROC_ARN;
  process.env['METRICS_COLLECTOR_ARN'] = METRICS_ARN;
  delete process.env['METRICS_DATASET_ID'];
});

afterEach(() => {
  delete process.env['DATASET_ID'];
  delete process.env['INVOCATION_PROCESSOR_ARN'];
  delete process.env['METRICS_COLLECTOR_ARN'];
  delete process.env['METRICS_DATASET_ID'];
});

// ---------------------------------------------------------------------------
// Property 1: Pipeline orchestration executes steps in correct order
// Validates: Requirements 1.1, 1.2, 1.3
// ---------------------------------------------------------------------------

describe('Feature: dashboard-visual-enhancements, Property 1: Pipeline orchestration executes steps in correct order', () => {
  it('invokes InvocationProcessor then MetricsCollector then SPICE ingestion in that order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ accountId: fc.constant(ACCOUNT_ID) }),
        async ({ accountId }) => {
          qsMock.reset();
          lambdaMock.reset();

          // Track call order
          const callOrder: string[] = [];

          lambdaMock.on(InvokeCommand).callsFake((input) => {
            callOrder.push(`lambda:${input.FunctionName as string}`);
            return Promise.resolve({ StatusCode: 200, $metadata: {} });
          });

          qsMock.on(CreateIngestionCommand).callsFake((input) => {
            callOrder.push(`qs:${input.DataSetId as string}`);
            return Promise.resolve({
              IngestionId: `refresh-${Date.now()}`,
              IngestionStatus: 'INITIALIZED',
              $metadata: { httpStatusCode: 200 },
            });
          });

          const result = await handlerModule.handler(makeEvent(accountId));
          const body = JSON.parse(result.body) as RefreshPipelineResponse;

          // Must succeed overall
          if (body.status === 'FAILURE') return false;

          // Must have at least 3 calls: InvProc, MetricsCollector, SPICE
          if (callOrder.length < 3) return false;

          // InvocationProcessor must be first
          if (!callOrder[0].includes(INV_PROC_ARN)) return false;

          // MetricsCollector must be second
          if (!callOrder[1].includes(METRICS_ARN)) return false;

          // SPICE ingestion must come after both Lambda invocations
          const spiceIndex = callOrder.findIndex(c => c.startsWith('qs:'));
          const lastLambdaIndex = Math.max(
            callOrder.findIndex(c => c.includes(INV_PROC_ARN)),
            callOrder.findIndex(c => c.includes(METRICS_ARN)),
          );
          if (spiceIndex <= lastLambdaIndex) return false;

          return true;
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Conditional metrics SPICE ingestion
// Validates: Requirements 1.4
// ---------------------------------------------------------------------------

describe('Feature: dashboard-visual-enhancements, Property 2: Conditional metrics SPICE ingestion', () => {
  it('triggers CreateIngestion on metrics dataset if and only if METRICS_DATASET_ID is set', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.string({ minLength: 5, maxLength: 20 }).filter(s => /^[a-z0-9-]+$/.test(s)),
        async (hasMetricsDataset, metricsDatasetId) => {
          qsMock.reset();
          lambdaMock.reset();

          if (hasMetricsDataset) {
            process.env['METRICS_DATASET_ID'] = metricsDatasetId;
          } else {
            delete process.env['METRICS_DATASET_ID'];
          }

          lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200, $metadata: {} });
          qsMock.on(CreateIngestionCommand).resolves({
            IngestionId: `refresh-${Date.now()}`,
            IngestionStatus: 'INITIALIZED',
            $metadata: { httpStatusCode: 200 },
          });

          const result = await handlerModule.handler(makeEvent(ACCOUNT_ID));
          const body = JSON.parse(result.body) as RefreshPipelineResponse;

          const qsCalls = qsMock.commandCalls(CreateIngestionCommand);
          const calledDatasetIds = qsCalls.map(c => c.args[0].input.DataSetId);

          if (hasMetricsDataset) {
            // Must have called CreateIngestion on the metrics dataset
            if (!calledDatasetIds.includes(metricsDatasetId)) return false;
            // Response must include metricsSpiceIngestion step
            if (!body.steps.metricsSpiceIngestion) return false;
          } else {
            // Must NOT have called CreateIngestion on any metrics dataset
            if (calledDatasetIds.includes(metricsDatasetId)) return false;
            // Response must NOT include metricsSpiceIngestion step
            if (body.steps.metricsSpiceIngestion !== undefined) return false;
          }

          return true;
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Pipeline failure short-circuits on Invocation Processor error
// Validates: Requirements 1.6
// ---------------------------------------------------------------------------

describe('Feature: dashboard-visual-enhancements, Property 3: Pipeline failure short-circuits on Invocation Processor error', () => {
  it('returns FAILURE and makes no downstream calls when InvocationProcessor fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.boolean(), // whether error is a thrown exception or FunctionError
        async (errorMessage, throwError) => {
          qsMock.reset();
          lambdaMock.reset();

          if (throwError) {
            lambdaMock.on(InvokeCommand).rejects(new Error(errorMessage));
          } else {
            lambdaMock.on(InvokeCommand).resolves({
              StatusCode: 200,
              FunctionError: 'Unhandled',
              $metadata: {},
            } as any);
          }

          const result = await handlerModule.handler(makeEvent(ACCOUNT_ID));

          // Must return 500
          if (result.statusCode !== 500) return false;

          const body = JSON.parse(result.body) as RefreshPipelineResponse;

          // Overall status must be FAILURE
          if (body.status !== 'FAILURE') return false;

          // InvocationProcessor must show FAILURE
          if (body.steps.invocationProcessor.status !== 'FAILURE') return false;

          // MetricsCollector must be SKIPPED (not called)
          if (body.steps.metricsCollector.status !== 'SKIPPED') return false;

          // SPICE ingestion must be SKIPPED (not called)
          if (body.steps.spiceIngestion.status !== 'SKIPPED') return false;

          // Lambda must have been called exactly once (only InvocationProcessor)
          const lambdaCalls = lambdaMock.commandCalls(InvokeCommand);
          if (lambdaCalls.length !== 1) return false;

          // QuickSight must NOT have been called at all
          const qsCalls = qsMock.commandCalls(CreateIngestionCommand);
          if (qsCalls.length !== 0) return false;

          return true;
        },
      ),
      { numRuns: 25 },
    );
  });
});
