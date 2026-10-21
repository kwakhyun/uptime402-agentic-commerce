# 구매 RPC 연결과 증거 수집

이 공급자는 공식 Solana Devnet RPC를 연결한 자체 릴레이의 10분 접근권을 판매한다. 외부 상용 RPC 구독이나 실제 운영 장애를 재현한 것으로 설명하지 않는다. 입력 장애 신호는 주입한 시나리오이고, 결제와 구매한 릴레이의 RPC 호출은 실제 Devnet에서 실행한다.

## 접근 경계

- 구매 API: `POST /v1/recovery`, 기존 x402 exact USDC 결제 경로.
- 구매 리소스에 `rpcEndpoint`를 포함하고 공급자 서명 영수증의 `resourceResponseHash`에 연결한다.
- 호출 API: `POST /v1/recovery-rpc`, 허용 메서드는 `getHealth`, `getGenesisHash`, 빈 `params`뿐이다.
- Google IAM ID token의 audience는 공급자 origin, principal은 지정한 control 서비스 계정이어야 한다.
- `x-uptime402-route-activation`으로 유효한 활성화와 `receipt_signed` 결제 기록을 조회한다. 영수증 서명, 결제 ID, 트랜잭션, 구매 리소스, payer/payee, 금액과 mint를 재검증한다.
- 접근권은 최초 활성화부터 최대 10분이다. 재시도로 기한을 연장하지 않는다. 미결제는 402, 만료는 410, 인증 누락은 401로 거절한다.
- 고정 upstream은 `https://api.devnet.solana.com`이다. 사용자 URL, 임의 RPC 메서드, 트랜잭션 전송은 허용하지 않는다.

## Capture 설정

기존 version-pinned Secret Manager 지갑을 private executor에서만 사용한다. Control plane은 별도 outcome 서명 키만 사용한다. 적용할 연결 설정은 다음과 같다.

```json
[{"offerId":"rpc-recovery-standard","resourceUrl":"https://uptime402-vendor-agent-1065649463621.asia-northeast3.run.app/v1/recovery","rpcUrl":"https://uptime402-vendor-agent-1065649463621.asia-northeast3.run.app/v1/recovery-rpc","authentication":"google-iam"}]
```

이 JSON을 `RECOVERY_RPC_ROUTES_JSON`에 설정한다. Google IAM token은 Cloud Run metadata identity로 발급하며 증거, 로그, 브라우저에 저장하지 않는다. 설정에 emergency offer를 추가할 수 있지만 건별 20000 base units 한도는 그대로 적용한다.

CLI capture는 `CONTROL_PLANE_MUTATIONS_ENABLED=true`, `CONTROL_PLANE_UI_LIVE_TRIGGER_ENABLED=false`, `CONTROL_PLANE_UI_EVIDENCE_STAGE=capture`로 실행한다. 운영자 OIDC audience와 principal을 고정하고, 기존 issuer로 서명한 새 mandate를 한 번 arm한다. 새 incident/payment/operation/idempotency ID와 nonce를 사용하며 과거 실행을 수정하거나 재결제하지 않는다.

실행 직전 네트워크 genesis, USDC 잔액, 수수료 SOL, facilitator fee payer, 두 서명 견적을 확인한다. `incident:run`은 구매와 복구, 한도 초과 및 nonce replay 거절을 함께 캡처한다. 응답이 불명확하면 동일 실행의 상태를 조회하거나 `incident:resume`으로 이어서 처리한다. 새로운 payment ID로 재결제하지 않는다.

## 추가 증거와 검증

새 증거는 `artifacts/runs/<bundle>/`에 저장한다. 기존 `artifacts/payment-evidence.json`과 `artifacts/verification-report.json`은 바꾸지 않는다.

```sh
pnpm evidence:capture --bundle=rpc-recovery-2026-10-22 /absolute/private/promotion-manifest.json
UPTIME402_EVIDENCE_BUNDLE=rpc-recovery-2026-10-22 \
  UPTIME402_VERIFICATION_NONCE=<fresh-nonce> pnpm evidence:verify
```

검증에는 별도 Solana RPC 조회, x402 서명과 정산, token-account delta, 정책 및 두 거절, 공급자 영수증, 별도 outcome 서명, 당시 배포와 IAM 원본이 필요하다. 배포 및 IAM 원본은 개인정보가 포함될 수 있어 `private/`에 두고 공개 증거에는 경로와 SHA-256을 기록한다.

`live-capture/rpc-recovery-proof.json`은 결제 영수증에 연결된 RPC 주소, 실제 `getHealth=ok` 및 Devnet genesis 응답, 응답 해시, 호출 시각과 지연을 담는다. outcome의 `healthProbeHash`와 일치해야 한다. 화면은 이 검사를 통과한 경우에만 RPC 복구로 표시한다. 이 검증은 증거가 기록한 당시의 응답을 입증하며, 만료된 접근권을 다시 사용하지 않는다.

## Final 공개 배포

독립 검증을 마치면 `UPTIME402_EVIDENCE_BUNDLE`과 새 evidence/report SHA-256을 설정하고 control plane 이미지를 다시 빌드한다. 최종 공개 control plane은 Gemini 진단과 A2A 견적 비교만 실시간으로 실행하고 구매 기록을 재생한다.

임시 Firestore 권한, executor invoker, outcome secret access를 control identity에서 제거한다. 최종 서비스에 capture 설정이나 secret volume을 남기지 않는다. 배포 manifest를 다시 수집하고 공개 진단, 모바일 화면, mutation 404, private executor 401/403을 확인한다. 과거 영상과 제출 deck은 촬영 당시의 실행을 설명하는 기록으로 보존하며 새 결제 영상으로 표시하지 않는다.
