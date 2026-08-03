# Uptime402 2분 45초 데모 대본

이 대본은 보존된 `finalist-demo-5` operator/evidence artifacts를 hash-pinned final UI에서 read-only로 재생하는 새 영상을 촬영하는 기준이다. 기존 raw screen recordings는 usable footage가 아니므로 사용하지 않고, 새 incident나 결제도 실행하지 않는다. `payment-evidence.json`, UI, README, deck의 값이 모두 같지 않으면 final export하지 않는다. 목표 길이: **2:45**, 절대 상한: **3:00**.

현재 handoff는 **capture complete / replacement video required**다. `submission/Uptime402_Demo.mp4`는 `164.966667`초지만 audio stream이 없고 sampled frames 대부분이 static Codex desktop + tiny UI inset이며 blank Google auth window가 중앙을 가린다. Manual QA에 실패했으므로 완료 산출물로 간주하지 않는다.

## 촬영 전 체크

- 로그아웃/시크릿 브라우저에서 public control-plane과 vendor Agent Card가 열린다.
- executor URL은 인증 없이 401/403이다.
- mandate는 incident `0.05 USDC`, per-tx `0.02 USDC`, TTL `10분`, Devnet USDC, allowed capability/recipient로 armed다.
- primary dependency는 unhealthy, kill switch는 표시되지만 `STANDBY`이고 remaining은 `0.05 USDC`다.
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
| 0:00–0:15 | Final UI full screen: `DEVNET VERIFIED`, demo5 run ID, before-state `degraded`, mandate `0.05 / 0.02 USDC`, kill switch를 보여 준다. | “장애는 구매 결재를 기다리지 않습니다. 지금 보시는 것은 이미 실행된 finalist-demo-5를 exact evidence hash로 고정한 read-only replay입니다.” |
| 0:15–0:30 | Operator action/mandate audit event와 `approval clicks after trigger: 0`을 확대한다. 새 trigger button은 클릭하지 않는다. | “운영자는 mandate를 한 번 설정했고 Google 인증으로 incident를 한 번 시작했습니다. 그 뒤에는 결제 승인 클릭도 지갑 팝업도 없었습니다.” |
| 0:30–0:55 | Exact `runBindingHash`, redaction event, baseline `rpc-recovery-standard`, Agent Card와 두 signed offers를 차례로 보여 준다. | “서버가 고정한 요청에서 credential과 PII를 제거한 뒤 Gemini 2.5 Flash가 두 signed offer를 비교해 15,000-unit standard를 선택했습니다.” |
| 0:55–1:15 | Counterfactual drawer에서 `12000ms / 100%`와 `rpc-recovery-emergency` 선택 flip을 보여 준다. | “같은 offer set에 full-outage telemetry를 주면 25,000-unit emergency로 선택이 바뀝니다. 모델은 offerId만 고르고 돈과 정책은 deterministic code가 결정합니다.” |
| 1:15–1:43 | Timeline의 402, reserve, automatic signature, paid retry, facilitator settle, confirmed 200을 순서대로 짚는다. | “Private executor가 policy를 reload하고 예산을 원자 예약했습니다. 먼저 broadcast하지 않고 PAYMENT-SIGNATURE를 만들었고, vendor와 facilitator가 paid retry를 settle한 뒤에만 200을 반환했습니다.” |
| 1:43–2:12 | Signature `4P7Y…KtmZ`, slot `480903755`, mint, payer/payee, token deltas, receipt와 outcome을 보여 준다. | “독립 RPC가 0.015 USDC와 서로 다른 owners를 확인했습니다. Payer는 15,000 감소하고 payee는 15,000 증가했습니다. Vendor receipt와 별도 outcome key가 응답을 healthy recovery에 묶습니다.” |
| 2:12–2:32 | `amount.per_transaction_limit`와 `identifier.nonce_fresh` 두 row 확대. | “25,000-unit 한도 초과와 기존 nonce 재사용이 자동 거절됐습니다. 둘 다 transactionCreated false, txSignature null이라 추가 온체인 거래가 없습니다.” |
| 2:32–2:45 | 전체 화면: health green, budget `0.050 -> 0.035 USDC`, exact Explorer link. | “한 번의 mandate, 건별 승인 없는 실제 결제와 복구, 그리고 자동 거절. Uptime402 — An outage does not wait for procurement.” |

## Capture handoff

Owner-only raw recordings은 감사용으로만 보존하고 영상에 사용하지 않는다. Fresh
verification과 final evidence-pin deploy 뒤 hash-pinned read-only replay만 full-screen으로
새로 녹화한다. UI의 `runBindingHash`와 verifier 값이 다르면 녹화만 다시 하고 결제는
재실행하지 않는다. 현재 QA-failed provisional 파일은 새 영상을 대체하지 않는다. 최종 결과를
`submission/Uptime402_Demo.mp4`에 두거나 접근 가능한 final URL을 사용한 뒤 다음을 확인한다.

```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 submission/Uptime402_Demo.mp4
```

영상 파일/URL, 길이, 실제 전체 흐름, secret 미노출, README/deck/evidence claim 일치를 확인하기 전에는 완료로 표시하지 않는다.
