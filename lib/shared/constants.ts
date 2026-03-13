/**
 * Runtime constants shared between Lambda handlers and CDK stacks.
 * IMPORTANT: This file must NOT import aws-cdk-lib or any CDK constructs.
 * Lambda handlers import from this file, and CDK imports would bloat the
 * esbuild bundle by ~13MB (the entire CDK library).
 *
 * For CDK-specific constants (e.g. LAMBDA_RUNTIME), see cdk-constants.ts.
 */

/** Default TTL for Identity_Cache entries (24 hours in seconds) */
export const IDENTITY_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** Default TTL for Idempotency_Table entries (24 hours in seconds) */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Circuit breaker: consecutive failures before opening */
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;

/** Circuit breaker: cooldown period in milliseconds before transitioning to HalfOpen */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

/** S3 prefix for failed records */
export const FAILED_RECORDS_PREFIX = 'failed-records';

/** Bedrock API calls captured by CloudTrail */
export const BEDROCK_CLOUDTRAIL_EVENT_NAMES = [
  'InvokeModel',
  'InvokeModelWithResponseStream',
  'Converse',
  'ConverseStream',
] as const;

export type BedrockEventName = (typeof BEDROCK_CLOUDTRAIL_EVENT_NAMES)[number];

/** Default schedule for CUR cost reconciliation */
export const DEFAULT_RECONCILIATION_SCHEDULE = 'rate(6 hours)';

/** Hours after which CUR data is considered stale */
export const CUR_DATA_STALENESS_THRESHOLD_HOURS = 48;

/** Percentage threshold for reconciliation mismatch alerts */
export const RECONCILIATION_MISMATCH_THRESHOLD_PERCENT = 5;

/** S3 prefix for processed CUR cost records */
export const CUR_COSTS_PREFIX = 'cur-costs';

/** S3 prefix for reconciled per-user cost records */
export const RECONCILED_COSTS_PREFIX = 'reconciled-costs';

/** S3 prefix for model billing name mapping data */
export const MODEL_BILLING_MAP_PREFIX = 'model-billing-map';
