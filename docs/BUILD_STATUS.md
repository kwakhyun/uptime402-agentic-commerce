# Uptime402 build status

Last updated: `2026-10-21T20:01:38.299Z`

Uptime402 was submitted before the 2026-08-03 23:59 KST deadline and was not selected among the ten finalists announced on 2026-08-07. It is now maintained as a portfolio/reference implementation. 아래 표의 `implementation`, `evidence`, `deployment`, `verification`, `priority`는 서로 독립적인 축이다. 로컬 테스트나 live endpoint만으로 Devnet settlement를 주장하지 않는다.

## 현재 체크포인트

- 2026-10-22 추가 승인: 기본 모델을 Gemini 3.8 Flash로 변경하고 최신 main의 공개 Cloud Run replay를 배포한다. 별도 마감은 없으며 모델 호환성 검증, main 반영, Cloud Build와 배포, 공개 URL 확인 순으로 진행한다. 30분 단위로 진행 상태를 점검한다. 기존 결제 증거와 결제 서비스, 읽기 전용 경계는 보존한다.

- 2026-10-22 사용자 승인 범위: 필수 개선점 네 가지를 수정하고 테스트한다. 별도 마감은 없다. 복구와 운영자 기록, 민감정보 제거와 의존성 패치, 전체 검증 순으로 진행했다. 검증을 30분 단위로 점검해 완료했다. 이번 변경의 상태는 `implementation=implemented`, `evidence=local`, `deployment=local`, `verification=verified`, `priority=P0`이며 `lastVerifiedAt=2026-10-22T04:06:02+09:00`이다. 근거는 아래 수정 및 검증 기록에 연결했다. 기존 `artifacts/`를 보존하며 새 결제, 지갑 변경, 배포는 수행하지 않는다.

- 2026-09-05 사용자 승인 범위: 한국어 문구 개선 후 전체 변경사항 커밋, main 푸시, 기존 공개 replay 배포를 완료했다. 별도 제출 마감은 없다. 새 결제 실행과 capture 권한 활성화는 이번 배포에 포함하지 않는다.

- 2026-09-05 검토 개선을 로컬 코드에 반영했다. 결제 후 단계 재개, 원자적 예산 증거, 실제 RPC probe, 검증 범위와 조건 비교 UI, 모듈 분리, 캐시/지연 로딩, DOM 테스트와 취약 의존성 패치를 포함한다. 결제 실행 경로의 검증은 로컬 구현에 한정한다. UI는 새 공개 리비전에서 확인했으며 demo5 evidence와 기존 결제 서비스 리비전은 보존했다. 상세: `docs/REVIEW_2026-09-05.md#개선-반영-기록`.

- Current replay deployment: GCP project `uptime402-hack-260803`, region `asia-northeast3`, control revision `uptime402-control-plane-00024-9fr`, exact source commit `82a960b1289f032c695f86fc58c18e7859321b6b`, Cloud Build `827b03a5-bc2b-4454-b47b-d8a82c4d0dd2` `SUCCESS`, image digest `sha256:972a1eefa418f4979e1dfcbcada88229bbd1aa8e6e1031dad50678fa8a8ef4d4`.
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
| Gemini 3.8 Flash default | implemented | local | local | verified | 2026-10-21T19:55:53.946Z | `docs/verification/gemini-3.8-flash.json`; `tests/control-plane.test.ts` | P0 | 실제 Vertex 응답 modelVersion 확인, standard/emergency 조건별 선택 확인. 무결제 모델 검증이며 공개 replay는 모델을 호출하지 않음 |
| Payment continuation and atomic budget evidence | implemented | local | local | verified | 2026-10-22T04:06:02+09:00 | `tests/control-plane-live-flow.test.ts`; `tests/services-integration.test.ts`; `tests/payments.test.ts`; `tests/persistence-firestore.test.ts` | P0 | paid 응답과 즉시 재조회 동시 유실, facilitator 응답 유실 후 무결제 재개; 기존 health/commit/audit 복구와 예산 snapshot 유지 |
| Paid-route RPC health probe | implemented | local | local | verified | 2026-09-05T20:53:43+09:00 | `tests/recovery-rpc-probe.test.ts`; `tests/dependency-health.test.ts` | P0 | pinned offer/resource/RPC, getHealth 및 Devnet genesis 확인. 실제 구매 endpoint 설정과 live 검증은 별도 필요 |
| Evidence scope, comparison UX and replay performance | implemented | local | live | verified | 2026-09-05T12:14:35.261Z | `artifacts/portfolio-deployment/manifest.json`; `tests/mission-control-dom.test.ts`; `docs/REVIEW_2026-09-05.md` | P0 | 9.340초 측정 구간 정정, 미검증 성공 표현 제거, 실제 조건 비교, 상세 지연 로딩, 최대 4개 캐시. 한국어 문구와 desktop/mobile 공개 URL 검증 |
| Maintenance dependency patches | implemented | local | local | verified | 2026-10-22T04:06:02+09:00 | `package.json`; `pnpm-lock.yaml`; 아래 2026-10-22 검증 기록 | P0 | Next.js 16.3.8 및 6개 전이 의존성 패치; production audit 0건; frozen lockfile 설치, lint/typecheck/build 통과 |
| Structured telemetry and vendor-text redaction | implemented | local | local | verified | 2026-10-22T04:06:02+09:00 | `tests/control-plane.test.ts` | P0 | 중첩 JSON 필드 허용 목록, 인증 헤더, IPv6, URL 사용자정보와 쿼리 제거; 모델 입력과 캡처에 원문이 남지 않음을 검사 |
| Append-only operator continuation records | implemented | local | local | verified | 2026-10-22T04:06:02+09:00 | `tests/operator-boundary.test.ts`; `tests/operator-continuation.test.ts`; `tests/recovery-checkpoints-firestore.test.ts` | P0 | 원본 capture/action 보존; 동시 완료 한 번만 추가; 운영자 재조회와 export의 최신 결과 일치 |
| Standard x402 paid resource | implemented | devnet | live | verified | 2026-08-03T21:24:50+09:00 | `artifacts/payment-evidence.json`; `artifacts/verification-report.json` | P0 | `402 -> reserve -> automatic PAYMENT-SIGNATURE -> paid retry -> facilitator verify/settle -> confirmed 200 -> signed receipt`; executor did not pre-broadcast |
| Solana Devnet USDC settlement | implemented | devnet | live | verified | 2026-08-03T20:18:06+09:00 | `artifacts/payment-evidence.json`; signature `4P7Y…KtmZ` | P0 | finalized slot `480903755`; CAIP-2 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; mint `4zMMC…ncDU`; distinct payer/payee; deltas `-15000/+15000` |
| Deterministic policy and dual denial | implemented | devnet | live | verified | 2026-08-03T20:18:22+09:00 | `artifacts/live-capture/policy-denial-over-transaction-limit-artifact.json`; `artifacts/live-capture/policy-denial-replay-artifact.json` | P0 | `25000 > 20000` over-cap and primary nonce replay both have `transactionCreated:false`, `txSignature:null` |
| Atomic reservation and fulfillment claim | implemented | devnet | live | verified | 2026-08-03T20:39:06+09:00 | `artifacts/payment-evidence.json`; managed-state audit; Firestore emulator artifact | P0 | demo5 reservation committed and vendor claim reached `receipt_signed`; concurrent replay and ambiguous-state rules pass locally |
| Signed receipt and recovery outcome | implemented | devnet | live | verified | 2026-08-03T20:51:11+09:00 | `artifacts/payment-evidence.json` | P0 | vendor key `uptime402-vendor-v1` binds offer/request/tx/response/incident; distinct outcome key `uptime402-outcome-v1` binds the receipt to `healthy` |
| Gemini two-offer material decision | implemented | devnet | live | verified | 2026-08-03T20:18:13+09:00 | `artifacts/live-capture/gemini-selection-artifact.json` | P0 | captured `gemini-2.5-flash` strict output selected `rpc-recovery-standard`; counterfactual selected `rpc-recovery-emergency` |
| A2A Agent Card and message boundary | implemented | devnet | live | verified | 2026-09-05T12:14:35.261Z | `artifacts/portfolio-deployment/manifest.json`; `artifacts/live-capture/vendor-agent-card.json` | P0 | separate public vendor service still returns health and Agent Card `200`; two immutable signed offers are preserved |
| Read-only portfolio mission control | implemented | devnet | live | verified | 2026-10-21T20:01:38.299Z | `artifacts/portfolio-deployment/manifest.json`; `apps/control-plane/components/mission-control.tsx` | P0 | logged-out evidence replay is the default; no Google login/live trigger; mutation routes fail before auth/backend initialization |
| Current Cloud Run and IAM boundary | implemented | local | live | verified | 2026-10-21T20:01:38.299Z | `artifacts/portfolio-deployment/manifest.json`; owner-private raw exports | P0 | capture tool verified control/vendor public, executor private, distinct service accounts, and no current control backend role, executor invoke permission, or retired config access; public manifest exposes only the minimal attestation and source hashes |
| Evidence hash-pinned final stage | implemented | devnet | live | verified | 2026-10-21T20:01:38.299Z | `artifacts/payment-evidence.json`; `artifacts/verification-report.json`; `artifacts/portfolio-deployment/manifest.json` | P0 | exact evidence/report bytes are pinned; missing or mismatched evidence cannot render `VERIFIED` |
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

## 2026-10-22 필수 개선점 수정

| 항목 | 변경과 검증 근거 |
|---|---|
| 결제 응답 유실 후 복구 | paid HTTP 전에 `request` 체크포인트를 저장한다. 공급자도 정산 시도와 기존 서명 페이로드를 원자적으로 보관한다. 재개 시 기존 거래의 메시지, payer/facilitator 서명, 거래 ID, USDC 변동을 검증한다. `tests/control-plane-live-flow.test.ts`, `tests/services-integration.test.ts`, `tests/payments.test.ts`, `tests/persistence-firestore.test.ts` |
| 민감정보 제거 | JSON은 진단 필드만 허용하며 중첩 값과 JSON으로 감싼 문자열도 검사한다. Basic/Bearer/Digest 인증, IPv6, URL 사용자정보와 쿼리 값을 제거한다. 공급자 설명과 상태에도 같은 필터를 적용한다. `tests/control-plane.test.ts` |
| 취약 의존성 | Next.js 16.3.8, fast-uri 3.1.9, brace-expansion 2.1.7, grpc-js 1.14.5, source-map-js 1.2.2, proxy-addr 2.0.8, sharp 0.35.5로 고정했다. production audit의 18건이 0건이 됐다. 기존 CI의 production audit gate를 유지한다. |
| 운영자 완료 기록 | 원본 capture와 action을 수정하지 않고 해시로 연결한 완료 기록을 한 번만 추가한다. 운영자 재조회와 export가 같은 최신 결과를 읽는다. denial 증거는 새로 만들지 않는다. `tests/operator-boundary.test.ts`, `tests/operator-continuation.test.ts`, `tests/recovery-checkpoints-firestore.test.ts` |

검증 결과:

- 기본 테스트 205개 통과. 기본 실행에서 건너뛰는 Emulator 전용 13개는 별도로 통과했다. Emulator 실행은 공통 테스트 하나를 포함해 14개이며, 고유 테스트 합계는 218개다.
- Firestore 재검사에서 발견한 서명 페이로드 역직렬화 누락을 수정했다. 마지막 Emulator 실행은 `--no-file-parallelism --testTimeout=60000 --hookTimeout=60000`으로 수행했고, 테스트 내부의 인스턴스 간 동시성 검증은 유지했다.
- lint, typecheck, production audit, Git boundary, deployment template, 기존 portfolio deployment evidence, 문서 일관성 검사를 통과했다.
- 깨끗한 임시 소스 복사본에서 `pnpm install --frozen-lockfile --offline` 성공. 같은 복사본의 strict structural 검사는 31 PASS, 2 INFO, 0 WARN, 0 FAIL이다. 개인 설정과 키 파일이 남아 있는 원래 작업 폴더는 삭제하거나 정리하지 않았다.
- `pnpm build` 성공. 마지막 저장소 수정 후 persistence, vendor-agent, payment-executor의 ESM/DTS 재빌드도 성공했다. 최종 `pnpm typecheck`와 변경 파일 lint를 재확인했다.
- A2A 프로세스 smoke test의 시작 대기 제한을 8초에서 60초로, 테스트 전체 제한을 12초에서 90초로 조정했다. 검증 항목과 결제 실행 경로는 그대로다.

보존 범위와 운영상 한계:

- `artifacts/payment-evidence.json`: `0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4`.
- `artifacts/verification-report.json`: `b147e7cfe2c71fee903f4052ca342d8266343694e48843ae017c8e55ae42cd3e`.
- 두 파일의 바이트는 작업 전과 같다. 기존 `artifacts/` 파일도 변경하지 않았다. 증거 보고서를 다시 쓰는 live verification이나 새 결제는 실행하지 않았다.
- 새 복구 경로는 로컬 코드와 테스트로 검증했다. 현재 공개 replay와 결제 서비스의 배포 리비전은 유지했다.
- 공급자 조회는 payer의 최근 confirmed 거래 100개로 제한한다. 이력이 없거나 조회 범위를 벗어났거나 저장된 페이로드가 없는 과거 claim은 잠긴 상태를 유지한다. 기존 실패 기록이나 demo5를 소급 변환하지 않는다. 자세한 경계는 `docs/ARCHITECTURE.md`의 결제 후 재개 설명에 기록했다.

## 2026-10-22 Gemini 3.8 및 공개 replay 배포

- 기본 모델은 `gemini-3.8-flash`, 추론 수준은 `LOW`다. 기존 2.5 모델을 명시하면 `thinkingBudget: 0` 호환 설정을 사용한다.
- 실제 Vertex 응답에서 모델 ID와 구조화 JSON을 확인했다. 기본 조건은 standard, 심한 장애 조건은 emergency를 선택했다. `docs/verification/gemini-3.8-flash.json`은 무결제 모델 검증 기록이다.
- 실행 소스는 `82a960b1289f032c695f86fc58c18e7859321b6b`. [GitHub Actions](https://github.com/kwakhyun/uptime402-agentic-commerce/actions/runs/39665988174)의 maintenance와 Firestore Emulator가 모두 통과했다. 기본 테스트 206개와 Emulator 전용 13개, 총 219개를 검증했다.
- Cloud Build `827b03a5-bc2b-4454-b47b-d8a82c4d0dd2` 성공. 새 리비전 `uptime402-control-plane-00024-9fr`에 트래픽 100%를 전환했다. 후속 커밋은 배포 기록과 문서만 갱신하며 실행 코드는 동일하다.
- 공개 UI/health 200, 실행 API 404, vendor health/Agent Card 200, 비인증 executor 403. 브라우저에서 재생 완료, 심한 장애 조건의 견적 전환, 원본 증거 지연 로딩과 receipt/outcome 검증 표시를 확인했다.
- `implementation=implemented`, `evidence=local`, `deployment=live`, `verification=verified`, `lastVerifiedAt=2026-10-21T20:01:38.299Z`, `priority=P0`. 배포 근거: `artifacts/portfolio-deployment/manifest.json`. 공개 서비스는 읽기 전용 replay이며 Gemini를 호출하지 않는다. 모델 실제 호출은 별도 로컬 검증이다.
- 기존 결제 증거 전체의 바이트와 두 SHA-256은 보존했다. 변경된 기존 artifact는 현재 배포 manifest 하나뿐이다. executor/vendor 리비전과 IAM, 비밀정보 설정은 유지했다. 이전 private raw 배포 export도 ignored history에 보존했다.
