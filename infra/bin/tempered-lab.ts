import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { loadConfig } from "../lib/config.js";
import { GuardrailsStack } from "../lib/guardrails-stack.js";
import { PipelineStack } from "../lib/pipeline-stack.js";

// Identifiers come from TL_* environment variables (lib/config.ts, ADR 0004). Hand-deployed stacks:
//   make deploy-guardrails   (workload account)
//   make deploy-pipeline     (tools account)
const config = loadConfig();
const app = new App();

new GuardrailsStack(app, "TemperedLabGuardrails", config, {
  env: { account: config.workloadAccount, region: config.region },
});
new PipelineStack(app, "TemperedLabPipeline", config, {
  env: { account: config.toolsAccount, region: config.region },
});

// cdk-nag errors fail synth, so the PR gate's synth is also the nag gate.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
