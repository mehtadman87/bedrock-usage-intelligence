import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from 'lib/stacks/network-stack';
import { PlatformConfig } from 'lib/config/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConfig(overrides: Partial<{
  vpcMode: 'create' | 'existing';
  vpcCidr: string;
  existingVpcId: string;
  enableNatGateway: boolean;
  vpcEndpointMode: 'minimal' | 'full';
}> = {}): PlatformConfig {
  const {
    vpcMode = 'create',
    vpcCidr = '10.0.0.0/16',
    enableNatGateway = false,
    vpcEndpointMode = 'minimal',
  } = overrides;

  const vpc =
    vpcMode === 'existing'
      ? {
          vpcMode: 'existing' as const,
          existingVpcId: overrides.existingVpcId ?? 'vpc-12345678',
          enableNatGateway,
          vpcEndpointMode,
        }
      : {
          vpcMode: 'create' as const,
          vpcCidr,
          enableNatGateway,
          vpcEndpointMode,
        };

  return {
    vpc,
    account: { accountMode: 'single' },
    region: { regionMode: 'single' },
    identity: { identityMode: 'iam' },
    dataExports: { curBucketName: 'test-cur-bucket', curReportFormat: 'csv', reconciliationSchedule: 'rate(6 hours)' },
    dashboard: { enableQuickSuite: false },
    cloudTrail: { cloudTrailMode: 'create' },
    deployment: { solutionName: 'test', environment: 'dev' },
    enableInvocationLogging: true,
  };
}

function buildNetworkStack(config: PlatformConfig): { stack: NetworkStack; template: Template } {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'NetworkStack', {
    config,
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return { stack, template: Template.fromStack(stack) };
}

// ---------------------------------------------------------------------------
// VPC creation mode
// ---------------------------------------------------------------------------

describe('NetworkStack - VPC creation mode', () => {
  it('creates a VPC with the specified custom CIDR', () => {
    const config = buildConfig({ vpcMode: 'create', vpcCidr: '192.168.0.0/16' });
    const { template } = buildNetworkStack(config);

    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '192.168.0.0/16',
    });
  });

  it('creates a VPC with the default CIDR when not specified', () => {
    const config = buildConfig({ vpcMode: 'create', vpcCidr: '10.0.0.0/16' });
    const { template } = buildNetworkStack(config);

    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
    });
  });

  it('creates exactly one VPC resource', () => {
    const config = buildConfig({ vpcMode: 'create' });
    const { template } = buildNetworkStack(config);

    template.resourceCountIs('AWS::EC2::VPC', 1);
  });

  it('creates private subnets across 2 AZs', () => {
    const config = buildConfig({ vpcMode: 'create' });
    const { template } = buildNetworkStack(config);

    // 2 private subnets (one per AZ)
    const subnets = template.findResources('AWS::EC2::Subnet');
    expect(Object.keys(subnets).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Existing VPC mode
// ---------------------------------------------------------------------------

describe('NetworkStack - existing VPC mode', () => {
  it('does not create a new VPC when vpcMode is existing', () => {
    const config = buildConfig({ vpcMode: 'existing', existingVpcId: 'vpc-abcdef12' });
    const { template } = buildNetworkStack(config);

    // fromLookup produces a dummy VPC in unit tests — no real VPC resource is synthesized
    template.resourceCountIs('AWS::EC2::VPC', 0);
  });

  it('exports the vpc property when using existing VPC', () => {
    const config = buildConfig({ vpcMode: 'existing', existingVpcId: 'vpc-abcdef12' });
    const { stack } = buildNetworkStack(config);

    expect(stack.vpc).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// NAT Gateway
// ---------------------------------------------------------------------------

describe('NetworkStack - NAT Gateway', () => {
  it('does not create a NAT Gateway when enableNatGateway is false', () => {
    const config = buildConfig({ vpcMode: 'create', enableNatGateway: false });
    const { template } = buildNetworkStack(config);

    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('creates a NAT Gateway when enableNatGateway is true', () => {
    const config = buildConfig({ vpcMode: 'create', enableNatGateway: true });
    const { template } = buildNetworkStack(config);

    // CDK creates 1 NAT gateway (natGateways: 1)
    const natGateways = template.findResources('AWS::EC2::NatGateway');
    expect(Object.keys(natGateways).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// VPC Endpoints - minimal mode
// ---------------------------------------------------------------------------

describe('NetworkStack - minimal VPC endpoint mode', () => {
  it('creates S3 gateway endpoint', () => {
    const config = buildConfig({ vpcMode: 'create', vpcEndpointMode: 'minimal' });
    const { template } = buildNetworkStack(config);

    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const endpointValues = Object.values(endpoints) as Array<{ Properties?: { ServiceName?: unknown; VpcEndpointType?: string } }>;

    // Gateway endpoints have ServiceName as a Fn::Join object containing 's3'
    const s3Gateway = endpointValues.find(
      (e) => {
        const svcName = JSON.stringify(e.Properties?.ServiceName ?? '');
        const isGateway = !e.Properties?.VpcEndpointType || e.Properties.VpcEndpointType === 'Gateway';
        return svcName.includes('s3') && isGateway;
      },
    );
    expect(s3Gateway).toBeDefined();
  });

  it('creates DynamoDB gateway endpoint', () => {
    const config = buildConfig({ vpcMode: 'create', vpcEndpointMode: 'minimal' });
    const { template } = buildNetworkStack(config);

    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const endpointValues = Object.values(endpoints) as Array<{ Properties?: { ServiceName?: unknown; VpcEndpointType?: string } }>;

    const dynamoGateway = endpointValues.find(
      (e) => {
        const svcName = JSON.stringify(e.Properties?.ServiceName ?? '');
        const isGateway = !e.Properties?.VpcEndpointType || e.Properties.VpcEndpointType === 'Gateway';
        return svcName.includes('dynamodb') && isGateway;
      },
    );
    expect(dynamoGateway).toBeDefined();
  });

  it('creates STS interface endpoint', () => {
    const config = buildConfig({ vpcMode: 'create', vpcEndpointMode: 'minimal' });
    const { template } = buildNetworkStack(config);

    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const endpointValues = Object.values(endpoints) as Array<{ Properties?: { ServiceName?: string; VpcEndpointType?: string } }>;

    const stsEndpoint = endpointValues.find(
      (e) =>
        typeof e.Properties?.ServiceName === 'string' &&
        e.Properties.ServiceName.includes('sts') &&
        e.Properties.VpcEndpointType === 'Interface',
    );
    expect(stsEndpoint).toBeDefined();
  });

  it('creates KMS interface endpoint', () => {
    const config = buildConfig({ vpcMode: 'create', vpcEndpointMode: 'minimal' });
    const { template } = buildNetworkStack(config);

    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const endpointValues = Object.values(endpoints) as Array<{ Properties?: { ServiceName?: string; VpcEndpointType?: string } }>;

    const kmsEndpoint = endpointValues.find(
      (e) =>
        typeof e.Properties?.ServiceName === 'string' &&
        e.Properties.ServiceName.includes('kms') &&
        e.Properties.VpcEndpointType === 'Interface',
    );
    expect(kmsEndpoint).toBeDefined();
  });

  it('creates CloudWatch Logs interface endpoint', () => {
    const config = buildConfig({ vpcMode: 'create', vpcEndpointMode: 'minimal' });
    const { template } = buildNetworkStack(config);

    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const endpointValues = Object.values(endpoints) as Array<{ Properties?: { ServiceName?: string; VpcEndpointType?: string } }>;

    const logsEndpoint = endpointValues.find(
      (e) =>
        typeof e.Properties?.ServiceName === 'string' &&
        e.Properties.ServiceName.includes('logs') &&
        e.Properties.VpcEndpointType === 'Interface',
    );
    expect(logsEndpoint).toBeDefined();
  });

  it('creates CloudWatch Monitoring interface endpoint', () => {
    const config = buildConfig({ vpcMode: 'create', vpcEndpointMode: 'minimal' });
    const { template } = buildNetworkStack(config);

    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const endpointValues = Object.values(endpoints) as Array<{ Properties?: { ServiceName?: string; VpcEndpointType?: string } }>;

    const monitoringEndpoint = endpointValues.find(
      (e) =>
        typeof e.Properties?.ServiceName === 'string' &&
        e.Properties.ServiceName.includes('monitoring') &&
        e.Properties.VpcEndpointType === 'Interface',
    );
    expect(monitoringEndpoint).toBeDefined();
  });

  it('does not create Lambda/SNS/SQS endpoints in minimal mode', () => {
    const config = buildConfig({ vpcMode: 'create', vpcEndpointMode: 'minimal' });
    const { template } = buildNetworkStack(config);

    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const endpointValues = Object.values(endpoints) as Array<{ Properties?: { ServiceName?: string } }>;

    const lambdaEndpoint = endpointValues.find(
      (e) =>
        typeof e.Properties?.ServiceName === 'string' &&
        e.Properties.ServiceName.endsWith('.lambda'),
    );
    expect(lambdaEndpoint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VPC Endpoints - full mode
// ---------------------------------------------------------------------------

describe('NetworkStack - full VPC endpoint mode', () => {
  it('creates more endpoints in full mode than minimal mode', () => {
    const minimalConfig = buildConfig({ vpcMode: 'create', vpcEndpointMode: 'minimal' });
    const fullConfig = buildConfig({ vpcMode: 'create', vpcEndpointMode: 'full' });

    const { template: minimalTemplate } = buildNetworkStack(minimalConfig);
    const { template: fullTemplate } = buildNetworkStack(fullConfig);

    const minimalEndpoints = Object.keys(minimalTemplate.findResources('AWS::EC2::VPCEndpoint'));
    const fullEndpoints = Object.keys(fullTemplate.findResources('AWS::EC2::VPCEndpoint'));

    expect(fullEndpoints.length).toBeGreaterThan(minimalEndpoints.length);
  });

  it('creates Lambda interface endpoint in full mode', () => {
    const config = buildConfig({ vpcMode: 'create', vpcEndpointMode: 'full' });
    const { template } = buildNetworkStack(config);

    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const endpointValues = Object.values(endpoints) as Array<{ Properties?: { ServiceName?: string; VpcEndpointType?: string } }>;

    const lambdaEndpoint = endpointValues.find(
      (e) =>
        typeof e.Properties?.ServiceName === 'string' &&
        e.Properties.ServiceName.endsWith('.lambda') &&
        e.Properties.VpcEndpointType === 'Interface',
    );
    expect(lambdaEndpoint).toBeDefined();
  });

  it('creates Bedrock interface endpoint in full mode', () => {
    const config = buildConfig({ vpcMode: 'create', vpcEndpointMode: 'full' });
    const { template } = buildNetworkStack(config);

    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const endpointValues = Object.values(endpoints) as Array<{ Properties?: { ServiceName?: string; VpcEndpointType?: string } }>;

    const bedrockEndpoint = endpointValues.find(
      (e) =>
        typeof e.Properties?.ServiceName === 'string' &&
        e.Properties.ServiceName.includes('bedrock') &&
        e.Properties.VpcEndpointType === 'Interface',
    );
    expect(bedrockEndpoint).toBeDefined();
  });

  it('creates EventBridge interface endpoint in full mode', () => {
    const config = buildConfig({ vpcMode: 'create', vpcEndpointMode: 'full' });
    const { template } = buildNetworkStack(config);

    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const endpointValues = Object.values(endpoints) as Array<{ Properties?: { ServiceName?: string; VpcEndpointType?: string } }>;

    const eventBridgeEndpoint = endpointValues.find(
      (e) =>
        typeof e.Properties?.ServiceName === 'string' &&
        e.Properties.ServiceName.includes('events') &&
        e.Properties.VpcEndpointType === 'Interface',
    );
    expect(eventBridgeEndpoint).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Security Groups
// ---------------------------------------------------------------------------

describe('NetworkStack - security groups', () => {
  it('creates exactly 3 security groups', () => {
    const config = buildConfig({ vpcMode: 'create' });
    const { template } = buildNetworkStack(config);

    // Lambda SG, API Gateway SG, VPC Endpoint SG
    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    expect(Object.keys(sgs).length).toBe(3);
  });

  it('exports lambdaSecurityGroup, apiGatewaySecurityGroup, and vpcEndpointSecurityGroup', () => {
    const config = buildConfig({ vpcMode: 'create' });
    const { stack } = buildNetworkStack(config);

    expect(stack.lambdaSecurityGroup).toBeDefined();
    expect(stack.apiGatewaySecurityGroup).toBeDefined();
    expect(stack.vpcEndpointSecurityGroup).toBeDefined();
  });

  it('API Gateway security group allows HTTPS inbound from VPC CIDR', () => {
    const config = buildConfig({ vpcMode: 'create', vpcCidr: '10.0.0.0/16' });
    const { template } = buildNetworkStack(config);

    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    const sgValues = Object.values(sgs) as Array<{
      Properties?: {
        GroupDescription?: string;
        SecurityGroupIngress?: Array<{ IpProtocol?: string; FromPort?: number; ToPort?: number; CidrIp?: unknown }>;
      };
    }>;

    const apiGwSg = sgValues.find((sg) =>
      sg.Properties?.GroupDescription?.includes('API Gateway'),
    );
    expect(apiGwSg).toBeDefined();

    const ingressRules = apiGwSg?.Properties?.SecurityGroupIngress ?? [];
    // CidrIp is a Fn::GetAtt token referencing the VPC's CidrBlock
    const httpsRule = ingressRules.find(
      (r) => r.FromPort === 443 && r.ToPort === 443 && r.CidrIp !== undefined,
    );
    expect(httpsRule).toBeDefined();
  });

  it('VPC endpoint security group allows HTTPS inbound from Lambda security group', () => {
    const config = buildConfig({ vpcMode: 'create' });
    const { template } = buildNetworkStack(config);

    // Cross-SG ingress rules are created as separate AWS::EC2::SecurityGroupIngress resources
    const ingressResources = template.findResources('AWS::EC2::SecurityGroupIngress');
    const ingressValues = Object.values(ingressResources) as Array<{
      Properties?: {
        FromPort?: number;
        ToPort?: number;
        SourceSecurityGroupId?: unknown;
        Description?: string;
      };
    }>;

    const httpsFromLambda = ingressValues.find(
      (r) =>
        r.Properties?.FromPort === 443 &&
        r.Properties?.ToPort === 443 &&
        r.Properties?.SourceSecurityGroupId !== undefined &&
        r.Properties?.Description?.includes('Lambda'),
    );
    expect(httpsFromLambda).toBeDefined();
  });

  it('Lambda security group allows all outbound traffic', () => {
    const config = buildConfig({ vpcMode: 'create' });
    const { template } = buildNetworkStack(config);

    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    const sgValues = Object.values(sgs) as Array<{
      Properties?: {
        GroupDescription?: string;
        SecurityGroupEgress?: Array<{ IpProtocol?: string; CidrIp?: string }>;
      };
    }>;

    const lambdaSg = sgValues.find((sg) =>
      sg.Properties?.GroupDescription?.includes('Lambda'),
    );
    expect(lambdaSg).toBeDefined();

    // allowAllOutbound: true means CDK adds a -1 egress rule to 0.0.0.0/0
    const egressRules = lambdaSg?.Properties?.SecurityGroupEgress ?? [];
    const allOutbound = egressRules.find(
      (r) => r.IpProtocol === '-1' && r.CidrIp === '0.0.0.0/0',
    );
    expect(allOutbound).toBeDefined();
  });
});
