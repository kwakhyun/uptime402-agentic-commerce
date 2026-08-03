# Uptime402 product brief

## Contents

- [Frozen thesis](#frozen-thesis)
- [Target and buyer](#target-and-buyer)
- [Problem](#problem)
- [Golden demo path](#golden-demo-path)
- [Why the stack is necessary](#why-the-stack-is-necessary)
- [Product surface](#product-surface)
- [Business model](#business-model)
- [Scope](#scope)
- [Concept decision](#concept-decision)

## Frozen thesis

**Uptime402 - an AI SRE that autonomously buys the API it needs to restore service.**

Tagline: **An outage does not wait for procurement.**

Uptime402 receives an incident, diagnoses the failure with Gemini, discovers and compares recovery offers through A2A, applies a pre-authorized spend mandate, pays the selected provider in USDC over x402 on Solana, switches the failing dependency, and leaves a verifiable signed receipt. No person approves the individual payment. Add the `pay.sh` name only after live-path evidence proves that its CLI, SDK, gateway, or catalog actually participated.

This is a specialized B2B autonomous API-procurement/FinOps product, not another crypto wallet or chat interface.

## Target and buyer

- Primary user: on-call SRE, platform engineer, or infrastructure lead at a payment company, Web3 service, B2B SaaS company, or API-first enterprise.
- Economic buyer: Head of Infrastructure, CTO, or FinOps lead.
- Initial wedge: time-critical purchase of backup RPC, observability, search, security, compute, or diagnostic APIs during an incident.
- Expansion: routine autonomous vendor routing, per-request procurement, budget governance, and machine-spend audit across all agent workloads.

## Problem

Critical systems can fail in seconds, but external tooling still assumes a human will create an account, obtain an API key, accept a plan, and enter a card. Existing backup integrations also require teams to subscribe before knowing they will need them. The result is longer downtime, shelfware subscriptions, and an unaudited gap between an agent's recommendation and the action that restores service.

The job to be done is:

> When a production dependency fails, restore the service by procuring the best available replacement within policy, without waiting for a human checkout, while proving exactly why and how money moved.

## Golden demo path

Use a deterministic injected incident: the application's primary Solana RPC or diagnostic dependency becomes unhealthy.

1. The dashboard already shows an active one-time mandate: `0.05 USDC incident cap`, `0.02 USDC per transaction`, ten-minute expiry, USDC-only, approved capabilities and recipients.
2. The incident endpoint emits an alert. No payment approval is requested after this point.
3. A redaction layer turns raw telemetry into an allowlisted incident schema; Gemini returns a schema-validated diagnosis and required capability such as `solana-rpc-health`.
4. The buyer discovers one independently deployed vendor agent via its A2A Agent Card and receives at least two immutable offers: for example `rpc-fast` at a higher price/lower latency and `rpc-economy` at a lower price/higher latency. One vendor deployment is enough for P0; two offers are required so Gemini's ranking is material.
5. The vendor exposes a paid recovery resource and returns HTTP 402.
6. The policy engine binds the quote to the incident, method, URL, canonical body hash, recipient, USDC mint, amount, nonce, and expiry; it reserves the budget atomically.
7. A private payment-executor service reloads the immutable mandate and execution policy, validates an IAM-authenticated decision envelope, and automatically signs the x402 payment payload with an isolated low-balance Devnet wallet. These are application-enforced limits and blast-radius isolation, not a cryptographically scoped keypair.
8. The buyer retries with `PAYMENT-SIGNATURE`; the vendor first schema-validates the payload/signature, signed offer, and request fingerprint, then atomically changes an unseen payment identifier to `settling`. It asks the facilitator to verify and settle, waits for confirmation, returns 200, and signs a fulfillment receipt that binds the offer, request, transaction, and response. Call it the official x402 Signed Offers & Receipts extension only after current SVM compatibility and the actual signature path are verified.
9. Uptime402 verifies the receipt, switches the dependency or completes a real health check, and turns the service state green.
10. The UI shows the 402/200 pair, offers, model decision, policy decision, USDC amount, remaining budget, transaction signature, Explorer link, verified receipt, and recovery result.
11. An offer above the cap or a replayed nonce is rejected automatically, with no transaction generated. A counterfactual telemetry test must select a different supplied offer ID.

The success scene plus denial scene makes the message explicit: **approval-free does not mean policy-free**.

## Why the stack is necessary

### Why AI

- Incident alerts, logs, runbooks, vendor capabilities, and responses are heterogeneous and partly unstructured.
- Gemini performs diagnosis, capability selection, and multi-factor ranking across at least two supplied offers; a counterfactual test proves that telemetry can change `selectedOfferId`.
- A deterministic policy engine, not the model, owns money math and authorization.
- The paid response changes the system state; this is a tool-using agent, not a chatbot ornament.

### Why Solana

- A software agent can exercise pre-armed application authority without a human checkout. In P0, the private executor plus a low-balance wallet limits blast radius; only a proven Fixed Delegation or equivalent justifies a cryptographic `scoped authority` claim.
- USDC provides stable denomination; Solana provides low-cost, fast, 24/7 global settlement suitable for per-request purchases.
- On-chain settlement plus an independently verifiable vendor-signed fulfillment receipt makes spend and delivery auditable across buyer and vendor systems.
- Native Fixed/Recurring Delegation is a strong production path for cap, expiry, and revocation when it is proven compatible with the selected x402 execution path.

### Why x402, and pay.sh when verified

- The API request itself becomes the storefront: the vendor quotes through HTTP 402 and the client retries with payment proof.
- The agent needs no bespoke checkout, subscription, or API-key relationship with the seller.
- Use x402 `exact` for the reliable MVP. Use `upto` only for truly variable one-shot usage and MPP session only for capped repeated calls.
- Treat pay.sh as an optional verified rail/provider. Never propagate its brand into the headline, diagram, or submission before evidence promotion.

### Why Google Cloud

- Gemini supplies the agentic decision.
- Cloud Run provides independently deployable control-plane, private payment-executor, and vendor services plus a public judging URL.
- Firestore transactions provide atomic reservation, idempotency, state, and receipts.
- Pub/Sub/Eventarc/Workflows fit event-driven incident handling after the core path works.
- Secret Manager and distinct least-privilege service accounts keep signer material accessible only to the payment executor; Cloud Logging/BigQuery can provide audit evidence.

## Product surface

Build one excellent screen, not a dashboard maze:

- top bar: service health, active mandate, remaining USDC, network, kill switch;
- center: chronological autonomous execution timeline;
- side panel: offers and Gemini's structured comparison;
- evidence drawer: HTTP challenge/response, policy fields, receipt, and Explorer link;
- outcome card: restored dependency, measured recovery time, and money spent;
- denial card: over-budget or replayed request with the exact failing invariant.

Use Korean presentation copy with English protocol labels. Keep protocol details progressively disclosed so a finance or payments judge can understand the main story in ten seconds.

## Business model

- Team: monthly control-plane fee plus a small percentage of successfully routed machine spend.
- Enterprise: annual contract for policy packs, audit retention, SSO/RBAC, private vendor catalog, and compliance exports.
- Provider side: optional paid listing or routing fee only after buyer traction; do not make this the initial story.

North-star metric: **autonomously recovered incidents with verified policy-compliant settlement**.

Supporting metrics: median time to recovery, human approvals avoided, spend per recovered incident, policy denial rate, vendor success rate, and savings versus standby subscriptions.

## Scope

### P0 submission

- Real Devnet USDC x402 payment and paid resource.
- Pre-armed budget, deterministic application policy, private low-balance payment executor, shared idempotency, and denial path.
- Gemini structured ranking across at least two immutable offers plus a counterfactual selection test.
- One real A2A boundary with an Agent Card.
- Cloud Run control plane, private payment executor, and separate vendor service with distinct identities.
- Firestore or another shared transactional store is mandatory for the deployed submission path; an in-memory adapter is for local tests only.
- Vendor-side concurrent replay protection and a verifiable signed offer/receipt path.
- Reproducible README, live URL, deck source and exported PDF, plus a recorded video no longer than three minutes or a final accessible video URL with verified duration.

### P1 finalist polish

- Native Fixed Delegation proven end to end.
- A second independently deployed vendor and broader price/latency selection.
- Eventarc/Pub/Sub/Workflows receipt pipeline.
- AP2 canonical Intent Mandate validation.
- BigQuery audit dashboard, Cloud KMS signing adapter, passkey setup, or gas sponsorship.

### Explicit non-goals before P0 is green

- Mainnet payments.
- Custom Solana program.
- MPP session, subscription, UCP shopping, NFT/cNFT, mobile app, or full marketplace.
- A generic conversational assistant.
- A fake enterprise login, fake transaction history, or mocked Explorer data presented as live.

## Concept decision

| Direction | Rubric fit | Demo credibility | Delivery risk | Decision |
|---|---|---|---|---|
| Uptime402 autonomous incident procurement | Strong across AI, GCP, Solana, UX, and live execution | A payment directly restores a failing service | Moderate | **Selected** |
| Generic research/API buying agent | Strong protocol proof but weaker vertical moat | Easy to reproduce | Low | Backup scope if incident switching blocks |
| Invoice/AP treasury agent | Strong institutional relevance | Invoice and vendor data are easily perceived as synthetic | Moderate | Not selected |
| Travel shopping agent | Familiar multi-agent story | Real booking/refund integration is difficult and crowded | High | Avoid |
| Verifiable mass payout | Strong Solana settlement | Weaker natural x402/pay.sh fit and higher eligibility risk | High | Avoid |

If time forces a fallback, preserve the same architecture and narrow the outcome to buying two paid diagnostic sources to produce an incident report. Do not change into an unrelated shopping demo.
