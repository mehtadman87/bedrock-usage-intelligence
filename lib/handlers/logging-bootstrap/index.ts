import {
  BedrockClient,
  PutModelInvocationLoggingConfigurationCommand,
  DeleteModelInvocationLoggingConfigurationCommand,
} from '@aws-sdk/client-bedrock';

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

// ─── Environment Variables ────────────────────────────────────────────────────

function getRawLogsBucketArn(): string {
  return process.env['RAW_LOGS_BUCKET_ARN'] ?? '';
}

function getRawLogsBucketPrefix(): string {
  return process.env['RAW_LOGS_BUCKET_PREFIX'] ?? 'bedrock-logs/';
}

function isDisableOnDelete(): boolean {
  return process.env['DISABLE_ON_DELETE'] === 'true';
}

// ─── Handler ──────────────────────────────────────────────────────────────────

const bedrockClient = new BedrockClient({});

/**
 * CDK Provider framework onEvent handler for Bedrock Model Invocation Logging.
 *
 * On CREATE/UPDATE: calls bedrock:PutModelInvocationLoggingConfiguration
 *   to enable S3 logging to the raw logs bucket under the configured prefix.
 * On DELETE: optionally disables logging (controlled by DISABLE_ON_DELETE env var).
 *
 * IMPORTANT: This function is invoked by the CDK Provider framework, NOT
 * directly by CloudFormation. The framework handles sending the cfn-response
 * to the pre-signed S3 URL. We just return a result object or throw an error.
 *
 * Requirements: 5.1
 */
export const handler = async (
  event: CdkCustomResourceEvent,
): Promise<CdkCustomResourceResponse> => {
  const physicalResourceId =
    event.PhysicalResourceId ?? 'bedrock-invocation-logging-config';

  console.log('LoggingBootstrap event:', JSON.stringify({
    requestType: event.RequestType,
    physicalResourceId,
  }));

  if (event.RequestType === 'Create' || event.RequestType === 'Update') {
    await enableLogging(getRawLogsBucketArn(), getRawLogsBucketPrefix());
    console.log('Bedrock Model Invocation Logging enabled successfully');
  } else if (event.RequestType === 'Delete') {
    if (isDisableOnDelete()) {
      await disableLogging();
      console.log('Bedrock Model Invocation Logging disabled on stack deletion');
    } else {
      console.log('DISABLE_ON_DELETE is false — leaving logging configuration intact');
    }
  }

  return { PhysicalResourceId: physicalResourceId };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function enableLogging(bucketArn: string, prefix: string): Promise<void> {
  await bedrockClient.send(
    new PutModelInvocationLoggingConfigurationCommand({
      loggingConfig: {
        s3Config: {
          bucketName: bucketArnToBucketName(bucketArn),
          keyPrefix: prefix,
        },
        textDataDeliveryEnabled: true,
        imageDataDeliveryEnabled: true,
        videoDataDeliveryEnabled: true,
        embeddingDataDeliveryEnabled: true,
      },
    }),
  );
}

async function disableLogging(): Promise<void> {
  await bedrockClient.send(
    new DeleteModelInvocationLoggingConfigurationCommand({}),
  );
}

/**
 * Extracts the bucket name from an S3 ARN.
 * ARN format: arn:aws:s3:::{bucket-name}
 */
function bucketArnToBucketName(arn: string): string {
  const parts = arn.split(':');
  return parts[parts.length - 1] ?? arn;
}
