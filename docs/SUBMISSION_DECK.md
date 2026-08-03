# Uptime402 — 9-slide submission deck source

Export target: `submission/Uptime402_Deck.pdf`. 실제 Devnet/live 값은 `artifacts/payment-evidence.json`에서만 가져오고 placeholder 상태로 최종 export하지 않는다.

## 1. An outage does not wait for procurement

**Uptime402** — AI SRE that discovers, pays for, and proves recovery in one incident budget.

- Google Cloud + Gemini + A2A + x402 + Solana Devnet USDC
- 운영자 최초 mandate 이후 결제 건별 승인 없음
- Hero visual: red dependency → autonomous paid recovery → green health

## 2. The procurement gap is an outage multiplier

- 장애 복구에 필요한 외부 routing, capacity, diagnostics는 즉시 필요하다.
- 현재 흐름은 vendor 탐색 → 견적 → 승인 → 결제 → provisioning으로 단절된다.
- 목표: **Time-to-remediation**, not a crypto checkout.

Evidence visual: incident clock 옆에 “approval clicks after trigger: 0”.

## 3. One mandate, autonomous execution

1. 운영자가 incident/per-tx/TTL/asset/capability/recipient를 한 번 설정.
2. Gemini가 redacted telemetry를 진단하고 두 signed offer 중 하나를 선택.
3. deterministic executor가 policy를 reload/recheck/reserve하고 x402 payload를 자동 서명.
4. confirmed payment 뒤 resource를 실제 적용하고 health를 검증.

정확한 표현: **application-enforced policy plus low-balance blast-radius isolation**.

## 4. Standard x402, not a prepaid proof

Sequence visual:

`request → 402 → policy reserve → PAYMENT-SIGNATURE → paid retry → verify/settle → confirmed 200 → signed receipt`

- executor가 먼저 broadcast하지 않는다.
- CAIP-2 Devnet network와 USDC integer base units.
- payment identifier + nonce + request fingerprint + idempotency.

## 5. Three real trust boundaries

- Public control-plane: incident/Gemini/A2A/orchestration, signer 없음.
- Public vendor-agent: Agent Card, two signed offers, shared claim, paid resource.
- Private payment-executor: exact IAM audience, authoritative policy, wallet signer.
- Firestore transaction + distinct Cloud Run service accounts + version-pinned secrets.

Live export가 있을 때만 URL/IAM badge를 넣는다.

## 6. Gemini is material, but not the bank

- Strict output: diagnosis, capability, selected supplied offerId, rationale, confidence.
- Baseline telemetry와 counterfactual telemetry가 서로 다른 offer를 선택.
- amount, recipient, mint, network, budget math, raw signature는 deterministic code.
- vendor text/prompt injection은 untrusted data.

Visual: 2-column offer comparison + selection flip.

## 7. Evidence is the product

한 화면의 timeline과 evidence drawer:

- model/modelVersion + redacted input/output hashes
- A2A Agent Card + signed offers
- ordered policy rules + budget before/after
- raw x402 header names, tx signature, Explorer
- distinct payer/payee + exact token-account negative/positive delta
- verified vendor receipt + separate signed healthy outcome
- dual denial: per-tx over-cap + nonce replay, both `transactionCreated:false`

실제 evidence가 없으면 수치나 Explorer를 넣지 않는다.

## 8. Safety under failure and replay

- over-cap and nonce replay deny before signer
- two vendor instances settle/fulfill once
- same fingerprint returns cached response; changed fingerprint 409
- ambiguous submission remains unknown/reconcile; no double pay
- SSRF, IAM audience, redaction, schema, receipt mutation tests
- Mainnet disabled

## 9. From procurement latency to recovery latency

Final frame:

- Trigger → healthy recovery: **[insert verified runtime only]**
- Autonomous payment approvals after trigger: **0**
- Devnet settlement: **[insert verified signature/Explorer only]**
- Ask: bring programmable, bounded incident procurement into production SRE workflows.

Footer: `Uptime402 — An outage does not wait for procurement.`
