# Uptime402 2분 45초 데모 대본

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
