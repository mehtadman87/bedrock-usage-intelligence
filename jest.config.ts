import type { Config } from 'jest';

const config: Config = {
  // Cap workers to avoid overwhelming the machine; integration tests run serially via runInBand
  maxWorkers: 2,
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/unit/**/*.test.ts'],
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            tsconfig: {
              module: 'CommonJS',
              moduleResolution: 'node',
            },
          },
        ],
      },
      moduleNameMapper: {
        '^lib/(.*)$': '<rootDir>/lib/$1',
        '^test/(.*)$': '<rootDir>/test/$1',
        // cheerio v1.x pulls in undici which requires File global (not available in Node 18.x).
        // cheerio/slim has the same load() API but skips the fetch/undici dependency.
        '^cheerio$': '<rootDir>/node_modules/cheerio/dist/commonjs/slim.js',
      },
    },
    {
      displayName: 'property',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/property/**/*.test.ts'],
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            tsconfig: {
              module: 'CommonJS',
              moduleResolution: 'node',
            },
          },
        ],
      },
      moduleNameMapper: {
        '^lib/(.*)$': '<rootDir>/lib/$1',
        '^test/(.*)$': '<rootDir>/test/$1',
        '^cheerio$': '<rootDir>/node_modules/cheerio/dist/commonjs/slim.js',
      },
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/integration/**/*.test.ts'],
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            tsconfig: {
              module: 'CommonJS',
              moduleResolution: 'node',
            },
          },
        ],
      },
      moduleNameMapper: {
        '^lib/(.*)$': '<rootDir>/lib/$1',
        '^test/(.*)$': '<rootDir>/test/$1',
        '^cheerio$': '<rootDir>/node_modules/cheerio/dist/commonjs/slim.js',
      },
    },
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  collectCoverageFrom: [
    'lib/**/*.ts',
    '!lib/**/*.d.ts',
    '!lib/**/*.js',
  ],
};

export default config;
