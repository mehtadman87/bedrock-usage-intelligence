#!/usr/bin/env bash
# verify-deployment.sh
#
# Verifies that the Bedrock Usage Intelligence Platform deployment is healthy.
# Checks Lambda functions, S3 buckets, DynamoDB tables, API Gateway, and CloudWatch alarms.
# Outputs a deployment summary with resource ARNs and endpoints.
#
# Usage:
#   bash scripts/verify-deployment.sh --solution-name <SOLUTION_NAME> [OPTIONS]
#
# Requirements: 15.3

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SOLUTION_NAME=""
REGION="${AWS_DEFAULT_REGION:-}"
OUTPUT_FORMAT="text"   # text | json
FAIL_FAST=false

# ── Counters ──────────────────────────────────────────────────────────────────
CHECKS_PASSED=0
CHECKS_FAILED=0
CHECKS_WARNED=0

# ── Colour codes (disabled if not a terminal) ─────────────────────────────────
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' BOLD='' RESET=''
fi

# ── Usage ─────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") --solution-name <SOLUTION_NAME> [OPTIONS]

Required:
  --solution-name <NAME>    Solution name prefix (e.g. bedrock-usage-intel)

Optional:
  --region <REGION>         AWS region (defaults to AWS_DEFAULT_REGION or current profile region)
  --output json             Output results as JSON (default: text)
  --fail-fast               Stop on first failure
  --help                    Show this help message

Examples:
  bash scripts/verify-deployment.sh --solution-name bedrock-usage-intel
  bash scripts/verify-deployment.sh --solution-name bedrock-usage-intel --region us-east-1 --output json
EOF
}

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --solution-name)
      SOLUTION_NAME="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --output)
      OUTPUT_FORMAT="$2"
      shift 2
      ;;
    --fail-fast)
      FAIL_FAST=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$SOLUTION_NAME" ]]; then
  echo "ERROR: --solution-name is required" >&2
  usage >&2
  exit 1
fi

# ── AWS CLI region flag ───────────────────────────────────────────────────────
REGION_FLAG=""
if [[ -n "$REGION" ]]; then
  REGION_FLAG="--region $REGION"
fi

# ── Verify AWS CLI ────────────────────────────────────────────────────────────
if ! command -v aws &>/dev/null; then
  echo "ERROR: AWS CLI is not installed or not in PATH" >&2
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity $REGION_FLAG --output text --query 'Account' 2>/dev/null) || {
  echo "ERROR: AWS credentials are not configured or are invalid" >&2
  exit 1
}

EFFECTIVE_REGION=$(aws configure get region $REGION_FLAG 2>/dev/null || echo "${REGION:-us-east-1}")
[[ -n "$REGION" ]] && EFFECTIVE_REGION="$REGION"

# ── JSON accumulator ──────────────────────────────────────────────────────────
declare -A RESOURCE_ARNS
declare -A CHECK_RESULTS

# ── Helper functions ──────────────────────────────────────────────────────────
pass() {
  local msg="$1"
  echo -e "  ${GREEN}✓${RESET} $msg"
  ((CHECKS_PASSED++)) || true
}

fail() {
  local msg="$1"
  echo -e "  ${RED}✗${RESET} $msg"
  ((CHECKS_FAILED++)) || true
  if [[ "$FAIL_FAST" == "true" ]]; then
    echo ""
    echo -e "${RED}FAIL_FAST enabled — stopping on first failure.${RESET}"
    exit 1
  fi
}

warn() {
  local msg="$1"
  echo -e "  ${YELLOW}⚠${RESET} $msg"
  ((CHECKS_WARNED++)) || true
}

section() {
  echo ""
  echo -e "${BOLD}${BLUE}── $1 ──────────────────────────────────────────────────────${RESET}"
}

# ── Check: Lambda function exists and is configured ──────────────────────────
check_lambda() {
  local name="$1"
  local full_name="${SOLUTION_NAME}-${name}"

  local result
  result=$(aws lambda get-function-configuration \
    $REGION_FLAG \
    --function-name "$full_name" \
    --query '{State: State, Runtime: Runtime, VpcId: VpcConfig.VpcId, Arn: FunctionArn}' \
    --output json 2>/dev/null) || {
    fail "Lambda '$full_name' not found"
    return
  }

  local state runtime vpc_id arn
  state=$(echo "$result" | grep -o '"State": "[^"]*"' | cut -d'"' -f4)
  runtime=$(echo "$result" | grep -o '"Runtime": "[^"]*"' | cut -d'"' -f4)
  vpc_id=$(echo "$result" | grep -o '"VpcId": "[^"]*"' | cut -d'"' -f4 || echo "")
  arn=$(echo "$result" | grep -o '"Arn": "[^"]*"' | cut -d'"' -f4)

  if [[ "$state" != "Active" ]]; then
    fail "Lambda '$full_name' exists but state is '$state' (expected Active)"
    return
  fi

  if [[ -z "$vpc_id" ]]; then
    warn "Lambda '$full_name' is not VPC-attached"
  fi

  pass "Lambda '$full_name' is Active (runtime: $runtime, vpc: ${vpc_id:-none})"
  RESOURCE_ARNS["lambda_${name}"]="$arn"
}

# ── Check: S3 bucket exists with correct encryption ──────────────────────────
check_s3_bucket() {
  local suffix="$1"
  local bucket_name="${SOLUTION_NAME}-${suffix}-${ACCOUNT_ID}-${EFFECTIVE_REGION}"

  # Check bucket exists
  if ! aws s3api head-bucket --bucket "$bucket_name" $REGION_FLAG 2>/dev/null; then
    fail "S3 bucket '$bucket_name' not found"
    return
  fi

  # Check encryption
  local enc_result
  enc_result=$(aws s3api get-bucket-encryption \
    --bucket "$bucket_name" \
    $REGION_FLAG \
    --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' \
    --output text 2>/dev/null) || enc_result="NONE"

  if [[ "$enc_result" == "aws:kms" ]]; then
    pass "S3 bucket '$bucket_name' exists with KMS encryption"
  else
    fail "S3 bucket '$bucket_name' exists but encryption is '$enc_result' (expected aws:kms)"
  fi

  local bucket_arn="arn:aws:s3:::${bucket_name}"
  RESOURCE_ARNS["s3_${suffix}"]="$bucket_arn"
}

# ── Check: DynamoDB table exists with PITR enabled ───────────────────────────
check_dynamodb_table() {
  local suffix="$1"
  local table_name="${SOLUTION_NAME}-${suffix}"

  local table_result
  table_result=$(aws dynamodb describe-table \
    $REGION_FLAG \
    --table-name "$table_name" \
    --query '{Status: Table.TableStatus, Arn: Table.TableArn}' \
    --output json 2>/dev/null) || {
    fail "DynamoDB table '$table_name' not found"
    return
  }

  local status arn
  status=$(echo "$table_result" | grep -o '"Status": "[^"]*"' | cut -d'"' -f4)
  arn=$(echo "$table_result" | grep -o '"Arn": "[^"]*"' | cut -d'"' -f4)

  if [[ "$status" != "ACTIVE" ]]; then
    fail "DynamoDB table '$table_name' exists but status is '$status' (expected ACTIVE)"
    return
  fi

  # Check PITR
  local pitr_status
  pitr_status=$(aws dynamodb describe-continuous-backups \
    $REGION_FLAG \
    --table-name "$table_name" \
    --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' \
    --output text 2>/dev/null) || pitr_status="UNKNOWN"

  if [[ "$pitr_status" == "ENABLED" ]]; then
    pass "DynamoDB table '$table_name' is ACTIVE with PITR enabled"
  else
    fail "DynamoDB table '$table_name' is ACTIVE but PITR is '$pitr_status' (expected ENABLED)"
  fi

  RESOURCE_ARNS["dynamodb_${suffix}"]="$arn"
}

# ── Check: API Gateway exists ─────────────────────────────────────────────────
check_api_gateway() {
  local api_name="${SOLUTION_NAME}-admin-api"

  local api_result
  api_result=$(aws apigateway get-rest-apis \
    $REGION_FLAG \
    --query "items[?name=='${api_name}'].{id: id, name: name, endpointType: endpointConfiguration.types[0]}" \
    --output json 2>/dev/null) || {
    fail "Could not query API Gateway"
    return
  }

  local api_id endpoint_type
  api_id=$(echo "$api_result" | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
  endpoint_type=$(echo "$api_result" | grep -o '"endpointType": "[^"]*"' | head -1 | cut -d'"' -f4 || echo "")

  if [[ -z "$api_id" ]]; then
    fail "API Gateway '$api_name' not found"
    return
  fi

  if [[ "$endpoint_type" == "PRIVATE" ]]; then
    pass "API Gateway '$api_name' exists as PRIVATE endpoint (id: $api_id)"
  else
    warn "API Gateway '$api_name' exists but endpoint type is '$endpoint_type' (expected PRIVATE)"
  fi

  local api_arn="arn:aws:apigateway:${EFFECTIVE_REGION}::/restapis/${api_id}"
  RESOURCE_ARNS["api_gateway"]="$api_arn"
  RESOURCE_ARNS["api_gateway_id"]="$api_id"
}

# ── Check: CloudWatch alarms are in OK state ──────────────────────────────────
check_cloudwatch_alarms() {
  local alarm_prefix="${SOLUTION_NAME}-"

  local alarms_result
  alarms_result=$(aws cloudwatch describe-alarms \
    $REGION_FLAG \
    --alarm-name-prefix "$alarm_prefix" \
    --query 'MetricAlarms[].{Name: AlarmName, State: StateValue}' \
    --output json 2>/dev/null) || {
    fail "Could not query CloudWatch alarms"
    return
  }

  local total_alarms
  total_alarms=$(echo "$alarms_result" | grep -c '"Name"' || echo "0")

  if [[ "$total_alarms" -eq 0 ]]; then
    warn "No CloudWatch alarms found with prefix '$alarm_prefix'"
    return
  fi

  local alarm_ok alarm_alarm alarm_insufficient
  alarm_ok=$(echo "$alarms_result" | grep -c '"State": "OK"' || echo "0")
  alarm_alarm=$(echo "$alarms_result" | grep -c '"State": "ALARM"' || echo "0")
  alarm_insufficient=$(echo "$alarms_result" | grep -c '"State": "INSUFFICIENT_DATA"' || echo "0")

  if [[ "$alarm_alarm" -gt 0 ]]; then
    fail "$alarm_alarm alarm(s) are in ALARM state (total: $total_alarms, OK: $alarm_ok, INSUFFICIENT_DATA: $alarm_insufficient)"
    # Print which alarms are in ALARM state
    echo "$alarms_result" | grep -B1 '"State": "ALARM"' | grep '"Name"' | sed 's/.*"Name": "\(.*\)".*/    - \1/' || true
  elif [[ "$alarm_insufficient" -gt 0 ]]; then
    warn "$alarm_insufficient alarm(s) are in INSUFFICIENT_DATA state (total: $total_alarms, OK: $alarm_ok)"
  else
    pass "All $total_alarms CloudWatch alarm(s) are in OK state"
  fi
}

# ── Check: KMS CMK exists ─────────────────────────────────────────────────────
check_kms_cmk() {
  local alias_name="alias/${SOLUTION_NAME}-cmk"

  local cmk_result
  cmk_result=$(aws kms describe-key \
    $REGION_FLAG \
    --key-id "$alias_name" \
    --query '{KeyId: KeyMetadata.KeyId, Arn: KeyMetadata.Arn, State: KeyMetadata.KeyState, RotationEnabled: KeyMetadata.KeyRotationStatus}' \
    --output json 2>/dev/null) || {
    fail "KMS CMK with alias '$alias_name' not found"
    return
  }

  local key_state key_arn
  key_state=$(echo "$cmk_result" | grep -o '"State": "[^"]*"' | cut -d'"' -f4 || echo "")
  key_arn=$(echo "$cmk_result" | grep -o '"Arn": "[^"]*"' | cut -d'"' -f4 || echo "")

  if [[ "$key_state" == "Enabled" ]]; then
    pass "KMS CMK '$alias_name' is Enabled"
  else
    fail "KMS CMK '$alias_name' exists but state is '$key_state' (expected Enabled)"
  fi

  RESOURCE_ARNS["kms_cmk"]="$key_arn"
}

# ── Check: SNS alarm topic exists ─────────────────────────────────────────────
check_sns_topic() {
  local topic_name="${SOLUTION_NAME}-alarms"

  local topic_arn
  topic_arn=$(aws sns list-topics \
    $REGION_FLAG \
    --query "Topics[?contains(TopicArn, '${topic_name}')].TopicArn | [0]" \
    --output text 2>/dev/null) || topic_arn=""

  if [[ -z "$topic_arn" || "$topic_arn" == "None" ]]; then
    fail "SNS topic '$topic_name' not found"
    return
  fi

  pass "SNS topic '$topic_name' exists"
  RESOURCE_ARNS["sns_alarm_topic"]="$topic_arn"
}

# ── Check: Athena workgroup exists ────────────────────────────────────────────
check_athena_workgroup() {
  local workgroup_name="${SOLUTION_NAME}-workgroup"

  local wg_result
  wg_result=$(aws athena get-work-group \
    $REGION_FLAG \
    --work-group "$workgroup_name" \
    --query 'WorkGroup.State' \
    --output text 2>/dev/null) || {
    fail "Athena workgroup '$workgroup_name' not found"
    return
  }

  if [[ "$wg_result" == "ENABLED" ]]; then
    pass "Athena workgroup '$workgroup_name' is ENABLED"
  else
    fail "Athena workgroup '$workgroup_name' exists but state is '$wg_result' (expected ENABLED)"
  fi

  RESOURCE_ARNS["athena_workgroup"]="$workgroup_name"
}

# ── Run all checks ────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Bedrock Usage Intelligence Platform — Deployment Verification${RESET}"
echo -e "${BOLD}════════════════════════════════════════════════════════════${RESET}"
echo "  Account:       $ACCOUNT_ID"
echo "  Region:        $EFFECTIVE_REGION"
echo "  Solution Name: $SOLUTION_NAME"
echo ""

# ── Security ──────────────────────────────────────────────────────────────────
section "Security"
check_kms_cmk

# ── Lambda Functions ──────────────────────────────────────────────────────────
section "Lambda Functions"
check_lambda "invocation-processor"
check_lambda "cloudtrail-processor"
check_lambda "metrics-collector"
check_lambda "identity-resolver"
check_lambda "pricing-scraper"
check_lambda "pricing-engine"
check_lambda "admin-api"

# ── S3 Buckets ────────────────────────────────────────────────────────────────
section "S3 Buckets"
check_s3_bucket "raw-logs"
check_s3_bucket "processed-data"
check_s3_bucket "failed-records"

# ── DynamoDB Tables ───────────────────────────────────────────────────────────
section "DynamoDB Tables"
check_dynamodb_table "runtime-config"
check_dynamodb_table "identity-cache"
check_dynamodb_table "idempotency"
check_dynamodb_table "pricing"

# ── API Gateway ───────────────────────────────────────────────────────────────
section "API Gateway"
check_api_gateway

# ── Monitoring ────────────────────────────────────────────────────────────────
section "Monitoring"
check_sns_topic
check_cloudwatch_alarms

# ── Analytics ─────────────────────────────────────────────────────────────────
section "Analytics"
check_athena_workgroup

# ── Deployment Summary ────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Deployment Summary${RESET}"
echo -e "${BOLD}════════════════════════════════════════════════════════════${RESET}"
echo ""
echo "  Resource ARNs and Endpoints:"
echo ""

# KMS CMK
[[ -n "${RESOURCE_ARNS[kms_cmk]:-}" ]] && \
  echo "  KMS CMK ARN:              ${RESOURCE_ARNS[kms_cmk]}"

# S3 Buckets
[[ -n "${RESOURCE_ARNS[s3_raw-logs]:-}" ]] && \
  echo "  Raw Logs Bucket ARN:      ${RESOURCE_ARNS[s3_raw-logs]}"
[[ -n "${RESOURCE_ARNS[s3_processed-data]:-}" ]] && \
  echo "  Processed Data Bucket ARN:${RESOURCE_ARNS[s3_processed-data]}"
[[ -n "${RESOURCE_ARNS[s3_failed-records]:-}" ]] && \
  echo "  Failed Records Bucket ARN:${RESOURCE_ARNS[s3_failed-records]}"

# DynamoDB Tables
[[ -n "${RESOURCE_ARNS[dynamodb_runtime-config]:-}" ]] && \
  echo "  Runtime Config Table ARN: ${RESOURCE_ARNS[dynamodb_runtime-config]}"
[[ -n "${RESOURCE_ARNS[dynamodb_identity-cache]:-}" ]] && \
  echo "  Identity Cache Table ARN: ${RESOURCE_ARNS[dynamodb_identity-cache]}"
[[ -n "${RESOURCE_ARNS[dynamodb_idempotency]:-}" ]] && \
  echo "  Idempotency Table ARN:    ${RESOURCE_ARNS[dynamodb_idempotency]}"
[[ -n "${RESOURCE_ARNS[dynamodb_pricing]:-}" ]] && \
  echo "  Pricing Table ARN:        ${RESOURCE_ARNS[dynamodb_pricing]}"

# API Gateway
if [[ -n "${RESOURCE_ARNS[api_gateway_id]:-}" ]]; then
  echo "  Admin API Endpoint:       https://${RESOURCE_ARNS[api_gateway_id]}.execute-api.${EFFECTIVE_REGION}.amazonaws.com/v1"
  echo "  Admin API ARN:            ${RESOURCE_ARNS[api_gateway]:-}"
fi

# SNS Topic
[[ -n "${RESOURCE_ARNS[sns_alarm_topic]:-}" ]] && \
  echo "  Alarm Topic ARN:          ${RESOURCE_ARNS[sns_alarm_topic]}"

# Athena Workgroup
[[ -n "${RESOURCE_ARNS[athena_workgroup]:-}" ]] && \
  echo "  Athena Workgroup:         ${RESOURCE_ARNS[athena_workgroup]}"

# Lambda Functions
echo ""
echo "  Lambda Function ARNs:"
for key in "${!RESOURCE_ARNS[@]}"; do
  if [[ "$key" == lambda_* ]]; then
    local_name="${key#lambda_}"
    echo "    ${local_name}: ${RESOURCE_ARNS[$key]}"
  fi
done

# Post-deployment script reminder
if [[ -n "${RESOURCE_ARNS[kms_cmk]:-}" ]]; then
  echo ""
  echo "  Post-Deployment Script:"
  echo "    bash scripts/enable-cloudwatch-logs-encryption.sh \\"
  echo "      --cmk-arn ${RESOURCE_ARNS[kms_cmk]} \\"
  echo "      --solution-name ${SOLUTION_NAME}"
fi

# ── Final result ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Verification Results${RESET}"
echo -e "${BOLD}════════════════════════════════════════════════════════════${RESET}"
echo -e "  ${GREEN}Passed:${RESET}   $CHECKS_PASSED"
echo -e "  ${YELLOW}Warnings:${RESET} $CHECKS_WARNED"
echo -e "  ${RED}Failed:${RESET}   $CHECKS_FAILED"
echo ""

if [[ $CHECKS_FAILED -gt 0 ]]; then
  echo -e "${RED}DEPLOYMENT VERIFICATION FAILED — $CHECKS_FAILED check(s) failed.${RESET}"
  echo "Review the errors above and ensure all stacks have been deployed successfully."
  exit 1
elif [[ $CHECKS_WARNED -gt 0 ]]; then
  echo -e "${YELLOW}DEPLOYMENT VERIFICATION PASSED WITH WARNINGS — review warnings above.${RESET}"
  exit 0
else
  echo -e "${GREEN}DEPLOYMENT VERIFICATION PASSED — all checks passed.${RESET}"
  exit 0
fi
