# Source dossier

Use this file to ground decisions and submission claims. Prefer the linked primary source when implementation details may have changed.

## Contents

- [User-provided PDFs](#user-provided-pdfs)
- [Official hackathon](#official-hackathon)
- [Payment and agent protocols](#payment-and-agent-protocols)
- [Solana bounded authority](#solana-bounded-authority)
- [Google Cloud and Gemini](#google-cloud-and-gemini)
- [Market and comparable cases](#market-and-comparable-cases)
- [Security research prompts](#security-research-prompts)

## User-provided PDFs

### Google X Solana AI Agentic Hackathon Intro Deck, 11 pages

- Four starting points are combinable: agent-initiated commerce, autonomous on-chain settlement, multi-agent commerce, and verifiable distribution.
- Required artifacts: product deck, reproducible GitHub repository/README, and a video under three minutes showing the actual on-chain payment flow. A live URL is recommended.
- The deck's four criteria are innovation/UX, Gemini and Google Cloud AI use, USDC/Solana Pay/pay.sh integration, and actual execution with logs/history.
- Mockups do not count; payment must work.
- Deadline: 2026-08-03 23:59 KST; about ten finalists announced 2026-08-07; Demo Day 2026-08-21.
- Google Cloud's $300 trial credit is separate from Google AI Studio Gemini API billing; the deck recommends the Gemini API free tier.

### The Agentic Commerce Stack: x402 & mpp, 31 pages

- Agentic commerce covers discovery, comparison, negotiation, selection, payment, and post-purchase work; a human is absent at payment time.
- A headless merchant endpoint makes the callable API itself the store.
- A2A handles agent communication; MCP connects agents to external systems; AP2 supplies mandate-based payment intent; UCP supplies broader shopping primitives.
- x402 is a strong one-shot MVP. MPP sessions reduce repeated-call on-chain operations but should only be added when repeated calls are central.
- The deck explicitly asks builders to prove why Solana/on-chain payment is necessary and identifies identity, intent, verification, and guardrails as opportunity layers.

### Vibe Coding on Google Cloud, 26 pages

- Skills are Markdown SOPs for an agent and may combine multiple tools; the harness follows this pattern.
- Suggested build stack includes Gemini, Next.js, Firestore, Cloud Run, Cloud Storage, pay.sh sandbox, and parallel coding agents.
- Gemini 3.5 Flash is presented as the stable agentic model in the session. The live catalog checked on 2026-08-02 also listed a newer stable Gemini 3.6 Flash, so verify account/region availability and pin the exact current stable model ID at implementation time.
- The deck recommends clarifying architecture before coding, using parallel work only with clean boundaries, and deploying the container to Cloud Run.

### Why Solana for Agentic Commerce, 18 pages

- The desired demo has a real on-chain settlement, no per-payment human approval, actual Solana payment-stack use, and an intuitive explanation of why it must be on-chain.
- Pay.sh is presented as no signup, no API key, no subscription, pay-per-use access to 70+ paid APIs.
- Use USDC for stable denomination and SOL only for network fees.
- Develop local/sandbox first, move to Devnet for the public demo, and use Mainnet only for production.
- Private keys are irrecoverable and smart-contract bugs execute as written; isolate the signer and test boundaries.

## Official hackathon

- [Official site](https://www.gcp-solana-ai-agentic-hacks-kr.xyz/)
- [Official resources](https://www.gcp-solana-ai-agentic-hacks-kr.xyz/resources)
- [Session Drive folder](https://drive.google.com/drive/folders/1uOw_wBmLub4xX153VTNFINPQqZXwvP4J?usp=sharing)
- [Kickoff recap](https://okky.kr/articles/1561256)

The current official production bundle exposes four unweighted criteria: innovation/UX; Gemini/Google Cloud AI; technical completeness across Solana payments, GCP AI, and agent/payment protocols; and real local/test/devnet execution. Some mirrors expose an older five-item/bonus formulation. Use the current official page and do not claim weights.

The official resource architecture recommends Cloud Run over GKE for this scope and shows an event-oriented path using Pub/Sub, Eventarc, Workflows, payment verification, Firestore state, receipts/BigQuery, and an agent response. Treat the full path as a target; keep P0 smaller if time constrained.

## Payment and agent protocols

- [x402 introduction](https://docs.x402.org/introduction): HTTP-native paid resources without accounts or sessions.
- [x402 client/server flow](https://docs.x402.org/core-concepts/client-server): client signs and retries; server/facilitator verifies, settles, confirms, and then returns the resource.
- [x402 facilitator](https://docs.x402.org/core-concepts/facilitator): verification and settlement roles; includes duplicate-settlement considerations on Solana.
- [x402 network/token support](https://docs.x402.org/core-concepts/network-and-token-support): current Solana and SPL support plus test facilitator details.
- [x402 Payment Identifier](https://docs.x402.org/extensions/payment-identifier): retry idempotency and request-fingerprint binding; replace the sample in-memory cache with shared storage across Cloud Run instances.
- [x402 Signed Offers & Receipts](https://docs.x402.org/extensions/offer-receipt): cryptographic offer/receipt artifacts and JWS `did:web`; verify current SVM compatibility before claiming the extension.
- [pay.sh docs](https://pay.sh/docs): client, agent, and provider paths.
- [pay.sh TypeScript schemes](https://pay.sh/docs/sdk/typescript/schemes): fixed, metered `upto`, subscription, and session semantics.
- [pay.sh launch](https://solana.com/news/solana-foundation-launches-pay-sh-in-collaboration-with-google-cloud): Solana Foundation and Google Cloud gateway rationale.
- [pay open-source repository](https://github.com/solana-foundation/pay): implementation and debugger.
- [MPP specification](https://paymentauth.org/): charge, session, discovery, and transport specifications.
- [AP2 announcement](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol): signed mandates and delegated tasks.
- [AP2 repository](https://github.com/google-agentic-commerce/AP2): official types, schemas, and samples.
- [A2A specification](https://a2a-protocol.org/latest/specification/): independent agent interoperability.
- [Official A2A JavaScript SDK](https://github.com/a2aproject/a2a-js): Agent Card, client, and server implementation.
- [A2A x402 extension](https://github.com/google-agentic-commerce/a2a-x402): payment-required/submitted/completed messages for agent commerce.

Important distinctions:

- pay CLI and agent quickstarts default to local user authorization for real payments. That behavior alone does not satisfy approval-free payment.
- A low-balance keypair is not cryptographically scoped. Until Fixed Delegation or another on-chain allowance is proven end to end, use the accurate label `application-enforced policy plus low-balance blast-radius isolation` and keep the key in a private executor boundary.
- x402 v2 uses CAIP-2 on the wire (`solana:<first 32 Base58 characters of the full genesis hash>`). Keep it separate from the full RPC genesis hash, an application cluster label, and any SDK-specific enum.
- The standard x402 order is `402 -> sign payment payload -> paid retry -> vendor/facilitator verify and settle -> confirmed 200`; broadcasting first and presenting a transaction later is a custom prepaid flow.

## Solana bounded authority

- [Fixed Delegation](https://solana.com/docs/payments/subscriptions/fixed-delegation)
- [Recurring Delegation](https://solana.com/docs/payments/subscriptions/recurring-delegation)
- [Spend permissions](https://solana.com/docs/payments/advanced-payments/spend-permissions)
- [Subscriptions and Allowances announcement](https://solana.com/news/subscriptions-and-allowances)

The native program supports a one-time amount cap with optional expiry and a recurring cap that resets by period. It is a compelling production mechanism for autonomous agent limits. Confirm exact x402/pay.sh interoperability before making it part of the live settlement path.

## Google Cloud and Gemini

- [Google Cloud free program](https://cloud.google.com/free): eligible new users receive $300 for 90 days; billing setup and identity/payment verification are required, and resources stop if the trial ends without an upgrade.
- [Hackathon credit guide video](https://www.youtube.com/watch?v=ngZ8tXVQ78w): organizer-linked overview of the $300 credit and related Google programs. The video page was throttled during research, so its credit claims were cross-checked against the official free-program documentation.
- [Gemini API billing](https://ai.google.dev/gemini-api/docs/billing): the $300 Welcome credit does not pay Gemini API/AI Studio usage; use the available free tier or a separately eligible billing path.
- [Gemini model catalog](https://ai.google.dev/gemini-api/docs/models): verify stable model IDs and capabilities at build time.
- [Gemini model catalog](https://ai.google.dev/gemini-api/docs/models): current stable model IDs and capabilities; it listed Gemini 3.6 Flash as the latest balanced stable Flash option at the 2026-08-02 research cutoff.
- [Host AI agents on Cloud Run](https://cloud.google.com/run/docs/ai-agents): managed agent service patterns.
- [Deploy an ADK agent to Cloud Run](https://cloud.google.com/run/docs/ai/build-and-deploy-ai-agents/deploy-adk-agent): official deployment guide if ADK is selected.
- [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions): atomic budget reservation.
- [Secret Manager best practices](https://cloud.google.com/secret-manager/docs/best-practices): least privilege, direct API access, version pinning, and audit logs.
- [Cloud Run secrets](https://cloud.google.com/run/docs/configuring/services/secrets): runtime integration.
- [Cloud KMS algorithms](https://cloud.google.com/kms/docs/algorithms): verify Ed25519 support before implementing a signer adapter.

Google Cloud Blockchain RPC documentation must be checked before use; it has not historically been a general Solana RPC. Do not draw it as the Solana node without verified support.

## Market and comparable cases

- [Cloudflare Monetization Gateway](https://blog.cloudflare.com/monetization-gateway/): seller-side rules for charging any API, data, or MCP resource over x402; validates per-request machine commerce but is not the buyer-side recovery control plane.
- [Pay.sh service catalog](https://pay.sh/): demonstrates real pay-per-call APIs and helps choose a stable demo provider.
- [Solana Developer Platform](https://solana.com/news/solana-developer-platform): API-first institutional payment infrastructure and current enterprise partners.
- [Colosseum Frontier winners](https://blog.colosseum.com/announcing-the-winners-of-the-solana-frontier-hackathon/): winning teams emphasize a durable startup wedge, execution speed, insight, and founder-market fit rather than protocol assembly alone.
- [Mastercard Korea live agentic transaction](https://www.mastercard.com/news/ap/en/newsroom/press-releases/en/2026/mastercard-completes-korea-s-first-live-agentic-transactions-unlocking-trusted-ai-powered-commerce/): evidence that generic travel booking is already crowded.

Position Uptime402 as the buyer-side decision, governance, and outcome layer **on top of** x402 and, only when verified in the live path, pay.sh. It is not a replacement for the payment rail. The moat is domain policy, recovery outcomes, and cross-vendor audit evidence.

## Security research prompts

When hardening, search current primary papers and official issue trackers for:

- duplicate settlement and replay on Solana x402;
- context redirection between quoted and paid resource;
- pre-execution metadata and PII leakage;
- facilitator concentration and unavailable settlement;
- AP2 mandate authenticity, expiry, and execution-time revalidation.

Bind the method, URL, canonical body hash, merchant, mint, amount, mandate hash, nonce, and expiry. Use atomic reserve/commit/release semantics and retain `unknown` for ambiguous submission outcomes.
