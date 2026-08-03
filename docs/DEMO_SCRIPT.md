# Uptime402 2분 45초 데모 대본

이 대본은 최종 live/Devnet evidence를 캡처한 뒤 사용한다. `payment-evidence.json`, UI, README, deck의 값이 모두 같지 않으면 촬영하지 않는다. 목표 길이: **2:45**, 절대 상한: **3:00**.

## 촬영 전 체크

- 로그아웃/시크릿 브라우저에서 public control-plane과 vendor Agent Card가 열린다.
- executor URL은 인증 없이 401/403이다.
- mandate는 incident `0.05 USDC`, per-tx `0.02 USDC`, TTL `10분`, Devnet USDC, allowed capability/recipient로 armed다.
- primary dependency는 unhealthy, kill switch는 표시되지만 `STANDBY`이고 remaining은 `0.05 USDC`다.
- 촬영 A의 UI live trigger가 configured이고 OAuth Web client ID = exact server audience,
  authorized origin = control-plane origin, server demo request/slot이 fresh다.
- 촬영 A의 `LIVE UNVERIFIED` panel에 표시된 `runBindingHash`를 기록한다. 이 값은
  incident, mandate, operation, payment, nonce, idempotency key, execution-policy hash를
  canonical하게 묶는다.
- 촬영 A 직후 promotion capture와 independent verifier를 실행하고, 그 exact evidence
  hash를 pin한 final revision에서 촬영 B를 한다. 촬영 B evidence drawer의
  `runBindingHash`가 촬영 A와 정확히 같고 verifier가 같은 필드에서 재계산했어야 한다.
- browser devtools, 터미널, env, wallet 파일, Secret Manager value는 화면에 나오지 않는다.
- `ffprobe`로 최종 영상이 180초 이하인지 확인한다.

## 클릭 순서와 한국어 내레이션

| Time | 화면 / 클릭 | 대본 |
|---:|---|---|
| 0:00–0:12 | 촬영 A: capture revision의 `LIVE UNVERIFIED`와 `DEVNET EVIDENCE PENDING`, health red, mandate contract, kill switch를 가리킨다. | “장애는 구매 결재를 기다리지 않습니다. 이 화면은 아직 증거가 승격되지 않은 live capture 단계이고, 실제 Devnet 결제 증거는 독립 검증 뒤에만 표시됩니다.” |
| 0:12–0:22 | 촬영 A: Google operator button을 한 번 클릭한다. 인증 callback 뒤에는 손을 떼고 포인터를 화면 밖으로 이동한다. Browser가 incident/policy body를 보내지 않는 `LIVE UNVERIFIED` label을 보여 준다. | “mandate는 촬영 전에 operator-authenticated route로 한 번 arm했습니다. 이 incident trigger 뒤에는 건별 결제 승인도, 지갑 팝업도 없습니다.” |
| 0:22–0:47 | 촬영 A: reduced live event list와 `runBindingHash`만 보여 준다. 중앙 local preview의 offer·402·policy drawer는 새 run의 증거로 설명하지 않는다. | “서버가 고정한 요청으로 telemetry redaction, Gemini, A2A, x402 단계가 실행됐습니다. 하지만 지금 보이는 것은 reduced execution telemetry일 뿐이며 Explorer나 결제 확정은 아직 주장하지 않습니다.” |
| 0:47–1:00 | 촬영 A: settle/recovery와 automatic over-cap + nonce-replay denial event를 끝까지 보여 주되 `LIVE UNVERIFIED`를 유지한다. | “vendor settle과 recovery 결과도 아직 미검증입니다. 이어진 한도 초과와 nonce replay는 둘 다 transactionCreated false로 끝났지만, 이 구간은 promotion 전 실행 기록입니다.” |
| 1:00–1:18 | 촬영 B: hash-pinned final revision에서 `DEVNET VERIFIED`와 evidence drawer의 동일한 `runBindingHash`를 나란히 보여 준다. | “같은 run binding을 verifier가 incident와 payment identity에서 재계산했고, 이 화면은 그 evidence bundle의 read-only replay입니다.” |
| 1:18–1:38 | 촬영 B: redaction/Gemini decision, A2A Agent Card와 두 signed offer, counterfactual toggle 전후 selectedOfferId 변화를 보여 준다. | “credential, PII, customer identifier를 제거한 allowlist만 Gemini에 갔습니다. 실제 schema-validated 출력은 두 immutable offer를 비교했고 counterfactual telemetry에서 선택을 바꿨습니다.” |
| 1:38–1:58 | 촬영 B: verified timeline의 402, policy reserve, automatic sign, paid retry, settle, 200을 순서대로 짚는다. | “private executor가 authoritative policy를 다시 읽고 예산을 원자 예약했습니다. 먼저 broadcast하지 않고 PAYMENT-SIGNATURE를 자동 생성했고, vendor와 facilitator가 paid retry를 settle한 뒤에만 200을 반환했습니다.” |
| 1:58–2:23 | 촬영 B: signature, Explorer, payer/payee, mint, 음·양 token delta, verified receipt와 outcome을 보여 준다. | “독립 RPC가 서로 다른 payer와 payee, 정확히 일치하는 USDC 음·양 delta와 confirmation을 확인했습니다. vendor receipt와 별도 outcome key가 결제된 응답을 실제 health recovery에 묶습니다.” |
| 2:23–2:37 | 촬영 B: 자동 denial 두 row 확대. | “트랜잭션 한도 초과와 기존 nonce 재사용이 각각 자동 거절됐습니다. 두 건 모두 transactionCreated는 false이고 새로운 온체인 signature는 없습니다.” |
| 2:37–2:45 | 촬영 B 전체 화면: health green, budget before/after, elapsed time. | “한 번의 mandate, 건별 승인 없는 결제, 실제 복구, 한 화면의 검증. Uptime402 — because an outage does not wait for procurement.” |

## Capture handoff

Codex가 OS 녹화나 업로드를 수행할 수 없으면 사용자가 촬영 A를 먼저 저장하고,
그 run의 promotion/verification/final evidence-pin deploy가 끝난 뒤 촬영 B를 저장해
1440p/30fps 단일 영상으로 편집한다. 두 구간의 `runBindingHash`가 다르거나 B의
verifier가 그 값을 재계산하지 못하면 폐기하고 다시 촬영한다. Transaction과 Explorer는
검증된 촬영 B에서만 증거로 제시한다. 결과를 `submission/Uptime402_Demo.mp4`에 두거나 접근
가능한 final URL을 알려 준다. 그 뒤에만 다음을 확인한다.

```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 submission/Uptime402_Demo.mp4
```

영상 파일/URL, 길이, 실제 전체 흐름, secret 미노출, README/deck/evidence claim 일치를 확인하기 전에는 완료로 표시하지 않는다.
