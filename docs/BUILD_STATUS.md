# Uptime402 build status

Last updated: `2026-08-03T21:26:00+09:00`

Submission deadline: **2026-08-03 23:59 KST**. 각 행의 다섯 축은 독립적이다. `implementation`은 코드 존재, `evidence`는 증거 환경, `deployment`는 endpoint 배포 상태, `verification`은 해당 행의 검증 완료 여부, `priority`는 범위를 뜻한다. `local` test나 `live` deployment만으로 Devnet settlement 또는 submission readiness를 의미하지 않는다.

## 현재 체크포인트

- GCP: project `uptime402-hack-260803`, region `asia-northeast3`, three-service capture deployment가 Ready다.
- Revisions: control `uptime402-control-plane-00012-h7q`, executor `uptime402-payment-executor-00009-wgq`, vendor `uptime402-vendor-agent-00008-hrb`; deployed image tag는 모두 Git SHA `c938a866b74c9f2682b0d1c1fe27391e562b7caa`다.
- UI stage: `capture`. `UPTIME402_UI_EVIDENCE_SHA256`와 report hash env는 비어 있고 UI는 반드시 `LIVE UNVERIFIED`다.
- Real payment: `finalist-demo-5`, `0.015 USDC`, finalized signature `4P7YWm9Rt7w4MKbRvmfj3sjt5SW1NUfra7xyT9zUMD9uBsby4f3JC8LgYKUFPE1GXN24SoK8ABRx5YSf1HQAKtmZ`.
- Current evidence file: `artifacts/payment-evidence.json`, SHA-256 `sha256:0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4`.
- Verification: final automated checker가 current bundle을 다시 검증해 `75 passed / 0 warned / 0 failed`로 종료했다. Evidence SHA-256은 `sha256:0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4`, report SHA-256은 `sha256:b147e7cfe2c71fee903f4052ca342d8266343694e48843ae017c8e55ae42cd3e`다. IAM policy bytes/hash `sha256:edadb0b47f343f024a871b2482867c6ce9f84c78ab1686041fc01c0710ea56a8`은 변하지 않았다.
- Open blocker: evidence/report hash-pinned `final` revision은 아직 배포되지 않았다. 9-page deck은 demo5 값으로 재export·렌더 QA를 통과했지만, QA-failed `164.966667`-second provisional video는 교체가 필요하다.
- No more payment: 현재까지 실제 Devnet 지출은 `0.045 USDC`; 승인된 총상한 `0.05 USDC` 안이지만 추가 결제를 실행하지 않는다.

## Integration status

| Integration | implementation | evidence | deployment | verification | lastVerifiedAt | evidenceRef | priority | Notes / blocker |
|---|---|---|---|---|---|---|---|---|
| Standard x402 exact paid resource | implemented | devnet | live | verified | 2026-08-03T21:24:50+09:00 | `artifacts/payment-evidence.json`; `artifacts/verification-report.json` | P0 | demo5 trace는 `402 -> reserve -> automatic PAYMENT-SIGNATURE -> paid retry -> facilitator verify/settle -> confirmed 200 -> receipt` 순서이며 executor가 먼저 broadcast하지 않았다. TS verifier와 independent Python gate가 pre-payload binding 및 finalized facilitator co-sign을 검증했다 |
| Solana Devnet USDC settlement | implemented | devnet | live | verified | 2026-08-03T20:18:06+09:00 | `artifacts/payment-evidence.json`; Solana signature `4P7Y…KtmZ` | P0 | finalized slot `480903755`; CAIP-2 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; mint `4zMMC…ncDU`; payer/payee owners distinct; exact deltas `-15000/+15000` |
| Deterministic policy + automatic dual denial | implemented | devnet | live | verified | 2026-08-03T20:18:22+09:00 | `artifacts/live-capture/policy-denial-over-transaction-limit-artifact.json`; `artifacts/live-capture/policy-denial-replay-artifact.json` | P0 | `amount.per_transaction_limit` at `25000 > 20000`; `identifier.nonce_fresh` with primary nonce reused. Both `transactionCreated:false`, `txSignature:null`; no paid retry/settlement for either denial |
| Atomic buyer reservation + vendor fulfillment claim | implemented | devnet | live | verified | 2026-08-03T20:39:06+09:00 | `artifacts/payment-evidence.json`; owner-only Firestore/log audit | P0 | primary reservation committed and vendor claim reached `receipt_signed`; two denial paths created no reservation/authorization/claim/resource. Managed Firestore state was read-only audited; full final gate still reruns emulator tests |
| Vendor signed offer/fulfillment receipt | implemented | devnet | live | verified | 2026-08-03T20:51:11+09:00 | `artifacts/payment-evidence.json`; `artifacts/live-capture/vendor-agent-card.json` | P0 | vendor key `uptime402-vendor-v1` binds offer/request/tx/response/incident and differs from payee; verifier passed signature and mutation-sensitive binding checks |
| Recovery outcome binding | implemented | devnet | live | verified | 2026-08-03T20:51:11+09:00 | `artifacts/payment-evidence.json`; `artifacts/live-capture/recovery-outcome-artifact.json` | P0 | distinct control-plane key `uptime402-outcome-v1` binds receipt hash and response to `statusAfter: healthy`; verifier recomputed the binding |
| Gemini strict two-offer material selection | implemented | devnet | live | verified | 2026-08-03T20:18:13+09:00 | `artifacts/live-capture/gemini-selection-artifact.json` | P0 | live `gemini-2.5-flash`; baseline selected `rpc-recovery-standard`, counterfactual selected `rpc-recovery-emergency`; both schema-validated from captured redacted runtime artifacts |
| A2A Agent Card + remote message boundary | implemented | devnet | live | verified | 2026-08-03T20:10:05+09:00 | `artifacts/live-capture/vendor-agent-card.json`; `artifacts/live-capture/cloud-run-vendor-agent-service.json` | P0 | separate public vendor Cloud Run service exposes the Agent Card and two immutable signed offers |
| Control-plane mission-control UI | implemented | local | live | verified | 2026-08-03T20:10:19+09:00 | `apps/control-plane/src/server/ui-evidence.ts`; control revision `00012-h7q` | P0 | capture stage runs without evidence hashes and shows `LIVE UNVERIFIED`; no capture path may render verified evidence. Hash-pinned final-stage QA is not done |
| Live-to-promoted run binding | implemented | devnet | live | verified | 2026-08-03T20:51:11+09:00 | `artifacts/payment-evidence.json`; `tests/evidence-verifier.test.ts` | P0 | demo5 `runBindingHash` is `sha256:a4e7321d4f191d58b58eccb8898a1f55f5dc468d22dce05b0ae7944ae08110dc`; verifier recomputed it from the strict promoted fragments |
| Three-service Cloud Run boundary | implemented | local | live | verified | 2026-08-03T20:10:19+09:00 | `artifacts/live-capture/cloud-run-*-service.json`; `artifacts/live-capture/cloud-run-*-iam.json` | P0 | control/vendor public, executor private; distinct service accounts and Ready capture revisions. Final immutable revision after evidence pin is not deployed |
| IAM + signer-secret least privilege | implemented | local | live | verified | 2026-08-03T20:39:06+09:00 | `artifacts/live-capture/project-iam.json`; `artifacts/live-capture/executor-signer-access-iam-policy.json` | P0 | unauthenticated executor returned `403`; control SA is the executor invoker; among the three runtime SAs only executor accesses the version-pinned wallet secret |
| Firestore transactional state | implemented | devnet | live | verified | 2026-08-03T21:25:44+09:00 | `artifacts/payment-evidence.json`; `artifacts/local/firestore-emulator-verification.json`; owner-only managed-state audit | P0 | demo5 mandate/action/reservation/authorization/vendor claim/resource/receipt/outcome were audited. Latest local emulator suite is 10/10 |
| Local repository gates | implemented | local | local | verified | 2026-08-03T21:25:44+09:00 | `package.json`; `artifacts/local/firestore-emulator-verification.json` | P0 | final checker `75/0/0`; build/lint/typecheck/full Vitest passed; Firestore emulator `10/10`; template/diff/boundary checks passed. `manual.*` video/UI review remains independent |
| Payment evidence promotion + fresh report | implemented | devnet | local | verified | 2026-08-03T21:24:50+09:00 | `artifacts/payment-evidence.json`; `artifacts/verification-report.json` | P0 | current demo5-only evidence and nonce-bound report passed both repository verifier and independent public RPC gate. Exact hashes are not live UI claims until final deployment |
| Deck PDF | implemented | local | local | verified | 2026-08-03T21:03:00+09:00 | `artifacts/local/deck-verification.json`; `submission/Uptime402_Deck.pdf` | P0 | 9 pages; demo5 values matched; PPTX overflow, template fidelity, source renders and final PDF renders passed. PDF is image-backed and not tagged/searchable; editable PPTX is included |
| Demo video <=180 seconds | implemented | local | local | unverified | — | `submission/Uptime402_Demo.mp4` | P0 | provisional file is `164.966667` seconds/H.264 but has no audio; sampled frames are mostly static Codex desktop with a tiny UI inset and blank auth window. Manual QA failed; replace before submission |
| pay.sh live-path participation | planned | none | local | unverified | — | — | P1 | pay.sh is absent from the verified live path and is not claimed |
| AP2 canonical conformance | planned | none | local | unverified | — | — | P1 | only `AP2-aligned` may be used at design level; no validated/compliant claim |
| Native Solana Fixed Delegation | planned | none | local | unverified | — | — | P1 | P0 is application-enforced policy plus low-balance blast-radius isolation, never a scoped-wallet or cryptographic-cap claim |

## Exact demo5 evidence

- Payer owner: `5ZT11fqnqaZPbWLqx5o4PCNSisXLKV1YFtNUxjQSGPHu`; token account `3Xu6xWJQ8TKdTfM21qkqvjqdAJd7Wg6qQgAB8EsMJvQd`; `19970000 -> 19955000` (`-15000`).
- Payee owner: `GKW6kwSgTY1KkMi4ygAbZH1gZ13mYHfQJjrCASqYodmk`; token account `7XiW3QKwGEbBzCfZALeoNKCYSaLcBzqenB9YtGT6Z74J`; `30000 -> 45000` (`+15000`).
- Paid offer: `rpc-recovery-standard`, `15000` base units. Counterfactual offer: `rpc-recovery-emergency`, `25000` base units and therefore denied by the per-transaction cap.
- Receipt key: `uptime402-vendor-v1`; outcome key: `uptime402-outcome-v1`; identities differ from each other and from payer/payee.
- Failures `finalist-demo-1` and `finalist-demo-2` remain locked audit records and were not retried, released, deleted, or used as evidence.

## Remaining handoff before any completion claim

1. Commit the audited local state, build all three images from that immutable Git SHA, and deploy `final` with the exact evidence/report hashes without another payment.
2. Verify public logged-out UI, OAuth, IAM, unauthenticated executor 401/403, desktop/mobile rendering, and evidence drawer values.
3. Replace the <=180-second video with a secret-free full-screen read-only final replay and complete manual playback QA.
4. Ask immediately before public GitHub push or external video upload.

Until those gates close, Uptime402 is a real Devnet/live **capture**, not final or submission-ready.
