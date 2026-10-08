# 0009. Signatures, SBOM, and provenance are cosign records signed by the KMS key

Status: accepted (2026-10-08)

## Context

The plan asks for an SBOM, a signature, and provenance on every release, checked at admission by Kyverno. GitHub's artifact attestations aren't available to private repositories on the Team plan, and the plan rules out paid add-ons.

## Decision

- The release signs the image index digest with `cosign sign` and adds `cosign attest` records for SLSA provenance and a syft SBOM, all with the KMS key in the tools account. cosign v3 stores them as OCI 1.1 referrers (no tags), which ECR supports and which don't collide with immutable tags.
- Nothing is uploaded to the public Rekor transparency log: it would publish the digests of a private repository's images.
- Kyverno (≥ 1.19.1) checks the signature with an `ImageValidatingPolicy`, the replacement for the deprecated `ClusterPolicy` `verifyImages`. The KMS public key sits in the policy, so Kyverno never calls KMS; it fetches signatures from ECR with a Pod Identity role allowed to pull from the tools-account repositories. Images must be referenced by digest.

## Consequences

- Admission checks the signature, not a transparency-log entry (`ignoreTlog`). The KMS key and its CloudTrail record are the trust root.
- Provenance is ours, not GitHub's; it is signed by the same key the build role uses, so it proves "built by the release workflow", not "built by GitHub".
