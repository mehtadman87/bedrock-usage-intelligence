import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/schema';
import { LAMBDA_RUNTIME } from '../shared/cdk-constants';

export interface IdentityStackProps extends cdk.StackProps {
  config: PlatformConfig;
  vpc: ec2.IVpc;
  privateSubnets: ec2.ISubnet[];
  lambdaSecurityGroup: ec2.SecurityGroup;
  cmk: kms.Key;
  identityCacheTable: dynamodb.Table;
}

export class IdentityStack extends cdk.Stack {
  public readonly identityResolver: lambda.Function;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);

    const {
      config,
      vpc,
      privateSubnets,
      lambdaSecurityGroup,
      cmk,
      identityCacheTable,
    } = props;

    const { solutionName } = config.deployment;
    const identityMode = config.identity.identityMode;
    const identityStoreId =
      config.identity.identityMode === 'sso' || config.identity.identityMode === 'auto'
        ? config.identity.identityStoreId
        : '';

    // ── Identity Resolver Lambda ──────────────────────────────────────────────
    this.identityResolver = new nodejs.NodejsFunction(this, 'IdentityResolver', {
      functionName: `${solutionName}-identity-resolver`,
      runtime: LAMBDA_RUNTIME,
      entry: path.join(__dirname, '../handlers/identity-resolver/index.ts'),
      bundling: { minify: true, sourceMap: true, target: 'node22', externalModules: ['@aws-sdk/*'] },
      vpc,
      vpcSubnets: { subnets: privateSubnets },
      securityGroups: [lambdaSecurityGroup],
      environmentEncryption: cmk,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        IDENTITY_MODE: identityMode,
        IDENTITY_STORE_ID: identityStoreId,
        IDENTITY_CACHE_TABLE: identityCacheTable.tableName,
        CIRCUIT_BREAKER_THRESHOLD: '5',
        CIRCUIT_BREAKER_COOLDOWN: '60000',
        RATE_LIMIT_MAX_RPS: '10',
      },
    });

    // ── IAM Permissions ───────────────────────────────────────────────────────

    // DynamoDB read/write on Identity_Cache
    identityCacheTable.grantReadWriteData(this.identityResolver);

    // CMK encrypt/decrypt for environment variables
    cmk.grantEncryptDecrypt(this.identityResolver);

    // Identity Store read permissions (only for sso and auto modes)
    if (identityMode === 'sso' || identityMode === 'auto') {
      this.identityResolver.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'AllowIdentityStoreRead',
          effect: iam.Effect.ALLOW,
          actions: [
            'identitystore:DescribeUser',
            'identitystore:ListUsers',
            'identitystore:GetUserId',
          ],
          resources: ['*'],
        }),
      );

      // SSO admin read for listing identity stores
      this.identityResolver.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'AllowSsoAdminRead',
          effect: iam.Effect.ALLOW,
          actions: [
            'sso:DescribeInstance',
            'sso:ListInstances',
          ],
          resources: ['*'],
        }),
      );
    }

    // STS assume role for cross-account scenarios
    this.identityResolver.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowStsGetCallerIdentity',
        effect: iam.Effect.ALLOW,
        actions: ['sts:GetCallerIdentity'],
        resources: ['*'],
      }),
    );
  }
}
