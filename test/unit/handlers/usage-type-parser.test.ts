/**
 * Unit tests for CUR usage_type parser.
 *
 * Requirements: 2.1, 2.3, 2.6
 */
import {
  parseUsageType,
  CUR_REGION_CODE_MAP,
  CUR_MODEL_BILLING_NAME_MAP,
} from '../../../lib/handlers/cur-processor/usage-type-parser';

describe('parseUsageType', () => {
  describe('standard token types', () => {
    it('parses input-tokens', () => {
      const result = parseUsageType('USE1-Claude4.6Opus-input-tokens');
      expect(result).toEqual({
        regionCode: 'USE1',
        resolvedRegion: 'us-east-1',
        modelBillingName: 'Claude4.6Opus',
        tokenType: 'input-tokens',
        crossRegionType: 'none',
      });
    });

    it('parses output-tokens', () => {
      const result = parseUsageType('USE1-Claude4.6Opus-output-tokens');
      expect(result).toEqual({
        regionCode: 'USE1',
        resolvedRegion: 'us-east-1',
        modelBillingName: 'Claude4.6Opus',
        tokenType: 'output-tokens',
        crossRegionType: 'none',
      });
    });
  });

  describe('cache token types', () => {
    it('parses cache-read-input-token-count', () => {
      const result = parseUsageType('USE1-Claude4.6Opus-cache-read-input-token-count');
      expect(result).toEqual({
        regionCode: 'USE1',
        resolvedRegion: 'us-east-1',
        modelBillingName: 'Claude4.6Opus',
        tokenType: 'cache-read-input-token-count',
        crossRegionType: 'none',
      });
    });

    it('parses cache-write-input-token-count', () => {
      const result = parseUsageType('USE1-Claude4.6Opus-cache-write-input-token-count');
      expect(result).toEqual({
        regionCode: 'USE1',
        resolvedRegion: 'us-east-1',
        modelBillingName: 'Claude4.6Opus',
        tokenType: 'cache-write-input-token-count',
        crossRegionType: 'none',
      });
    });
  });

  describe('cross-region suffixes', () => {
    it('parses cross-region-global suffix', () => {
      const result = parseUsageType('USE1-Claude4.6Opus-output-tokens-cross-region-global');
      expect(result).toEqual({
        regionCode: 'USE1',
        resolvedRegion: 'us-east-1',
        modelBillingName: 'Claude4.6Opus',
        tokenType: 'output-tokens',
        crossRegionType: 'cross-region-global',
      });
    });

    it('parses cross-region-geo suffix', () => {
      const result = parseUsageType('USW2-NovaPro-input-tokens-cross-region-geo');
      expect(result).toEqual({
        regionCode: 'USW2',
        resolvedRegion: 'us-west-2',
        modelBillingName: 'NovaPro',
        tokenType: 'input-tokens',
        crossRegionType: 'cross-region-geo',
      });
    });
  });

  describe('combined cache + cross-region', () => {
    it('parses cache-read with cross-region-global', () => {
      const result = parseUsageType('USE1-Claude4.6Opus-cache-read-input-token-count-cross-region-global');
      expect(result).toEqual({
        regionCode: 'USE1',
        resolvedRegion: 'us-east-1',
        modelBillingName: 'Claude4.6Opus',
        tokenType: 'cache-read-input-token-count',
        crossRegionType: 'cross-region-global',
      });
    });

    it('parses cache-write with cross-region-geo', () => {
      const result = parseUsageType('EUC1-Claude3.5Haiku-cache-write-input-token-count-cross-region-geo');
      expect(result).toEqual({
        regionCode: 'EUC1',
        resolvedRegion: 'eu-central-1',
        modelBillingName: 'Claude3.5Haiku',
        tokenType: 'cache-write-input-token-count',
        crossRegionType: 'cross-region-geo',
      });
    });
  });

  describe('all region codes in CUR_REGION_CODE_MAP', () => {
    for (const [code, region] of Object.entries(CUR_REGION_CODE_MAP)) {
      it(`resolves ${code} to ${region}`, () => {
        const result = parseUsageType(`${code}-NovaPro-input-tokens`);
        expect(result).not.toBeNull();
        expect(result!.regionCode).toBe(code);
        expect(result!.resolvedRegion).toBe(region);
      });
    }
  });

  describe('all models in CUR_MODEL_BILLING_NAME_MAP', () => {
    for (const billingName of Object.keys(CUR_MODEL_BILLING_NAME_MAP)) {
      it(`extracts model billing name: ${billingName}`, () => {
        const result = parseUsageType(`USE1-${billingName}-input-tokens`);
        expect(result).not.toBeNull();
        expect(result!.modelBillingName).toBe(billingName);
      });
    }
  });

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(parseUsageType('')).toBeNull();
    });

    it('returns null for non-Bedrock usage types', () => {
      expect(parseUsageType('DataTransfer-Out-Bytes')).toBeNull();
    });

    it('returns null for malformed strings with no hyphens', () => {
      expect(parseUsageType('USE1')).toBeNull();
    });

    it('returns null for missing token type', () => {
      expect(parseUsageType('USE1-Claude4.6Opus')).toBeNull();
    });

    it('returns null for missing model name', () => {
      expect(parseUsageType('USE1-input-tokens')).toBeNull();
    });

    it('returns resolvedRegion as null for unknown region codes', () => {
      const result = parseUsageType('ZZZ1-Claude4.6Opus-input-tokens');
      expect(result).not.toBeNull();
      expect(result!.regionCode).toBe('ZZZ1');
      expect(result!.resolvedRegion).toBeNull();
    });

    it('returns null for null-ish input', () => {
      expect(parseUsageType(null as unknown as string)).toBeNull();
      expect(parseUsageType(undefined as unknown as string)).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(parseUsageType(123 as unknown as string)).toBeNull();
    });

    it('handles model names with dots and numbers', () => {
      const result = parseUsageType('USW2-Llama3.18BInstruct-output-tokens');
      expect(result).not.toBeNull();
      expect(result!.modelBillingName).toBe('Llama3.18BInstruct');
      expect(result!.tokenType).toBe('output-tokens');
    });

    it('returns null when only region code and hyphen present', () => {
      expect(parseUsageType('USE1-')).toBeNull();
    });
  });
});
