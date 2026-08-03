# Payment evidence v2 contract

This is the normative contract for `artifacts/payment-evidence.json`. It describes real evidence; do not copy placeholder-shaped values into a submission. The bundled readiness checker enforces this shape, while the target repository's `evidence:verify` script must enforce the application schemas, RFC 8785 canonicalization, signatures, and golden vectors.

## Fixed Devnet identity

Keep these fields separate and test the mapping:

- application cluster: `devnet`;
- full RPC genesis hash: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`;
- x402 CAIP-2 network: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`;
- SDK network enum: the verified current SDK's Devnet value;
- asset: `USDC`;
- mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`;
- decimals: integer `6`.

The CAIP-2 reference is the first 32 Base58 characters of the full genesis hash. Never replace one identifier with another.

## Root object

The root contains:

- `schemaVersion: "2.0"` and a timezone-aware `generatedAt`;
- `project`, `attestations`, `offers`, `selection`, `payments`, and `denials`;
- no key material, credential-bearing URL, private telemetry, fabricated hash, or unlabeled fixture.

### Project

`project` records the judge-facing assets and the actual three-service boundary:

```text
liveUrl: public HTTPS control-plane UI
deploymentArtifact: repository-relative root deployment file
deckPdf: repository-relative exported PDF
demoVideo OR demoVideoUrl: final playable video
demoVideoDurationSeconds: 1..180
services:
  - role: control-plane
    url: distinct HTTPS Cloud Run URL
    healthUrl: public reachable health URL
    public: true
    serviceAccount: dedicated service-account email
    deploymentArtifact: repository-relative service config
    serviceDescribeArtifact + serviceDescribeArtifactSha256: raw live Cloud Run JSON description
    iamPolicyArtifact + iamPolicyArtifactSha256: raw JSON IAM export with allUsers run.invoker
  - role: payment-executor
    url: distinct HTTPS Cloud Run URL
    public: false
    iamProtected: true
    audience: exactly the service URL
    serviceAccount: dedicated executor service-account email
    deploymentArtifact: repository-relative service config
    serviceDescribeArtifact + serviceDescribeArtifactSha256: raw live Cloud Run JSON description
    iamPolicyArtifact + iamPolicyArtifactSha256: raw JSON IAM export allowing only the control-plane identity to invoke
    signerSecretResource: version-pinned Secret Manager resource
    secretIamPolicyArtifact + secretIamPolicyArtifactSha256: raw JSON IAM export granting secretAccessor to the executor, not the other services
  - role: vendor-agent
    url: distinct HTTPS Cloud Run URL
    healthUrl: public reachable health URL
    public: true
    serviceAccount: dedicated service-account email
    deploymentArtifact: repository-relative service config
    serviceDescribeArtifact + serviceDescribeArtifactSha256: raw live Cloud Run JSON description
    iamPolicyArtifact + iamPolicyArtifactSha256: raw JSON IAM export with allUsers run.invoker
```

Generate each description with `gcloud run services describe SERVICE --region REGION --format=json` after deployment. The checker requires the raw Knative v1 Service metadata, generation/observedGeneration, ready condition and revision—not a handwritten `{url, serviceAccount}` summary—and binds its URL/account to the manifest. All three identities, configs, descriptions, IAM exports, and service origins differ. The final checker calls the executor without credentials and requires a 401/403, verifies the raw IAM bindings, and ensures only the executor identity among the three can read the version-pinned signer secret. Do not publish an unauthenticated executor health endpoint.

### Runtime attestations

Every `gemini`, `a2a`, `autonomy`, and `policy` attestation contains `implemented: true`, existing `sourcePaths`, a repository-relative `runtimeArtifact`, and its `runtimeArtifactSha256`.

- `gemini` also names a real `model` containing `gemini`.
- `a2a` sets `separateService: true`, supplies its public `agentCardUrl`, and pins `verificationKeyId` plus an Ed25519 `verificationPublicKey`. Its runtime artifact lists the same pair in `verificationMethods`; `agentCardHash` is the RFC 8785 canonical-object hash, distinct from the raw-file `runtimeArtifactSha256`.
- `autonomy` sets `humanApprovalPerPayment: false` and `automaticSigning: true`; it pins the control-plane key that signs recovery outcomes, also listed in its runtime artifact. Its public key and key ID must differ from the A2A/vendor offer-and-receipt authority.
- `policy` sets `deterministic: true`, records non-empty `enforcedLimits`, and exposes the RFC 8785 canonical `executionPolicyHash`, distinct from the artifact's raw-byte hash. Each payment binds that canonical policy hash.

These records are evidence references, not proof of semantic quality. The demo and traces still need human review.

## Signed offers and material selection

Use the same envelope for each offer and fulfillment receipt:

```ts
type SignedEnvelope<T> = {
  payload: T;
  signer: string;   // Base58 Ed25519 public key
  keyId: string;    // pinned Agent Card verification method
  signature: string; // Base58 Ed25519 signature over RFC 8785(payload)
};
```

`offers` contains at least two valid provider-signed envelopes. Every offer payload contains `offerId`, `providerAgentId`, `providerAgentCardUrl`, `providerAgentCardHash`, `resourceUrl`, `network`, `asset`, `assetMint`, `amountBaseUnits`, `payee`, and timezone-aware `expiresAt`. The signing key must match the pinned Agent Card key, differ from the USDC payee, and remain unexpired through paid execution and confirmation.

`selection` contains:

```text
candidateOfferIds: at least two unique verified offer IDs
baseline:
  telemetryHash: sha256:<64 lowercase hex>
  modelOutputHash: sha256:<64 lowercase hex>
  selectedOfferId: one candidate
  schemaValidated: true
  capturedAt: timezone-aware timestamp
counterfactual:
  same fields, but a different telemetryHash and selectedOfferId
artifactPath: repository-relative JSON containing the same three objects
artifactSha256: hash of the exact artifact bytes
```

The paid offer is the baseline selection. Record actual Gemini inputs/outputs after redaction; a handwritten pair of IDs is not sufficient even if its shape passes the checker.

## Payment record

Each `payments[]` item contains:

- identity: `incidentId`, `incidentAt`, `mandateId`, `paymentId`, `offerId`, and `idempotencyKey`;
- chain and money: `network`, `cluster`, `asset`, `assetMint`, `decimals`, decimal-string `amount`, integer-string `amountBaseUnits`, distinct `payer` and `payee`;
- settlement: real `txSignature`, matching Devnet `explorerUrl`, `confirmationStatus`, and `confirmedAt`;
- bindings: `executionPolicyHash`, `challengeHash`, `requestFingerprint`, `resourceResponseHash`, `fulfillmentReceipt`, `fulfillmentReceiptHash`, `outcome`, and `x402`.

### x402 trace

Store raw Base64-encoded JSON header values rather than re-created summaries. Preserve exactly what the verified SDK sends; the checker accepts the standard and URL-safe Base64 alphabets.

```text
x402.request:
  method: GET or POST
  resourceUrl: normalized public HTTPS resource URL
  operationId: stable paid operation ID
  canonicalBodyHash: SHA-256 of the canonical body bytes
x402.challenge:
  status: 402
  headerName: PAYMENT-REQUIRED
  headerValue: Base64 JSON for x402 v2 PaymentRequired
  capturedAt
x402.payment:
  headerName: PAYMENT-SIGNATURE
  headerValue: Base64 JSON for the automatically signed x402 v2 payload
  signedTransactionSha256: hash of the exact signed transaction bytes
  capturedAt
x402.settlement:
  status: 200
  headerName: PAYMENT-RESPONSE
  headerValue: Base64 JSON binding success, network, payer, and tx signature
  capturedAt
```

The challenge's selected `exact` requirement must match the payment network, mint, integer base units, and payee. `challengeHash` hashes the decoded, validated PaymentRequired object. The client retries the same operation with `PAYMENT-SIGNATURE`; it does not broadcast first and later submit a proof.

Compute `requestFingerprint` as SHA-256 of RFC 8785 canonical JSON over exactly these fields:

```json
{
  "method": "POST",
  "resourceUrl": "<normalized paid URL>",
  "operationId": "<stable operation ID>",
  "canonicalBodyHash": "sha256:<body hash>",
  "paymentId": "<bound identifier>",
  "scheme": "exact",
  "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "assetMint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "amountBaseUnits": "<positive integer string>",
  "payee": "<verified recipient>"
}
```

The payment header is deliberately excluded: including it would make signing and request binding circular.

### Fulfillment and outcome

`fulfillmentReceipt` is a vendor `SignedEnvelope<FulfillmentReceiptPayload>`. Its payload contains:

```text
version: "1"
issuerAgentId
incidentId, paymentId, offerId
executionPolicyHash, challengeHash, requestFingerprint
txSignature, resourceResponseHash, resourceUrl
payer, payee, assetMint, amountBaseUnits
fulfilledAt
```

Hash the complete signed envelope to obtain `fulfillmentReceiptHash`. The signer/key ID must be the pinned Agent Card identity and not the payee wallet.

`outcome` is the control-plane-signed envelope plus `artifactPath` and `artifactSha256`. Its payload contains `incidentId`, `paymentId`, `fulfillmentReceiptHash`, `resourceResponseHash`, `statusBefore` (`degraded` or `down`), `statusAfter: "healthy"`, `healthProbeHash`, and `recoveredAt`. The JSON outcome artifact repeats those bound payload fields.

Enforce chronology:

```text
incident -> 402 challenge -> automatic payment payload -> confirmed Devnet block
         -> 200 settlement/resource -> vendor fulfillment receipt -> healthy recovery outcome
```

The checker tolerates small capture-clock skew around the block, but never accepts recovery before fulfillment or fulfillment before confirmation.

## Denial proof

At least one `denials[]` item records `incidentId`, `mandateId`, `reasonCode`, `attemptedAt`, `attemptedAmountBaseUnits`, `perTransactionLimitBaseUnits`, `executionPolicyHash`, `transactionCreated: false`, `txSignature: null`, `artifactPath`, and `artifactSha256`. For the P0 over-cap proof, attempted base units must exceed the limit. The JSON artifact must bind the incident, reason, policy hash, and absence of a transaction.

## Fresh verification report

When the readiness checker invokes `evidence:verify`, it passes `UPTIME402_VERIFICATION_NONCE`. The script must freshly create `artifacts/verification-report.json` with:

- `schemaVersion: "1.0"`, the exact nonce, and a `producedAt` inside that invocation;
- `evidenceSha256` of the final payment evidence file;
- true checks for `geminiRuntime`, `a2aRemoteService`, `autonomousNoPrompt`, `policyAllow`, `policyDeny`, `recoveryOutcome`, `x402RoundTrip`, `offerSignature`, `fulfillmentReceiptSignature`, `cloudRunIdentityBoundary`, `executorUnauthenticatedDenied`, `signerSecretLeastPrivilege`, and `urlCanonicalization`.

The final submission command then independently checks the live RPC, URLs, PDF, video, and service manifest. Its `manual.*` INFO results remain required human review items; zero automated failures is not by itself a finalist claim.
