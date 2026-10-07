import { Stack, type StackProps, Validations } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ce from "aws-cdk-lib/aws-ce";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as guardduty from "aws-cdk-lib/aws-guardduty";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import type { Config } from "./config.js";

// Workload account. Deployed by hand before anything that bills, and never torn down.
// Budget data lags by hours, so these alerts are a backstop; the lease (Phase 1) is the real guard.
export class GuardrailsStack extends Stack {
  readonly alerts: sns.Topic;

  constructor(scope: Construct, id: string, config: Config, props: StackProps = {}) {
    super(scope, id, props);

    // Budgets and Cost Anomaly Detection can't publish to a topic encrypted with the AWS-managed SNS
    // key, and a customer key is $1/month for alerts that hold no secrets.
    this.alerts = new sns.Topic(this, "Alerts", { topicName: "tempered-lab-alerts", enforceSSL: true });
    this.alerts.addSubscription(new subscriptions.EmailSubscription(config.alertEmail));
    for (const service of ["budgets.amazonaws.com", "costalerts.amazonaws.com"]) {
      this.alerts.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal(service)],
          actions: ["sns:Publish"],
          resources: [this.alerts.topicArn],
          conditions: { StringEquals: { "aws:SourceAccount": this.account } },
        }),
      );
    }
    const toTopic = [{ subscriptionType: "SNS", address: this.alerts.topicArn }];
    const notify = (type: "ACTUAL" | "FORECASTED", threshold: number) => ({
      notification: {
        notificationType: type,
        comparisonOperator: "GREATER_THAN",
        threshold,
        thresholdType: "PERCENTAGE",
      },
      subscribers: toTopic,
    });

    // Phase 1 subscribes the lifecycle machine to the 100% actual alert: forced tear-down and a spin-up lock.
    const monthly = new budgets.CfnBudget(this, "Monthly", {
      budget: {
        budgetName: "tempered-lab-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: config.monthlyBudgetUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        notify("ACTUAL", 50),
        notify("ACTUAL", 80),
        notify("FORECASTED", 100),
        notify("ACTUAL", 100),
      ],
    });
    // Daily budgets take actual-cost notifications only.
    const daily = new budgets.CfnBudget(this, "Daily", {
      budget: {
        budgetName: "tempered-lab-daily",
        budgetType: "COST",
        timeUnit: "DAILY",
        budgetLimit: { amount: config.dailyBudgetUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [notify("ACTUAL", 100)],
    });
    // Budgets validate the subscriber at create time, so the topic policy must exist first.
    const policy = this.alerts.node.tryFindChild("Policy");
    if (policy) for (const budget of [monthly, daily]) budget.node.addDependency(policy);

    const monitorArn =
      config.anomalyMonitorArn ??
      new ce.CfnAnomalyMonitor(this, "AnomalyMonitor", {
        monitorName: "tempered-lab-services",
        monitorType: "DIMENSIONAL",
        monitorDimension: "SERVICE",
      }).attrMonitorArn;
    const anomalies = new ce.CfnAnomalySubscription(this, "AnomalyAlerts", {
      subscriptionName: "tempered-lab-anomalies",
      monitorArnList: [monitorArn],
      frequency: "IMMEDIATE", // IMMEDIATE takes SNS subscribers only
      subscribers: [{ type: "SNS", address: this.alerts.topicArn }],
      thresholdExpression: JSON.stringify({
        Dimensions: { Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE", MatchOptions: ["GREATER_THAN_OR_EQUAL"], Values: ["10"] },
      }),
    });
    if (policy) anomalies.node.addDependency(policy);

    // CloudTrail: the organization trail already covers this account (ADR 0007).

    // EKS audit logs on (the cluster is the thing under attack, by design). Runtime monitoring off: it
    // installs an agent in the cluster and bills per vCPU. Malware scans off: they bill per GB on findings.
    new guardduty.CfnDetector(this, "GuardDuty", {
      enable: true,
      findingPublishingFrequency: "FIFTEEN_MINUTES",
      features: [
        { name: "EKS_AUDIT_LOGS", status: "ENABLED" },
        { name: "RUNTIME_MONITORING", status: "DISABLED" },
        { name: "EBS_MALWARE_PROTECTION", status: "DISABLED" },
      ],
    });
    new events.Rule(this, "HighSeverityFindings", {
      eventPattern: {
        source: ["aws.guardduty"],
        detailType: ["GuardDuty Finding"],
        detail: { severity: [{ numeric: [">=", 7] }] },
      },
      targets: [new targets.SnsTopic(this.alerts)],
    });

    Validations.of(this.alerts).acknowledge({
      id: "AwsSolutions-SNS2",
      reason: "Budgets and Cost Anomaly Detection cannot publish to the AWS-managed key; alerts hold no secrets.",
    });
  }
}
