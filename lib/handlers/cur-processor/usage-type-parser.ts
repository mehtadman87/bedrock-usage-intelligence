/**
 * CUR usage_type parser for Bedrock cost line items.
 *
 * Parses the CUR usage_type field format:
 *   {REGION_CODE}-{MODEL_NAME}-{TOKEN_TYPE}[-{CROSS_REGION_SUFFIX}]
 *
 * Examples:
 *   USE1-Claude4.6Opus-input-tokens
 *   USE1-Claude4.6Opus-cache-read-input-token-count
 *   USE1-Claude4.6Opus-output-tokens-cross-region-global
 *   USE1-Claude4.6Opus-cache-read-input-token-count-cross-region-global
 *
 * Requirements: 2.1, 2.3, 2.6
 */

import { CurCrossRegionType, CurTokenType, ParsedUsageType } from '../../shared/cur-types';

/**
 * Maps CUR region short codes to AWS region codes.
 */
export const CUR_REGION_CODE_MAP: Record<string, string> = {
  USE1: 'us-east-1',
  USE2: 'us-east-2',
  USW1: 'us-west-1',
  USW2: 'us-west-2',
  EUW1: 'eu-west-1',
  EUW2: 'eu-west-2',
  EUW3: 'eu-west-3',
  EUC1: 'eu-central-1',
  EUN1: 'eu-north-1',
  APS1: 'ap-south-1',
  APS2: 'ap-southeast-2',
  APE1: 'ap-northeast-1',
  APN1: 'ap-northeast-1',
  APSE1: 'ap-southeast-1',
  SAE1: 'sa-east-1',
  CAN1: 'ca-central-1',
  MES1: 'me-south-1',
};

/**
 * Maps CUR billing names (from usage_type) to Bedrock API model IDs.
 * This is the single mapping that replaces the fragile three-way name mapping.
 */
export const CUR_MODEL_BILLING_NAME_MAP: Record<string, string> = {
  'Claude4.6Opus': 'anthropic.claude-opus-4-6-v1',
  'Claude4.6Sonnet': 'anthropic.claude-sonnet-4-6',
  'Claude4.5Opus': 'anthropic.claude-opus-4-5-20251101-v1:0',
  'Claude4.5Haiku': 'anthropic.claude-haiku-4-5-20251001-v1:0',
  'Claude3.7Sonnet': 'anthropic.claude-3-7-sonnet-20250219-v1:0',
  'Claude3.5Sonnetv2': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'Claude3.5Haiku': 'anthropic.claude-3-5-haiku-20241022-v1:0',
  'Claude3Haiku': 'anthropic.claude-3-haiku-20240307-v1:0',
  'Claude3Sonnet': 'anthropic.claude-3-sonnet-20240229-v1:0',
  'Claude3Opus': 'anthropic.claude-3-opus-20240229-v1:0',
  'Claude4.5Sonnet': 'anthropic.claude-4-5-sonnet-20250514-v1:0',
  'Jamba1-5Large': 'ai21.jamba-1-5-large-v1:0',
  'Jamba1-5Mini': 'ai21.jamba-1-5-mini-v1:0',
  NovaPro: 'amazon.nova-pro-v1:0',
  NovaPremier: 'amazon.nova-premier-v1:0',
  NovaLite: 'amazon.nova-lite-v1:0',
  NovaMicro: 'amazon.nova-micro-v1:0',
  NovaReel: 'amazon.nova-reel-v1:0',
  NovaCanvas: 'amazon.nova-canvas-v1:0',
  TitanTextExpress: 'amazon.titan-text-express-v1',
  'Llama3.18BInstruct': 'meta.llama3-1-8b-instruct-v1:0',
  'Llama3.170BInstruct': 'meta.llama3-1-70b-instruct-v1:0',
};


/** Valid CUR token types for matching. */
const TOKEN_TYPES: CurTokenType[] = [
  'cache-read-input-token-count',
  'cache-write-input-token-count',
  'input-tokens',
  'output-tokens',
];

/** Valid CUR cross-region suffixes. */
const CROSS_REGION_SUFFIXES: Record<string, CurCrossRegionType> = {
  '-cross-region-global': 'cross-region-global',
  '-cross-region-geo': 'cross-region-geo',
};

/**
 * Parses a CUR usage_type string into its structured components.
 *
 * Format: {REGION_CODE}-{MODEL_NAME}-{TOKEN_TYPE}[-{CROSS_REGION_SUFFIX}]
 *
 * Returns null for usage types that do not match the expected format,
 * without throwing an error.
 *
 * @param usageType - Raw CUR usage_type string
 * @returns Parsed components or null if format doesn't match
 */
export function parseUsageType(usageType: string): ParsedUsageType | null {
  if (!usageType || typeof usageType !== 'string') {
    return null;
  }

  // Extract cross-region suffix first (if present) so it doesn't interfere with token type matching
  let crossRegionType: CurCrossRegionType = 'none';
  let remaining = usageType;

  for (const [suffix, type] of Object.entries(CROSS_REGION_SUFFIXES)) {
    if (remaining.endsWith(suffix)) {
      crossRegionType = type;
      remaining = remaining.slice(0, -suffix.length);
      break;
    }
  }

  // Match token type from the end of the remaining string
  let tokenType: CurTokenType | null = null;
  let beforeTokenType = '';

  for (const tt of TOKEN_TYPES) {
    const suffix = `-${tt}`;
    if (remaining.endsWith(suffix)) {
      tokenType = tt;
      beforeTokenType = remaining.slice(0, -suffix.length);
      break;
    }
  }

  if (!tokenType || !beforeTokenType) {
    return null;
  }

  // Split the prefix into region code and model name at the first hyphen
  const firstHyphen = beforeTokenType.indexOf('-');
  if (firstHyphen <= 0 || firstHyphen === beforeTokenType.length - 1) {
    return null;
  }

  const regionCode = beforeTokenType.slice(0, firstHyphen);
  const modelBillingName = beforeTokenType.slice(firstHyphen + 1);

  if (!regionCode || !modelBillingName) {
    return null;
  }

  const resolvedRegion = CUR_REGION_CODE_MAP[regionCode] ?? null;

  return {
    regionCode,
    resolvedRegion,
    modelBillingName,
    tokenType,
    crossRegionType,
  };
}
