# Bedrock Usage Intelligence Platform

A comprehensive AWS CDK solution for tracking, attributing, and visualizing Amazon Bedrock LLM usage and costs across AWS accounts and regions. Cost data is sourced from AWS Data Exports (CUR 2.0) and attributed to individual users via proportional token-based reconciliation.

## Features

- **Per-user cost attribution** — Automatically attributes Bedrock costs to individual IAM users/roles using CUR data and proportional token-based reconciliation
- **Multi-model support** — Tracks usage across all Bedrock models including Claude, Nova, Llama, Titan, Jamba, and more
- **Cross-region inference** — Handles global and geo cross-region inference profiles with correct cost attribution
- **QuickSight dashboards** — Four-page dashboard with Executive Summary, Cost & Usage, Performance, and Service Quota Prep views
- **Multi-account & multi-region** — Aggregate usage data across AWS accounts and regions
- **Identity resolution** — Maps IAM role sessions to human-readable usernames via IAM or SSO/Identity Center
- **Fully VPC-contained** — All Lambda functions run inside a VPC with no internet dependency for core operations
- **Infrastructure as Code** — Entire solution deployed via AWS CDK with a single configuration file

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Data Sources                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │   Bedrock     │  │  CloudTrail  │  │  AWS Data Exports (CUR)  │  │
│  │  Invocation   │  │   Events     │  │    Cost & Usage Report   │  │
│  │    Logs       │  │              │  │                          │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘  │
│         │                  │                       │                 │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌────────────▼─────────────┐  │
│  │  Invocation   │  │  CloudTrail  │  │     CUR Processor        │  │
│  │  Processor    │  │  Processor   │  │     Lambda               │  │
│  │  Lambda       │  │  Lambda      │  │                          │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘  │
│         │                  │                       │                 │
│         ▼                  ▼                       ▼                 │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              S3 Processed Data Bucket (Parquet)              │    │
│  │  invocation-logs/  cloudtrail-events/  cur-costs/           │    │
│  └─────────────────────────┬───────────────────────────────────┘    │
│                             │                                        │
│                    ┌────────▼────────┐                               │
│                    │ Cost Reconciler  │  (runs every 6 hours)        │
│                    │ Lambda           │                               │
│                    └────────┬────────┘                               │
│                             │                                        │
│                    ┌────────▼────────┐                               │
│                    │ reconciled-costs │                               │
│                    │ (Parquet)        │                               │
│                    └────────┬────────┘                               │
│                             │                                        │
│              ┌──────────────▼──────────────┐                        │
│              │  Glue Catalog + Athena       │                        │
│              │  QuickSight Dashboard        │                        │
│              └─────────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

### Required

1. **Node.js 22 LTS** — `node --version` should show `v22.x.x`
2. **AWS CDK v2** — Install globally: `npm install -g aws-cdk`
3. **AWS CLI** — Configured with credentials that have admin access to the target account
4. **AWS Data Exports (CUR 2.0)** — A Data Export must be configured in the AWS Billing console to deliver Cost and Usage Report data to an S3 bucket. See [Data Exports Setup](#data-exports-setup) below.

### Optional

5. **Amazon QuickSight** — Required only if deploying the dashboard (`enableQuickSuite: true`). Must be activated in the AWS console with at least one Author user before deploying.
6. **IAM Identity Center** — Required only if using SSO identity resolution (`identityMode: "sso"` or `"auto"`).

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/bedrock-usage-intelligence.git
cd bedrock-usage-intelligence

# 2. Install dependencies
npm install

# 3. Configure the solution
#    Edit config.yaml with your settings (at minimum, set curBucketName)
cp config.yaml config.yaml.backup
nano config.yaml

# 4. Verify TypeScript compiles
npm run build

# 5. Synthesize CloudFormation templates (validates config)
npx cdk synth

# 6. Deploy all stacks
npx cdk deploy --all

# 7. (Optional) Run post-deployment encryption script
bash scripts/enable-cloudwatch-logs-encryption.sh \
  --cmk-arn <CMK_ARN_FROM_DEPLOY_OUTPUT> \
  --solution-name bedrock-usage-intel
```

## Data Exports Setup

The platform uses AWS Data Exports (CUR 2.0) as the authoritative source for Bedrock cost data.

### Step 1: Create a Data Export

1. Open the [AWS Billing Data Exports console](https://console.aws.amazon.com/billing/home#/dataexports)
2. Click **Create export**
3. Configure:
   - **Export type**: Cost and Usage Report 2.0
   - **Time granularity**: Daily
   - **Include resource IDs**: Yes
   - **S3 bucket**: Choose or create a bucket (this becomes `curBucketName` in config)
   - **S3 prefix**: Optional prefix (this becomes `curReportPrefix` in config)
   - **Format**: CSV (default) or Parquet
4. Click **Create**

### Step 2: Update Configuration

Set the `dataExports` section in `config.yaml`:

```yaml
dataExports:
  curBucketName: "your-cur-exports-bucket"
  curReportPrefix: "your-prefix/data"       # match the S3 prefix from Step 1
  curReportFormat: "csv"                     # or "parquet"
  reconciliationSchedule: "rate(6 hours)"    # how often to reconcile costs
```

### Step 3: Deploy

The CDK deployment automatically creates IAM permissions for the CUR Processor Lambda to read from the CUR bucket.

## Configuration Reference

All configuration is in `config.yaml`. Below is a complete reference of every option.

### VPC Configuration (`vpc`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vpcMode` | `"create"` \| `"existing"` | required | Create a new VPC or import an existing one |
| `vpcCidr` | string | `"10.0.0.0/16"` | CIDR block for the new VPC (only when `vpcMode: "create"`) |
| `existingVpcId` | string | — | VPC ID to import (only when `vpcMode: "existing"`, must match `vpc-[a-z0-9]+`) |
| `enableNatGateway` | boolean | `false` | Deploy a NAT Gateway for internet access. Only needed if you have other integrations requiring internet. |
| `vpcEndpointMode` | `"minimal"` \| `"full"` | `"minimal"` | **minimal**: S3, DynamoDB gateway + STS, KMS, CloudWatch Logs interface endpoints. **full**: adds Lambda, SNS, SQS, Glue, Athena, Identity Store, Bedrock, CloudTrail, EventBridge interface endpoints. |

### Account Configuration (`account`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `accountMode` | `"single"` \| `"multi"` | required | Single-account or multi-account deployment |
| `sourceAccountIds` | string[] | — | List of 12-digit AWS account IDs (only when `accountMode: "multi"`) |
| `organizationId` | string | — | AWS Organization ID (e.g., `o-abc1234567`). Uses `aws:PrincipalOrgID` condition instead of enumerating accounts. |

### Region Configuration (`region`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `regionMode` | `"single"` \| `"multi"` | required | Single-region or multi-region deployment |
| `sourceRegions` | string[] | — | List of AWS region codes (only when `regionMode: "multi"`, e.g., `["us-east-1", "us-west-2"]`) |

### Identity Configuration (`identity`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `identityMode` | `"iam"` \| `"sso"` \| `"auto"` | required | **iam**: resolve IAM principal ARNs only. **sso**: map IAM role sessions to SSO users via Identity Center. **auto**: try SSO first, fall back to IAM. |
| `identityStoreId` | string | — | IAM Identity Center store ID (required for `sso` and `auto` modes, must match `d-[a-z0-9]+`) |

### Data Exports Configuration (`dataExports`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `curBucketName` | string | required | S3 bucket name where AWS Data Exports delivers CUR files |
| `curReportPrefix` | string | — | S3 key prefix for CUR files (e.g., `"cur-reports"` or `"BedrockUsage/data"`) |
| `curReportFormat` | `"csv"` \| `"parquet"` | `"csv"` | Format of the CUR files |
| `reconciliationSchedule` | string | `"rate(6 hours)"` | EventBridge schedule expression for cost reconciliation frequency |

### Dashboard Configuration (`dashboard`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enableQuickSuite` | boolean | `false` | Deploy QuickSight dashboard, analysis, datasets, and SPICE refresh |
| `quickSuiteEdition` | `"STANDARD"` \| `"ENTERPRISE"` | — | QuickSight edition. Enterprise adds row-level security. |
| `quickSightPrincipalArn` | string | — | QuickSight user/group ARN for dashboard permissions (required when `enableQuickSuite: true`) |

### CloudTrail Configuration (`cloudTrail`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cloudTrailMode` | `"create"` \| `"existing"` | required | Create a new CloudTrail trail or use an existing one |
| `existingCloudTrailBucket` | string | — | S3 bucket name of existing CloudTrail logs (only when `cloudTrailMode: "existing"`) |

### Deployment Configuration (`deployment`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `solutionName` | string | `"bedrock-usage-intel"` | Prefix for all AWS resource names |
| `environment` | `"dev"` \| `"staging"` \| `"production"` | `"dev"` | Controls S3 lifecycle policies: dev (90d expire), staging (Glacier 180d), production (Glacier 365d) |
| `tags` | Record<string, string> | — | Custom tags applied to all resources |

### Top-Level Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enableInvocationLogging` | boolean | `true` | Automatically enable Bedrock Model Invocation Logging via a Custom Resource during deployment |


## Deployed Stacks

The solution deploys 9 CloudFormation stacks in dependency order:

| # | Stack | Description |
|---|-------|-------------|
| 1 | **Network** | VPC, subnets, security groups, VPC endpoints |
| 2 | **Security** | KMS CMK for encryption at rest |
| 3 | **Storage** | S3 buckets (raw logs, processed data, failed records), DynamoDB tables (runtime config, identity cache, idempotency) |
| 4 | **Ingestion** | Invocation Processor, CloudTrail Processor, Metrics Collector, CUR Processor, Cost Reconciler Lambdas with S3/EventBridge triggers |
| 5 | **Identity** | Identity Resolver Lambda for IAM/SSO user resolution |
| 6 | **Analytics** | Glue database, Glue tables (invocation_logs, cloudtrail_events, metrics, cur_costs, reconciled_costs, model_billing_map), Athena workgroup, QuickSight datasets |
| 7 | **Dashboard** | QuickSight dashboard, analysis, SPICE refresh Lambda (conditional on `enableQuickSuite`) |
| 8 | **API** | API Gateway REST API for admin operations and dashboard refresh |
| 9 | **Monitoring** | SNS alarm topic, CloudWatch alarms (DLQ, Lambda errors, CUR processing, reconciliation staleness, cost mismatches) |

## Cost Attribution Pipeline

The platform uses a three-phase approach:

### Phase 1: Invocation Processing
The Invocation Processor Lambda processes Bedrock invocation logs from S3, extracts usage metadata (tokens, model, user identity, latency), and writes records with `costStatus: 'pending'` and zero cost fields. Costs are not computed at ingestion time.

### Phase 2: CUR Ingestion
The CUR Processor Lambda ingests AWS Data Exports (CUR 2.0) files, filters for `AmazonBedrockService` line items, parses the `usage_type` field to extract region, model, token type, and cross-region information, and writes processed cost records to the `cur_costs` Glue table.

### Phase 3: Cost Reconciliation
The Cost Reconciler Lambda runs on a schedule (default: every 6 hours) and joins CUR cost data with invocation logs to compute per-user costs using proportional attribution:

```
user_cost = (user_tokens / total_tokens_in_bucket) × cur_unblended_cost
```

Where a "bucket" is a unique combination of `(account, region, model, token_type, cross_region_type, day)`.

### Reconciliation Lifecycle

| Status | Description |
|--------|-------------|
| `pending` | Record written by invocation processor; no CUR data matched yet |
| `estimated` | Costs estimated using cached rates (when CUR data is delayed) |
| `reconciled` | Costs matched to authoritative CUR line items |
| `unmatched` | No corresponding CUR line item found after the reconciliation window |

## Dashboard Pages

When `enableQuickSuite: true`, the platform deploys a QuickSight dashboard with four pages:

### Executive Summary
- Total Invocations, Total Cost, Unique Users, Avg Latency, Error Rate KPIs
- Daily Token Usage (Input vs Output) line chart
- Daily Invocations & Cost Trend
- Top 10 Users table with conditional formatting (red when cost ≥ $100)

### Cost & Usage
- Cost by Model (Input vs Output) stacked bar chart
- Cost Heat Map (Model × Day)
- Token Usage Trends area chart
- Cost by User donut chart
- Reconciliation Status breakdown
- User × Model pivot table

### Performance
- Avg Latency and P99 Latency KPIs
- Latency by Model (Avg vs P99) combo chart
- Latency vs Token Count by Model scatter plot
- Model filter dropdown

### Service Quota Prep
- Steady State TPM/RPM KPIs
- Peak State TPM/RPM KPIs
- Avg Input/Output Tokens KPIs
- Model filter dropdown

## Monitoring & Alarms

| Alarm | Description |
|-------|-------------|
| DLQ Alarms | Fires when any Dead Letter Queue has messages |
| Lambda Error Alarms | Fires when any Lambda function has errors |
| CUR Processor Errors | Fires when the CUR Processor encounters errors |
| Reconciliation Staleness | Fires if no reconciliation has run in >24 hours |
| CUR Data Missing | Fires if no new CUR data has arrived in >48 hours |
| Reconciliation Mismatch | Fires if attributed cost totals differ from CUR totals by >5% |
| Unmapped Billing Name | Fires when the CUR Processor encounters an unknown Bedrock billing name |
| Circuit Breaker | Fires when the Identity Resolver circuit breaker opens |
| Identity Cache Miss | Fires when identity cache miss rate exceeds 50% |

## Querying Data

Open the Athena console, select the workgroup, and set the database. Example queries:

```sql
-- Per-user cost breakdown
SELECT resolvedusername, modelid,
       SUM(inputtokens) AS input_tokens,
       SUM(outputtokens) AS output_tokens,
       SUM(totalcost) AS total_cost
FROM invocation_logs
WHERE year = '2026'
GROUP BY resolvedusername, modelid
ORDER BY total_cost DESC;

-- Daily cost by model from CUR reconciliation
SELECT usage_date, model_id,
       SUM(attributed_cost) AS cost,
       reconciliation_status
FROM reconciled_costs
WHERE year = '2026'
GROUP BY usage_date, model_id, reconciliation_status
ORDER BY usage_date;

-- Reconciliation status breakdown
SELECT reconciliation_status,
       COUNT(*) AS records,
       SUM(attributed_cost) AS total_cost
FROM reconciled_costs
GROUP BY reconciliation_status;

-- Model performance metrics
SELECT modelid,
       SUM(invocationcount) AS invocations,
       AVG(invocationlatencyavg) AS avg_latency_ms,
       AVG(invocationlatencyp99) AS p99_latency_ms
FROM metrics
WHERE invocationcount > 0
GROUP BY modelid
ORDER BY invocations DESC;
```

## Testing

```bash
# Run all tests
npm test

# Run specific test suites
npx jest test/unit/          --no-coverage   # Unit tests
npx jest test/property/      --no-coverage   # Property-based tests
npx jest test/integration/   --no-coverage   # Integration tests

# Run with coverage
npx jest --coverage
```

## Project Structure

```
bin/app.ts                          — CDK app entry point
config.yaml                         — Deployment configuration
lib/
  config/
    schema.ts                       — Zod configuration schema with validation
    validator.ts                    — YAML config loader and validator
  stacks/
    network-stack.ts                — VPC, subnets, security groups, endpoints
    security-stack.ts               — KMS CMK
    storage-stack.ts                — S3 buckets, DynamoDB tables
    ingestion-stack.ts              — Lambda functions, S3/EventBridge triggers
    identity-stack.ts               — Identity Resolver Lambda
    analytics-stack.ts              — Glue catalog, Athena, QuickSight datasets
    dashboard-stack.ts              — QuickSight dashboard and analysis
    dashboard-visuals.ts            — Visual definitions (programmatic)
    customized-dashboard-definition.json — Dashboard definition (exported snapshot)
    monitoring-stack.ts             — CloudWatch alarms, SNS topic
    api-stack.ts                    — API Gateway REST API
  handlers/
    invocation-processor/           — Processes Bedrock invocation logs from S3
    cloudtrail-processor/           — Processes CloudTrail Bedrock events
    metrics-collector/              — Collects CloudWatch metrics every 5 minutes
    cur-processor/                  — Ingests CUR 2.0 files, parses usage_type
    cost-reconciler/                — Proportional cost attribution from CUR data
    identity-resolver/              — Resolves IAM/SSO identities
    dashboard-refresh/              — SPICE dataset refresh trigger
    logging-bootstrap/              — Enables Bedrock invocation logging
    admin-api/                      — Admin API handler
    qs-account-validator/           — QuickSight account validation
  shared/
    constants.ts                    — Runtime constants
    cdk-constants.ts                — CDK-specific constants
    cur-types.ts                    — CUR and reconciliation type definitions
    pricing-types.ts                — Pricing dimension types
    parquet-writer.ts               — Parquet serialization
    s3-partitioner.ts               — Hive-style S3 path generation
    idempotency.ts                  — DynamoDB idempotency checker
    circuit-breaker.ts              — Circuit breaker pattern
    rate-limiter.ts                 — Rate limiter
scripts/
  enable-cloudwatch-logs-encryption.sh  — Post-deployment log encryption
  verify-deployment.sh                  — Deployment verification
  reprocess-logs.py                     — Reprocess invocation logs
templates/
  source-account-setup.yaml             — CloudFormation for multi-account setup
test/
  unit/                                 — Unit tests
  property/                             — Property-based tests (fast-check)
  integration/                          — Integration tests
```

## Estimated Monthly Costs

| Tier | Profile | Monthly Cost |
|------|---------|-------------|
| **Small** (Dev/POC) | 500 invocations/day, no QuickSight | ~$46/month |
| **Medium** (Team) | 10K invocations/day, QuickSight Standard | ~$116/month |
| **Large** (Enterprise) | 100K invocations/day, QuickSight Enterprise, multi-account | ~$469/month |

The dominant cost driver is VPC interface endpoints (~$44/month for minimal mode). See `PRICING_ESTIMATES.md` for detailed breakdowns.

## Troubleshooting

### CDK synth fails with config validation error
Check that `config.yaml` has all required fields. At minimum: `vpc.vpcMode`, `account.accountMode`, `region.regionMode`, `identity.identityMode`, `dataExports.curBucketName`, `cloudTrail.cloudTrailMode`.

### QuickSight dashboard shows no data
1. Verify SPICE refresh has completed: check the QuickSight console for dataset ingestion status
2. Verify invocation logs exist: `aws s3 ls s3://BUCKET/invocation-logs/ --recursive | head`
3. Trigger a manual SPICE refresh via the Admin API or QuickSight console

### Cost shows $0 on dashboard
1. Verify CUR data has been delivered to the CUR bucket
2. Check CUR Processor logs: `aws logs filter-log-events --log-group-name /aws/lambda/SOLUTION-cur-processor --filter-pattern "CUR processing complete"`
3. Check Cost Reconciler logs: `aws logs filter-log-events --log-group-name /aws/lambda/SOLUTION-cost-reconciler --filter-pattern "Cost reconciliation complete"`
4. Verify reconciled_costs table has data: query via Athena

### Reconciliation shows "unmatched" records
This means CUR line items exist but no corresponding invocation logs were found. Common causes:
- CUR billing name not in the model mapping (check for "Unmapped CUR billing name" warnings in CUR Processor logs)
- Invocation logs haven't been processed yet for that date
- Cross-region inference profile detection mismatch

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
