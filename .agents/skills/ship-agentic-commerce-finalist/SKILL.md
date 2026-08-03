---
name: ship-agentic-commerce-finalist
description: Build, debug, verify, and package Uptime402 or a closely related Google Cloud x Solana Agentic Commerce hackathon entry. Use when work must prove autonomous payments within a pre-authorized budget, Gemini-driven decisions, A2A/AP2/x402 or pay.sh interoperability, real Solana USDC settlement, Cloud Run deployment, reproducible code, a 3-minute demo, or finalist-readiness against the 2026 Korean hackathon rubric.
---

# Ship an Agentic Commerce Finalist

Treat this as an evidence-first delivery workflow. Optimize the one live path that proves the product claim; do not maximize feature count.

## Load the brief

Read these files before changing product behavior:

1. [product-brief.md](references/product-brief.md) for the frozen problem, scope, and golden path.
2. [architecture.md](references/architecture.md) for boundaries, schemas, security invariants, and the preferred repository shape.
3. [judging-and-evidence.md](references/judging-and-evidence.md) for rubric mapping, claim gates, demo timing, and submission requirements.
4. [payment-evidence-v2.md](references/payment-evidence-v2.md) for the single normative evidence contract and final verification interface.

Read [source-dossier.md](references/source-dossier.md) only when making a technical choice, writing claims, or preparing submission copy. Re-check unstable APIs against current official documentation before coding; do not trust remembered package names or flags.

## Execute in this order

### 1. Preflight

- Inspect the repository, instructions, dirty state, package manager, current tests, and existing deployment configuration.
- Record the current deadline and a time-boxed plan in `docs/BUILD_STATUS.md`.
- Preserve unrelated user work. Do not initialize or rewrite an existing project blindly.
- Default to Solana Devnet or an official sandbox. Never spend mainnet funds or create/fund a real wallet without explicit user authorization.
- List missing user-supplied credentials without blocking work that can use adapters or emulators. Ask for an existing low-balance Devnet executor wallet with fee SOL and Devnet USDC only at the live-payment boundary.
- Tell the user to place credentials in an ignored local env file or Secret Manager and provide only variable names/paths. Never request a private key in chat.

### 2. Prove the payment spike first

Before polishing UI, make the smallest paid resource complete this trace:

`request -> 402 -> deterministic policy reserve -> automatic payment-payload signature -> paid retry -> vendor/facilitator verify and settle -> confirmed 200 resource -> signed receipt`

- Use USDC and Solana Devnet for the submission path unless the user explicitly authorizes Mainnet.
- Prefer current `@solana/pay-kit` or official x402 SVM libraries after verifying their docs and versions.
- Capture the real transaction signature, CAIP-2 network, mint, amount/base units, distinct payer/payee owners, matching token-account balance deltas, confirmation state, x402 headers, signed receipt, outcome binding, and Explorer URL in `artifacts/payment-evidence.json`.
- Wait for confirmed/finalized settlement before claiming success in the demo.
- Require the x402 Payment Identifier extension or an equivalent bound identifier. Use a vendor-side shared atomic fulfillment claim before verify/settle; an in-memory cache is not enough across Cloud Run instances.

Do not continue to broad UI work until this spike passes an automated integration test or a recorded, independently verifiable live check.

### 3. Add bounded application autonomy

- Let Gemini propose a structured action; never let the model calculate authoritative balances, alter policy, access keys, or sign raw transactions.
- Validate every proposal with deterministic code immediately before signing.
- Enforce network, asset mint, recipient allowlist, capability, per-transaction cap, incident cap, daily cap, expiry, nonce, body hash, and remaining balance.
- Reserve budget atomically before signing; commit only after settlement and verified fulfillment receipt; release on terminal failure.
- Put policy recheck, reservation, and signing in a private payment-executor service with a distinct identity and audience-locked IAM invocation. The control plane and Gemini never receive key material.
- Prefer a native Solana Fixed Delegation for cryptographically bounded authority only when the official SDK path interoperates with the selected x402 flow and an end-to-end test proves it. Otherwise use an isolated low-balance executor wallet and call the limit **application-enforced policy plus blast-radius isolation**, never a `scoped wallet` or on-chain cap.

### 4. Connect intelligence and agents

- Use the current stable Gemini model through structured outputs or function calling for diagnosis, offer comparison, and an explanation tied to evidence.
- Keep a deterministic fallback diagnosis for demo resilience and label it clearly.
- Implement at least one genuinely separate vendor agent with the official A2A SDK, a discoverable Agent Card, and a protocol request. A local function named "agent" is not A2A.
- Require at least two immutable offers from that vendor and a counterfactual test where changed telemetry changes `selectedOfferId`; a single available offer makes Gemini decorative.
- Redact and allowlist telemetry before model/log use. Treat vendor/A2A text as prompt-injection-capable data, reject unknown fields, select only supplied offer IDs, and escape rendered output.
- Add AP2 only through official types or canonical schemas. If conformance is not tested, label the object `AP2-aligned` or `AP2-inspired`, never `AP2-compliant`.
- Use x402 exact for the core one-shot recovery purchase. Add x402 `upto` or MPP session only after the core path is green and the use case actually has variable or repeated usage.
- Claim pay.sh only if its actual CLI, SDK, gateway, or catalog participates in the verified live path.

### 5. Build the proof-oriented UX

Create one primary operations screen showing, in order:

- injected or real incident and current health;
- the one-time mandate and remaining budget;
- A2A offers and Gemini's structured selection;
- deterministic policy decision;
- HTTP 402 challenge, automatic payload signature, paid retry, facilitator settlement, and resource delivery;
- transaction signature, Explorer link, verified vendor-signed receipt, and before/after budget;
- recovery outcome;
- one deliberately rejected over-budget or replay attempt.

After the mandate is armed, the success flow must require no payment approval click. Never fabricate hashes, balances, protocol messages, or provider responses.

### 6. Deploy the smallest credible Google Cloud story

- Prefer three Cloud Run services with distinct service accounts: public control plane, private payment executor, and independently deployed vendor agent.
- Export and hash-bind each raw ready Cloud Run service description and IAM policy after deployment. Prove an unauthenticated executor request returns 401/403, only the control-plane identity has `run.invoker`, and only the executor identity among the three has `secretAccessor` on a version-pinned signer secret.
- Use Firestore for mandates, reservations, payment identifiers, vendor fulfillment claims, events, and receipts when credentials exist; retain an in-memory adapter for local tests only.
- Add Pub/Sub, Eventarc, Workflows, BigQuery, or Cloud KMS only when the live path remains stable. Do not draw an architecture service as implemented unless deployment evidence exists.
- Store secrets in Secret Manager with least privilege. Never expose a private key to the browser, model context, logs, fixtures, or Git.
- Emit structured logs carrying the same `incidentId`, `mandateId`, `idempotencyKey`, and `txSignature` across services.

### 7. Verify and package

- Test policy boundaries, expiry, duplicate nonce, recipient/mint/network mismatch, concurrent buyer reservations, concurrent vendor retries across two instances, IAM audience/identity/policy, vendor-vs-recovery key separation, URL canonicalization, canonical hash mutation, signed receipt mutation, telemetry redaction, vendor prompt injection, SSRF/redirects, model-invalid output, provider timeout, and settlement failure.
- Run lint, type-check, unit, integration, production build, and the repository's existing checks.
- Run the structural gate early: `python3 .agents/skills/ship-agentic-commerce-finalist/scripts/check_finalist_readiness.py --root . --strict`. This checks structure and evidence shape only.
- For the final automated gate, run `python3 .agents/skills/ship-agentic-commerce-finalist/scripts/check_finalist_readiness.py --root . --submission --run-repo-scripts --rpc-url-env SOLANA_RPC_URL --secondary-rpc-url https://api.devnet.solana.com --usdc-mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --strict`. If `SOLANA_RPC_URL` is already the official credential-free endpoint, omit the secondary flag. Review every emitted `manual.*` INFO item before calling the submission ready.
- Verify the live URL from a clean session and replay the exact three-minute script twice.
- Produce `README.md`, `.env.example`, `docs/ARCHITECTURE.md`, `docs/DEMO_SCRIPT.md`, `docs/SUBMISSION_DECK.md`, the exported deck PDF, the final video file or accessible video URL with verified duration, and `artifacts/payment-evidence.json`.
- If Codex cannot record/upload the video, create a deterministic capture checklist and stop for the user handoff; do not call the submission ready until the final video is present and no longer than three minutes.
- Keep separate `docs/BUILD_STATUS.md` axes: implementation, evidence, deployment, verification timestamp/reference, and priority, using the exact schema in `references/architecture.md`.

## Stop conditions

Do not declare the submission ready unless all are true:

- A real Solana transaction is independently inspectable.
- RPC proves the configured USDC mint, distinct payer/payee owners, and matching negative/positive token-account base-unit deltas.
- The paid resource is delivered only after verified payment; a vendor-signed receipt binds request, transaction, and response, then a control-plane-signed outcome binds that receipt to the healthy recovery.
- At least one second payment or one denial occurs without per-payment human approval.
- Gemini materially ranks at least two supplied offers, its output is schema-validated, and a counterfactual changes the selection.
- The A2A claim crosses a process or deployment boundary and passes a smoke test.
- A fresh clone can follow the README to run the core flow.
- The live URL, final video, exported deck PDF, README, and evidence artifact agree on what is actually implemented.

If a dependency is unavailable, narrow scope and report the exact evidence gap. Never replace a required live integration with an unlabeled mock.
