# Uptime402 build status

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


Last updated: `2026-10-21T22:05:05.400626Z`

Uptime402 was submitted before the 2026-08-03 23:59 KST deadline and was not selected among the ten finalists announced on 2026-08-07. It is now maintained as a portfolio/reference implementation. 아래 표의 `implementation`, `evidence`, `deployment`, `verification`, `priority`는 서로 독립적인 축이다. 로컬 테스트나 live endpoint만으로 Devnet settlement를 주장하지 않는다.

## 현재 체크포인트

- 승인된 새 Devnet 구매 RPC 검증과 공개 재배포를 완료했다. 기존 지갑을 사용했으며 새 결제는 2건, 합계 0.030 USDC다. 첫 거래의 복구 실패를 보존하고 별도 실행에서 실제 RPC 호출과 복구까지 검증했다. 과거 demo5와 실패 기록은 덮어쓰지 않았다.
- Current replay deployment: project `uptime402-hack-260803`, Cloud Run region `asia-northeast3`, control revision `uptime402-control-plane-00029-jsh`, source `a752c708d17ba6e472cc72d48de39982fc16013b`, Cloud Build `740335a5-b962-4d89-ad2a-4f17758f2e74` (`global`, `SUCCESS`), image digest `sha256:e38f625364435e8634dd28aa4a08ca1dc02da808092a52c39c7bda673bbd17db`. 공개 리비전에 트래픽 100%를 배정했다.
- Payment services: executor `uptime402-payment-executor-00013-rpc`, vendor `uptime402-vendor-agent-00012-n6w`, source `8155948a5f9fdf90171e8800f5da0e52fed137ce`. 성공 capture의 control source는 `b2855e2a5190979ffb609d74924f484b6a667303`, revision은 `uptime402-control-plane-00028-nsm`이다.
- 공개 UI/health `200`, 결제 mutation `404`, 비인증 executor `403`, vendor health/Agent Card `200`. 공개 진단 모델은 `gemini-3.8-flash`이며 결제를 실행하지 않는다. 기록 재생은 `artifacts/runs/rpc-recovery-2026-10-22/`의 새 해시 핀을 읽는다.
- 임시 control Firestore `datastore.user`, executor `run.invoker`, outcome secret `secretAccessor`를 모두 회수했다. final manifest에는 signer, outcome key, secret mount, Firestore, executor endpoint, operator 설정이 없다. control에는 예측 전용 `aiplatform.endpoints.predict` custom role만 남는다.
- Current deployment authority: `artifacts/portfolio-deployment/manifest.json`, `notPaymentEvidence: true`. 공개 파일에는 최소 attestation과 원본 해시만 있고 raw service/IAM/build export는 ignored `private/portfolio-deployment-raw/`에 있다. capture 당시 raw export와 이전 공개 배포 export도 private history에 보존했다.
- 새 payment evidence `sha256:c3524b10e841f57f9ab4bcbe32cbfccbce74b7081c8e5ba4d9cdcb1a9627781f`, verification report `sha256:10c9fcf7b2206039960fb14281a99cec1afa0f8de2e973905147a60dd8d0441d`. 독립 검증 13개가 모두 통과했다. 기존 root evidence `sha256:0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4`, report `sha256:b147e7cfe2c71fee903f4052ca342d8266343694e48843ae017c8e55ae42cd3e`도 바이트 단위로 보존했다.
- [실행 소스 CI](https://github.com/kwakhyun/uptime402-agentic-commerce/actions/runs/39682384710): maintenance와 Firestore Emulator 모두 성공. 기본 242개와 Emulator 전용 13개, 고유 테스트 255개 통과. production audit 취약점 0건, strict readiness 31 PASS / 2 INFO / 0 WARN / 0 FAIL. 이후 배포 기록, 검증 도구와 문서 수정은 실행 이미지에 영향을 주지 않는다.
- 기존 PDF/PPTX와 165.021초 demo 영상은 demo5의 역사 기록이다. 새 RPC 검증 영상으로 표시하지 않는다.

최종 공개 브라우저 검증: 390px/320px에서 실제 진단과 두 견적 비교, 새 RPC 증거 상세와 실행 기록 재생을 확인했다. 추가 결제와 콘솔 오류는 없다. 실제 모바일 하드웨어는 검증하지 않았다. 근거: `docs/verification/paid-rpc-deployment-ui.json`.

## Integration status

| Integration | implementation | evidence | deployment | verification | lastVerifiedAt | evidenceRef | priority | Notes / blocker |
|---|---|---|---|---|---|---|---|---|
| Public mobile diagnosis | implemented | local | live | verified | 2026-10-21T22:05:05.400626Z | `docs/verification/paid-rpc-deployment-ui.json` | P0 | 390px standard와 320px emergency 실제 Gemini 선택, 16px 입력, 가로 넘침 없음; 실제 단말 미검증 |
| Public payment-free diagnosis | implemented | local | live | verified | 2026-10-21T22:05:05.400626Z | `docs/verification/paid-rpc-deployment-ui.json`; `artifacts/portfolio-deployment/manifest.json` | P0 | 실제 모델 진단과 A2A 두 견적 비교, 결제 mutation 404, 추가 결제 없음 |
| Gemini 3.8 Flash default | implemented | devnet | live | verified | 2026-10-21T21:45:03.839Z | `artifacts/runs/rpc-recovery-2026-10-22/live-capture/gemini-selection-artifact.json` | P0 | 실제 결제 실행에서 standard 선택, 심한 장애 조건에서 emergency 선택; 공개 무결제 진단에도 같은 모델 적용 |
| Payment continuation and atomic budget evidence | implemented | local | local | verified | 2026-10-22T04:06:02+09:00 | `tests/control-plane-live-flow.test.ts`; `tests/services-integration.test.ts`; `tests/payments.test.ts`; `tests/persistence-firestore.test.ts` | P0 | paid 응답과 즉시 재조회 동시 유실, facilitator 응답 유실 후 무결제 재개; 기존 health/commit/audit 복구와 예산 snapshot 유지 |
| Paid-route RPC health probe | implemented | devnet | live | verified | 2026-10-21T21:45:03.839Z | `artifacts/runs/rpc-recovery-2026-10-22/live-capture/rpc-recovery-proof.json`; `docs/RPC_RECOVERY_2026-10-22.md` | P0 | 실제 구매 RPC에서 getHealth=ok, Devnet genesis 일치. IAM과 receipt_signed 결제 확인 후에만 접근. |
| Evidence scope, comparison UX and replay performance | implemented | devnet | live | verified | 2026-10-21T22:05:05.400626Z | `docs/verification/paid-rpc-deployment-ui.json`; `tests/mission-control-dom.test.ts` | P0 | 새 RPC 7.026초 증거, receipt/outcome 상세 지연 로딩, 기록 재생 100%, 브라우저 오류 없음 |
| Maintenance dependency patches | implemented | local | local | verified | 2026-10-22T04:06:02+09:00 | `package.json`; `pnpm-lock.yaml`; 아래 2026-10-22 검증 기록 | P0 | Next.js 16.3.8 및 6개 전이 의존성 패치; production audit 0건; frozen lockfile 설치, lint/typecheck/build 통과 |
| Structured telemetry and vendor-text redaction | implemented | local | local | verified | 2026-10-22T04:06:02+09:00 | `tests/control-plane.test.ts` | P0 | 중첩 JSON 필드 허용 목록, 인증 헤더, IPv6, URL 사용자정보와 쿼리 제거; 모델 입력과 캡처에 원문이 남지 않음을 검사 |
| Append-only operator continuation records | implemented | local | local | verified | 2026-10-22T04:06:02+09:00 | `tests/operator-boundary.test.ts`; `tests/operator-continuation.test.ts`; `tests/recovery-checkpoints-firestore.test.ts` | P0 | 원본 capture/action 보존; 동시 완료 한 번만 추가; 운영자 재조회와 export의 최신 결과 일치 |
| Standard x402 paid resource | implemented | devnet | live | verified | 2026-10-21T21:45:03.839Z | `artifacts/runs/rpc-recovery-2026-10-22/payment-evidence.json` | P0 | 402, reserve, PAYMENT-SIGNATURE, paid retry, confirmed 200과 서명된 RPC 접근권 전달 확인 |
| Solana Devnet USDC settlement | implemented | devnet | live | verified | 2026-10-21T21:45:03.839Z | `artifacts/runs/rpc-recovery-2026-10-22/payment-evidence.json` | P0 | finalized slot 513662003; payer -15000 / payee +15000; 원본 demo5도 보존 |
| Deterministic policy and dual denial | implemented | devnet | live | verified | 2026-08-03T20:18:22+09:00 | `artifacts/live-capture/policy-denial-over-transaction-limit-artifact.json`; `artifacts/live-capture/policy-denial-replay-artifact.json` | P0 | `25000 > 20000` over-cap and primary nonce replay both have `transactionCreated:false`, `txSignature:null` |
| Atomic reservation and fulfillment claim | implemented | devnet | live | verified | 2026-08-03T20:39:06+09:00 | `artifacts/payment-evidence.json`; managed-state audit; Firestore emulator artifact | P0 | demo5 reservation committed and vendor claim reached `receipt_signed`; concurrent replay and ambiguous-state rules pass locally |
| Signed receipt and recovery outcome | implemented | devnet | live | verified | 2026-08-03T20:51:11+09:00 | `artifacts/payment-evidence.json` | P0 | vendor key `uptime402-vendor-v1` binds offer/request/tx/response/incident; distinct outcome key `uptime402-outcome-v1` binds the receipt to `healthy` |
| Gemini two-offer material decision | implemented | devnet | live | verified | 2026-10-21T21:45:03.839Z | `artifacts/runs/rpc-recovery-2026-10-22/live-capture/gemini-selection-artifact.json` | P0 | gemini-3.8-flash, baseline standard와 counterfactual emergency 선택 |
| A2A Agent Card and message boundary | implemented | devnet | live | verified | 2026-09-05T12:14:35.261Z | `artifacts/portfolio-deployment/manifest.json`; `artifacts/live-capture/vendor-agent-card.json` | P0 | separate public vendor service still returns health and Agent Card `200`; two immutable signed offers are preserved |
| Read-only portfolio mission control | implemented | devnet | live | verified | 2026-10-21T21:59:27.023Z | `artifacts/portfolio-deployment/manifest.json` | P0 | 새 RPC 증거를 읽기 전용으로 재생하고 공개 무결제 진단 제공; mutation 404 |
| Current Cloud Run and IAM boundary | implemented | local | live | verified | 2026-10-21T21:59:27.023Z | `artifacts/portfolio-deployment/manifest.json` | P0 | 임시 control backend/invoke/outcome-secret 권한 회수, executor private, 세 identity 분리 |
| Evidence hash-pinned final stage | implemented | devnet | live | verified | 2026-10-21T21:59:27.023Z | `artifacts/runs/rpc-recovery-2026-10-22/payment-evidence.json`; `artifacts/runs/rpc-recovery-2026-10-22/verification-report.json`; `artifacts/portfolio-deployment/manifest.json` | P0 | 새 RPC 번들의 정확한 evidence/report 해시 pin; 역사 원본 불변 |
| Test, supply-chain and release gates | implemented | local | local | verified | 2026-10-21T21:59:27.023Z | `.github/workflows/quality.yml`; CI `39682384710` | P0 | 기본 242 + Emulator 전용 13 = 고유 255개; production build/audit, strict readiness, 배포/문서/보안 검사 통과 |
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

## 2026-10-22 공개 무결제 진단

- 공개 화면에서 수치 장애 지표를 입력해 실제 Gemini 3.8 Flash 진단을 실행한다. 고정 A2A 공급자의 서명된 두 견적을 비교하며 만료 여부를 표시한다. 입력 예시는 실제 수집된 장애로 주장하지 않는다.
- API는 결제/저장소/서명 모듈을 호출하지 않는다. 기존 결제 증거 재생과 분리하며 새 결제, 예산 예약, 복구 실행, 과거 증거 갱신은 하지 않는다.
- 입력/서명/모델 검증, 동시 호출과 시간당 호출 제한, 오류 응답 비공개, React 텍스트 escape, 결제 API 404 회귀 테스트를 추가했다. 제한은 프로세스 단위이며 인스턴스 재시작 시 초기화된다.
- 로컬 기본 테스트 220개, lint, typecheck, 문서/배포 템플릿/Git boundary 검증을 통과했다. 실제 A2A 조회와 Gemini 3.8 응답도 새 API로 확인했다. 배포와 공개 브라우저 검증을 완료했다.
- 실행 소스 `53c960da0bd9102f2d29511bc707cfd0fcf956bc`, Cloud Build `af3f0fc3-83f5-46dd-9963-13bcedc5736a` 성공, 리비전 `uptime402-control-plane-00025-xq2`에 100% 트래픽. [소스 CI](https://github.com/kwakhyun/uptime402-agentic-commerce/actions/runs/39669334875)에서 maintenance와 Firestore Emulator가 성공했다. 고유 테스트 233개다. 후속 문서 커밋은 실행 코드를 바꾸지 않는다.
- 공개 브라우저에서 5%/420ms는 standard, 100%/12000ms는 emergency를 선택했다. 두 응답 모두 `gemini-3.8-flash`이며 새 결제가 없음을 표시했다. `docs/verification/public-diagnosis.json`에 검증 범위를 기록했다.
- 공개 UI/health 200, 결제 실행 API 404, 비인증 executor 403, vendor health/Agent Card 200. 예측 전용 IAM 정의와 바인딩, 최대 인스턴스 1, secret/Firestore/executor 접근 차단을 배포 capture에서 확인했다.
- 기존 결제 artifact는 전부 바이트 그대로다. 현재 배포 manifest만 갱신했으며 이전 private 배포 export는 ignored history에 보존했다. 새 결제나 복구는 실행하지 않았다.

## 2026-10-22 모바일 진단 개선

- 수정 전 390px 공개 화면에서 5%/420ms 입력으로 실제 `gemini-3.8-flash` 응답과 standard 선택을 확인했다. 320px에서도 진단과 견적 내용의 가로 넘침은 없었다. 검증은 브라우저 뷰포트 기준이며 실제 iPhone/Android 하드웨어 검증은 아니다.
- `AbortSignal.timeout()`이 없는 구형 모바일 환경에서는 fetch 호출 전에 실패함을 DOM 회귀 테스트로 재현했다. `AbortController`와 정리되는 45초 타이머로 교체하고, 지연 응답 취소와 입력 재활성화, 대기 중 중복 제출 차단을 검사한다. [MDN 호환성 설명](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static).
- 숫자 키패드 힌트를 추가하고 입력 글자를 16px로 조정했다.
- 새 결제 평가: 현재 배포는 기존 Firestore 라우트 활성화 증거까지이며, 로컬 RPC probe에 필요한 `RECOVERY_RPC_ROUTES_JSON`이 운영 설정 파일에 없다. 구매 제공 RPC의 offer/resource/endpoint 연결을 검증하지 못한 상태에서 재결제해도 실사용 성공 증거가 추가되지 않는다. 공개 Gemini 3.8 판단은 무결제 검증으로 이미 얻을 수 있으므로 새 거래 시각이나 모델 교체만을 위해 결제하지 않는다. 새 결제 0건, demo5 원본 보존.
- 더 강한 결제 증거의 조건: 실제 구매 제공 RPC 연결 확인, private capture runtime과 현재 복구 코드 배포, 새 one-shot mandate/incident/payment ID, Gemini 3.8 선택과 실사용 RPC probe를 포함한 별도 증거 번들, 독립 검증 후 새 hash pin. 기존 demo5 번들은 덮어쓰지 않는다.

- 배포 완료: 실행 소스 `e0ce8092fd64025402fd80dfe2ed8d2a23b47007`, revision `uptime402-control-plane-00026-bg4`, Cloud Build `5fbf5243-f658-4d81-865e-837b8aa003f4` 성공 및 100% 트래픽. 390px의 5%/420ms는 standard, 320px의 100%/12000ms는 emergency를 선택했다. 430px 결과 배치까지 가로 넘침 없음. `docs/verification/mobile-diagnosis.json`과 두 PNG에 기록했다.
- [소스 GitHub Actions](https://github.com/kwakhyun/uptime402-agentic-commerce/actions/runs/39673013954)의 maintenance와 Firestore Emulator 모두 성공. 기본 221개와 Emulator 전용 13개, 고유 테스트 234개다. 로컬 A2A 테스트는 최초 샌드박스 listen EPERM 후 네트워크 권한으로 다시 실행해 통과했다.
- UI/health 200, 결제 실행 API 404, 비인증 executor 403, vendor health/Agent Card 200을 배포 capture로 확인했다. 이전 raw export는 private history에 보존했다. 기존 payment artifact 전체는 동일하며 현재 배포 manifest만 갱신했다. 후속 문서 커밋은 실행 소스를 변경하지 않는다.
