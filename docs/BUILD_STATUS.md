# Uptime402 build status

Last updated: `2026-08-03T22:50:21+09:00`

Submission deadline: **2026-08-03 23:59 KST**. 각 행의 다섯 축은 독립적이다. `implementation`은 코드 존재, `evidence`는 증거 환경, `deployment`는 endpoint 배포 상태, `verification`은 해당 행의 검증 완료 여부, `priority`는 범위를 뜻한다. `local` test나 `live` deployment만으로 Devnet settlement 또는 submission readiness를 의미하지 않는다.

## 현재 체크포인트

- GCP: project `uptime402-hack-260803`, region `asia-northeast3`, three-service final deployment가 Ready이고 각 service는 latest revision에 100% traffic을 보낸다.
- Revisions: control `uptime402-control-plane-00015-sqw`, executor `uptime402-payment-executor-00012-2dg`, vendor `uptime402-vendor-agent-00011-88p`; deployed image tag는 모두 Git SHA `10ca5f2ccaf2af45e2d80f6065de9c623b24e559`다.
- Cloud Build: `793d0ada-8859-4ed6-b2ad-bf3a5fd13ee3` `SUCCESS`; digests are control `sha256:1f9313ae6915f09a81d78b26816fa918a0a22750f57cdedb95b7f1c256e953db`, executor `sha256:766bed6a1c1f12968e18b7a1fadab1afe61c916fd65a29243af7d2b37bb550ad`, vendor `sha256:cc249b8f161fe96ec0fde0b6f79c2a977aef5433fe2ac0726fde2eae4b7ff694`.
- UI stage: `final`. Exact evidence/report hashes are configured; logged-out root defaults to `DEVNET VERIFIED` read-only replay and does not render Google login or a live payment trigger.
- Real payment: `finalist-demo-5`, `0.015 USDC`, finalized signature `4P7YWm9Rt7w4MKbRvmfj3sjt5SW1NUfra7xyT9zUMD9uBsby4f3JC8LgYKUFPE1GXN24SoK8ABRx5YSf1HQAKtmZ`.
- Current evidence file: `artifacts/payment-evidence.json`, SHA-256 `sha256:0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4`.
- Verification: independent report의 13 checks가 모두 true다. Evidence SHA-256은 `sha256:0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4`, report SHA-256은 `sha256:b147e7cfe2c71fee903f4052ca342d8266343694e48843ae017c8e55ae42cd3e`다. IAM policy bytes/hash `sha256:edadb0b47f343f024a871b2482867c6ce9f84c78ab1686041fc01c0710ea56a8`은 변하지 않았다. 과거 `75/0/0` submission checker 기록은 제거된 QA-failed video가 있던 tree의 결과이므로 현재 결과로 재주장하지 않는다.
- Final QA: public root/control health/vendor Agent Card `200`, unauthenticated operator mutation and executor `403`, three latest revision ERROR logs `0`. Chrome logged-out 1440×1000 and 390×844 views, protocol disclosure, evidence drawer were checked. Prior successful OAuth capture와 final exact audience/client-ID config가 일치하며 추가 authenticated mutation은 실행하지 않았다.
- Open blocker: 9-page deck은 demo5 값으로 재export·렌더 QA를 통과했지만 final video file/URL은 아직 없다.
- No more payment: public submission evidence가 증명하는 지출은 demo5의 `0.015 USDC` 한 건이다. 추가 결제를 실행하지 않는다.

## Integration status

| Integration | implementation | evidence | deployment | verification | lastVerifiedAt | evidenceRef | priority | Notes / blocker |
|---|---|---|---|---|---|---|---|---|
| Standard x402 exact paid resource | implemented | devnet | live | verified | 2026-08-03T21:24:50+09:00 | `artifacts/payment-evidence.json`; `artifacts/verification-report.json` | P0 | demo5 trace는 `402 -> reserve -> automatic PAYMENT-SIGNATURE -> paid retry -> facilitator verify/settle -> confirmed 200 -> receipt` 순서이며 executor가 먼저 broadcast하지 않았다. TS verifier와 independent Python gate가 pre-payload binding 및 finalized facilitator co-sign을 검증했다 |
| Solana Devnet USDC settlement | implemented | devnet | live | verified | 2026-08-03T20:18:06+09:00 | `artifacts/payment-evidence.json`; Solana signature `4P7Y…KtmZ` | P0 | finalized slot `480903755`; CAIP-2 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; mint `4zMMC…ncDU`; payer/payee owners distinct; exact deltas `-15000/+15000` |
| Deterministic policy + automatic dual denial | implemented | devnet | live | verified | 2026-08-03T20:18:22+09:00 | `artifacts/live-capture/policy-denial-over-transaction-limit-artifact.json`; `artifacts/live-capture/policy-denial-replay-artifact.json` | P0 | `amount.per_transaction_limit` at `25000 > 20000`; `identifier.nonce_fresh` with primary nonce reused. Both `transactionCreated:false`, `txSignature:null`; no paid retry/settlement for either denial |
| Atomic buyer reservation + vendor fulfillment claim | implemented | devnet | live | verified | 2026-08-03T20:39:06+09:00 | `artifacts/payment-evidence.json`; owner-only Firestore/log audit | P0 | primary reservation committed and vendor claim reached `receipt_signed`; two denial paths created no reservation/authorization/claim/resource. Managed Firestore state was read-only audited and local emulator suite passed 10/10 |
| Vendor signed offer/fulfillment receipt | implemented | devnet | live | verified | 2026-08-03T20:51:11+09:00 | `artifacts/payment-evidence.json`; `artifacts/live-capture/vendor-agent-card.json` | P0 | vendor key `uptime402-vendor-v1` binds offer/request/tx/response/incident and differs from payee; verifier passed signature and mutation-sensitive binding checks |
| Recovery outcome binding | implemented | devnet | live | verified | 2026-08-03T20:51:11+09:00 | `artifacts/payment-evidence.json`; `artifacts/live-capture/recovery-outcome-artifact.json` | P0 | distinct control-plane key `uptime402-outcome-v1` binds receipt hash and response to `statusAfter: healthy`; verifier recomputed the binding |
| Gemini strict two-offer material selection | implemented | devnet | live | verified | 2026-08-03T20:18:13+09:00 | `artifacts/live-capture/gemini-selection-artifact.json` | P0 | live `gemini-2.5-flash`; baseline selected `rpc-recovery-standard`, counterfactual selected `rpc-recovery-emergency`; both schema-validated from captured redacted runtime artifacts |
| A2A Agent Card + remote message boundary | implemented | devnet | live | verified | 2026-08-03T20:10:05+09:00 | `artifacts/live-capture/vendor-agent-card.json`; `artifacts/final-release.json` | P0 | separate public vendor Cloud Run service exposes the Agent Card and two immutable signed offers; operator-identifying raw service export is withheld from the public snapshot |
| Control-plane mission-control UI | implemented | devnet | live | verified | 2026-08-03T22:50:21+09:00 | `apps/control-plane/src/server/ui-evidence.ts`; control revision `uptime402-control-plane-00015-sqw` | P0 | exact evidence/report hashes are pinned. Logged-out desktop/mobile render `DEVNET VERIFIED` read-only replay; simplified hero states 0.015 USDC, 0 approvals, 9.340s, in-policy before protocol details |
| Live-to-promoted run binding | implemented | devnet | live | verified | 2026-08-03T20:51:11+09:00 | `artifacts/payment-evidence.json`; `tests/evidence-verifier.test.ts` | P0 | demo5 `runBindingHash` is `sha256:a4e7321d4f191d58b58eccb8898a1f55f5dc468d22dce05b0ae7944ae08110dc`; verifier recomputed it from the strict promoted fragments |
| Three-service Cloud Run boundary | implemented | local | live | verified | 2026-08-03T22:50:21+09:00 | `artifacts/final-release.json`; `artifacts/final-deployment/*.iam.json` | P0 | control/vendor public, executor private; distinct service accounts; same immutable image tag; Ready final revisions at 100% traffic; public snapshot retains derived summary and leaf IAM proof while withholding operator-identifying raw service/project exports |
| IAM + signer-secret least privilege | implemented | local | live | verified | 2026-08-03T22:50:21+09:00 | `artifacts/final-deployment/*.iam.json`; `artifacts/final-release.json` | P0 | executor unauthenticated `403`; control SA is its only invoker; among runtime SAs only executor accesses the version-pinned signer secret; vendor alone accesses offer/receipt secrets |
| Firestore transactional state | implemented | devnet | live | verified | 2026-08-03T21:25:44+09:00 | `artifacts/payment-evidence.json`; `artifacts/local/firestore-emulator-verification.json`; owner-only managed-state audit | P0 | demo5 mandate/action/reservation/authorization/vendor claim/resource/receipt/outcome were audited. Latest local emulator suite is 10/10 |
| Local repository gates | implemented | local | local | verified | 2026-08-03T22:50:21+09:00 | `package.json`; `artifacts/local/firestore-emulator-verification.json` | P0 | lint/typecheck/build/template/diff/boundary passed; full Vitest `178 passed / 9 skipped`; Firestore emulator `10/10`. Submission-only gate remains blocked by absent final video |
| Payment evidence promotion + fresh report | implemented | devnet | live | verified | 2026-08-03T22:50:21+09:00 | `artifacts/payment-evidence.json`; `artifacts/verification-report.json`; control revision `00015-sqw` | P0 | demo5-only evidence and nonce-bound report passed repository verifier and independent public RPC gate; exact hashes are configured on the final UI |
| Deck PDF | implemented | local | local | verified | 2026-08-03T22:20:00+09:00 | `artifacts/local/deck-verification.json`; `submission/Uptime402_Deck.pdf` | P0 | 9 pages; demo5 values matched; PPTX/PDF render, overflow and template-fidelity QA passed. PDF SHA-256 `983ac835…6a263`; PPTX `cc5eefbb…68264` |
| Demo video <=180 seconds | blocked | none | local | unverified | — | — | P0 | QA-failed provisional MP4 was removed from the Git candidate set. A <=180-second secret-free full-screen final replay file or accessible URL is still required |
| Pub/Sub → Eventarc → Workflows → BigQuery audit pipeline | planned | none | local | unverified | — | `docs/ARCHITECTURE.md` | P1 | hackathon recommendation mapped as the production async extension for settlement events, reconciliation, receipt dispatch, and analytics; P0 intentionally proves the shorter synchronous safety path first |
| pay.sh live-path participation | planned | none | local | unverified | — | — | P1 | pay.sh is absent from the verified live path and is not claimed |
| AP2 canonical conformance | planned | none | local | unverified | — | — | P1 | only `AP2-aligned` may be used at design level; no validated/compliant claim |
| Native Solana Fixed Delegation | planned | none | local | unverified | — | — | P1 | P0 is application-enforced policy plus low-balance blast-radius isolation, never a scoped-wallet or cryptographic-cap claim |

## Exact demo5 evidence

- Payer owner: `5ZT11fqnqaZPbWLqx5o4PCNSisXLKV1YFtNUxjQSGPHu`; token account `3Xu6xWJQ8TKdTfM21qkqvjqdAJd7Wg6qQgAB8EsMJvQd`; `19970000 -> 19955000` (`-15000`).
- Payee owner: `GKW6kwSgTY1KkMi4ygAbZH1gZ13mYHfQJjrCASqYodmk`; token account `7XiW3QKwGEbBzCfZALeoNKCYSaLcBzqenB9YtGT6Z74J`; `30000 -> 45000` (`+15000`).
- Paid offer: `rpc-recovery-standard`, `15000` base units. Counterfactual offer: `rpc-recovery-emergency`, `25000` base units and therefore denied by the per-transaction cap.
- Receipt key: `uptime402-vendor-v1`; outcome key: `uptime402-outcome-v1`; identities differ from each other and from payer/payee.
- Failures `finalist-demo-1` and `finalist-demo-2` remain locked audit records and were not retried, released, deleted, or used as evidence.

## Remaining handoff before submission-ready claim

1. Record the 165-second (hard limit 180 seconds) secret-free full-screen read-only final replay using `docs/DEMO_SCRIPT.md`; do not run a new incident or payment. Preserve the evidence-declared `submission/Uptime402_Demo.mp4` path and `165`-second contract unless you intentionally rerun evidence/report pinning.
2. Complete audio/playback/duration/claim QA, place the accepted MP4 at the evidence-declared `submission/Uptime402_Demo.mp4` path with the exact `165`-second contract, then run the submission-only readiness checker. Changing that path or declared duration requires evidence → report → final hash repinning.
3. Upload the accepted local MP4 externally only with the user's separate approval; the public URL is an additional distribution link, not a replacement for the pinned local evidence contract.

Uptime402 is a real Devnet/live **final evidence replay**, but it is not submission-ready until the final video gate closes.
