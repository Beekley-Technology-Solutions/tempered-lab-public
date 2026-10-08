import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { type Config, loadConfig } from "./config.js";

const config = loadConfig({ TL_PLACEHOLDERS: "1" });

function lab(c: Config = config) {
  const { network, cluster } = buildApp(c, new App());
  return { network: Template.fromStack(network), cluster: Template.fromStack(cluster), stacks: { network, cluster } };
}

describe("lab network", () => {
  const { network, stacks } = lab();

  it("lives in the workload account, in the configured zones only", () => {
    expect(stacks.network.account).toBe(config.workloadAccount);
    const zones = Object.values(network.findResources("AWS::EC2::Subnet")).map((s) => s.Properties.AvailabilityZone);
    expect([...new Set(zones)].sort()).toEqual([...config.azs].sort());
  });

  it("has one NAT gateway and gives nothing a public address on launch", () => {
    network.resourceCountIs("AWS::EC2::NatGateway", 1);
    for (const subnet of Object.values(network.findResources("AWS::EC2::Subnet"))) {
      expect(subnet.Properties.MapPublicIpOnLaunch ?? false).toBe(false);
    }
  });

  it("tags private subnets for internal load balancers", () => {
    network.hasResourceProperties("AWS::EC2::Subnet", {
      Tags: Match.arrayWith([{ Key: "kubernetes.io/role/internal-elb", Value: "1" }]),
    });
  });
});

describe("lab cluster", () => {
  const { cluster, stacks } = lab();

  it("admits only the admin address to the public endpoint and keeps the private one", () => {
    expect(stacks.cluster.account).toBe(config.workloadAccount);
    cluster.hasResourceProperties("AWS::EKS::Cluster", {
      Version: "1.36",
      ResourcesVpcConfig: Match.objectLike({
        EndpointPublicAccess: true,
        EndpointPrivateAccess: true,
        PublicAccessCidrs: [config.adminCidr],
      }),
      AccessConfig: Match.objectLike({ AuthenticationMode: "API" }),
    });
  });

  it("uses a managed node group, not Auto Mode (FIS can't stop or terminate Auto Mode nodes)", () => {
    const [eksCluster] = Object.values(cluster.findResources("AWS::EKS::Cluster"));
    expect(eksCluster?.Properties.ComputeConfig?.Enabled ?? false).toBe(false);
    cluster.hasResourceProperties("AWS::EKS::Nodegroup", {
      AmiType: "AL2023_x86_64_STANDARD",
      InstanceTypes: ["t3.medium"],
      ScalingConfig: { MinSize: 3, DesiredSize: 3, MaxSize: 4 },
    });
  });

  it("switches nodes to Graviton with one config value", () => {
    const arm = lab({ ...config, nodeArch: "arm64" }).cluster;
    arm.hasResourceProperties("AWS::EKS::Nodegroup", {
      AmiType: "AL2023_ARM_64_STANDARD",
      InstanceTypes: ["t4g.medium"],
    });
  });

  it("enforces network policy in the VPC CNI and installs the Pod Identity agent", () => {
    cluster.hasResourceProperties("AWS::EKS::Addon", {
      AddonName: "vpc-cni",
      ConfigurationValues: JSON.stringify({ enableNetworkPolicy: "true" }),
    });
    cluster.hasResourceProperties("AWS::EKS::Addon", { AddonName: "eks-pod-identity-agent" });
  });

  it("brings networking up before nodes and coredns after them", () => {
    const [nodegroupId] = Object.keys(cluster.findResources("AWS::EKS::Nodegroup"));
    const addons = cluster.findResources("AWS::EKS::Addon");
    const byName = (n: string) => Object.entries(addons).find(([, a]) => a.Properties.AddonName === n);
    const nodegroup = cluster.findResources("AWS::EKS::Nodegroup")[nodegroupId as string];
    for (const n of ["vpc-cni", "kube-proxy", "eks-pod-identity-agent"]) {
      expect(nodegroup?.DependsOn).toContain(byName(n)?.[0]);
    }
    expect(byName("coredns")?.[1].DependsOn).toContain(nodegroupId);
  });

  it("gives the admin role cluster-admin through an access entry", () => {
    cluster.hasResourceProperties("AWS::EKS::AccessEntry", {
      PrincipalArn: config.adminRoleArn,
      AccessPolicies: [Match.objectLike({ AccessScope: { Type: "cluster" } })],
    });
  });
});

describe("lab config", () => {
  it("rejects an admin CIDR wider than one address, and a non-role admin ARN", () => {
    const base = { TL_PLACEHOLDERS: "1" };
    expect(() => loadConfig({ ...base, TL_ADMIN_CIDR: "0.0.0.0/0" })).toThrow(/TL_ADMIN_CIDR/);
    expect(() => loadConfig({ ...base, TL_ADMIN_CIDR: "10.0.0.0/24" })).toThrow(/TL_ADMIN_CIDR/);
    expect(() => loadConfig({ ...base, TL_ADMIN_ROLE_ARN: "arn:aws:iam::222222222222:user/tim" })).toThrow(
      /TL_ADMIN_ROLE_ARN/,
    );
  });
});
