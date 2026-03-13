import {
  QuickSightClient,
  DescribeAccountSubscriptionCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-quicksight';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * CDK Provider framework onEvent handler interface.
 * The Provider framework handles the CloudFormation cfn-response callback
 * automatically — this handler only needs to return a result object.
 *
 * See: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.custom_resources.Provider.html
 */
interface CdkCustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: Record<string, string>;
  OldResourceProperties?: Record<string, string>;
}

interface CdkCustomResourceResponse {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PHYSICAL_RESOURCE_ID = 'qs-account-validator';

// ─── Client ───────────────────────────────────────────────────────────────────

const quickSightClient = new QuickSightClient({});

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * CDK Provider framework onEvent handler for QuickSight Account Validation.
 *
 * On CREATE/UPDATE: calls quicksight:DescribeAccountSubscription to verify
 *   that QuickSight is activated in this AWS account. Throws if not activated.
 * On DELETE: no-op, returns PhysicalResourceId.
 *
 * IMPORTANT: This function is invoked by the CDK Provider framework, NOT
 * directly by CloudFormation. The framework handles sending the cfn-response
 * to the pre-signed S3 URL. We just return a result object or throw an error.
 *
 * NOT in VPC: QuickSight control plane API requires internet access.
 *
 * Requirements: 8
 */
export const handler = async (
  event: CdkCustomResourceEvent,
): Promise<CdkCustomResourceResponse> => {
  const physicalResourceId = event.PhysicalResourceId ?? PHYSICAL_RESOURCE_ID;

  console.log('QsAccountValidator event:', JSON.stringify({
    requestType: event.RequestType,
    physicalResourceId,
  }));

  if (event.RequestType === 'Create' || event.RequestType === 'Update') {
    const awsAccountId =
      event.ResourceProperties['AwsAccountId'] ?? process.env['AWS_ACCOUNT_ID'] ?? '';

    await validateQuickSightAccount(awsAccountId);
    console.log('QuickSight account subscription validated successfully');

    return { PhysicalResourceId: PHYSICAL_RESOURCE_ID };
  }

  // DELETE: no-op
  return { PhysicalResourceId: physicalResourceId };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function validateQuickSightAccount(awsAccountId: string): Promise<void> {
  try {
    const response = await quickSightClient.send(
      new DescribeAccountSubscriptionCommand({ AwsAccountId: awsAccountId }),
    );

    const status = response.AccountInfo?.AccountSubscriptionStatus;
    if (!status || status !== 'ACCOUNT_CREATED') {
      throw new Error(
        'QuickSight account is not activated in this AWS account. Please activate QuickSight before deploying.',
      );
    }
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      throw new Error(
        'QuickSight account is not activated in this AWS account. Please activate QuickSight before deploying.',
      );
    }
    throw err;
  }
}
