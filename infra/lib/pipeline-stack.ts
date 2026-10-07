import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps, Validations } from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { Config } from "./config.js";

/** The object release.yml overwrites; each new S3 version is one release. */
export const RELEASE_KEY = "releases/tempered-lab.zip";

// Tools account, deployed by hand, never torn down. Phase 0 holds what GitHub builds into: the image
// repositories, the signing key, the release bucket, and `github-build`, the only role GitHub can
// assume. Phase 1 adds the CodePipeline that promotes the release zip.
export class PipelineStack extends Stack {
  readonly buildRole: iam.Role;

  constructor(scope: Construct, id: string, config: Config, props: StackProps = {}) {
    super(scope, id, props);

    const repositories = config.services.map((service) => {
      const repo = new ecr.Repository(this, `Repo-${service}`, {
        repositoryName: `tempered-lab/${service}`,
        imageTagMutability: ecr.TagMutability.IMMUTABLE, // a re-run can't replace a promoted image
        imageScanOnPush: true,
        removalPolicy: RemovalPolicy.RETAIN,
        lifecycleRules: [{ maxImageCount: 50 }],
      });
      repo.grantPull(new iam.AccountPrincipal(config.workloadAccount));
      return repo;
    });

    // Versioned: old versions are the rollback path, and the pipeline sees each upload as a revision.
    const releases = new s3.Bucket(this, "Releases", {
      bucketName: `tempered-lab-releases-${this.account}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // cosign signs image digests with this key; Kyverno checks the signature at admission (Phase 1).
    const signingKey = new kms.Key(this, "SigningKey", {
      alias: "tempered-lab/image-signing",
      description: "cosign signatures on tempered-lab images",
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // One provider per issuer per account, owned by the org's OIDC-Infra repo; import, never create.
    const github = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "Github",
      `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    // Exact subject, immutable IDs: only jobs in this repo's `build` environment, which is limited to main.
    // A renamed or re-created repo with the same name gets new IDs and no access.
    this.buildRole = new iam.Role(this, "BuildRole", {
      roleName: "tempered-lab-github-build",
      description: "GitHub Actions: push and sign images, upload the release zip. Nothing else.",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(github.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `${config.repoSubject}:environment:build`,
        },
      }),
    });
    for (const repo of repositories) {
      repo.grantPullPush(this.buildRole);
      repo.grant(this.buildRole, "ecr:DescribeImages");
    }
    signingKey.grant(this.buildRole, "kms:Sign", "kms:GetPublicKey", "kms:DescribeKey");
    // PutObject on the one key, not grantPut: that also grants tagging, retention, and legal hold.
    this.buildRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["s3:PutObject"], resources: [releases.arnForObjects(RELEASE_KEY)] }),
    );

    new CfnOutput(this, "BuildRoleArn", { value: this.buildRole.roleArn });
    new CfnOutput(this, "ReleaseBucket", { value: releases.bucketName });
    new CfnOutput(this, "SigningKeyArn", { value: signingKey.keyArn });

    Validations.of(releases).acknowledge({
      id: "AwsSolutions-S1",
      reason: "Access logs would need a second bucket; CloudTrail records writes, and only the build role can put.",
    });
    Validations.of(this.buildRole).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason: "ecr:GetAuthorizationToken has no resource scope.",
    });
  }
}
