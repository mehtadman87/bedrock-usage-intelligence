import {
  QuickSightClient,
  CreateIngestionCommand,
  LimitExceededException,
} from '@aws-sdk/client-quicksight';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// ─── Response Types ───────────────────────────────────────────────────────────

export interface StepResult {
  status: 'SUCCESS' | 'FAILURE' | 'SKIPPED';
  durationMs: number;
  error?: string;
}

export interface RefreshPipelineResponse {
  status: 'SUCCESS' | 'PARTIAL_FAILURE' | 'FAILURE';
  elapsedMs: number;
  steps: {
    invocationProcessor: StepResult;
    metricsCollector: StepResult;
    spiceIngestion: StepResult;
    metricsSpiceIngestion?: StepResult;
  };
}

// ─── Clients ──────────────────────────────────────────────────────────────────

const quickSightClient = new QuickSightClient({});
const lambdaClient = new LambdaClient({});

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * API Gateway proxy handler for end-to-end data refresh pipeline.
 *
 * GET /dashboard/refresh?accountId=<id>
 *
 * Orchestrates the full pipeline:
 *   1. Invoke Invocation Processor Lambda (sync)
 *   2. Invoke Metrics Collector Lambda (sync)
 *   3. Trigger SPICE ingestion on invocations dataset
 *   4. Trigger SPICE ingestion on metrics dataset (if METRICS_DATASET_ID is set)
 *
 * Env vars:
 *   DATASET_ID                - QuickSight dataset ID for invocations dataset
 *   INVOCATION_PROCESSOR_ARN  - ARN of the Invocation Processor Lambda
 *   METRICS_COLLECTOR_ARN     - ARN of the Metrics Collector Lambda
 *   METRICS_DATASET_ID        - QuickSight dataset ID for metrics dataset (optional)
 *
 * Responses:
 *   200 - Pipeline completed (SUCCESS or PARTIAL_FAILURE)
 *   400 - Missing required query parameters
 *   429 - LimitExceededException (too many concurrent ingestions)
 *   500 - Invocation Processor failed
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const pipelineStart = Date.now();

  const invocationProcessorArn = process.env['INVOCATION_PROCESSOR_ARN'];
  const metricsCollectorArn = process.env['METRICS_COLLECTOR_ARN'];
  const metricsDatasetId = process.env['METRICS_DATASET_ID'];
  const datasetId = process.env['DATASET_ID'];

  console.log('DashboardRefresh pipeline invoked:', JSON.stringify({
    invocationProcessorArn,
    metricsCollectorArn,
    metricsDatasetId: metricsDatasetId ?? '(not set)',
    queryParams: event.queryStringParameters,
  }));

  const accountId = event.queryStringParameters?.['accountId'];

  if (!accountId) {
    return jsonResponse(400, {
      error: 'Missing required query parameter: accountId is required',
    });
  }

  // ── Step 1: Invoke Invocation Processor ────────────────────────────────────
  const invProcResult = await invokeStepLambda(invocationProcessorArn, 'InvocationProcessor');

  if (invProcResult.status === 'FAILURE') {
    const elapsedMs = Date.now() - pipelineStart;
    console.error('Pipeline short-circuited: InvocationProcessor failed', {
      error: invProcResult.error,
      elapsedMs,
    });

    const pipelineResponse: RefreshPipelineResponse = {
      status: 'FAILURE',
      elapsedMs,
      steps: {
        invocationProcessor: invProcResult,
        metricsCollector: { status: 'SKIPPED', durationMs: 0 },
        spiceIngestion: { status: 'SKIPPED', durationMs: 0 },
        ...(metricsDatasetId ? { metricsSpiceIngestion: { status: 'SKIPPED', durationMs: 0 } } : {}),
      },
    };

    logPipelineSummary(pipelineResponse);
    return jsonResponse(500, pipelineResponse as unknown as Record<string, unknown>);
  }

  // ── Step 2: Invoke Metrics Collector ───────────────────────────────────────
  const metricsCollResult = await invokeStepLambda(metricsCollectorArn, 'MetricsCollector');

  // ── Step 3: SPICE ingestion on invocations dataset ─────────────────────────
  const effectiveDatasetId = datasetId ?? event.queryStringParameters?.['datasetId'];
  const spiceResult = await triggerSpiceIngestion(quickSightClient, accountId, effectiveDatasetId, 'spiceIngestion');

  if (spiceResult.httpStatus === 429) {
    const elapsedMs = Date.now() - pipelineStart;
    return jsonResponse(429, {
      error: 'SPICE refresh limit exceeded. Please wait before triggering another refresh.',
    });
  }

  // ── Step 4: SPICE ingestion on metrics dataset (conditional) ───────────────
  let metricsSpiceResult: StepResult | undefined;
  if (metricsDatasetId) {
    const metricsSpice = await triggerSpiceIngestion(quickSightClient, accountId, metricsDatasetId, 'metricsSpiceIngestion');
    if (metricsSpice.httpStatus === 429) {
      const elapsedMs = Date.now() - pipelineStart;
      return jsonResponse(429, {
        error: 'SPICE refresh limit exceeded for metrics dataset. Please wait before triggering another refresh.',
      });
    }
    metricsSpiceResult = metricsSpice.stepResult;
  }

  // ── Build final response ───────────────────────────────────────────────────
  const elapsedMs = Date.now() - pipelineStart;

  const anyFailure =
    metricsCollResult.status === 'FAILURE' ||
    spiceResult.stepResult.status === 'FAILURE' ||
    (metricsSpiceResult?.status === 'FAILURE');

  const overallStatus: RefreshPipelineResponse['status'] = anyFailure ? 'PARTIAL_FAILURE' : 'SUCCESS';

  const pipelineResponse: RefreshPipelineResponse = {
    status: overallStatus,
    elapsedMs,
    steps: {
      invocationProcessor: invProcResult,
      metricsCollector: metricsCollResult,
      spiceIngestion: spiceResult.stepResult,
      ...(metricsSpiceResult !== undefined ? { metricsSpiceIngestion: metricsSpiceResult } : {}),
    },
  };

  logPipelineSummary(pipelineResponse);
  return jsonResponse(200, pipelineResponse as unknown as Record<string, unknown>);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function invokeStepLambda(
  functionArn: string | undefined,
  stepName: string,
): Promise<StepResult> {
  const stepStart = Date.now();

  if (!functionArn) {
    console.warn(`${stepName}: ARN not configured, skipping`);
    return { status: 'SKIPPED', durationMs: 0 };
  }

  try {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: functionArn,
        InvocationType: 'RequestResponse',
      }),
    );

    const durationMs = Date.now() - stepStart;

    // Lambda returns FunctionError if the invoked function threw an error
    if (response.FunctionError) {
      const payload = response.Payload ? Buffer.from(response.Payload).toString('utf-8') : 'unknown error';
      console.error(`${stepName} returned FunctionError:`, payload);
      return { status: 'FAILURE', durationMs, error: `FunctionError: ${payload}` };
    }

    console.log(`${stepName} succeeded in ${durationMs}ms`);
    return { status: 'SUCCESS', durationMs };
  } catch (err) {
    const durationMs = Date.now() - stepStart;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${stepName} invocation failed:`, message);
    return { status: 'FAILURE', durationMs, error: message };
  }
}

async function triggerSpiceIngestion(
  client: QuickSightClient,
  accountId: string,
  datasetId: string | undefined,
  stepName: string,
): Promise<{ stepResult: StepResult; httpStatus?: number }> {
  const stepStart = Date.now();

  if (!datasetId) {
    console.warn(`${stepName}: datasetId not configured, skipping`);
    return { stepResult: { status: 'SKIPPED', durationMs: 0 } };
  }

  const ingestionId = `refresh-${Date.now()}`;

  try {
    const response = await client.send(
      new CreateIngestionCommand({
        AwsAccountId: accountId,
        DataSetId: datasetId,
        IngestionId: ingestionId,
      }),
    );

    const durationMs = Date.now() - stepStart;
    console.log(`${stepName} ingestion started:`, { ingestionId, status: response.IngestionStatus, durationMs });
    return { stepResult: { status: 'SUCCESS', durationMs } };
  } catch (err) {
    const durationMs = Date.now() - stepStart;

    if (err instanceof LimitExceededException) {
      console.warn(`${stepName} LimitExceededException:`, err.message);
      return {
        stepResult: { status: 'FAILURE', durationMs, error: err.message },
        httpStatus: 429,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    console.error(`${stepName} CreateIngestion failed:`, message);
    return { stepResult: { status: 'FAILURE', durationMs, error: message } };
  }
}

function logPipelineSummary(response: RefreshPipelineResponse): void {
  console.log('Pipeline completed:', JSON.stringify({
    status: response.status,
    elapsedMs: response.elapsedMs,
    steps: Object.fromEntries(
      Object.entries(response.steps).map(([k, v]) => [k, { status: v?.status, durationMs: v?.durationMs }]),
    ),
  }));
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
