# Bedrock Usage Intelligence Platform — Pricing Estimates (us-east-1)

> **Last Updated:** February 2026
> **Region:** US East (N. Virginia) — us-east-1
> **Disclaimer:** All prices are based on publicly available AWS pricing pages as of February 2026. Actual costs may vary. Prices exclude taxes and do not account for AWS Free Tier credits, Reserved Capacity, or Savings Plans unless noted. Always verify current pricing at [aws.amazon.com/pricing](https://aws.amazon.com/pricing).

---

## Table of Contents

1. [Usage Tiers Defined](#1-usage-tiers-defined)
2. [Service-by-Service Unit Pricing](#2-service-by-service-unit-pricing)
3. [Scenario A — Small (Dev/POC)](#3-scenario-a--small-devpoc)
4. [Scenario B — Medium (Team/Department)](#4-scenario-b--medium-teamdepartment)
5. [Scenario C — Large (Enterprise)](#5-scenario-c--large-enterprise)
6. [Optional Add-On Costs](#6-optional-add-on-costs)
7. [Cost Optimization Tips](#7-cost-optimization-tips)

---

## 1. Usage Tiers Defined

| Dimension | Small (Dev/POC) | Medium (Team) | Large (Enterprise) |
|---|---|---|---|
| Bedrock invocations/day | 500 | 10,000 | 100,000 |
| Bedrock invocations/month | ~15,000 | ~300,000 | ~3,000,000 |
| Avg log record size | 2 KB | 2 KB | 2 KB |
| Monthly raw log volume | ~30 MB | ~600 MB | ~6 GB |
| Monthly processed Parquet | ~10 MB | ~200 MB | ~2 GB |
| CloudTrail events/month | ~50,000 | ~1,000,000 | ~10,000,000 |
| Athena queries/month | 50 | 500 | 5,000 |
| Avg Athena scan per query | 10 MB | 50 MB | 200 MB |
| Dashboard users | 1 Author | 2 Authors, 5 Readers | 3 Authors, 20 Readers |
| Config mode | Single-account, single-region | Single-account, single-region | Multi-account, multi-region |
| VPC Endpoint mode | Minimal (3 interface) | Minimal (3 interface) | Full (14 interface) |
| NAT Gateway | No | No | Optional |
| QuickSight | No | Standard | Enterprise |

---

## 2. Service-by-Service Unit Pricing

All prices are for **us-east-1** (US East — N. Virginia).

### 2.1 AWS Lambda

Sources: [AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/)

| Component | Price |
|---|---|
| Requests | $0.20 per 1M requests |
| Compute (x86) | $0.0000166667 per GB-second |
| Free Tier | 1M requests + 400,000 GB-seconds/month |

**Platform Lambda functions (7 total):**
- Invocation Processor (512 MB, 5 min timeout)
- CloudTrail Processor (512 MB, 5 min timeout)
- Metrics Collector (512 MB, 5 min timeout)
- Identity Resolver (256 MB, 30s timeout)
- CUR Processor (512 MB, 5 min timeout)
- Cost Reconciler (512 MB, 5 min timeout)
- Admin API (256 MB, 30s timeout)
- Logging Bootstrap (one-time Custom Resource, negligible)

### 2.2 Amazon S3

Sources: [Amazon S3 Pricing](https://aws.amazon.com/s3/pricing/)

| Component | Price |
|---|---|
| S3 Standard storage (first 50 TB) | $0.023 per GB/month |
| S3 Standard-IA storage | $0.0125 per GB/month |
| S3 Glacier Flexible Retrieval | $0.0036 per GB/month |
| PUT, COPY, POST, LIST requests | $0.005 per 1,000 requests |
| GET, SELECT requests | $0.0004 per 1,000 requests |
| Free Tier | 5 GB Standard storage, 20,000 GET, 2,000 PUT/month (12 months) |

**Platform S3 buckets (3):** Raw Logs, Processed Data, Failed Records

### 2.3 Amazon DynamoDB (On-Demand)

Sources: [DynamoDB On-Demand Pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/)

| Component | Price |
|---|---|
| Write Request Units (WRU) | $1.25 per million |
| Read Request Units (RRU) | $0.25 per million |
| Storage | $0.25 per GB/month |
| Free Tier | 25 GB storage (always free) |

**Platform DynamoDB tables (3):** Runtime Config, Identity Cache, Idempotency

### 2.4 Amazon SQS

Sources: [Amazon SQS Pricing](https://aws.amazon.com/sqs/pricing/)

| Component | Price |
|---|---|
| Standard Queue requests | $0.40 per million (after first 1M free) |
| Free Tier | 1M requests/month (always free) |

**Platform SQS queues (5 DLQs):** Invocation DLQ, CloudTrail DLQ, Metrics DLQ, CUR Processor DLQ, Cost Reconciler DLQ

### 2.5 Amazon EventBridge

Sources: [Amazon EventBridge Pricing](https://aws.amazon.com/eventbridge/pricing/)

| Component | Price |
|---|---|
| Custom/Partner events | $1.00 per million events |
| Scheduled rules | Free (you pay for targets invoked) |

**Platform rules (3):** Metrics Collector (every 5 min), CUR Processor (every 6 hours), Cost Reconciler (every 6 hours)

### 2.6 AWS KMS

Sources: [AWS KMS Pricing](https://aws.amazon.com/kms/pricing/)

| Component | Price |
|---|---|
| Customer Managed Key (CMK) | $1.00 per key/month |
| Symmetric API requests | $0.03 per 10,000 requests |
| Free Tier | 20,000 requests/month |

**Platform CMK:** 1 key shared across all resources

### 2.7 Amazon Athena

Sources: [Amazon Athena Pricing](https://aws.amazon.com/athena/pricing/)

| Component | Price |
|---|---|
| Data scanned | $5.00 per TB scanned |
| Minimum per query | 10 MB |
| DDL statements | Free |

### 2.8 AWS Glue Data Catalog

Sources: [AWS Glue Pricing](https://aws.amazon.com/glue/pricing/)

| Component | Price |
|---|---|
| Storage (first 1M objects) | Free |
| Storage (above 1M objects) | $1.00 per 100,000 objects/month |
| Requests (first 1M) | Free |
| Requests (above 1M) | $1.00 per million requests |

**Platform Glue resources:** 1 database, 7 tables (invocation_logs, cloudtrail_events, cur_costs, reconciled_costs, model_billing_map, and 2 more) — well within free tier

### 2.9 VPC Interface Endpoints (AWS PrivateLink)

Sources: [AWS PrivateLink Pricing](https://aws.amazon.com/privatelink/pricing/)

| Component | Price |
|---|---|
| Per endpoint per AZ per hour | $0.01 |
| Data processed per GB | $0.01 (first 1 PB) |
| Gateway endpoints (S3, DynamoDB) | Free |

**Minimal mode (3 interface endpoints × 2 AZs):** STS, KMS, CloudWatch Logs
**Full mode (14 interface endpoints × 2 AZs):** + Lambda, SNS, SQS, Glue, Athena, Identity Store, Bedrock, Bedrock Runtime, CloudTrail, EventBridge, and more

### 2.10 NAT Gateway (Optional)

Sources: [Amazon VPC Pricing](https://aws.amazon.com/vpc/pricing/)

| Component | Price |
|---|---|
| Per NAT Gateway per hour | $0.045 |
| Data processed per GB | $0.045 |

Only required for enterprise deployments needing internet access for other integrations. No longer required for pricing data — CUR data is delivered via S3.

### 2.11 Amazon SNS

Sources: [Amazon SNS Pricing](https://aws.amazon.com/sns/pricing/)

| Component | Price |
|---|---|
| Publishes (first 1M) | Free |
| Publishes (above 1M) | $0.50 per million |
| Email notifications | $2.00 per 100,000 |

**Platform SNS topic:** 1 alarm topic

### 2.12 Amazon CloudWatch

Sources: [Amazon CloudWatch Pricing](https://aws.amazon.com/cloudwatch/pricing/)

| Component | Price |
|---|---|
| Log ingestion | $0.50 per GB |
| Log storage | $0.03 per GB/month |
| Standard metrics | Free (up to 10 detailed) |
| Custom metrics | $0.30 per metric/month |
| Standard alarms | $0.10 per alarm/month |
| Free Tier | 5 GB log ingestion, 10 custom metrics, 10 alarms |

**Platform alarms (~10-12):** DLQ alarms, Lambda error alarms, circuit breaker, CUR processor errors, reconciliation staleness, CUR data missing, reconciliation mismatch, unmapped billing names, cache miss

### 2.13 AWS CloudTrail

Sources: [AWS CloudTrail Pricing](https://aws.amazon.com/cloudtrail/pricing/)

| Component | Price |
|---|---|
| First copy of management events to S3 | Free |
| Additional copies of management events | $2.00 per 100,000 events |
| Data events delivered to S3 | $0.10 per 100,000 events |

Only applies when `cloudTrailMode: "create"`. When using `"existing"`, CloudTrail costs are already part of your existing infrastructure.

### 2.14 API Gateway (REST, Private)

Sources: [Amazon API Gateway Pricing](https://aws.amazon.com/api-gateway/pricing/)

| Component | Price |
|---|---|
| REST API calls (first 333M) | $3.50 per million |
| Free Tier | 1M REST API calls/month (12 months) |

**Platform API:** 1 private REST API for Admin operations

### 2.15 Amazon QuickSight (Optional)

Sources: [Amazon QuickSight Pricing](https://aws.amazon.com/quick/quicksight/pricing/)

| Component | Standard | Enterprise |
|---|---|---|
| Author | $24/user/month | $24/user/month |
| Author Pro | $40/user/month | $40/user/month |
| Reader | $3/user/month | $3/user/month |
| SPICE capacity (included) | 10 GB per Author | 10 GB per Author |
| Additional SPICE | $0.38 per GB/month | $0.38 per GB/month |

---

## 3. Scenario A — Small (Dev/POC)

**Profile:** Single developer, 500 Bedrock invocations/day, no QuickSight, minimal VPC endpoints, existing CloudTrail.

| Service | Calculation | Monthly Cost |
|---|---|---|
| **Lambda** | ~15K invocations across all functions, ~50K total requests (incl. metrics collector 8,640/mo, CUR processor ~30/mo, cost reconciler ~120/mo). Well within free tier. | $0.00 |
| **S3 Storage** | ~50 MB across 3 buckets | $0.00 |
| **S3 Requests** | ~30K PUT + 15K GET | $0.16 |
| **DynamoDB** | ~60K writes + ~120K reads/month, <1 GB storage. Within free tier. | $0.00 |
| **SQS (DLQs)** | Minimal messages (error cases only) | $0.00 |
| **EventBridge** | 3 scheduled rules, targets are Lambda (free) | $0.00 |
| **KMS** | 1 CMK + ~50K API requests | $1.09 |
| **VPC Endpoints** | 3 interface × 2 AZs × 730 hrs = 4,380 endpoint-hours | $43.80 |
| **CloudWatch Logs** | ~500 MB ingestion, ~500 MB storage | $0.27 |
| **CloudWatch Alarms** | ~10 standard alarms | $1.00 |
| **Athena** | 50 dashboard queries × 10 MB + 120 reconciliation queries × 50 MB = 6.5 GB scanned | $0.03 |
| **Glue Catalog** | 1 DB + 7 tables, <1M requests | $0.00 |
| **API Gateway** | ~100 admin API calls | $0.00 |
| **CloudTrail** | Existing (no additional cost) | $0.00 |
| **NAT Gateway** | Not deployed | $0.00 |
| **QuickSight** | Not deployed | $0.00 |
| | | |
| **TOTAL** | | **~$46/month** |

> The dominant cost is VPC interface endpoints. This is the baseline infrastructure cost regardless of usage volume.

---

## 4. Scenario B — Medium (Team/Department)

**Profile:** 10,000 Bedrock invocations/day, QuickSight Standard (2 Authors + 5 Readers), minimal VPC endpoints, existing CloudTrail.

| Service | Calculation | Monthly Cost |
|---|---|---|
| **Lambda** | ~300K invocations + metrics collector (8,640) + CUR processor (~30) + cost reconciler (~120) + admin API (~1K). Total ~310K requests. Compute: ~310K × avg 2s × 0.5 GB = 310K GB-s. After free tier: ~0 requests charge, ~0 compute (within free tier for small durations). Realistic: most invocations are <1s avg. | $0.00 |
| **S3 Storage** | ~1 GB across 3 buckets + Athena results | $0.02 |
| **S3 Requests** | ~600K PUT + ~300K GET | $3.12 |
| **DynamoDB** | ~1.2M writes + ~2.4M reads/month, ~2 GB storage | $2.10 |
| **SQS (DLQs)** | Minimal | $0.00 |
| **EventBridge** | 3 scheduled rules | $0.00 |
| **KMS** | 1 CMK + ~500K API requests | $1.44 |
| **VPC Endpoints** | 3 interface × 2 AZs × 730 hrs | $43.80 |
| **CloudWatch Logs** | ~2 GB ingestion, ~2 GB storage | $1.06 |
| **CloudWatch Alarms** | ~10 standard alarms | $1.00 |
| **Athena** | 500 dashboard queries × 50 MB + 120 reconciliation queries × 50 MB = 31 GB scanned | $0.16 |
| **Glue Catalog** | Within free tier | $0.00 |
| **API Gateway** | ~5K admin API calls | $0.02 |
| **CloudTrail** | Existing | $0.00 |
| **NAT Gateway** | Not deployed | $0.00 |
| **QuickSight** | 2 Authors × $24 + 5 Readers × $3 | $63.00 |
| **SPICE** | ~1 GB (within 20 GB included with 2 Authors) | $0.00 |
| | | |
| **TOTAL** | | **~$116/month** |

---

## 5. Scenario C — Large (Enterprise)

**Profile:** 100,000 Bedrock invocations/day, multi-account, multi-region, QuickSight Enterprise (3 Authors + 20 Readers), full VPC endpoints, existing CloudTrail.

| Service | Calculation | Monthly Cost |
|---|---|---|
| **Lambda** | ~3M invocations + metrics (8,640) + CUR processor (~30) + cost reconciler (~120) + admin (~10K) + identity resolver (~3M). Total ~6M requests. Compute: ~6M × avg 1s × 0.5 GB = 3M GB-s. After free tier: 5M requests × $0.20/M = $1.00. 2.6M GB-s × $0.0000166667 = $43.33. | $44.33 |
| **S3 Storage** | ~10 GB across 3 buckets + Athena results + CUR cost data. With lifecycle (IA after 90d): ~$0.15 | $0.23 |
| **S3 Requests** | ~6M PUT + ~3M GET | $31.20 |
| **DynamoDB** | ~12M writes + ~24M reads/month, ~10 GB storage | $21.00 |
| **SQS (DLQs)** | ~50K messages (error cases) | $0.00 |
| **EventBridge** | 3 scheduled rules | $0.00 |
| **KMS** | 1 CMK + ~5M API requests | $14.00 |
| **VPC Endpoints** | 14 interface × 2 AZs × 730 hrs = 20,440 endpoint-hours | $204.40 |
| **CloudWatch Logs** | ~10 GB ingestion, ~10 GB storage | $5.30 |
| **CloudWatch Alarms** | ~12 standard alarms | $1.20 |
| **Athena** | 5,000 dashboard queries × 200 MB + 120 reconciliation queries × 50 MB = 1.006 TB scanned | $5.03 |
| **Glue Catalog** | Within free tier | $0.00 |
| **API Gateway** | ~50K admin API calls | $0.18 |
| **CloudTrail** | New trail: 1st copy mgmt events free. Data events: 10M × $0.10/100K = $10.00 | $10.00 |
| **NAT Gateway** | Not deployed (no longer required for pricing) | $0.00 |
| **QuickSight** | 3 Authors × $24 + 20 Readers × $3 | $132.00 |
| **SPICE** | ~5 GB (within 30 GB included with 3 Authors) | $0.00 |
| | | |
| **TOTAL** | | **~$469/month** |

---

## 6. Optional Add-On Costs

These costs apply only when specific configuration options are enabled.

### 6.1 NAT Gateway (Optional — for internet access)

| Duration | Hourly Cost | Data Processing | Monthly Total |
|---|---|---|---|
| Always-on (730 hrs) | $32.85 | ~$0.05 (minimal data) | **~$32.90** |

> NAT Gateway is no longer required for pricing data collection. CUR data is delivered directly to S3 via AWS Data Exports. NAT Gateway may still be needed for other integrations requiring internet access.

### 6.2 QuickSight SPICE Overage

If your aggregated dataset exceeds the included SPICE capacity (10 GB per Author):

| Extra SPICE | Cost |
|---|---|
| 10 GB | $3.80/month |
| 50 GB | $19.00/month |
| 100 GB | $38.00/month |

### 6.3 Additional VPC Endpoints (Full Mode vs Minimal)

| Mode | Endpoints × AZs | Monthly Cost |
|---|---|---|
| Minimal (3 interface) | 3 × 2 = 6 | $43.80 |
| Full (14 interface) | 14 × 2 = 28 | $204.40 |
| **Delta** | | **+$160.60** |

### 6.4 Multi-Account CloudTrail (create mode)

Additional copies of management events across organization trails:

| Events/Month | Cost |
|---|---|
| 5M management events (additional copies) | $100.00 |
| 10M data events | $10.00 |

### 6.5 SSO/Identity Center Resolution

When `identityMode: "sso"` or `"auto"`, the Identity Resolver Lambda makes additional API calls to IAM Identity Center. These API calls are free, but the Lambda compute adds marginal cost (~$1-5/month depending on cache hit rate).

---

## 7. Cost Optimization Tips

### Biggest Cost Drivers (ranked)

1. **VPC Interface Endpoints** — $43.80-$204.40/month. This is the single largest fixed cost. Use `vpcEndpointMode: "minimal"` unless you need the full set.

2. **QuickSight Users** — $24/Author, $3/Reader. Only enable if you need dashboards. Athena queries via console/CLI are a free alternative for ad-hoc analysis.

3. **NAT Gateway** — $32.90/month fixed. No longer needed for pricing data (CUR is delivered via S3). Only deploy if you have other integrations requiring internet access.

4. **Lambda Compute** — Scales linearly with invocation volume. At enterprise scale, this becomes meaningful. Consider Graviton (Arm) for up to 34% better price-performance. CUR Processor and Cost Reconciler add minimal overhead (~150 invocations/month combined).

5. **KMS API Requests** — Every encrypt/decrypt operation across all services hits KMS. At high volume, this adds up. The 20K free tier requests/month helps at small scale.

### Recommendations by Tier

| Optimization | Small | Medium | Large |
|---|---|---|---|
| Use `vpcEndpointMode: "minimal"` | ✅ | ✅ | Consider |
| Skip QuickSight, use Athena directly | ✅ | Optional | — |
| Use `cloudTrailMode: "existing"` | ✅ | ✅ | ✅ |
| Use `spiceMode: "disabled"` (direct query) | — | ✅ | Optional |
| Enable S3 lifecycle policies | ✅ | ✅ | ✅ |
| Use Parquet + partition projection | ✅ (built-in) | ✅ (built-in) | ✅ (built-in) |

### Free Tier Coverage

For a **Small/Dev** deployment, the following services are effectively free:
- Lambda (1M requests + 400K GB-s/month)
- DynamoDB (25 GB storage, always free)
- S3 (5 GB storage, first 12 months)
- SQS (1M requests/month, always free)
- SNS (1M publishes/month)
- CloudWatch (5 GB log ingestion, 10 alarms)
- Glue Catalog (1M objects + 1M requests)
- KMS (20K requests/month)
- EventBridge scheduled rules (free)
- CloudTrail (first copy of management events)

---

## Summary Comparison

| | Small (Dev/POC) | Medium (Team) | Large (Enterprise) |
|---|---|---|---|
| **Monthly Cost** | **~$46** | **~$116** | **~$469** |
| **Annual Cost** | **~$552** | **~$1,392** | **~$5,628** |
| **Primary Cost Driver** | VPC Endpoints (95%) | QuickSight (54%) + VPC Endpoints (38%) | VPC Endpoints (44%) + QuickSight (28%) |
| **Cost per 1K invocations** | $3.07 | $0.39 | $0.16 |

> **Note:** These estimates do not include the cost of Amazon Bedrock model invocations themselves (input/output token pricing), which are separate from this platform's infrastructure costs. This platform tracks and attributes those costs using AWS Data Exports (CUR 2.0) — it does not generate them.

> **CUR Migration Savings:** By replacing the Pricing Scraper/Engine/Web Scraper architecture with CUR-based cost attribution, the Large (Enterprise) tier saves ~$33/month by eliminating the NAT Gateway ($32.90) that was previously required for pricing web scraping. Small and Medium tiers were already not using NAT Gateway, so savings there are minimal but the architecture is significantly more reliable.

---

*Sources: All pricing data retrieved from official AWS pricing pages in February 2026. Content was rephrased for compliance with licensing restrictions. Verify current pricing at the linked AWS pages before making purchasing decisions.*
