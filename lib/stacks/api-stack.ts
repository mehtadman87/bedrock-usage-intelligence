/**
 * Api_Stack CDK construct.
 *
 * Deploys a private REST API Gateway accessible only through a VPC endpoint,
 * with Admin API Lambda handlers for CRUD operations on Runtime_Config.
 *
 * Requirements: 4.2, 12.1, 12.2, 15.2
 */
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/schema';
import { LAMBDA_RUNTIME } from '../shared/cdk-constants';

export interface ApiStackProps extends cdk.StackProps {
  config: PlatformConfig;
  vpc: ec2.IVpc;
  apiGatewaySecurityGroup: ec2.SecurityGroup;
  vpcEndpointSecurityGroup: ec2.SecurityGroup;
  cmk: kms.Key;
  runtimeConfigTable: dynamodb.Table;
  /** Optional Refresh Lambda for GET /dashboard/refresh (SPICE modes only) */
  refreshLambda?: lambda.IFunction;
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const {
      config,
      vpc,
      apiGatewaySecurityGroup,
      vpcEndpointSecurityGroup,
      cmk,
      runtimeConfigTable,
    } = props;

    const { solutionName } = config.deployment;

    // ── VPC Endpoint for API Gateway (execute-api) ────────────────────────────
    const apiGatewayVpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ApiGatewayVpcEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      securityGroups: [apiGatewaySecurityGroup],
      privateDnsEnabled: true,
    });

    // ── Admin API Lambda handler ───────────────────────────────────────────────
    const adminApiLambda = new nodejs.NodejsFunction(this, 'AdminApiHandler', {
      functionName: `${solutionName}-admin-api`,
      runtime: LAMBDA_RUNTIME,
      entry: path.join(__dirname, '../handlers/admin-api/index.ts'),
      bundling: { minify: true, sourceMap: true, target: 'node22', externalModules: ['@aws-sdk/*'] },
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [vpcEndpointSecurityGroup],
      environmentEncryption: cmk,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        RUNTIME_CONFIG_TABLE: runtimeConfigTable.tableName,
      },
    });

    // ── IAM Permissions ───────────────────────────────────────────────────────

    // DynamoDB read/write on Runtime_Config table
    runtimeConfigTable.grantReadWriteData(adminApiLambda);

    // CMK encrypt/decrypt for environment variables
    cmk.grantEncryptDecrypt(adminApiLambda);

    // ── Private REST API Gateway ──────────────────────────────────────────────

    // Resource policy: restrict access to VPC endpoint only
    const apiResourcePolicy = new iam.PolicyDocument({
      statements: [
        // Allow invocations from the VPC endpoint
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*'],
          conditions: {
            StringEquals: {
              'aws:SourceVpce': apiGatewayVpcEndpoint.vpcEndpointId,
            },
          },
        }),
        // Deny all other access
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*'],
          conditions: {
            StringNotEquals: {
              'aws:SourceVpce': apiGatewayVpcEndpoint.vpcEndpointId,
            },
          },
        }),
      ],
    });

    this.api = new apigateway.RestApi(this, 'AdminApi', {
      restApiName: `${solutionName}-admin-api`,
      description: `Bedrock Usage Intelligence Platform Admin API for ${solutionName}`,
      endpointConfiguration: {
        types: [apigateway.EndpointType.PRIVATE],
        vpcEndpoints: [apiGatewayVpcEndpoint],
      },
      policy: apiResourcePolicy,
      deployOptions: {
        stageName: 'v1',
        description: 'Admin API v1',
      },
      // Disable default endpoint (private API only)
      disableExecuteApiEndpoint: false,
    });

    // ── Request validator ─────────────────────────────────────────────────────
    const requestValidator = new apigateway.RequestValidator(this, 'RequestValidator', {
      restApi: this.api,
      requestValidatorName: `${solutionName}-request-validator`,
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    // ── Lambda integration ────────────────────────────────────────────────────
    const lambdaIntegration = new apigateway.LambdaIntegration(adminApiLambda, {
      proxy: true,
    });

    // ── API Gateway resources and methods ─────────────────────────────────────
    // /config
    const configResource = this.api.root.addResource('config');

    // Define all config categories
    const configCategories = [
      'pricing',
      'alerts',
      'identity',
      'accounts',
      'retention',
      'pricing-auto-update',
    ];

    for (const category of configCategories) {
      const categoryResource = configResource.addResource(category);

      // GET /{category}
      categoryResource.addMethod('GET', lambdaIntegration, {
        requestValidator,
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '404' },
          { statusCode: '503' },
        ],
      });

      // PUT /{category}
      categoryResource.addMethod('PUT', lambdaIntegration, {
        requestValidator,
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '400' },
          { statusCode: '409' },
          { statusCode: '503' },
        ],
      });
    }

    // ── GET /dashboard/refresh (SPICE modes only) ─────────────────────────────
    // Wired when a Refresh Lambda is provided (spiceMode !== 'disabled').
    // No additional IAM auth — VPC endpoint policy restricts access to VPC only.
    if (props.refreshLambda) {
      const dashboardResource = this.api.root.addResource('dashboard');
      const refreshResource = dashboardResource.addResource('refresh');

      const refreshIntegration = new apigateway.LambdaIntegration(props.refreshLambda, {
        proxy: true,
      });

      refreshResource.addMethod('GET', refreshIntegration, {
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '429' },
          { statusCode: '502' },
        ],
      });

      new cdk.CfnOutput(this, 'DashboardRefreshEndpointUrl', {
        value: `${this.api.url}dashboard/refresh`,
        description: 'Dashboard refresh endpoint URL (accessible only from within VPC)',
        exportName: `${solutionName}-dashboard-refresh-url`,
      });
    }

    // ── CfnOutputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiGatewayEndpointUrl', {
      value: this.api.url,
      description: 'Admin API Gateway endpoint URL (accessible only from within VPC)',
      exportName: `${solutionName}-api-endpoint-url`,
    });

    new cdk.CfnOutput(this, 'ApiGatewayRestApiId', {
      value: this.api.restApiId,
      description: 'Admin API Gateway REST API ID',
      exportName: `${solutionName}-api-rest-api-id`,
    });
  }
}
