import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/schema';

export interface SecurityStackProps extends cdk.StackProps {
  config: PlatformConfig;
  vpc: ec2.IVpc;
}

export class SecurityStack extends cdk.Stack {
  public readonly cmk: kms.Key;
  public readonly lambdaExecutionRole: iam.Role;
  public readonly adminApiRole: iam.Role;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { solutionName } = config.deployment;

    // ── KMS CMK ───────────────────────────────────────────────────────────────
    this.cmk = new kms.Key(this, 'Cmk', {
      description: `${solutionName} CMK`,
      enableKeyRotation: true,
      alias: `alias/${solutionName}-cmk`,
    });

    // Grant encrypt/decrypt to all Platform service principals
    const serviceEncryptionActions = [
      'kms:Encrypt',
      'kms:Decrypt',
      'kms:ReEncrypt*',
      'kms:GenerateDataKey*',
      'kms:DescribeKey',
    ];

    const servicePrincipals = [
      's3.amazonaws.com',
      'dynamodb.amazonaws.com',
      'sns.amazonaws.com',
      'sqs.amazonaws.com',
      'glue.amazonaws.com',
      'athena.amazonaws.com',
      'lambda.amazonaws.com',
      'quicksight.amazonaws.com',
    ];

    for (const principal of servicePrincipals) {
      this.cmk.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: `Allow${principal.split('.')[0].replace(/-/g, '')}ServiceEncryption`,
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal(principal)],
          actions: serviceEncryptionActions,
          resources: ['*'],
        }),
      );
    }

    // CloudWatch Logs requires a region-specific service principal and
    // additional permissions (CreateGrant) to associate a CMK with log groups.
    // See: https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/encrypt-log-data-kms.html
    this.cmk.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogsEncryption',
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
        ],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
          },
        },
      }),
    );

    // ── IAM Roles ─────────────────────────────────────────────────────────────

    // Base Lambda execution role — used by all Lambda handlers
    this.lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      roleName: `${solutionName}-lambda-execution-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Allow Lambda functions to use the CMK for decrypting env vars and data
    this.lambdaExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowCmkUsage',
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [this.cmk.keyArn],
      }),
    );

    // Admin API role — used by Admin API Lambda handlers
    this.adminApiRole = new iam.Role(this, 'AdminApiRole', {
      roleName: `${solutionName}-admin-api-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Least-privilege DynamoDB access for Admin API (scoped to specific tables in Api_Stack)
    this.adminApiRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowRuntimeConfigTableAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
        ],
        // Scoped to specific table ARNs in Api_Stack; wildcard here as base policy
        resources: ['*'],
      }),
    );

    // Allow Admin API role to use the CMK
    this.adminApiRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowCmkUsage',
        effect: iam.Effect.ALLOW,
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [this.cmk.keyArn],
      }),
    );

    // ── CfnOutputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'CmkArn', {
      value: this.cmk.keyArn,
      description: 'ARN of the KMS Customer Master Key used to encrypt all Platform resources',
      exportName: `${solutionName}-cmk-arn`,
    });

    new cdk.CfnOutput(this, 'CmkAlias', {
      value: `alias/${solutionName}-cmk`,
      description: 'Alias of the KMS Customer Master Key',
      exportName: `${solutionName}-cmk-alias`,
    });
  }
}
