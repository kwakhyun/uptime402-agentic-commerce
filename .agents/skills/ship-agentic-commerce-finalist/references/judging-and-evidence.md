# Judging and evidence guide

## Contents

- [Official rubric](#official-rubric)
- [Claim gates](#claim-gates)
- [Three-minute video](#three-minute-video)
- [Presentation PDF outline](#presentation-pdf-outline)
- [README minimum](#readme-minimum)
- [Submission checklist](#submission-checklist)
- [Deadline-focused order](#deadline-focused-order)

## Official rubric

The current official site and the organizer's introduction deck expose four unweighted criteria. No official percentage weights were found; do not invent them.

| Criterion | What the judge must see | Uptime402 proof |
|---|---|---|
| Innovation and UX | A new, intuitive way to solve a real problem | An incident autonomously buys recovery capacity; a single timeline explains autonomy and safety |
| AI utilization | Gemini/Google Cloud AI is integral, not decorative | Gemini ranks at least two immutable offers through a strict schema; counterfactual telemetry changes the recovery action |
| Technical and infrastructure completeness | Solana USDC/Solana Pay/pay.sh plus Google Cloud AI and AP2/A2A/x402 where relevant | A2A vendor discovery, x402 402/signed retry/facilitator settlement, private payment executor, Cloud Run, Firestore, truthful optional-protocol labels |
| Actual operation | Live local/test/devnet transaction and inspectable logs/history | Confirmed Devnet signature and token deltas, Explorer link, HTTP evidence, verified signed fulfillment receipt, budget delta, and denial without a transaction |

Mainnet is not required by the current official page. A reliable Devnet path is preferable to an unsafe or fragile Mainnet demo.

## Claim gates

Use these exact gates in README, deck, UI, and narration:

- Claim **real Solana payment** only after RPC or Explorer independently returns the transaction and expected token transfer.
- Claim **USDC** only after the mint and token balance deltas are checked; a SOL transfer is not USDC.
- Claim **x402** only after the captured flow includes a real 402 challenge, a payment payload/proof retry, settlement verification, and a paid resource response.
- Claim **pay.sh** only if the actual pay.sh CLI, SDK, gateway, or catalog URL participates in the live path. Using an unrelated x402 library is not pay.sh.
- Claim **A2A** only if the official protocol/SDK crosses a separate process or deployment boundary with a discoverable Agent Card.
- Claim **AP2 validated/compliant** only if official AP2 types or canonical schemas validate the mandate and the implemented flow meets the claimed profile. Otherwise say `AP2-aligned mandate`.
- Claim **autonomous** only when no person approves each payment after the initial mandate is armed.
- Claim **application-enforced limits** only when code blocks over-cap, expired, wrong-recipient, and replay cases. Claim **cryptographically scoped/on-chain allowance** only after Fixed Delegation or equivalent is proven end to end; a low-balance keypair is not scoped.
- Claim **Cloud Run/Firestore/Secret Manager** only when deployment/config evidence exists; a diagram is a target state.
- Claim **recovery** only when a health signal changes because the paid resource was used.
- Claim **verifiable fulfillment** only after the vendor-signed receipt independently binds the offer, request fingerprint, payment/transaction, delivered response hash, and incident, and a later control-plane-signed outcome binds that receipt to the recovered health probe.

## Three-minute video

Target 2:45 to leave export and pacing margin.

| Time | Scene | Spoken point | On-screen evidence |
|---|---|---|---|
| 0:00-0:15 | Broken service | "An outage cannot wait for account creation and checkout." | red health check, target user, problem |
| 0:15-0:30 | Armed mandate | "The operator authorized the boundary once, not each transaction." | cap, expiry, USDC, recipients, Devnet |
| 0:30-0:50 | Gemini diagnosis | "Gemini turns redacted telemetry into a required capability and ranks two real offers." | strict schema, two IDs, evidence refs |
| 0:50-1:10 | A2A offers | "The buyer discovers an independent vendor agent and receives immutable offers." | Agent Card URL, task ID, two offer IDs |
| 1:10-1:35 | Autonomous payment | "The vendor returns 402; the private executor reserves policy and signs the retry without a click; the vendor/facilitator settles it." | 402, policy/IAM checks, PAYMENT-SIGNATURE, 200 |
| 1:35-1:55 | Chain + delivery proof | "The USDC settlement and signed fulfillment receipt are independently verifiable." | signature, token deltas, Explorer, receipt verifier |
| 1:55-2:10 | Outcome | "The paid resource restores the dependency." | green health, recovery time, budget delta |
| 2:10-2:28 | Boundary proof | "A replay or over-cap request is rejected with no transaction." | denial rule and unchanged balance |
| 2:28-2:45 | Architecture/business | "Cloud Run and Firestore make this an enterprise control plane, not a wallet demo." | compact architecture, live URL, buyer and pricing |

Record the cursor and terminal so there is no hidden approval prompt. Keep the Explorer page pre-opened but refresh the real signature during the recording.

## Presentation PDF outline

Use 8-10 visual slides:

1. One-line outcome: incident -> autonomous purchase -> recovery.
2. Target and costly procurement gap.
3. Why now and why ordinary cards/API keys fail agents.
4. Product flow with the one-time mandate and no per-payment approval.
5. Live evidence: 402/200, USDC signature, Explorer, and denial.
6. Architecture: Gemini, A2A, x402 (pay.sh only if verified), Solana, three Cloud Run services, Firestore.
7. Safety: deterministic policy, atomic reserve, private low-balance executor, shared idempotency, signed receipt, kill switch.
8. Commercial scenario, buyer, pricing, and expansion.
9. Competitive positioning: orchestration/control plane above pay.sh and seller gateways.
10. Reproduction, live URL, GitHub, and next milestones.

Use measured demo values rather than generic network claims whenever possible.

## README minimum

The fresh-clone path must include:

- problem and one-line product explanation;
- architecture and repository map;
- exact prerequisites and pinned runtime versions;
- `.env.example` field descriptions without secrets;
- local in-memory run;
- sandbox and Devnet run as separate, clearly labelled modes;
- how to obtain non-sensitive Devnet prerequisites without committing keys;
- test, lint, build, and readiness commands;
- Cloud Run deployment commands, three expected services, identities, and IAM boundary;
- how to reproduce the `402 -> signed retry -> facilitator settlement -> 200` path;
- how to verify the transaction independently;
- security model, known limitations, and mainnet warning;
- live URL, demo video, deck PDF, and last verified timestamp.

## Submission checklist

- Presentation source plus exported PDF.
- GitHub repository is public or accessible to judges and reproducible.
- Three-minute-or-shorter video shows the entire real payment path.
- Live Cloud Run URL works from a logged-out browser.
- `artifacts/payment-evidence.json` contains no placeholders or secrets.
- The final video duration is independently checked; a script without a recorded/uploaded video is incomplete.
- README commands were run from a clean clone.
- All links use the final repository/deployment, not localhost.
- Demo transaction has enough confirmation and remains visible in Explorer.
- A backup Devnet wallet and vendor endpoint are prepared, without switching to fake evidence.
- Slides and narration use Korean; protocol labels and code may remain English.

## Deadline-focused order

The official submission deadline is 2026-08-03 23:59 KST. Use relative build hours:

- H0-H3: standard x402 Devnet payment spike and evidence artifact;
- H3-H6: private executor, policy/reservation, vendor replay claim, denial, tests;
- H6-H9: Gemini two-offer decision, counterfactual, and real A2A vendor;
- H9-H12: single proof-oriented UI;
- H12-H15: Cloud Run/Firestore deploy and clean-run verification;
- H15-H18: README, deck, video recording;
- remaining time: link QA and contingency buffer.

If behind, cut P1 features in this order: BigQuery/KMS, AP2 conformance, second vendor, Eventarc/Workflows, native delegation, MPP, passkey/gasless. Never cut the real payment evidence, deterministic policy, material Gemini step, or live URL before cosmetic work.
