# Uptime402 build status

Last updated: `2026-08-30T11:07:08+09:00`

Uptime402 was submitted before the 2026-08-03 23:59 KST deadline and was not selected among the ten finalists announced on 2026-08-07. It is now maintained as a portfolio/reference implementation. 아래 표의 `implementation`, `evidence`, `deployment`, `verification`, `priority`는 서로 독립적인 축이다. 로컬 테스트나 live endpoint만으로 Devnet settlement를 주장하지 않는다.

## 현재 체크포인트

- Current replay deployment: GCP project `uptime402-hack-260803`, region `asia-northeast3`, control revision `uptime402-control-plane-00022-dd6`, exact source commit `85954e700095ddc78be0c63810e5f0de1349fd85`, Cloud Build `676d7d1f-1203-4e48-ac29-0dd101f2f083` `SUCCESS`, image digest `sha256:51b9d80bc2a7307e4baa09f7e2394bca5ddb8dc6dcc5c0a1f6e9384cd8111436`.
- Preserved payment services: executor revision `uptime402-payment-executor-00012-2dg`, vendor revision `uptime402-vendor-agent-00011-88p`, payment runtime SHA `10ca5f2ccaf2af45e2d80f6065de9c623b24e559`. 이 두 service는 portfolio replay 배포에서 다시 build하거나 변경하지 않았다.
- Current replay boundary: UI stage `final`, root/health `200`, mutation route `404`, executor unauthenticated `403`, vendor health/Agent Card `200`. Logged-out desktop 1440×1024와 mobile 390×844에서 `DEVNET VERIFIED`, 핵심 무승인 결제 문구, replay controls, no horizontal overflow, no console error를 확인했다.
- Current control identity has no executor `run.invoker`, Firestore `datastore.user`, Vertex `aiplatform.user`, or retired capture-secret access. Current replay manifest에는 OAuth, Gemini, Firestore, executor endpoint와 secret volume이 없다. 이는 현재 read-only 배포 경계이며 2026-08-03 capture 당시의 payment path IAM 증거를 소급 변경하지 않는다.
- Current deployment authority: `artifacts/portfolio-deployment/manifest.json`. 공개 파일에는 최소 deployment attestation과 owner-private raw export의 SHA-256만 있고, 개인·조직 권한 메타데이터가 든 원본은 ignored `private/portfolio-deployment-raw/`에만 있다. 이 artifact는 `notPaymentEvidence: true`다. `artifacts/final-release.json`과 `artifacts/final-deployment/`는 initial final-promotion history다.
- Preserved real payment: `finalist-demo-5`, `0.015 USDC` (`15000` base units), finalized signature `4P7YWm9Rt7w4MKbRvmfj3sjt5SW1NUfra7xyT9zUMD9uBsby4f3JC8LgYKUFPE1GXN24SoK8ABRx5YSf1HQAKtmZ`. 추가 Devnet payment는 실행하지 않았다.
- Payment evidence SHA-256: `sha256:0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4`. Verification report SHA-256: `sha256:b147e7cfe2c71fee903f4052ca342d8266343694e48843ae017c8e55ae42cd3e`; independent report 13 checks are all true.
- Portfolio media: 9-page deck is tracked. The 165.021-second H.264/AAC demo is intentionally excluded from Git and published on [YouTube](https://www.youtube.com/watch?v=jwJRfs-NRZY).

## Integration status

| Integration | implementation | evidence | deployment | verification | lastVerifiedAt | evidenceRef | priority | Notes / blocker |
|---|---|---|---|---|---|---|---|---|
| Standard x402 paid resource | implemented | devnet | live | verified | 2026-08-03T21:24:50+09:00 | `artifacts/payment-evidence.json`; `artifacts/verification-report.json` | P0 | `402 -> reserve -> automatic PAYMENT-SIGNATURE -> paid retry -> facilitator verify/settle -> confirmed 200 -> signed receipt`; executor did not pre-broadcast |
| Solana Devnet USDC settlement | implemented | devnet | live | verified | 2026-08-03T20:18:06+09:00 | `artifacts/payment-evidence.json`; signature `4P7Y…KtmZ` | P0 | finalized slot `480903755`; CAIP-2 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; mint `4zMMC…ncDU`; distinct payer/payee; deltas `-15000/+15000` |
| Deterministic policy and dual denial | implemented | devnet | live | verified | 2026-08-03T20:18:22+09:00 | `artifacts/live-capture/policy-denial-over-transaction-limit-artifact.json`; `artifacts/live-capture/policy-denial-replay-artifact.json` | P0 | `25000 > 20000` over-cap and primary nonce replay both have `transactionCreated:false`, `txSignature:null` |
| Atomic reservation and fulfillment claim | implemented | devnet | live | verified | 2026-08-03T20:39:06+09:00 | `artifacts/payment-evidence.json`; managed-state audit; Firestore emulator artifact | P0 | demo5 reservation committed and vendor claim reached `receipt_signed`; concurrent replay and ambiguous-state rules pass locally |
| Signed receipt and recovery outcome | implemented | devnet | live | verified | 2026-08-03T20:51:11+09:00 | `artifacts/payment-evidence.json` | P0 | vendor key `uptime402-vendor-v1` binds offer/request/tx/response/incident; distinct outcome key `uptime402-outcome-v1` binds the receipt to `healthy` |
| Gemini two-offer material decision | implemented | devnet | live | verified | 2026-08-03T20:18:13+09:00 | `artifacts/live-capture/gemini-selection-artifact.json` | P0 | captured `gemini-2.5-flash` strict output selected `rpc-recovery-standard`; counterfactual selected `rpc-recovery-emergency` |
| A2A Agent Card and message boundary | implemented | devnet | live | verified | 2026-08-30T01:34:24Z | `artifacts/portfolio-deployment/manifest.json`; `artifacts/live-capture/vendor-agent-card.json` | P0 | separate public vendor service still returns health and Agent Card `200`; two immutable signed offers are preserved |
| Read-only portfolio mission control | implemented | devnet | live | verified | 2026-08-30T10:20:00+09:00 | `artifacts/portfolio-deployment/manifest.json`; `apps/control-plane/components/mission-control.tsx` | P0 | logged-out evidence replay is the default; no Google login/live trigger; mutation routes fail before auth/backend initialization |
| Current Cloud Run and IAM boundary | implemented | local | live | verified | 2026-08-30T01:54:42Z | `artifacts/portfolio-deployment/manifest.json`; owner-private raw exports | P0 | capture tool verified control/vendor public, executor private, distinct service accounts, and no current control backend role, executor invoke permission, or retired config access; public manifest exposes only the minimal attestation and source hashes |
| Evidence hash-pinned final stage | implemented | devnet | live | verified | 2026-08-30T01:34:24Z | `artifacts/payment-evidence.json`; `artifacts/verification-report.json`; `artifacts/portfolio-deployment/manifest.json` | P0 | exact evidence/report bytes are pinned; missing or mismatched evidence cannot render `VERIFIED` |
| Test, supply-chain and release gates | implemented | local | local | verified | 2026-08-30T11:07:08+09:00 | `.github/workflows/quality.yml`; `scripts/run-maintenance-gates.ts`; `pnpm-lock.yaml` | P0 | clean-clone lint, typecheck, 185 non-emulator tests, production build, production audit, Git boundary, deployment contracts and strict readiness pass; clean-clone Firestore suite passed 10/10. CI action runtimes use their current Node 24-compatible major versions |
| Public source release | implemented | local | live | verified | 2026-08-30T11:07:08+09:00 | `https://github.com/kwakhyun/uptime402-agentic-commerce`; [GitHub Actions quality](https://github.com/kwakhyun/uptime402-agentic-commerce/actions/workflows/quality.yml) | P0 | public `main` is fast-forwarded only with a raw-metadata-free squash tree; maintenance and Firestore jobs are required to pass after each push |
| Pub/Sub, Eventarc, Workflows, BigQuery pipeline | planned | none | local | unverified | — | `docs/ARCHITECTURE.md` | P1 | production async extension; deliberately outside the proved synchronous recovery path |
| pay.sh live-path participation | planned | none | local | unverified | — | — | P1 | not used in the verified path and not claimed |
| AP2 canonical conformance | planned | none | local | unverified | — | — | P1 | no AP2-compliant claim |
| Native Solana Fixed Delegation | planned | none | local | unverified | — | — | P1 | P0 guarantee remains application-enforced policy plus low-balance blast-radius isolation |

## Exact demo5 evidence

- Payer owner `5ZT11fqnqaZPbWLqx5o4PCNSisXLKV1YFtNUxjQSGPHu`, token account `3Xu6xWJQ8TKdTfM21qkqvjqdAJd7Wg6qQgAB8EsMJvQd`: `19970000 -> 19955000` (`-15000`).
- Payee owner `GKW6kwSgTY1KkMi4ygAbZH1gZ13mYHfQJjrCASqYodmk`, token account `7XiW3QKwGEbBzCfZALeoNKCYSaLcBzqenB9YtGT6Z74J`: `30000 -> 45000` (`+15000`).
- Paid offer `rpc-recovery-standard` is `15000` base units. Counterfactual offer `rpc-recovery-emergency` is `25000`, above the `20000` per-transaction cap.
- Failures `finalist-demo-1` and `finalist-demo-2` remain locked audit records and were never retried, released, deleted, or promoted.

## Maintenance rule

The preserved demo5 payment evidence is immutable. UX and documentation releases may update only the read-only replay image and current deployment evidence. A future payment claim requires a fresh one-shot slot, new promotion bundle, independent verification, and a newly hash-pinned final deployment.
