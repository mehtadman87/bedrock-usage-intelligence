/**
 * CDK-specific constants. Only imported by stack definitions, never by
 * Lambda handler code. Importing aws-cdk-lib in handler code would pull
 * the entire CDK library (~13MB) into the esbuild bundle.
 */
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Shared Lambda runtime constant — all Lambda functions in the platform
 * use Node.js 22 LTS to match the CDK toolchain and stay on the upstream
 * LTS track through April 2027.
 */
export const LAMBDA_RUNTIME = lambda.Runtime.NODEJS_22_X;
