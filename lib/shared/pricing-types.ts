/**
 * Shared pricing type definitions for Bedrock pricing dimensions.
 * Used by invocation-processor and CUR reconciliation.
 *
 * Requirements: 1.2, 1.3, 4.1, 4.2
 */

/** Billing tier for a Bedrock invocation. */
export type InferenceTier = 'standard' | 'priority' | 'flex' | 'batch';

/** Cross-region inference routing type. */
export type CrossRegionType = 'none' | 'global' | 'geo';

/** Prompt-caching dimension for a Bedrock invocation. */
export type CacheType = 'none' | 'cacheWrite5m' | 'cacheWrite1h' | 'cacheRead';

/** Model modality — determines which rate fields and cost formulas apply. */
export type ModelModality = 'text' | 'image' | 'video' | 'audio';
