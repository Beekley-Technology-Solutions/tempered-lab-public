import { readFileSync } from "node:fs";
import { Duration, Stack, type StackProps, Validations } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as eks from "aws-cdk-lib/aws-eks-v2";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import type { Config } from "./config.js";

/** The internal ALB every stage shares. The edge looks it up by this name (ADR 0010). */
export const ALB_NAME = "tempered-lab";
/** Stage namespaces. Admission policy and default-deny network policy apply to these. */
export const STAGES = ["staging", "prod"] as const;
/** CloudFront's origin-facing managed prefix list in us-east-1 (an AWS constant, not ours). */
const CLOUDFRONT_ORIGIN_FACING = "pl-3b927c52";

const fromRepo = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

// Lab delivery: the controllers that turn a release into running, admitted pods. Comes and goes with the lab.
export class DeliveryStack extends Stack {
  readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, config: Config, cluster: eks.Cluster, props: StackProps = {}) {
    super(scope, id, props);
    const chart = (id: string, options: Omit<eks.HelmChartOptions, "wait" | "timeout">) =>
      new eks.HelmChart(this, id, { cluster, wait: true, timeout: Duration.minutes(10), ...options });
    // A role for a chart's own service account, bound by Pod Identity (namespace + name). The charts
    // create their service accounts; Kyverno's chart can't be told not to, so CDK never creates one.
    const podIdentity = (id: string, namespace: string, serviceAccount: string) => {
      const role = new iam.Role(this, id, {
        assumedBy: new iam.ServicePrincipal("pods.eks.amazonaws.com"),
        description: `Pod Identity: ${namespace}/${serviceAccount}`,
      });
      role.assumeRolePolicy?.addStatements(
        new iam.PolicyStatement({
          actions: ["sts:TagSession"],
          principals: [new iam.ServicePrincipal("pods.eks.amazonaws.com")],
        }),
      );
      new eks.CfnPodIdentityAssociation(this, `${id}Association`, {
        clusterName: cluster.clusterName,
        namespace,
        serviceAccount,
        roleArn: role.roleArn,
      });
      return role;
    };

    const namespaces = new eks.KubernetesManifest(this, "Namespaces", {
      cluster,
      manifest: [
        ...["kyverno", "argo-rollouts", "lab-edge"].map((name) => ({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name },
        })),
        ...STAGES.map((name) => ({
          apiVersion: "v1",
          kind: "Namespace",
          // Readiness gates: a pod counts as ready only once the ALB target is healthy, so a rollout
          // never removes the last healthy target.
          metadata: { name, labels: { "elbv2.k8s.aws/pod-readiness-gate-inject": "enabled" } },
        })),
      ],
    });

    // AWS Load Balancer Controller, with the upstream IAM policy for its release, through Pod Identity.
    const lbcRole = podIdentity("LbcRole", "kube-system", "aws-load-balancer-controller");
    const lbcPolicy = iam.PolicyDocument.fromJson(
      JSON.parse(fromRepo("infra/lib/policies/aws-load-balancer-controller.json")),
    );
    const lbcIamPolicy = new iam.Policy(this, "LbcPolicy", { document: lbcPolicy, roles: [lbcRole] });
    const lbc = chart("LoadBalancerController", {
      chart: "aws-load-balancer-controller",
      repository: "https://aws.github.io/eks-charts",
      version: "3.6.0",
      namespace: "kube-system",
      release: "aws-load-balancer-controller",
      values: {
        clusterName: cluster.clusterName,
        region: this.region,
        vpcId: cluster.vpc.vpcId,
        replicaCount: 1,
        serviceAccount: { name: "aws-load-balancer-controller" },
        // Only Ingress (ALB) is needed; leave Services of type LoadBalancer alone.
        enableServiceMutatorWebhook: false,
      },
    });
    lbc.node.addDependency(lbcRole);

    const rollouts = chart("ArgoRollouts", {
      chart: "argo-rollouts",
      repository: "https://argoproj.github.io/argo-helm",
      version: "2.43.6",
      namespace: "argo-rollouts",
      release: "argo-rollouts",
      // Aggregate roles (default on) add Rollout permissions to the built-in edit role the deployer gets.
      values: { controller: { replicas: 1 }, dashboard: { enabled: false } },
    });
    rollouts.node.addDependency(namespaces);

    // Kyverno: admission control for the stage namespaces. Its admission controller pulls signatures
    // from the tools account's ECR through Pod Identity.
    const kyvernoRole = podIdentity("KyvernoRole", "kyverno", "kyverno-admission-controller");
    kyvernoRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }),
    );
    kyvernoRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages", "ecr:ListImages"],
        resources: [`arn:aws:ecr:${this.region}:${config.toolsAccount}:repository/tempered-lab/*`],
      }),
    );
    const kyverno = chart("Kyverno", {
      chart: "kyverno",
      repository: "https://kyverno.github.io/kyverno",
      version: "3.9.1",
      namespace: "kyverno",
      release: "kyverno",
      values: {
        admissionController: { replicas: 1 },
        backgroundController: { replicas: 1 },
        cleanupController: { replicas: 1 },
        reportsController: { replicas: 1 },
      },
    });
    kyverno.node.addDependency(kyvernoRole, namespaces);

    // Every image in a stage namespace must carry our KMS signature (ADR 0009). A hand-pushed or
    // third-party image is refused at admission.
    const signedImages = new eks.KubernetesManifest(this, "RequireSignedImages", {
      cluster,
      manifest: [
        {
          apiVersion: "policies.kyverno.io/v1",
          kind: "ImageValidatingPolicy",
          metadata: { name: "require-tempered-lab-signature" },
          spec: {
            validationActions: ["Deny"],
            failurePolicy: "Fail",
            webhookConfiguration: { timeoutSeconds: 15 },
            matchConstraints: {
              namespaceSelector: {
                matchExpressions: [{ key: "kubernetes.io/metadata.name", operator: "In", values: [...STAGES] }],
              },
              resourceRules: [
                { apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"], resources: ["pods"] },
              ],
            },
            matchImageReferences: [{ glob: "*" }],
            credentials: { providers: ["amazon"] },
            // Pinned by digest in the chart; refuse a tag rather than resolve one.
            validationConfigurations: { mutateDigest: false, verifyDigest: true, required: true },
            attestors: [
              {
                name: "release",
                cosign: {
                  key: { data: fromRepo("policy/image-signing.pub") },
                  // Signatures are not uploaded to the public transparency log (ADR 0009).
                  ctlog: { insecureIgnoreTlog: true, insecureIgnoreSCT: true },
                },
              },
            ],
            validations: [
              {
                expression:
                  "images.containers.map(image, verifyImageSignatures(image, [attestors.release])).all(e, e > 0)",
                message: "image is not signed by the Tempered Lab release key",
              },
              {
                expression:
                  "images.initContainers.map(image, verifyImageSignatures(image, [attestors.release])).all(e, e > 0)",
                message: "init container image is not signed by the Tempered Lab release key",
              },
            ],
          },
        },
      ],
    });
    signedImages.node.addDependency(kyverno);

    // Default deny in each stage: no traffic in or out except DNS. Each chart opens exactly what it needs.
    const defaultDeny = new eks.KubernetesManifest(this, "DefaultDeny", {
      cluster,
      manifest: STAGES.flatMap((namespace) => [
        {
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          metadata: { name: "default-deny", namespace },
          spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
        },
        {
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          metadata: { name: "allow-dns", namespace },
          spec: {
            podSelector: {},
            policyTypes: ["Egress"],
            egress: [
              {
                to: [
                  {
                    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
                    podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
                  },
                ],
                ports: [
                  { protocol: "UDP", port: 53 },
                  { protocol: "TCP", port: 53 },
                ],
              },
            ],
          },
        },
      ]),
    });
    defaultDeny.node.addDependency(namespaces);

    // The shared internal ALB, created now with only a 404 default so the edge can be built before any
    // release. Stage charts add their rules to the same ingress group. Only CloudFront can reach it.
    this.albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: cluster.vpc,
      description: "Tempered Lab ALB: HTTP from CloudFront origin-facing addresses only",
      allowAllOutbound: false,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(CLOUDFRONT_ORIGIN_FACING),
      ec2.Port.tcp(80),
      "CloudFront VPC origin",
    );
    const baseIngress = new eks.KubernetesManifest(this, "BaseIngress", {
      cluster,
      manifest: [
        {
          apiVersion: "networking.k8s.io/v1",
          kind: "Ingress",
          metadata: {
            name: "tempered-lab-base",
            namespace: "lab-edge",
            annotations: {
              "alb.ingress.kubernetes.io/group.name": ALB_NAME,
              "alb.ingress.kubernetes.io/group.order": "1000",
              "alb.ingress.kubernetes.io/load-balancer-name": ALB_NAME,
              "alb.ingress.kubernetes.io/scheme": "internal",
              "alb.ingress.kubernetes.io/target-type": "ip",
              "alb.ingress.kubernetes.io/listen-ports": '[{"HTTP":80}]',
              "alb.ingress.kubernetes.io/security-groups": this.albSecurityGroup.securityGroupId,
              "alb.ingress.kubernetes.io/manage-backend-security-group-rules": "true",
              "alb.ingress.kubernetes.io/tags": "tempered-lab=lab",
              "alb.ingress.kubernetes.io/actions.not-found":
                '{"type":"fixed-response","fixedResponseConfig":{"contentType":"text/plain","statusCode":"404","messageBody":"not found"}}',
            },
          },
          spec: {
            ingressClassName: "alb",
            defaultBackend: { service: { name: "not-found", port: { name: "use-annotation" } } },
          },
        },
      ],
    });
    baseIngress.node.addDependency(lbc, namespaces);

    // The controller's policy is upstream's, vendored per release; its wildcards are tag-conditioned there.
    const wildcards = new Set<string>();
    for (const statement of lbcPolicy.toJSON().Statement as {
      Action: string | string[];
      Resource: string | string[];
    }[]) {
      for (const r of [statement.Resource].flat()) if (r.includes("*")) wildcards.add(`Resource::${r}`);
      for (const a of [statement.Action].flat()) if (a.includes("*")) wildcards.add(`Action::${a}`);
    }
    Validations.of(lbcIamPolicy).acknowledge(
      ...[...wildcards].map((w) => ({
        id: `AwsSolutions-IAM5[${w}]`,
        reason: "Upstream AWS Load Balancer Controller IAM policy for this release (tag-conditioned upstream).",
      })),
    );
    Validations.of(kyvernoRole).acknowledge(
      { id: "AwsSolutions-IAM5[Resource::*]", reason: "ecr:GetAuthorizationToken has no resource scope." },
      {
        id: `AwsSolutions-IAM5[Resource::arn:aws:ecr:${this.region}:${config.toolsAccount}:repository/tempered-lab/*]`,
        reason: "Kyverno reads signatures from every tempered-lab image repository.",
      },
    );
    Validations.of(this.albSecurityGroup).acknowledge({
      id: "AwsSolutions-EC23",
      reason: "Ingress is CloudFront's origin-facing prefix list only, not 0.0.0.0/0.",
    });
  }
}
