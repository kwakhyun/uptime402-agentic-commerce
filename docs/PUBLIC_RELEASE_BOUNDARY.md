# Public release boundary

This repository is a sanitized, reproducible source release of Uptime402. Functional source,
tests, deployment templates, canonical `artifacts/payment-evidence.json`, the independent
verification report, public protocol artifacts, leaf IAM proofs, and the deck are included.

The public snapshot intentionally omits:

- raw Cloud Run service and revision descriptions;
- rendered runtime service YAML exports;
- project-wide IAM and project metadata exports;
- raw recovered-state snapshots containing the operator identity;
- `.env*` runtime files, credentials, keypairs, tokens, private captures, build outputs, and
  QA-failed or unaccepted video files.

Those omitted deployment artifacts contain no payment secret value, but they expose operator
identity, literal runtime configuration, service metadata, and Secret Manager reference names.
Their original SHA-256 commitments remain in the canonical hash-pinned payment evidence and
verification report. Public `artifacts/final-release.json` is explicitly a derived QA summary,
not payment evidence, and indexes only the retained public-safe leaf IAM artifacts.

`artifacts/payment-evidence.json` is deliberately left byte-for-byte unchanged so that its
published SHA-256 remains
`0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4` and continues to bind
the deployed final replay. It contains the operator identity used by the verified policy rule;
that field is audit evidence, not a credential or secret.
