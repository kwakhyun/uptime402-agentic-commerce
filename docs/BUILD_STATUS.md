# Uptime402 build status

Last updated: `2026-09-05T21:15:40+09:00`

Uptime402 was submitted before the 2026-08-03 23:59 KST deadline and was not selected among the ten finalists announced on 2026-08-07. It is now maintained as a portfolio/reference implementation. 아래 표의 `implementation`, `evidence`, `deployment`, `verification`, `priority`는 서로 독립적인 축이다. 로컬 테스트나 live endpoint만으로 Devnet settlement를 주장하지 않는다.

## 현재 체크포인트

- 2026-09-05 사용자 승인 범위: 한국어 문구 개선 후 전체 변경사항 커밋, main 푸시, 기존 공개 replay 배포를 완료했다. 별도 제출 마감은 없다. 새 결제 실행과 capture 권한 활성화는 이번 배포에 포함하지 않는다.

- 2026-09-05 검토 개선을 로컬 코드에 반영했다. 결제 후 단계 재개, 원자적 예산 증거, 실제 RPC probe, 검증 범위와 조건 비교 UI, 모듈 분리, 캐시/지연 로딩, DOM 테스트와 취약 의존성 패치를 포함한다. 결제 실행 경로의 검증은 로컬 구현에 한정한다. UI는 새 공개 리비전에서 확인했으며 demo5 evidence와 기존 결제 서비스 리비전은 보존했다. 상세: `docs/REVIEW_2026-09-05.md#개선-반영-기록`.

- Current replay deployment: GCP project `uptime402-hack-260803`, region `asia-northeast3`, control revision `uptime402-control-plane-00023-sl4`, exact source commit `cb3e5595e33670536e552327ebda2a27a7d48f94`, Cloud Build `9339a850-987a-4077-8067-d4ca796082ea` `SUCCESS`, image digest `sha256:dadf1d201429242f59573a9f791ea95426b07a31dc36dc08d6b4e33e57b4ce95`.
- Preserved payment services: executor revision `uptime402-payment-executor-00012-2dg`, vendor revision `uptime402-vendor-agent-00011-88p`, payment runtime SHA `10ca5f2ccaf2af45e2d80f6065de9c623b24e559`. 이 두 service는 portfolio replay 배포에서 다시 build하거나 변경하지 않았다.
- 공개 서비스 상태: UI 단계 `final`, 메인 화면과 health API `200`, 실행 API `404`, 비인증 executor `403`, vendor health/Agent Card `200`. 로그인 없이 데스크톱 1440×1024와 모바일 390×844에서 한국어 문구, 재생 버튼, 조건 전환과 상세 증거를 확인했다. 두 화면 모두 가로 넘침이 없었다.
- Current control identity has no executor `run.invoker`, Firestore `datastore.user`, Vertex `aiplatform.user`, or retired capture-secret access. Current replay manifest에는 OAuth, Gemini, Firestore, executor endpoint와 secret volume이 없다. 이는 현재 read-only 배포 경계이며 2026-08-03 capture 당시의 payment path IAM 증거를 소급 변경하지 않는다.
- Current deployment authority: `artifacts/portfolio-deployment/manifest.json`. 공개 파일에는 최소 deployment attestation과 owner-private raw export의 SHA-256만 있고, 개인·조직 권한 메타데이터가 든 원본은 ignored `private/portfolio-deployment-raw/`에만 있다. 이 artifact는 `notPaymentEvidence: true`다. `artifacts/final-release.json`과 `artifacts/final-deployment/`는 initial final-promotion history다.
- Preserved real payment: `finalist-demo-5`, `0.015 USDC` (`15000` base units), finalized signature `4P7YWm9Rt7w4MKbRvmfj3sjt5SW1NUfra7xyT9zUMD9uBsby4f3JC8LgYKUFPE1GXN24SoK8ABRx5YSf1HQAKtmZ`. 추가 Devnet payment는 실행하지 않았다.
- Payment evidence SHA-256: `sha256:0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4`. Verification report SHA-256: `sha256:b147e7cfe2c71fee903f4052ca342d8266343694e48843ae017c8e55ae42cd3e`; independent report 13 checks are all true.
- Portfolio media: 9-page deck is tracked. The 165.021-second H.264/AAC demo is intentionally excluded from Git and published on [YouTube](https://www.youtube.com/watch?v=jwJRfs-NRZY).

## Integration status

| Integration | implementation | evidence | deployment | verification | lastVerifiedAt | evidenceRef | priority | Notes / blocker |
|---|---|---|---|---|---|---|---|---|
| Payment continuation and atomic budget evidence | implemented | local | local | verified | 2026-09-05T20:53:43+09:00 | `tests/control-plane-live-flow.test.ts`; `tests/services-integration.test.ts`; `tests/recovery-checkpoints-firestore.test.ts` | P0 | health/commit/audit 실패 후 추가 결제 없이 재개; original proof events 유지; 동시 예약 snapshot 검증. 새 live payment 없음 |
| Paid-route RPC health probe | implemented | local | local | verified | 2026-09-05T20:53:43+09:00 | `tests/recovery-rpc-probe.test.ts`; `tests/dependency-health.test.ts` | P0 | pinned offer/resource/RPC, getHealth 및 Devnet genesis 확인. 실제 구매 endpoint 설정과 live 검증은 별도 필요 |
| Evidence scope, comparison UX and replay performance | implemented | local | live | verified | 2026-09-05T12:14:35.261Z | `artifacts/portfolio-deployment/manifest.json`; `tests/mission-control-dom.test.ts`; `docs/REVIEW_2026-09-05.md` | P0 | 9.340초 측정 구간 정정, 미검증 성공 표현 제거, 실제 조건 비교, 상세 지연 로딩, 최대 4개 캐시. 한국어 문구와 desktop/mobile 공개 URL 검증 |
| Maintenance dependency patches | implemented | local | local | verified | 2026-09-05T20:53:43+09:00 | `package.json`; `pnpm-lock.yaml`; `docs/REVIEW_2026-09-05.md` | P0 | fast-uri 3.1.6, qs 6.16.0; production audit 0 known vulnerabilities; lint/typecheck/build 및 194개 기본 테스트 통과 |
| Standard x402 paid resource | implemented | devnet | live | verified | 2026-08-03T21:24:50+09:00 | `artifacts/payment-evidence.json`; `artifacts/verification-report.json` | P0 | `402 -> reserve -> automatic PAYMENT-SIGNATURE -> paid retry -> facilitator verify/settle -> confirmed 200 -> signed receipt`; executor did not pre-broadcast |
| Solana Devnet USDC settlement | implemented | devnet | live | verified | 2026-08-03T20:18:06+09:00 | `artifacts/payment-evidence.json`; signature `4P7Y…KtmZ` | P0 | finalized slot `480903755`; CAIP-2 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; mint `4zMMC…ncDU`; distinct payer/payee; deltas `-15000/+15000` |
| Deterministic policy and dual denial | implemented | devnet | live | verified | 2026-08-03T20:18:22+09:00 | `artifacts/live-capture/policy-denial-over-transaction-limit-artifact.json`; `artifacts/live-capture/policy-denial-replay-artifact.json` | P0 | `25000 > 20000` over-cap and primary nonce replay both have `transactionCreated:false`, `txSignature:null` |
| Atomic reservation and fulfillment claim | implemented | devnet | live | verified | 2026-08-03T20:39:06+09:00 | `artifacts/payment-evidence.json`; managed-state audit; Firestore emulator artifact | P0 | demo5 reservation committed and vendor claim reached `receipt_signed`; concurrent replay and ambiguous-state rules pass locally |
| Signed receipt and recovery outcome | implemented | devnet | live | verified | 2026-08-03T20:51:11+09:00 | `artifacts/payment-evidence.json` | P0 | vendor key `uptime402-vendor-v1` binds offer/request/tx/response/incident; distinct outcome key `uptime402-outcome-v1` binds the receipt to `healthy` |
| Gemini two-offer material decision | implemented | devnet | live | verified | 2026-08-03T20:18:13+09:00 | `artifacts/live-capture/gemini-selection-artifact.json` | P0 | captured `gemini-2.5-flash` strict output selected `rpc-recovery-standard`; counterfactual selected `rpc-recovery-emergency` |
| A2A Agent Card and message boundary | implemented | devnet | live | verified | 2026-09-05T12:14:35.261Z | `artifacts/portfolio-deployment/manifest.json`; `artifacts/live-capture/vendor-agent-card.json` | P0 | separate public vendor service still returns health and Agent Card `200`; two immutable signed offers are preserved |
| Read-only portfolio mission control | implemented | devnet | live | verified | 2026-09-05T12:14:35.261Z | `artifacts/portfolio-deployment/manifest.json`; `apps/control-plane/components/mission-control.tsx` | P0 | logged-out evidence replay is the default; no Google login/live trigger; mutation routes fail before auth/backend initialization |
| Current Cloud Run and IAM boundary | implemented | local | live | verified | 2026-09-05T12:14:35.261Z | `artifacts/portfolio-deployment/manifest.json`; owner-private raw exports | P0 | capture tool verified control/vendor public, executor private, distinct service accounts, and no current control backend role, executor invoke permission, or retired config access; public manifest exposes only the minimal attestation and source hashes |
| Evidence hash-pinned final stage | implemented | devnet | live | verified | 2026-09-05T12:14:35.261Z | `artifacts/payment-evidence.json`; `artifacts/verification-report.json`; `artifacts/portfolio-deployment/manifest.json` | P0 | exact evidence/report bytes are pinned; missing or mismatched evidence cannot render `VERIFIED` |
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

## 2026-09-05 공개 화면 배포 검증

- 실행 코드: `cb3e5595e33670536e552327ebda2a27a7d48f94`. 후속 커밋은 배포 증거와 문서만 갱신한다.
- [GitHub Actions](https://github.com/kwakhyun/uptime402-agentic-commerce/actions/runs/33965164971): maintenance와 Firestore Emulator 모두 성공. 기본 테스트 194개와 emulator 전용 12개를 합쳐 고유 테스트 206개 확인. 깨끗한 CI checkout의 strict structural readiness도 통과했다.
- Cloud Build와 새 Cloud Run revision은 위 현재 체크포인트 및 `artifacts/portfolio-deployment/manifest.json`과 일치한다. 공식 URL의 UI/health 200, mutation 404, 비인증 executor 403을 재확인했다.
- 한국어 문구, 조건 전환, 재생/일시정지/재시작, 상세 증거 열기를 공개 URL에서 확인했다. 1440px/390px 가로 넘침 없음.
- 기존 raw Cloud Run/IAM export는 ignored private history에 보존하고 새 export로 현재 배포 증거를 갱신했다. 개인 권한 메타데이터는 공개 Git에 포함하지 않았다.
- 기존 Devnet 결제 증거의 두 SHA-256은 유지했다. 새 결제, 지갑 변경, capture 권한 활성화는 수행하지 않았다. 결제 실행기와 공급자 이미지는 보존했으므로 그 실행 경로의 신규 기능은 아직 live 검증 대상이 아니다.
