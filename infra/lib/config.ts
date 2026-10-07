// Every identifier comes from the environment (ADR 0004): this repo is published, so account IDs,
// emails, and repo subjects never appear in code. TL_PLACEHOLDERS=1 swaps in obvious fakes so the
// PR gate can synth without them; without it, a missing value stops synth instead of deploying a fake.

export interface Config {
  region: string;
  toolsAccount: string;
  workloadAccount: string;
  /** Budget, anomaly, and security alerts. */
  alertEmail: string;
  /** Immutable OIDC subject prefix, `repo:<org>@<id>/<repo>@<id>`, from
   *  `gh api repos/<org>/<repo>/actions/oidc/customization/sub -q .sub_claim_prefix`. */
  repoSubject: string;
  /** Existing Cost Anomaly Detection services monitor to subscribe to. AWS creates one in new
   *  accounts and allows only one per account; unset, Guardrails creates it. */
  anomalyMonitorArn: string | undefined;
  monthlyBudgetUsd: number;
  dailyBudgetUsd: number;
  leaseHours: number;
  nodeArch: "x86_64" | "arm64";
  /** Image repositories under `tempered-lab/`, one per service. */
  services: string[];
}

const PLACEHOLDERS = {
  TL_TOOLS_ACCOUNT: "111111111111",
  TL_WORKLOAD_ACCOUNT: "222222222222",
  TL_ALERT_EMAIL: "alerts@example.com",
  TL_REPO_SUBJECT: "repo:example-org@0/tempered-lab@0",
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const placeholders = env.TL_PLACEHOLDERS === "1";
  const required = (name: keyof typeof PLACEHOLDERS): string => {
    const value = env[name] || (placeholders ? PLACEHOLDERS[name] : undefined);
    if (!value)
      throw new Error(`${name} is not set. Put it in .env (see docs/bootstrap.md), or set TL_PLACEHOLDERS=1 to synth.`);
    return value;
  };
  const number = (name: string, fallback: number): number => {
    const value = Number(env[name] ?? fallback);
    if (!(value > 0)) throw new Error(`${name} must be a positive number`);
    return value;
  };
  const accounts = ["TL_TOOLS_ACCOUNT", "TL_WORKLOAD_ACCOUNT"] as const;
  for (const name of accounts) {
    if (!/^\d{12}$/.test(required(name))) throw new Error(`${name} must be a 12-digit account ID`);
  }
  if (!/^repo:[^/]+@\d+\/[^/]+@\d+$/.test(required("TL_REPO_SUBJECT"))) {
    throw new Error("TL_REPO_SUBJECT must be the immutable form repo:<org>@<id>/<repo>@<id>");
  }
  const nodeArch = env.TL_NODE_ARCH ?? "x86_64";
  if (nodeArch !== "x86_64" && nodeArch !== "arm64") throw new Error("TL_NODE_ARCH must be x86_64 or arm64");

  return {
    region: env.TL_REGION ?? "us-east-1",
    toolsAccount: required("TL_TOOLS_ACCOUNT"),
    workloadAccount: required("TL_WORKLOAD_ACCOUNT"),
    alertEmail: required("TL_ALERT_EMAIL"),
    repoSubject: required("TL_REPO_SUBJECT"),
    anomalyMonitorArn: env.TL_ANOMALY_MONITOR_ARN || undefined,
    monthlyBudgetUsd: number("TL_MONTHLY_BUDGET_USD", 100),
    dailyBudgetUsd: number("TL_DAILY_BUDGET_USD", 15),
    leaseHours: number("TL_LEASE_HOURS", 4),
    nodeArch,
    services: ["gateway"],
  };
}
