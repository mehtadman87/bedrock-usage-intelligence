/**
 * Shared type definitions for CUR (Cost and Usage Report) processing
 * and cost reconciliation.
 *
 * Requirements: 2.3, 2.6, 2.7
 */

/** Lifecycle state of a cost record during reconciliation. */
export type ReconciliationStatus = 'pending' | 'estimated' | 'reconciled' | 'unmatched';

/** Token type as encoded in CUR usage_type field. */
export type CurTokenType =
  | 'input-tokens'
  | 'output-tokens'
  | 'cache-read-input-token-count'
  | 'cache-write-input-token-count';

/** Cross-region inference type as encoded in CUR usage_type suffix. */
export type CurCrossRegionType = 'none' | 'cross-region-global' | 'cross-region-geo';

/**
 * Processed CUR cost record written to the cur-costs/ prefix.
 * Represents a single Bedrock line item from AWS Data Exports.
 */
export interface CurCostRecord {
  /** CUR billing period (e.g., '2025-01') */
  billingPeriod: string;
  /** Date the usage occurred (YYYY-MM-DD) */
  usageDate: string;
  /** AWS account ID that incurred the cost */
  payerAccountId: string;
  /** AWS account ID that used the service */
  usageAccountId: string;
  /** AWS region code (e.g., 'us-east-1') */
  region: string;
  /** CUR region short code (e.g., 'USE1') */
  regionCode: string;
  /** Model billing name as it appears in CUR usage_type (e.g., 'Claude4.6Opus') */
  modelBillingName: string;
  /** Resolved Bedrock API model ID, or null if unmapped */
  resolvedModelId: string | null;
  /** Token type from CUR usage_type */
  tokenType: CurTokenType;
  /** Cross-region type parsed from CUR usage_type suffix */
  crossRegionType: CurCrossRegionType;
  /** Raw CUR usage_type string */
  usageType: string;
  /** CUR pricing unit (e.g., '1K tokens', 'Images', 'Seconds') */
  pricingUnit: string;
  /** Usage quantity from CUR */
  usageQuantity: number;
  /** AWS-calculated unblended cost for this line item */
  unblendedCost: number;
  /** Unit price extracted from item_description as validation/fallback */
  unitPrice: number | null;
  /** Raw CUR item_description field */
  itemDescription: string;
  /** S3 key of the source CUR file */
  sourceCurFile: string;
}

/**
 * Output of the usage_type parser.
 * Extracts structured fields from the CUR usage_type format:
 * {REGION_CODE}-{MODEL_NAME}-{TOKEN_TYPE}[-{CROSS_REGION_SUFFIX}]
 */
export interface ParsedUsageType {
  /** CUR region short code (e.g., 'USE1', 'USW2', 'EUC1') */
  regionCode: string;
  /** Resolved AWS region code (e.g., 'us-east-1'), or null if unknown */
  resolvedRegion: string | null;
  /** Model billing name extracted from usage_type (e.g., 'Claude4.6Opus') */
  modelBillingName: string;
  /** Token type extracted from usage_type */
  tokenType: CurTokenType;
  /** Cross-region type parsed from optional suffix */
  crossRegionType: CurCrossRegionType;
}

/**
 * Reconciled per-user cost record written to the reconciled-costs/ prefix.
 * Produced by the Cost Reconciler via proportional attribution of CUR costs.
 */
export interface ReconciledCostRecord {
  /** Date the usage occurred (YYYY-MM-DD) */
  usageDate: string;
  /** AWS account ID */
  accountId: string;
  /** AWS region code */
  region: string;
  /** Bedrock API model ID */
  modelId: string;
  /** CUR model billing name */
  modelBillingName: string;
  /** Token type for this cost line */
  tokenType: CurTokenType;
  /** Cross-region type */
  crossRegionType: CurCrossRegionType;
  /** Resolved user ID from identity resolution */
  resolvedUserId: string;
  /** Resolved user name from identity resolution */
  resolvedUserName: string;
  /** User's token/usage count for this bucket */
  userTokens: number;
  /** Total tokens/usage in the reconciliation bucket */
  totalTokensInBucket: number;
  /** User's proportion of the bucket (userTokens / totalTokensInBucket) */
  proportion: number;
  /** CUR unblended cost for the entire bucket */
  bucketUnblendedCost: number;
  /** Attributed cost for this user: proportion × bucketUnblendedCost */
  attributedCost: number;
  /** Reconciliation status */
  reconciliationStatus: ReconciliationStatus;
}
