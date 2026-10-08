import { KubectlV36Layer } from "@aws-cdk/lambda-layer-kubectl-v36";
import { Stack, type StackProps, Validations } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as eks from "aws-cdk-lib/aws-eks-v2";
import type { Construct } from "constructs";
import type { Config } from "./config.js";

// Lab cluster: comes and goes with the lab. Managed node groups, never Auto Mode: Auto Mode refuses the
// FIS actions that stop, reboot, or terminate instances, which Phase 4 needs.
export class ClusterStack extends Stack {
  readonly cluster: eks.Cluster;

  constructor(scope: Construct, id: string, config: Config, vpc: ec2.IVpc, props: StackProps = {}) {
    super(scope, id, props);
    const arm = config.nodeArch === "arm64";

    this.cluster = new eks.Cluster(this, "Cluster", {
      clusterName: "tempered-lab",
      version: eks.KubernetesVersion.V1_36,
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      // Public endpoint for Tim's address only; everything else (kubectl handler, deployer, nodes) uses
      // the private endpoint inside the VPC.
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE.onlyFrom(config.adminCidr),
      defaultCapacityType: eks.DefaultCapacityType.NODEGROUP,
      defaultCapacity: 0,
      // vpc-cni, kube-proxy, and coredns are EKS managed add-ons below, so their config lives here.
      bootstrapSelfManagedAddons: false,
      // Applies manifests and Helm charts from a Lambda in the private subnets.
      kubectlProviderOptions: { kubectlLayer: new KubectlV36Layer(this, "Kubectl") },
    });
    this.cluster.grantClusterAdmin("Admin", config.adminRoleArn);

    // Networking add-ons come before nodes (a node is NotReady without a CNI); coredns after, since it
    // runs as pods. Network policy enforcement is the VPC CNI's own (eBPF), so default-deny needs nothing else.
    const addon = (name: string, configurationValues?: Record<string, string>) =>
      new eks.Addon(this, name, {
        cluster: this.cluster,
        addonName: name,
        ...(configurationValues && { configurationValues }),
      });
    const networking = [
      addon("vpc-cni", { enableNetworkPolicy: "true" }),
      addon("kube-proxy"),
      addon("eks-pod-identity-agent"),
    ];
    const nodes = this.cluster.addNodegroupCapacity("Nodes", {
      nodegroupName: "lab",
      instanceTypes: [new ec2.InstanceType(arm ? "t4g.medium" : "t3.medium")],
      // AL2 reached end of support; the CDK default is still AL2 unless the AMI type is set.
      amiType: arm ? eks.NodegroupAmiType.AL2023_ARM_64_STANDARD : eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
      minSize: config.nodeCount,
      desiredSize: config.nodeCount,
      maxSize: config.nodeCount + 1, // room for Phase 4's scale-out without a stack change
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    for (const a of networking) nodes.node.addDependency(a);
    addon("coredns").node.addDependency(nodes);

    // CDK's kubectl provider: its handler, roles, and framework are generated and pinned by CDK.
    const kubectlProvider = this.cluster.node.findChild("KubectlProvider");
    const managed = (reason: string, ...names: string[]) =>
      names.map((n) => ({ id: `AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/${n}]`, reason }));
    const ecrPublic = `AwsSolutions-IAM4[Policy::${JSON.stringify({
      "Fn::If": [
        "ClusterKubectlProviderHandlerHasEcrPublic69E09706",
        {
          "Fn::Join": [
            "",
            ["arn:", { Ref: "AWS::Partition" }, ":iam::aws:policy/AmazonElasticContainerRegistryPublicReadOnly"],
          ],
        },
        { Ref: "AWS::NoValue" },
      ],
    })}]`;
    Validations.of(kubectlProvider).acknowledge(
      { id: "AwsSolutions-L1", reason: "CDK pins the kubectl handler's runtime to match the kubectl layer." },
      ...managed(
        "CDK-generated execution roles for the kubectl handler and its provider framework.",
        "service-role/AWSLambdaBasicExecutionRole",
        "service-role/AWSLambdaVPCAccessExecutionRole",
        "AmazonEC2ContainerRegistryReadOnly",
      ),
      { id: ecrPublic, reason: "CDK-generated: lets the kubectl handler pull public chart images when asked to." },
      {
        id: "AwsSolutions-IAM5[Resource::<ClusterKubectlProviderHandler2E05C68A.Arn>:*]",
        reason: "CDK's provider framework invokes its own handler's versions.",
      },
    );
    Validations.of(this.cluster.role).acknowledge(...managed("Required by EKS.", "AmazonEKSClusterPolicy"));
    Validations.of(nodes.role).acknowledge(
      ...managed(
        "Required by EKS managed node groups.",
        "AmazonEKSWorkerNodePolicy",
        "AmazonEKS_CNI_Policy",
        "AmazonEC2ContainerRegistryReadOnly",
      ),
    );
    Validations.of(this).acknowledge(
      {
        id: "AwsSolutions-EKS1",
        reason:
          "The public endpoint admits one address (TL_ADMIN_CIDR); every in-VPC caller uses the private endpoint.",
      },
      {
        id: "AwsSolutions-EKS2",
        reason:
          "GuardDuty reads EKS audit logs from its own feed; control-plane log groups would outlive a leased lab.",
      },
    );
  }
}
