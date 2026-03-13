import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/schema';

export interface NetworkStackProps extends cdk.StackProps {
  config: PlatformConfig;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  public readonly apiGatewaySecurityGroup: ec2.SecurityGroup;
  public readonly vpcEndpointSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { vpc: vpcConfig } = config;

    // ── VPC ──────────────────────────────────────────────────────────────────
    if (vpcConfig.vpcMode === 'create') {
      const subnetConfig: ec2.SubnetConfiguration[] = [
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ];

      // NAT Gateways require public subnets to be placed in
      if (vpcConfig.enableNatGateway) {
        subnetConfig.push({
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        });
      }

      this.vpc = new ec2.Vpc(this, 'Vpc', {
        ipAddresses: ec2.IpAddresses.cidr(vpcConfig.vpcCidr),
        maxAzs: 2,
        natGateways: vpcConfig.enableNatGateway ? 1 : 0,
        subnetConfiguration: subnetConfig,
      });
    } else {
      // vpcMode === 'existing'
      this.vpc = ec2.Vpc.fromLookup(this, 'Vpc', {
        vpcId: vpcConfig.existingVpcId,
      });
    }

    // Collect private subnets
    this.privateSubnets = this.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnets;

    // ── Security Groups ───────────────────────────────────────────────────────
    this.vpcEndpointSecurityGroup = new ec2.SecurityGroup(this, 'VpcEndpointSG', {
      vpc: this.vpc,
      description: 'Security group for VPC endpoints',
      allowAllOutbound: false,
    });

    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSG', {
      vpc: this.vpc,
      description: 'Security group for Lambda functions',
      allowAllOutbound: true, // Lambdas need outbound to reach VPC endpoints / AWS services
    });

    this.apiGatewaySecurityGroup = new ec2.SecurityGroup(this, 'ApiGatewaySG', {
      vpc: this.vpc,
      description: 'Security group for API Gateway VPC endpoint',
      allowAllOutbound: false,
    });

    // Allow inbound HTTPS from VPC CIDR to API Gateway SG
    this.apiGatewaySecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS from VPC CIDR',
    );

    // Allow inbound HTTPS from Lambda SG to VPC endpoint SG
    this.vpcEndpointSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(443),
      'Allow HTTPS from Lambda SG',
    );

    // Allow inbound HTTPS from API Gateway SG to VPC endpoint SG
    this.vpcEndpointSecurityGroup.addIngressRule(
      this.apiGatewaySecurityGroup,
      ec2.Port.tcp(443),
      'Allow HTTPS from API Gateway SG',
    );

    // ── VPC Endpoints ─────────────────────────────────────────────────────────
    this.addMinimalEndpoints(vpcConfig.vpcEndpointMode);

    if (vpcConfig.vpcEndpointMode === 'full') {
      this.addFullEndpoints();
    }
  }

  private addMinimalEndpoints(mode: 'minimal' | 'full'): void {
    // Gateway endpoints (free, no SG needed)
    new ec2.GatewayVpcEndpoint(this, 'S3Endpoint', {
      vpc: this.vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    new ec2.GatewayVpcEndpoint(this, 'DynamoDbEndpoint', {
      vpc: this.vpc,
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Interface endpoints — minimal set
    this.addInterfaceEndpoint('StsEndpoint', ec2.InterfaceVpcEndpointAwsService.STS);
    this.addInterfaceEndpoint('KmsEndpoint', ec2.InterfaceVpcEndpointAwsService.KMS);
    this.addInterfaceEndpoint('CloudWatchLogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS);
    this.addInterfaceEndpoint('CloudWatchMonitoringEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING);
  }

  private addFullEndpoints(): void {
    this.addInterfaceEndpoint('LambdaEndpoint', ec2.InterfaceVpcEndpointAwsService.LAMBDA);
    this.addInterfaceEndpoint('SnsEndpoint', ec2.InterfaceVpcEndpointAwsService.SNS);
    this.addInterfaceEndpoint('SqsEndpoint', ec2.InterfaceVpcEndpointAwsService.SQS);
    this.addInterfaceEndpoint('GlueEndpoint', ec2.InterfaceVpcEndpointAwsService.GLUE);
    this.addInterfaceEndpoint('AthenaEndpoint', ec2.InterfaceVpcEndpointAwsService.ATHENA);
    this.addInterfaceEndpoint('IdentityStoreEndpoint', ec2.InterfaceVpcEndpointAwsService.IAM_IDENTITY_CENTER);
    this.addInterfaceEndpoint('PricingEndpoint', ec2.InterfaceVpcEndpointAwsService.PRICING_CALCULATOR);
    this.addInterfaceEndpoint('BedrockEndpoint', ec2.InterfaceVpcEndpointAwsService.BEDROCK);
    this.addInterfaceEndpoint('BedrockRuntimeEndpoint', ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME);
    this.addInterfaceEndpoint('CloudTrailEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDTRAIL);
    this.addInterfaceEndpoint('EventBridgeEndpoint', ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE);
  }

  private addInterfaceEndpoint(id: string, service: ec2.InterfaceVpcEndpointAwsService): ec2.InterfaceVpcEndpoint {
    return new ec2.InterfaceVpcEndpoint(this, id, {
      vpc: this.vpc,
      service,
      securityGroups: [this.vpcEndpointSecurityGroup],
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
  }
}
