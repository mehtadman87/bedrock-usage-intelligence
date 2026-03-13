import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

const DEFAULT_TTL_SECONDS = 86400; // 24 hours

/**
 * Provides exactly-once processing semantics using a DynamoDB table.
 *
 * The table schema (from design doc):
 *   PK: requestId (String)
 *   SK: timestamp (String)
 *   Attributes:
 *     processedAt  — ISO 8601 string
 *     processorName — e.g. "invocation" | "cloudtrail"
 *     status       — "completed"
 *     expiresAt    — TTL epoch seconds (Number)
 *
 * Requirements: 13.4
 */
export class IdempotencyChecker {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly ttlSeconds: number;

  constructor(tableName: string, ttlSeconds: number = DEFAULT_TTL_SECONDS) {
    this.tableName = tableName;
    this.ttlSeconds = ttlSeconds;

    const ddbClient = new DynamoDBClient({});
    this.docClient = DynamoDBDocumentClient.from(ddbClient);
  }

  /**
   * Checks whether a record identified by (requestId, timestamp) has already
   * been processed.
   *
   * @param requestId - The Bedrock request ID (partition key).
   * @param timestamp - The invocation timestamp (sort key).
   * @returns `true` if the record exists in the idempotency table, `false` otherwise.
   */
  async isProcessed(requestId: string, timestamp: string): Promise<boolean> {
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { requestId, timestamp },
      }),
    );

    return result.Item !== undefined;
  }

  /**
   * Marks a record as processed using a conditional PutItem so that concurrent
   * executions cannot both succeed — only the first write wins.
   *
   * If the record already exists (ConditionalCheckFailedException), this method
   * returns silently — the duplicate is not an error.
   *
   * @param requestId     - The Bedrock request ID (partition key).
   * @param timestamp     - The invocation timestamp (sort key).
   * @param processorName - Name of the processor writing the record (e.g. "invocation").
   */
  async markProcessed(
    requestId: string,
    timestamp: string,
    processorName: string,
  ): Promise<void> {
    const now = new Date();
    const expiresAt = Math.floor(now.getTime() / 1000) + this.ttlSeconds;

    try {
      await this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            requestId,
            timestamp,
            processedAt: now.toISOString(),
            processorName,
            status: 'completed',
            expiresAt,
          },
          ConditionExpression: 'attribute_not_exists(requestId)',
        }),
      );
    } catch (err: unknown) {
      // ConditionalCheckFailedException means the record was already written by
      // a concurrent execution — this is expected and not an error.
      if (
        err instanceof Error &&
        err.name === 'ConditionalCheckFailedException'
      ) {
        return;
      }
      throw err;
    }
  }
}
