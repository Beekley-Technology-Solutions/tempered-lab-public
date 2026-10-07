import { App, Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { GuardrailsStack } from "./guardrails-stack.js";
import { PipelineStack, RELEASE_KEY } from "./pipeline-stack.js";

const config = loadConfig({ TL_PLACEHOLDERS: "1" });

function synth() {
  const app = new App();
  const env = { account: config.toolsAccount, region: config.region };
  const pipeline = new PipelineStack(app, "Pipeline", config, { env });
  const guardrails = new GuardrailsStack(app, "Guardrails", config, {
    env: { ...env, account: config.workloadAccount },
  });
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  return { app, pipeline: Template.fromStack(pipeline), guardrails: Template.fromStack(guardrails) };
}

describe("github-build role", () => {
  const { pipeline } = synth();

  it("trusts only the build environment of this repo, by immutable subject", () => {
    pipeline.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub": `${config.repoSubject}:environment:build`,
              },
            },
          },
        ],
      },
    });
  });

  // The whole contract: if a grant is added anywhere, this list has to change in the same PR.
  it("can push and sign images and upload the release zip, and nothing else", () => {
    const policies = pipeline.findResources("AWS::IAM::Policy");
    const actions = Object.values(policies)
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .flatMap((s: { Action: string | string[] }) => [s.Action].flat())
      .sort();
    expect(actions).toEqual(
      [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:CompleteLayerUpload",
        "ecr:DescribeImages",
        "ecr:GetAuthorizationToken",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart",
        "kms:DescribeKey",
        "kms:GetPublicKey",
        "kms:Sign",
        "s3:PutObject",
      ].sort(),
    );
    expect(Object.keys(policies)).toHaveLength(1);
    pipeline.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:PutObject",
            Resource: { "Fn::Join": ["", [Match.anyValue(), `/${RELEASE_KEY}`]] },
          }),
        ]),
      },
    });
  });

  it("has no managed policies", () => {
    pipeline.hasResourceProperties("AWS::IAM::Role", { ManagedPolicyArns: Match.absent() });
  });
});

describe("image repositories", () => {
  it("have immutable tags and let the workload account pull", () => {
    const { pipeline } = synth();
    pipeline.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: "tempered-lab/gateway",
      ImageTagMutability: "IMMUTABLE",
    });
    const [repo] = Object.values(pipeline.findResources("AWS::ECR::Repository"));
    expect(JSON.stringify(repo?.Properties.RepositoryPolicyText.Statement[0].Principal)).toContain(
      `:${config.workloadAccount}:root`,
    );
  });
});

describe("guardrails", () => {
  const { guardrails } = synth();

  it("alerts on the monthly ceiling at 50%, 80%, forecast 100%, and actual 100%", () => {
    guardrails.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: { TimeUnit: "MONTHLY", BudgetLimit: { Amount: 100, Unit: "USD" } },
      NotificationsWithSubscribers: [
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 50 }) }),
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 80 }) }),
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: "FORECASTED", Threshold: 100 }) }),
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 100 }) }),
      ],
    });
  });

  it("has a daily budget", () => {
    guardrails.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: { TimeUnit: "DAILY", BudgetLimit: { Amount: 15, Unit: "USD" } },
    });
  });

  it("leaves CloudTrail to the organization trail", () => {
    guardrails.resourceCountIs("AWS::CloudTrail::Trail", 0);
  });

  it("keeps GuardDuty runtime monitoring off", () => {
    guardrails.hasResourceProperties("AWS::GuardDuty::Detector", {
      Features: Match.arrayWith([{ Name: "RUNTIME_MONITORING", Status: "DISABLED" }]),
    });
  });

  it("subscribes to an existing anomaly monitor instead of creating one", () => {
    const app = new App();
    const arn = "arn:aws:ce::222222222222:anomalymonitor/abc";
    const stack = new GuardrailsStack(app, "G", { ...config, anomalyMonitorArn: arn });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::CE::AnomalyMonitor", 0);
    template.hasResourceProperties("AWS::CE::AnomalySubscription", { MonitorArnList: [arn] });
  });
});

describe("cdk-nag", () => {
  it("has no unacknowledged findings", () => {
    expect(() => synth().app.synth()).not.toThrow();
  });

  it("fails synth on a finding", () => {
    const app = new App();
    const stack = new PipelineStack(app, "Pipeline", config, {
      env: { account: config.toolsAccount, region: config.region },
    });
    new s3.Bucket(stack, "NoAccessLogsNoSsl");
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    expect(() => app.synth()).toThrow(/AwsSolutions-S10/);
  });
});

describe("config", () => {
  it("refuses to synth without identifiers unless asked for placeholders", () => {
    expect(() => loadConfig({})).toThrow(/TL_TOOLS_ACCOUNT is not set/);
  });

  it("rejects malformed identifiers", () => {
    const base = { TL_PLACEHOLDERS: "1" };
    expect(() => loadConfig({ ...base, TL_WORKLOAD_ACCOUNT: "1234" })).toThrow(/12-digit/);
    expect(() => loadConfig({ ...base, TL_REPO_SUBJECT: "repo:org/tempered-lab" })).toThrow(/immutable form/);
    expect(() => loadConfig({ ...base, TL_NODE_ARCH: "riscv" })).toThrow(/TL_NODE_ARCH/);
    expect(() => loadConfig({ ...base, TL_MONTHLY_BUDGET_USD: "-5" })).toThrow(/positive/);
  });

  it("reads overrides", () => {
    const c = loadConfig({
      TL_PLACEHOLDERS: "1",
      TL_NODE_ARCH: "arm64",
      TL_LEASE_HOURS: "2",
      TL_ANOMALY_MONITOR_ARN: "arn:x",
    });
    expect(c).toMatchObject({ nodeArch: "arm64", leaseHours: 2, anomalyMonitorArn: "arn:x", monthlyBudgetUsd: 100 });
  });
});
