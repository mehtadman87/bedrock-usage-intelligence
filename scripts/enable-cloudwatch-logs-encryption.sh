#!/usr/bin/env bash
# enable-cloudwatch-logs-encryption.sh
#
# Applies CMK encryption to all CloudWatch Log Groups created by the Platform.
# This script is run post-deployment to avoid circular dependencies during CDK deployment.
#
# Usage:
#   bash scripts/enable-cloudwatch-logs-encryption.sh --cmk-arn <CMK_ARN> --solution-name <SOLUTION_NAME>
#
# Requirements: 3.8, 15.3

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
CMK_ARN=""
SOLUTION_NAME=""
DRY_RUN=false
REGION="${AWS_DEFAULT_REGION:-}"

# ── Usage ─────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $(basename "$0") --cmk-arn <CMK_ARN> --solution-name <SOLUTION_NAME> [OPTIONS]

Required:
  --cmk-arn <ARN>           KMS CMK ARN to apply to CloudWatch Log Groups
  --solution-name <NAME>    Solution name prefix used to identify log groups

Optional:
  --region <REGION>         AWS region (defaults to AWS_DEFAULT_REGION or current profile region)
  --dry-run                 Print log groups that would be updated without making changes
  --help                    Show this help message

Examples:
  bash scripts/enable-cloudwatch-logs-encryption.sh \\
    --cmk-arn arn:aws:kms:us-east-1:123456789012:key/abc123 \\
    --solution-name bedrock-usage-intel

  bash scripts/enable-cloudwatch-logs-encryption.sh \\
    --cmk-arn arn:aws:kms:us-east-1:123456789012:key/abc123 \\
    --solution-name bedrock-usage-intel \\
    --dry-run
EOF
}

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cmk-arn)
      CMK_ARN="$2"
      shift 2
      ;;
    --solution-name)
      SOLUTION_NAME="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
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

# ── Validate required arguments ───────────────────────────────────────────────
if [[ -z "$CMK_ARN" ]]; then
  echo "ERROR: --cmk-arn is required" >&2
  usage >&2
  exit 1
fi

if [[ -z "$SOLUTION_NAME" ]]; then
  echo "ERROR: --solution-name is required" >&2
  usage >&2
  exit 1
fi

# Validate CMK ARN format
if ! [[ "$CMK_ARN" =~ ^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[a-zA-Z0-9-]+$ ]]; then
  echo "ERROR: Invalid CMK ARN format: $CMK_ARN" >&2
  echo "       Expected format: arn:aws:kms:<region>:<account-id>:key/<key-id>" >&2
  exit 1
fi

# ── AWS CLI region flag ───────────────────────────────────────────────────────
REGION_FLAG=""
if [[ -n "$REGION" ]]; then
  REGION_FLAG="--region $REGION"
fi

# ── Verify AWS CLI is available ───────────────────────────────────────────────
if ! command -v aws &>/dev/null; then
  echo "ERROR: AWS CLI is not installed or not in PATH" >&2
  exit 1
fi

# ── Verify AWS credentials are configured ────────────────────────────────────
if ! aws sts get-caller-identity $REGION_FLAG --output text --query 'Account' &>/dev/null; then
  echo "ERROR: AWS credentials are not configured or are invalid" >&2
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity $REGION_FLAG --output text --query 'Account')
echo "INFO: Running as account: $ACCOUNT_ID"
echo "INFO: Solution name prefix: $SOLUTION_NAME"
echo "INFO: CMK ARN: $CMK_ARN"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "INFO: DRY RUN mode — no changes will be made"
fi
echo ""

# ── Counters ──────────────────────────────────────────────────────────────────
TOTAL=0
ALREADY_ENCRYPTED=0
UPDATED=0
FAILED=0

# ── Find and encrypt log groups ───────────────────────────────────────────────
echo "INFO: Searching for CloudWatch Log Groups with prefix: /$SOLUTION_NAME"
echo "INFO: Also searching for Lambda log groups: /aws/lambda/$SOLUTION_NAME"
echo ""

# Collect all matching log group names using pagination
LOG_GROUPS=()

# Search for log groups matching /{solutionName}* pattern
while IFS= read -r log_group; do
  [[ -n "$log_group" ]] && LOG_GROUPS+=("$log_group")
done < <(
  aws logs describe-log-groups \
    $REGION_FLAG \
    --log-group-name-prefix "/$SOLUTION_NAME" \
    --query 'logGroups[].logGroupName' \
    --output text 2>/dev/null | tr '\t' '\n' || true
)

# Search for Lambda log groups: /aws/lambda/{solutionName}*
while IFS= read -r log_group; do
  [[ -n "$log_group" ]] && LOG_GROUPS+=("$log_group")
done < <(
  aws logs describe-log-groups \
    $REGION_FLAG \
    --log-group-name-prefix "/aws/lambda/$SOLUTION_NAME" \
    --query 'logGroups[].logGroupName' \
    --output text 2>/dev/null | tr '\t' '\n' || true
)

# Deduplicate
LOG_GROUPS=($(printf '%s\n' "${LOG_GROUPS[@]}" | sort -u))

TOTAL=${#LOG_GROUPS[@]}

if [[ $TOTAL -eq 0 ]]; then
  echo "INFO: No CloudWatch Log Groups found matching prefix '$SOLUTION_NAME'"
  echo "INFO: Ensure the platform has been deployed and Lambda functions have been invoked at least once."
  exit 0
fi

echo "INFO: Found $TOTAL log group(s) to process"
echo ""

# ── Process each log group ────────────────────────────────────────────────────
for LOG_GROUP in "${LOG_GROUPS[@]}"; do
  echo -n "Processing: $LOG_GROUP ... "

  # Check if the log group already has the correct CMK applied (idempotency)
  CURRENT_KMS_KEY=$(
    aws logs describe-log-groups \
      $REGION_FLAG \
      --log-group-name-prefix "$LOG_GROUP" \
      --query "logGroups[?logGroupName=='$LOG_GROUP'].kmsKeyId | [0]" \
      --output text 2>/dev/null || echo "None"
  )

  if [[ "$CURRENT_KMS_KEY" == "$CMK_ARN" ]]; then
    echo "SKIPPED (already encrypted with target CMK)"
    ((ALREADY_ENCRYPTED++)) || true
    continue
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    if [[ "$CURRENT_KMS_KEY" == "None" || -z "$CURRENT_KMS_KEY" ]]; then
      echo "DRY RUN (would apply CMK encryption)"
    else
      echo "DRY RUN (would update CMK from $CURRENT_KMS_KEY)"
    fi
    ((UPDATED++)) || true
    continue
  fi

  # Apply CMK encryption
  if aws logs associate-kms-key \
    $REGION_FLAG \
    --log-group-name "$LOG_GROUP" \
    --kms-key-id "$CMK_ARN" 2>/dev/null; then
    echo "OK"
    ((UPDATED++)) || true
  else
    echo "FAILED"
    echo "  ERROR: Failed to apply CMK encryption to $LOG_GROUP" >&2
    ((FAILED++)) || true
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Post-Deployment CloudWatch Logs Encryption Summary"
echo "════════════════════════════════════════════════════════════"
echo "  Total log groups found:       $TOTAL"
echo "  Already encrypted (skipped):  $ALREADY_ENCRYPTED"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "  Would be updated:             $UPDATED"
else
  echo "  Successfully updated:         $UPDATED"
fi
echo "  Failed:                       $FAILED"
echo "════════════════════════════════════════════════════════════"

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "WARNING: $FAILED log group(s) failed to be encrypted."
  echo "         Check IAM permissions: the caller needs kms:CreateGrant and logs:AssociateKmsKey."
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "INFO: Dry run complete. Re-run without --dry-run to apply changes."
fi

exit 0
