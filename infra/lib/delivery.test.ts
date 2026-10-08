import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ALB_NAME, STAGES } from "./delivery-stack.js";

const config = loadConfig({ TL_PLACEHOLDERS: "1" });
const { delivery } = buildApp(config, new App());
const template = Template.fromStack(delivery);

// Kubernetes objects the kubectl handler applies. Manifests with tokens (an SG id) are Fn::Join; resolve
// those by substituting a marker for each token so the structure can still be inspected.
type K8sObject = {
  kind: string;
  apiVersion: string;
  metadata: { name: string; namespace?: string; annotations?: Record<string, string> };
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary manifest specs
  spec: any;
};
const objects: K8sObject[] = Object.values(template.findResources("Custom::AWSCDK-EKS-KubernetesResource")).flatMap(
  (r) => {
    const m = r.Properties.Manifest;
    const text =
      typeof m === "string" ? m : m["Fn::Join"][1].map((p: unknown) => (typeof p === "string" ? p : "TOKEN")).join("");
    return JSON.parse(text);
  },
);
const find = (kind: string, name: string) => objects.find((o) => o.kind === kind && o.metadata.name === name);

describe("admission: signed images only", () => {
  const policy = find("ImageValidatingPolicy", "require-tempered-lab-signature");

  it("denies unsigned images in every stage namespace", () => {
    expect(policy?.apiVersion).toBe("policies.kyverno.io/v1");
    expect(policy?.spec.validationActions).toEqual(["Deny"]);
    expect(policy?.spec.failurePolicy).toBe("Fail");
    expect(policy?.spec.matchConstraints.namespaceSelector.matchExpressions).toEqual([
      { key: "kubernetes.io/metadata.name", operator: "In", values: [...STAGES] },
    ]);
    expect(policy?.spec.matchImageReferences).toEqual([{ glob: "*" }]);
  });

  it("trusts exactly the release key and requires digests", () => {
    expect(policy?.spec.attestors[0].cosign.key.data).toBe(
      readFileSync(new URL("../../policy/image-signing.pub", import.meta.url), "utf8"),
    );
    expect(policy?.spec.validationConfigurations).toEqual({ mutateDigest: false, verifyDigest: true, required: true });
    const checked = policy?.spec.validations.map((v: { expression: string }) => v.expression).join(" ");
    expect(checked).toContain("images.containers");
    expect(checked).toContain("images.initContainers");
  });
});

describe("network policy", () => {
  it.each(STAGES)("denies all traffic in %s except DNS", (namespace) => {
    const deny = objects.find(
      (o) => o.kind === "NetworkPolicy" && o.metadata.name === "default-deny" && o.metadata.namespace === namespace,
    );
    expect(deny?.spec).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
    const dns = objects.find(
      (o) => o.kind === "NetworkPolicy" && o.metadata.name === "allow-dns" && o.metadata.namespace === namespace,
    );
    expect(dns?.spec.policyTypes).toEqual(["Egress"]);
    expect(dns?.spec.egress[0].ports.map((p: { port: number }) => p.port)).toEqual([53, 53]);
  });
});

describe("the shared ALB", () => {
  it("is internal, named for the edge to find, and fronted by our security group", () => {
    const ingress = find("Ingress", "tempered-lab-base");
    const a = ingress?.metadata.annotations ?? {};
    expect(a["alb.ingress.kubernetes.io/scheme"]).toBe("internal");
    expect(a["alb.ingress.kubernetes.io/load-balancer-name"]).toBe(ALB_NAME);
    expect(a["alb.ingress.kubernetes.io/group.name"]).toBe(ALB_NAME);
    expect(a["alb.ingress.kubernetes.io/security-groups"]).toBe("TOKEN");
  });

  it("admits only CloudFront's origin-facing addresses, on port 80, and sends nothing out itself", () => {
    // The controller attaches its own backend security group for traffic to pods; ours is inbound only.
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupEgress: [Match.objectLike({ CidrIp: "255.255.255.255/32", Description: "Disallow all traffic" })],
    });
    const rules = Object.values(template.findResources("AWS::EC2::SecurityGroupIngress")).map((r) => r.Properties);
    expect(rules).toEqual([
      expect.objectContaining({ SourcePrefixListId: "pl-3b927c52", FromPort: 80, ToPort: 80, IpProtocol: "tcp" }),
    ]);
  });
});

describe("controllers", () => {
  it("pins every chart version", () => {
    const charts = Object.values(template.findResources("Custom::AWSCDK-EKS-HelmChart")).map(
      (c) => `${c.Properties.Chart}@${c.Properties.Version}`,
    );
    expect(charts.sort()).toEqual(["argo-rollouts@2.43.6", "aws-load-balancer-controller@3.6.0", "kyverno@3.9.1"]);
  });

  it("binds the controllers' own service accounts through Pod Identity", () => {
    const bindings = Object.values(template.findResources("AWS::EKS::PodIdentityAssociation")).map(
      (a) => `${a.Properties.Namespace}/${a.Properties.ServiceAccount}`,
    );
    expect(bindings.sort()).toEqual([
      "kube-system/aws-load-balancer-controller",
      "kyverno/kyverno-admission-controller",
    ]);
    for (const role of Object.values(template.findResources("AWS::IAM::Role"))) {
      const principals = role.Properties.AssumeRolePolicyDocument.Statement.map(
        (s: { Principal: { Service: string } }) => s.Principal.Service,
      );
      expect(new Set(principals)).toEqual(new Set(["pods.eks.amazonaws.com"]));
    }
  });

  it("lets Kyverno read only the tools account's tempered-lab repositories", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages", "ecr:ListImages"],
            Resource: `arn:aws:ecr:${config.region}:${config.toolsAccount}:repository/tempered-lab/*`,
          }),
        ]),
      },
    });
  });
});
