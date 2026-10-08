import { Stack, type StackProps, Tags, Validations } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";
import type { Config } from "./config.js";

// Lab network: comes and goes with the lab. Private subnets hold the nodes, the internal ALB, the
// kubectl handler, and the deployer; one NAT gateway (not one per AZ) is their way out.
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  private readonly azs: string[];

  constructor(scope: Construct, id: string, config: Config, props: StackProps = {}) {
    super(scope, id, props);
    this.azs = config.azs;
    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: "tempered-lab",
      ipAddresses: ec2.IpAddresses.cidr("10.40.0.0/16"),
      availabilityZones: this.azs,
      natGateways: 1,
      subnetConfiguration: [
        // Public subnets hold only the NAT gateway. The VPC's internet gateway is also what CloudFront
        // VPC origins require; nothing in the lab gets a public address.
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, mapPublicIpOnLaunch: false },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
      ],
      // Free, and keeps image layer pulls (S3-backed) off the NAT gateway.
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });
    // The AWS Load Balancer Controller places internal ALBs in subnets carrying this tag.
    for (const subnet of this.vpc.privateSubnets) Tags.of(subnet).add("kubernetes.io/role/internal-elb", "1");

    Validations.of(this.vpc).acknowledge({
      id: "AwsSolutions-VPC7",
      reason: "GuardDuty analyses VPC flow logs from its own feed; a lab torn down every session keeps none.",
    });
  }

  // The zones come from config, so CDK needn't look them up: a lookup would need credentials at synth
  // and would write the account ID into cdk.context.json (ADR 0004).
  override get availabilityZones(): string[] {
    return this.azs;
  }
}
