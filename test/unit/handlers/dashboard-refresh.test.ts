// Feature: dashboard-visual-enhancements
// Unit tests for Dashboard Refresh handler (pipeline orchestration)
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8

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

import { handler } from 'lib/handlers/dashboard-refresh/index';

function makeEvent(params?: Record<string, string>): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/dashboard/refresh',
    queryStringParameters: params ?? null,
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

const ACCOUNT_ID = '123456789012';
const DATASET_ID = 'invocations-dataset';
const METRICS_DATASET_ID = 'metrics-dataset';
const INV_PROC_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:InvocationProcessor';
const METRICS_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:MetricsCollector';

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockLambdaSuccess(): void {
  lambdaMock.on(InvokeCommand).resolves({
    StatusCode: 200,
    $metadata: {},
  });
}

function mockQsSuccess(): void {
  qsMock.on(CreateIngestionCommand).resolves({
    IngestionId: 'refresh-111',
    IngestionStatus: 'INITIALIZED',
    $metadata: { httpStatusCode: 200 },
  });
}

// ─── Success path ─────────────────────────────────────────────────────────────

describe('Dashboard Refresh handler — success path', () => {
  it('returns 200 with SUCCESS status when all steps succeed', async () => {
    mockLambdaSuccess();
    mockQsSuccess();

    const result = await handler(makeEvent({ accountId: ACCOUNT_ID }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as RefreshPipelineResponse;
    expect(body.status).toBe('SUCCESS');
    expect(body.steps.invocationProcessor.status).toBe('SUCCESS');
    expect(body.steps.metricsCollector.status).toBe('SUCCESS');
    expect(body.steps.spiceIngestion.status).toBe('SUCCESS');
    expect(typeof body.elapsedMs).toBe('number');
  });

  it('triggers SPICE ingestion on metrics dataset when METRICS_DATASET_ID is set', async () => {
    process.env['METRICS_DATASET_ID'] = METRICS_DATASET_ID;
    mockLambdaSuccess();
    mockQsSuccess();

    const result = await handler(makeEvent({ accountId: ACCOUNT_ID }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as RefreshPipelineResponse;
    expect(body.steps.metricsSpiceIngestion).toBeDefined();
    expect(body.steps.metricsSpiceIngestion?.status).toBe('SUCCESS');

    const qsCalls = qsMock.commandCalls(CreateIngestionCommand);
    expect(qsCalls).toHaveLength(2);
    const datasetIds = qsCalls.map(c => c.args[0].input.DataSetId);
    expect(datasetIds).toContain(DATASET_ID);
    expect(datasetIds).toContain(METRICS_DATASET_ID);
  });

  it('does NOT trigger metrics SPICE ingestion when METRICS_DATASET_ID is not set', async () => {
    mockLambdaSuccess();
    mockQsSuccess();

    const result = await handler(makeEvent({ accountId: ACCOUNT_ID }));

    const body = JSON.parse(result.body) as RefreshPipelineResponse;
    expect(body.steps.metricsSpiceIngestion).toBeUndefined();

    const qsCalls = qsMock.commandCalls(CreateIngestionCommand);
    expect(qsCalls).toHaveLength(1);
  });

  it('returns Content-Type application/json header', async () => {
    mockLambdaSuccess();
    mockQsSuccess();

    const result = await handler(makeEvent({ accountId: ACCOUNT_ID }));

    expect(result.headers?.['Content-Type']).toBe('application/json');
  });
});

// ─── Missing parameters ───────────────────────────────────────────────────────

describe('Dashboard Refresh handler — missing parameters', () => {
  it('returns 400 when accountId is missing', async () => {
    const result = await handler(makeEvent({}));

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
  });

  it('returns 400 when queryStringParameters is null', async () => {
    const result = await handler(makeEvent(undefined));

    expect(result.statusCode).toBe(400);
  });
});

// ─── Pipeline failure short-circuit (Req 1.6) ─────────────────────────────────

describe('Dashboard Refresh handler — Invocation Processor failure short-circuits pipeline', () => {
  it('returns 500 and skips downstream steps when Invocation Processor fails', async () => {
    lambdaMock.on(InvokeCommand).resolves({
      StatusCode: 200,
      FunctionError: 'Unhandled',
      $metadata: {},
    } as any);

    const result = await handler(makeEvent({ accountId: ACCOUNT_ID }));

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body) as RefreshPipelineResponse;
    expect(body.status).toBe('FAILURE');
    expect(body.steps.invocationProcessor.status).toBe('FAILURE');
    expect(body.steps.metricsCollector.status).toBe('SKIPPED');
    expect(body.steps.spiceIngestion.status).toBe('SKIPPED');

    // No Lambda or QS calls after the failure
    const lambdaCalls = lambdaMock.commandCalls(InvokeCommand);
    expect(lambdaCalls).toHaveLength(1); // only InvocationProcessor was called
    expect(qsMock.commandCalls(CreateIngestionCommand)).toHaveLength(0);
  });

  it('returns 500 with failure reason when Invocation Processor throws', async () => {
    lambdaMock.on(InvokeCommand).rejectsOnce(new Error('Connection timeout'));

    const result = await handler(makeEvent({ accountId: ACCOUNT_ID }));

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body) as RefreshPipelineResponse;
    expect(body.status).toBe('FAILURE');
    expect(body.steps.invocationProcessor.error).toContain('Connection timeout');
  });
});

// ─── LimitExceededException → 429 (Req 1.7) ──────────────────────────────────

describe('Dashboard Refresh handler — LimitExceededException returns 429', () => {
  it('returns 429 when CreateIngestion throws LimitExceededException', async () => {
    mockLambdaSuccess();
    qsMock.on(CreateIngestionCommand).rejects(
      new LimitExceededException({ message: 'Rate exceeded for CreateIngestion', $metadata: {} }),
    );

    const result = await handler(makeEvent({ accountId: ACCOUNT_ID }));

    expect(result.statusCode).toBe(429);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
    expect(body['error']).toContain('limit exceeded');
  });
});

// ─── Elapsed time and step logging (Req 1.8) ──────────────────────────────────

describe('Dashboard Refresh handler — logs elapsed time and step statuses', () => {
  it('response includes elapsedMs and per-step durationMs', async () => {
    mockLambdaSuccess();
    mockQsSuccess();

    const result = await handler(makeEvent({ accountId: ACCOUNT_ID }));

    const body = JSON.parse(result.body) as RefreshPipelineResponse;
    expect(typeof body.elapsedMs).toBe('number');
    expect(body.elapsedMs).toBeGreaterThanOrEqual(0);

    expect(typeof body.steps.invocationProcessor.durationMs).toBe('number');
    expect(typeof body.steps.metricsCollector.durationMs).toBe('number');
    expect(typeof body.steps.spiceIngestion.durationMs).toBe('number');
  });

  it('response includes status for each step', async () => {
    mockLambdaSuccess();
    mockQsSuccess();

    const result = await handler(makeEvent({ accountId: ACCOUNT_ID }));

    const body = JSON.parse(result.body) as RefreshPipelineResponse;
    const validStatuses = ['SUCCESS', 'FAILURE', 'SKIPPED'];
    expect(validStatuses).toContain(body.steps.invocationProcessor.status);
    expect(validStatuses).toContain(body.steps.metricsCollector.status);
    expect(validStatuses).toContain(body.steps.spiceIngestion.status);
  });
});

// ─── Partial failure (Req 1.2) ────────────────────────────────────────────────

describe('Dashboard Refresh handler — partial failure', () => {
  it('returns 200 PARTIAL_FAILURE when Metrics Collector fails but continues to SPICE ingestion', async () => {
    // InvocationProcessor succeeds, MetricsCollector fails
    lambdaMock
      .on(InvokeCommand)
      .resolvesOnce({ StatusCode: 200, $metadata: {} })
      .rejectsOnce(new Error('MetricsCollector error'));
    mockQsSuccess();

    const result = await handler(makeEvent({ accountId: ACCOUNT_ID }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as RefreshPipelineResponse;
    expect(body.status).toBe('PARTIAL_FAILURE');
    expect(body.steps.invocationProcessor.status).toBe('SUCCESS');
    expect(body.steps.metricsCollector.status).toBe('FAILURE');
    expect(body.steps.spiceIngestion.status).toBe('SUCCESS');
  });
});
