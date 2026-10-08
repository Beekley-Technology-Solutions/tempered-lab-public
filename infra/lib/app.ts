import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { ClusterStack } from "./cluster-stack.js";
import type { Config } from "./config.js";
import { GuardrailsStack } from "./guardrails-stack.js";
import { NetworkStack } from "./network-stack.js";
import { PipelineStack } from "./pipeline-stack.js";

// Which stack lands in which account. Here rather than in bin/ so the tests synthesize exactly this.
// Hand-deployed:
//   make deploy-guardrails   (workload account)
//   make deploy-pipeline     (tools account)
export function buildApp(config: Config, app = new App()) {
  const guardrails = new GuardrailsStack(app, "TemperedLabGuardrails", config, {
    env: { account: config.workloadAccount, region: config.region },
  });
  const pipeline = new PipelineStack(app, "TemperedLabPipeline", config, {
    env: { account: config.toolsAccount, region: config.region },
  });
  // The lab: deployed by the lifecycle machine on spin-up, destroyed on tear-down.
  const workload = { account: config.workloadAccount, region: config.region };
  const network = new NetworkStack(app, "TemperedLabNetwork", config, { env: workload });
  const cluster = new ClusterStack(app, "TemperedLabCluster", config, network.vpc, { env: workload });
  // cdk-nag errors fail synth, so the PR gate's synth is also the nag gate.
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return { app, guardrails, pipeline, network, cluster };
}
