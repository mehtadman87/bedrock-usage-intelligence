#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { loadAndValidateConfig } from '../lib/config/validator';
import { NetworkStack } from '../lib/stacks/network-stack';
import { SecurityStack } from '../lib/stacks/security-stack';
import { StorageStack } from '../lib/stacks/storage-stack';
import { IngestionStack } from '../lib/stacks/ingestion-stack';
import { IdentityStack } from '../lib/stacks/identity-stack';
import { AnalyticsStack } from '../lib/stacks/analytics-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { DashboardStack } from '../lib/stacks/dashboard-stack';
import { MonitoringStack } from '../lib/stacks/monitoring-stack';

const app = new cdk.App();

// Load and validate config at synth time — fails fast with actionable errors
const configPath = app.node.tryGetContext('configPath') ?? path.join(__dirname, '..', 'config.yaml');
const config = loadAndValidateConfig(configPath);

const { solutionName, environment, tags } = config.deployment;

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Common stack props shared by all stacks
const commonProps: cdk.StackProps = { env };

// ── 1. Network_Stack (no dependencies) ───────────────────────────────────────
const networkStack = new NetworkStack(app, `${solutionName}-network`, {
  ...commonProps,
  stackName: `${solutionName}-network`,
  config,
});

// ── 2. Security_Stack (depends on NetworkStack) ───────────────────────────────
const securityStack = new SecurityStack(app, `${solutionName}-security`, {
  ...commonProps,
  stackName: `${solutionName}-security`,
  config,
  vpc: networkStack.vpc,
});
securityStack.addDependency(networkStack);

// ── 3. Storage_Stack (depends on SecurityStack) ───────────────────────────────
const storageStack = new StorageStack(app, `${solutionName}-storage`, {
  ...commonProps,
  stackName: `${solutionName}-storage`,
  config,
  cmk: securityStack.cmk,
});
storageStack.addDependency(securityStack);

// ── 4. Ingestion_Stack (depends on StorageStack, NetworkStack) ────────────────
const ingestionStack = new IngestionStack(app, `${solutionName}-ingestion`, {
  ...commonProps,
  stackName: `${solutionName}-ingestion`,
  config,
  vpc: networkStack.vpc,
  privateSubnets: networkStack.privateSubnets,
  lambdaSecurityGroup: networkStack.lambdaSecurityGroup,
  cmk: securityStack.cmk,
  rawLogsBucket: storageStack.rawLogsBucket,
  processedDataBucket: storageStack.processedDataBucket,
  failedRecordsBucket: storageStack.failedRecordsBucket,
  idempotencyTable: storageStack.idempotencyTable,
  curBucketName: config.dataExports.curBucketName,
});
ingestionStack.addDependency(storageStack);
ingestionStack.addDependency(networkStack);

// ── 5. Identity_Stack (depends on StorageStack, NetworkStack) ─────────────────
const identityStack = new IdentityStack(app, `${solutionName}-identity`, {
  ...commonProps,
  stackName: `${solutionName}-identity`,
  config,
  vpc: networkStack.vpc,
  privateSubnets: networkStack.privateSubnets,
  lambdaSecurityGroup: networkStack.lambdaSecurityGroup,
  cmk: securityStack.cmk,
  identityCacheTable: storageStack.identityCacheTable,
});
identityStack.addDependency(storageStack);
identityStack.addDependency(networkStack);

// ── 6. Analytics_Stack (depends on StorageStack) ─────────────────────────────
const analyticsStack = new AnalyticsStack(app, `${solutionName}-analytics`, {
  ...commonProps,
  stackName: `${solutionName}-analytics`,
  config,
  cmk: securityStack.cmk,
  processedDataBucket: storageStack.processedDataBucket,
});
analyticsStack.addDependency(storageStack);

// ── 7. Dashboard_Stack (depends on AnalyticsStack) ────────────────────────────
// Created before ApiStack so refreshLambda can be passed to ApiStack.
const dashboardStack = new DashboardStack(app, `${solutionName}-dashboard`, {
  ...commonProps,
  stackName: `${solutionName}-dashboard`,
  config,
  cmk: securityStack.cmk,
  processedDataBucket: storageStack.processedDataBucket,
  analyticsStack,
  invocationProcessorArn: ingestionStack.invocationProcessor.functionArn,
  metricsCollectorArn: ingestionStack.metricsCollector.functionArn,
});
dashboardStack.addDependency(analyticsStack);
dashboardStack.addDependency(ingestionStack);

// ── 8. Api_Stack (depends on StorageStack, NetworkStack, DashboardStack) ──────
const apiStack = new ApiStack(app, `${solutionName}-api`, {
  ...commonProps,
  stackName: `${solutionName}-api`,
  config,
  vpc: networkStack.vpc,
  apiGatewaySecurityGroup: networkStack.apiGatewaySecurityGroup,
  vpcEndpointSecurityGroup: networkStack.vpcEndpointSecurityGroup,
  cmk: securityStack.cmk,
  runtimeConfigTable: storageStack.runtimeConfigTable,
  refreshLambda: dashboardStack.refreshLambda,
});
apiStack.addDependency(storageStack);
apiStack.addDependency(networkStack);
// DashboardStack must be created before ApiStack to provide the refreshLambda prop
apiStack.addDependency(dashboardStack);

// ── 9. Monitoring_Stack (depends on all other stacks) ────────────────────────
//
// Collect all DLQs and Lambda functions from the ingestion and identity
// stacks so the Monitoring_Stack can create alarms for each.
const allDlqs = [
  ingestionStack.invocationDlq,
  ingestionStack.cloudTrailDlq,
  ingestionStack.metricsDlq,
  ingestionStack.curProcessorDlq,
  ingestionStack.costReconcilerDlq,
  ...(dashboardStack.refreshDlq ? [dashboardStack.refreshDlq] : []),
];

const allLambdaFunctions = [
  ingestionStack.invocationProcessor,
  ingestionStack.cloudTrailProcessor,
  ingestionStack.metricsCollector,
  ingestionStack.curProcessor,
  ingestionStack.costReconciler,
  identityStack.identityResolver,
  ...(dashboardStack.refreshLambda ? [dashboardStack.refreshLambda] : []),
];

const monitoringStack = new MonitoringStack(app, `${solutionName}-monitoring`, {
  ...commonProps,
  stackName: `${solutionName}-monitoring`,
  config,
  cmk: securityStack.cmk,
  dlqs: allDlqs,
  lambdaFunctions: allLambdaFunctions,
});
monitoringStack.addDependency(ingestionStack);
monitoringStack.addDependency(identityStack);
monitoringStack.addDependency(analyticsStack);
monitoringStack.addDependency(apiStack);
monitoringStack.addDependency(dashboardStack);

// ── Wire Invocation_Processor and CloudTrail_Processor to Identity_Resolver ──
//
// Grant the ingestion processors permission to invoke the Identity_Resolver
// Lambda so they can resolve caller identities during record processing.
identityStack.identityResolver.grantInvoke(ingestionStack.invocationProcessor);
identityStack.identityResolver.grantInvoke(ingestionStack.cloudTrailProcessor);

// Pass the Identity_Resolver ARN as an environment variable so the processors
// know which function to call at runtime.
ingestionStack.invocationProcessor.addEnvironment(
  'IDENTITY_RESOLVER_ARN',
  identityStack.identityResolver.functionArn,
);
ingestionStack.cloudTrailProcessor.addEnvironment(
  'IDENTITY_RESOLVER_ARN',
  identityStack.identityResolver.functionArn,
);

// ── Apply tags from config to all stacks ─────────────────────────────────────
//
// Tags from config.deployment.tags are applied to every resource in the app.
// Additionally, SolutionName and Environment tags are always applied.
const commonTags: Record<string, string> = {
  SolutionName: solutionName,
  Environment: environment,
  ...(tags ?? {}),
};

Object.entries(commonTags).forEach(([key, value]) => {
  cdk.Tags.of(app).add(key, value);
});

app.synth();
