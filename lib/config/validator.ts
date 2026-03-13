import * as fs from 'fs';
import * as yaml from 'yaml';
import { ConfigSchema, PlatformConfig } from './schema';

/**
 * Loads config.yaml from disk, parses it, and validates it against the
 * ConfigSchema. Throws with actionable error messages on failure so that
 * CDK synth fails fast with clear guidance.
 */
export function loadAndValidateConfig(configPath: string): PlatformConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config file not found at "${configPath}". ` +
        'Create a config.yaml at the project root (see config.yaml for an example).',
    );
  }

  const raw = yaml.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${errors}`);
  }

  return result.data;
}
