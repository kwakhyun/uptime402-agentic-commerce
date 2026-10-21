# Uptime402 데모 기록과 현재 검증 안내

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


이 대본은 보존된 `finalist-demo-5` operator/evidence artifacts를 hash-pinned final UI에서 read-only로 재생하는 새 영상을 촬영하는 기준이다. 기존 raw screen recordings는 usable footage가 아니므로 사용하지 않고, 새 incident나 결제도 실행하지 않는다. `payment-evidence.json`, UI, README, deck의 값이 모두 같지 않으면 final export하지 않는다. 목표 길이: **2:45**, 절대 상한: **3:00**.

이 대본으로 제작한 165-second final video는 `https://www.youtube.com/watch?v=jwJRfs-NRZY`에 공개했다. Local final source는 `submission/Uptime402_Demo.mp4`에 보존하되 Git에는 포함하지 않는다. 아래 내용은 영상 재제작이나 claim audit를 위한 canonical capture sequence이며, 새 incident나 결제를 요구하지 않는다.

## 촬영 전 체크

- 로그아웃/시크릿 브라우저에서 public control-plane과 vendor Agent Card가 열린다.
- executor URL은 인증 없이 401/403이다.
- 첫 화면에 `DEVNET VERIFIED`, `건별 승인 없이 0.015 USDC`, 복구 `9.340초`, `읽기 전용 · 새 결제 없음`이 보인다. Budget과 `IN POLICY`는 아래 Policy 단계와 개발자 증거에서 확인한다.
- 최종 화면은 `DEVNET VERIFIED`와 `READ-ONLY EVIDENCE REPLAY`를 표시하고 Google 로그인이나 live payment trigger를 렌더링하지 않는다.
- Demo5의 operator action, Firestore state, logs, x402 headers, transaction, denials는 보존됐지만 usable capture-stage footage는 없다. 같은 slot/button을 다시 클릭하거나 paid retry를 재전송하지 않는다.
- Final replay의 `runBindingHash`는
  `sha256:a4e7321d4f191d58b58eccb8898a1f55f5dc468d22dce05b0ae7944ae08110dc`다. 이 값은
  incident, mandate, operation, payment, nonce, idempotency key, execution-policy hash를
  canonical하게 묶는다.
- Fresh verifier가 그 exact evidence hash와 `runBindingHash`를 재계산한 뒤 두 hash를 pin한 final revision에서만 촬영한다.
- browser devtools, 터미널, env, wallet 파일, Secret Manager value는 화면에 나오지 않는다.
- `ffprobe`로 최종 영상이 180초 이하인지 확인한다.

## 클릭 순서와 한국어 내레이션

| Time | 화면 / 클릭 | 대본 |
|---:|---|---|
| 0:00–0:18 | Public final UI full screen. `DEVNET VERIFIED`, headline, `건별 승인 없이 0.015 USDC`, `9.340초`, `읽기 전용 · 새 결제 없음`을 보여 준다. | “장애는 구매 결재를 기다리지 않습니다. Gemini가 미리 정한 정책 안에서 건별 승인 없이 0.015 USDC를 자동 결제했고, 9.340초 만에 서비스를 복구했습니다.” |
| 0:18–0:34 | 네 단계 Gemini → A2A → x402 → Health와 budget `0.050000 → 0.035000`을 짚는다. 로그인이나 trigger는 찾거나 클릭하지 않는다. | “이 화면은 finalist-demo-5의 exact evidence hash를 고정한 공개 read-only replay입니다. 새 incident나 결제를 만들지 않습니다.” |
| 0:34–0:58 | `전체 x402 증거 흐름 보기`를 한 번 열고 Agent Card, 두 immutable offers, baseline `rpc-recovery-standard`를 보여 준다. | “정제된 telemetry만 Gemini 2.5 Flash, 정확한 모델 ID `gemini-2.5-flash`에 전달했고, 별도 A2A vendor의 signed offer 두 개 중 15,000-unit standard를 선택했습니다.” |
| 0:58–1:17 | `COUNTERFACTUAL`을 클릭해 `rpc-recovery-emergency` selection flip을 보여 준다. | “같은 offer set에 더 심한 telemetry를 주면 25,000-unit emergency로 선택이 바뀝니다. 모델은 supplied offerId만 고르고 금액 계산과 서명은 deterministic code가 맡습니다.” |
| 1:17–1:45 | Timeline의 402, reserve/sign, paid retry, facilitator verify/settle, confirmed 200, recovery를 순서대로 짚는다. | “Private executor가 정책을 다시 읽고 예산을 원자 예약했습니다. 먼저 broadcast하지 않고 x402 PAYMENT-SIGNATURE를 만들었고, vendor와 facilitator가 settlement를 확인한 뒤에만 복구 resource와 200을 반환했습니다.” |
| 1:45–2:15 | 증거 패널을 열어 signature `4P7Y…KtmZ`, slot `480903755`, mint, payer/payee, `-15000/+15000`, receipt/outcome verified를 보여 준다. | “독립 RPC가 서로 다른 payer와 payee 사이의 15,000 base-unit 이동을 finalized로 확인했습니다. Vendor receipt와 별도 control outcome signature가 실제 healthy recovery까지 묶습니다.” |
| 2:15–2:34 | `amount.per_transaction_limit`와 `identifier.nonce_fresh` 두 denial을 확대한다. | “25,000-unit 한도 초과와 nonce replay는 자동 거절됐습니다. 둘 다 transactionCreated false, txSignature null이라 추가 온체인 거래가 없습니다.” |
| 2:34–2:45 | Hero와 Explorer link로 돌아와 headline과 budget을 다시 보여 준다. | “한 번의 mandate, 건별 승인 없는 실제 결제와 복구, 그리고 증명 가능한 거절. Uptime402 — An outage does not wait for procurement.” |

## Capture handoff

Owner-only raw recordings은 감사용으로만 보존하고 영상에 사용하지 않는다. 이미 배포된
hash-pinned read-only final replay만 full-screen으로 새로 녹화한다. UI의 `runBindingHash`와
verifier 값이 다르면 녹화만 다시 하고 결제는
재실행하지 않는다. 현재 QA-failed provisional 파일은 새 영상을 대체하지 않는다. 최종 결과를
evidence가 선언한 정확한 `submission/Uptime402_Demo.mp4` 경로와 `165`초 계약으로 저장한 뒤
다음을 확인한다. 경로나 선언 길이를 바꾸려면 evidence → report → final hash pin을 다시 수행한다.

```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 submission/Uptime402_Demo.mp4
```

로컬 영상 파일, 길이, 실제 전체 흐름, secret 미노출, README/deck/evidence claim 일치를 확인하기 전에는 완료로 표시하지 않는다. 외부 업로드 URL은 이 로컬 검증이 끝난 뒤 별도 배포 링크로만 추가한다.

## 현재 화면 확인 순서

1. 상단 Gemini 3.8 실시간 진단에 오류율 45%, 지연 1800ms를 입력해 실제 두 견적 비교를 확인한다. 이 동작은 결제를 만들지 않는다.
2. 새 기록 재생에서 0.015 USDC, 판단 후 7.026초, RPC 정상 응답을 확인한다.
3. 영수증 카드의 구매 endpoint, getHealth=ok, Devnet genesis와 315ms 호출 지연을 확인한다.
4. Explorer에서 새 트랜잭션과 finalized 상태를 확인한다.
5. 더 심한 조건의 견적 비교와 두 자동 거절, 첫 검증 실패 기록을 함께 설명한다.

이 순서는 현재 화면 검증용이며 기존 165초 영상이 새 실행을 포함한다는 뜻은 아니다.
