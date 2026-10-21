# Uptime402 — 보존된 제출 deck과 추가 검증

## 2026-10-22 구매 RPC 검증

Gemini 3.8 Flash(`gemini-3.8-flash`)가 두 서명 견적 중 standard를 선택했고, 기존 지갑에서 `0.015 USDC`(`15000` base units)를 결제했다. 구매한 RPC에서 `getHealth=ok`와 Devnet genesis 일치를 확인하고 서명된 복구 결과와 예산 commit까지 완료했다. 판단 기록부터 복구까지 **7.026초**, 실제 두 RPC 호출은 **314.6ms**였다.

공식 Solana Devnet을 upstream으로 사용하는 자체 공급자 RPC 릴레이의 10분 접근권이다. 허용 메서드는 `getHealth`, `getGenesisHash`이며 입력 장애는 주입한 시나리오다. 운영 환경 전체 장애나 외부 상용 RPC 구독을 검증한 것으로 설명하지 않는다.

- 성공 거래: `jQtGSXygzbMBV3pptkYuFCJaU343LHxCyfo43y975oVoNFLqWNRD4wAZkTJR7s9czMqBXYS27kbFe83EbfSZgUS` — [Solana Explorer](https://explorer.solana.com/tx/jQtGSXygzbMBV3pptkYuFCJaU343LHxCyfo43y975oVoNFLqWNRD4wAZkTJR7s9czMqBXYS27kbFe83EbfSZgUS?cluster=devnet)
- 정산: `finalized`, slot `513662003`, payer `-15000`, payee `+15000` base units.
- 한도 초과 `25000 > 20000`과 nonce 재사용을 자동 거절했다. 두 요청 모두 추가 거래가 없다.
- 새 evidence SHA-256: `c3524b10e841f57f9ab4bcbe32cbfccbce74b7081c8e5ba4d9cdcb1a9627781f`
- 새 verification report SHA-256: `10c9fcf7b2206039960fb14281a99cec1afa0f8de2e973905147a60dd8d0441d`
- 기존 demo5 원본 두 파일과 과거 결제 증거는 그대로 보존했다.

첫 검증 거래도 0.015 Devnet USDC로 정산됐으나, 접근권 만료와 견적 만료를 같아야 한다고 검사하는 오류로 복구 단계가 거절됐다. 해당 기록을 보존하고 만료 검사를 수정한 뒤 별도 실행에서 위 결과를 얻었다. **이번 작업의 새 Devnet 결제는 총 2건, 0.030 USDC**다. 첫 거래를 재결제하거나 실패를 성공으로 표시하지 않았다.

상세: [새 RPC 검증 기록](RPC_RECOVERY_2026-10-22.md). 아래 과거 기록과 영상 수치는 당시 실행에만 적용한다.


Export target: `submission/Uptime402_Deck.pdf`. 아래 값은 `finalist-demo-5`의 `artifacts/payment-evidence.json`과 독립 `artifacts/verification-report.json`에서 가져왔다. 9-page PDF/PPTX는 이 실측값으로 재export했고 overflow, template fidelity, source render, final PDF render QA를 통과했다. 이 deck은 새 결제를 만들지 않는 judge-facing read-only replay이며, 165-second final walkthrough는 `https://www.youtube.com/watch?v=jwJRfs-NRZY`에 공개했다.

## 1. An outage does not wait for procurement

**Uptime402** — AI SRE that discovers, pays for, and proves recovery in one incident budget.

- Google Cloud + Gemini + A2A + x402 + Solana Devnet USDC
- 운영자 최초 mandate 이후 결제 건별 승인 없음
- Hero visual: red dependency → autonomous paid recovery → green health

## 2. The procurement gap is an outage multiplier

- 장애 복구에 필요한 외부 routing, capacity, diagnostics는 즉시 필요하다.
- 현재 흐름은 vendor 탐색 → 견적 → 승인 → 결제 → provisioning으로 단절된다.
- 목표: **Time-to-remediation**, not a crypto checkout.
- Primary user: on-call SRE / platform engineer. Economic buyer: Head of Infrastructure / CTO / FinOps lead.

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

- Public control-plane: incident/Gemini/A2A/orchestration; wallet signer 없음.
- Public vendor-agent: Agent Card, two signed offers, atomic shared claim, paid resource.
- Private payment-executor: exact IAM audience, authoritative policy reload/recheck, wallet signer; unauthenticated 요청은 `401/403`.
- Firestore transaction + distinct Cloud Run service accounts + version-pinned secrets.

Judge-facing slide copy intentionally omits Cloud Run runtime deployment identifiers, image tags, and release-stage labels. Runtime/deployment identity is verified separately in hash-bound artifacts and is not inferred from this architecture diagram.

## 6. Gemini is material, but not the bank

- Live model: `gemini-2.5-flash`; strict output is diagnosis, capability, selected supplied offerId, rationale, confidence.
- Baseline degraded telemetry: `1800ms`, `45%` failure → `rpc-recovery-standard`, `15000` base units, offer latency `180ms`.
- Counterfactual full outage: `12000ms`, `100%` failure → `rpc-recovery-emergency`, `25000` base units, offer latency `30ms`.
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

Demo5 measured evidence:

- `0.015 USDC` / `15000` base units, finalized slot `480903755`
- tx `4P7YWm9Rt7w4MKbRvmfj3sjt5SW1NUfra7xyT9zUMD9uBsby4f3JC8LgYKUFPE1GXN24SoK8ABRx5YSf1HQAKtmZ`
- payer `-15000`, payee `+15000`; incident budget `50000 -> 35000` base units (`0.050 -> 0.035 USDC`)
- vendor receipt key `uptime402-vendor-v1`; distinct outcome key `uptime402-outcome-v1`; `statusAfter: healthy`

These values are bound to `payment-evidence.json` SHA-256 `0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4` and `verification-report.json` SHA-256 `b147e7cfe2c71fee903f4052ca342d8266343694e48843ae017c8e55ae42cd3e`. The deck shows their prefixes and presents them only as a read-only replay of `finalist-demo-5`.

## 8. Safety under failure and replay

- `amount.per_transaction_limit`: `25000 > 20000`, `transactionCreated:false`, `txSignature:null`
- `identifier.nonce_fresh`: attempted `15000` with reused primary nonce, fresh payment/idempotency IDs, `transactionCreated:false`, `txSignature:null`
- two vendor instances settle/fulfill once
- same fingerprint returns cached response; changed fingerprint 409
- ambiguous submission remains unknown/reconcile; no double pay
- SSRF, IAM audience, redaction, schema, receipt mutation tests
- Mainnet disabled

## 9. From procurement latency to recovery latency

Final frame:

- Live Gemini/A2A decision captured → healthy recovery: **9.340s** (`11:18:01.000Z -> 11:18:10.340Z`; do not derive from fixture `incidentAt`)
- Autonomous payment approvals after trigger: **0**
- Devnet settlement: **0.015 USDC, finalized, `4P7Y…KtmZ`**
- Exact token delta: **payer `-15000` / payee `+15000`**
- Deterministic safety: **two automatic denials, zero new transactions**
- Business model: Team control-plane fee + routed-spend percentage; Enterprise annual policy/audit/SSO package.
- Positioning: buyer-side governance and recovery-outcome layer above x402, not a replacement payment rail.
- Live control-plane origin: `https://uptime402-control-plane-1065649463621.asia-northeast3.run.app` (deployment state is verified separately; this deck makes no deployment-state claim).
- Ask: bring programmable, bounded incident procurement into production SRE workflows.

Footer: `Uptime402 — An outage does not wait for procurement.`

Judge-facing close: `finalist-demo-5` / `READ-ONLY REPLAY · NO NEW PAYMENT`, followed by the verified amount, recovery time, decimal budget delta, and transaction signature summary. The deck, public replay, evidence and published video use the same verified values.

Public source: `https://github.com/kwakhyun/uptime402-agentic-commerce`. The repository is public and the current gate results are recorded in `docs/BUILD_STATUS.md`: install, lint, typecheck, effective full suite, Firestore emulator 10/10, production build, template validation, Git boundary audit, and structural readiness. Keep the deck itself URL-light; the final handoff records the exact public commit.
