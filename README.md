# Uptime402

> **An outage does not wait for procurement.**

Uptime402는 Gemini 기반 AI SRE가 정제된 장애 신호를 진단하고, 별도 A2A vendor agent의 서명된 복구 견적을 비교한 뒤, 운영자가 미리 설정한 정책과 예산 안에서 x402 + Solana Devnet USDC 결제 payload를 자동 서명하는 B2B 복구 데모입니다. 주요 사용자는 on-call SRE와 platform engineer이고, 경제적 구매자는 infrastructure/FinOps lead입니다. 제품은 payment rail을 대체하지 않고 x402 위에서 구매 정책과 recovery outcome을 증명합니다. `finalist-demo-5`에서 세 Cloud Run 서비스와 Firestore를 거쳐 `0.015 USDC`가 실제로 결제됐고, paid resource가 health를 `healthy`로 전환했습니다. 같은 operator action에서 per-transaction 초과와 nonce replay도 자동 거절됐습니다. 결제 건별 사람 승인이나 브라우저 지갑 팝업은 없었습니다.

Primary hackathon track은 **B. Autonomous On-chain Settlement**이며, 실제 A2A buyer/vendor 경계 때문에 **C. Multi-Agent Commerce**가 secondary theme입니다. 제출폼의 copy-ready 문구는 [SUBMISSION_FORM.md](docs/SUBMISSION_FORM.md)에 있습니다.

검증된 `payment-evidence.json`과 독립 `verification-report.json`의 exact SHA-256을 고정한 `final` revision이 현재 배포돼 있습니다. 공개 control-plane은 로그인 없는 read-only evidence replay가 기본이며 새 incident나 결제를 만들지 않습니다. 로그아웃 desktop/mobile, evidence drawer, Cloud Run/IAM/Secret 경계는 최종 revision에서 다시 확인했습니다. 다만 3분 이하 최종 데모 영상의 촬영·재생 QA·업로드가 남아 있으므로 아직 submission-ready를 주장하지 않습니다. 현재 증거 수준은 [BUILD_STATUS.md](docs/BUILD_STATUS.md)가 기준입니다. pay.sh는 live path에 없으므로 통합을 주장하지 않습니다.

## Live final endpoints

| Role | URL | 현재 상태 |
|---|---|---|
| Control plane | [Mission control](https://uptime402-control-plane-1065649463621.asia-northeast3.run.app) · [health](https://uptime402-control-plane-1065649463621.asia-northeast3.run.app/api/health) | public `final`; `DEVNET VERIFIED` read-only replay |
| Vendor agent | [Agent Card](https://uptime402-vendor-agent-1065649463621.asia-northeast3.run.app/.well-known/agent-card.json) · [health](https://uptime402-vendor-agent-1065649463621.asia-northeast3.run.app/health) | public, 별도 Cloud Run/A2A boundary; bare service root는 product route가 아니므로 `404`가 정상 |
| Payment executor | `https://uptime402-payment-executor-1065649463621.asia-northeast3.run.app` | private; unauthenticated request는 `403` |

위 URL은 evidence SHA-256 `sha256:0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4`와 report SHA-256 `sha256:b147e7cfe2c71fee903f4052ca342d8266343694e48843ae017c8e55ae42cd3e`를 exact pin한 final deployment다. Public root와 health, vendor Agent Card는 `200`, executor와 operator mutation route의 unauthenticated request는 `403`으로 확인했다.

Judge quick links: [transaction Explorer](https://explorer.solana.com/tx/4P7YWm9Rt7w4MKbRvmfj3sjt5SW1NUfra7xyT9zUMD9uBsby4f3JC8LgYKUFPE1GXN24SoK8ABRx5YSf1HQAKtmZ?cluster=devnet) · [payment evidence](artifacts/payment-evidence.json) · [verification report](artifacts/verification-report.json) · [final deployment QA summary](artifacts/final-release.json) · [architecture](docs/ARCHITECTURE.md) · [deck PDF](submission/Uptime402_Deck.pdf) · [editable deck](submission/Uptime402_Deck.pptx) · [video production checklist](docs/DEMO_VIDEO_PRODUCTION.md). Final demo video는 아직 없다.

## 구현 경계

- `apps/control-plane`: Next.js 한국어 mission-control UI, telemetry redaction, Gemini decision adapter, A2A buyer, incident orchestration. Executor/vendor key는 읽지 않고, server-only recovery-outcome key 하나만 별도 mount합니다.
- `services/vendor-agent`: 별도 Express/A2A 서비스, 두 immutable signed offer, x402-gated recovery resource, shared payment claim, vendor-signed fulfillment receipt.
- `services/payment-executor`: private IAM Cloud Run service, authoritative state reload, deterministic policy, atomic reserve, 기존 저잔액 executor wallet을 이용한 x402 payload 서명. 먼저 broadcast하지 않으며 control-plane service identity만 호출할 수 있습니다.
- `packages/domain`: strict schemas, RFC 8785 canonicalization, SHA-256 binding, URL/SSRF rules.
- `packages/policy`: 순수 결정론적 policy evaluation.
- `packages/payments`: 공식 x402 SVM client/server adapters, pinned facilitator, receipt/outcome signatures, independent Solana RPC verifier.
- `packages/persistence`: in-memory test adapter와 Firestore transactional adapter.
- `scripts` / `tests`: capture·verification·operator tooling과 unit/integration/security suites.
- `deploy`: Cloud Build와 세 Cloud Run template, capture→final renderer 계약.
- `artifacts` / `docs` / `submission`: hash-bound runtime evidence, 설계·대본, deck/video 제출물.

## Fresh clone: 로컬 검증

필수 도구는 Git, Corepack, Node.js 22+, pnpm 10.29.2, Python 3.11+입니다. Firestore emulator test에는 Firebase CLI 11+와 JDK 17+가, 실제 Cloud Run 렌더/배포에는 Google Cloud SDK가 추가로 필요합니다.

```bash
git clone https://github.com/kwakhyun/uptime402-agentic-commerce.git uptime402
cd uptime402
corepack enable
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run audit:git
python3 .agents/skills/ship-agentic-commerce-finalist/scripts/check_finalist_readiness.py --root . --strict
python3 deploy/render_cloudrun.py --check-templates
```

핵심 local-simulated x402 경로만 재현하려면 다음을 실행합니다.

```bash
pnpm exec vitest run tests/services-integration.test.ts --reporter=verbose
```

이 테스트는 `request -> 402 -> reserve -> automatic payload signature -> paid retry -> verify/settle adapter -> confirmed 200 resource -> signed receipt` 순서, over-cap `transactionCreated:false`, 그리고 두 vendor instance의 settle-once/replay-conflict를 검증합니다. facilitator와 chain은 명시적인 local adapter이므로 결과를 Devnet 증거로 사용하면 안 됩니다.

## 실행 모드

| Mode | State | 허용되는 주장 |
|---|---|---|
| `local-simulated` | in-memory repository + injected model/facilitator | 코드·정책·protocol state-machine의 로컬 검증 |
| `firestore-emulator` | `FIRESTORE_EMULATOR_HOST` 필요 | emulator transaction/concurrency 검증 |
| `devnet` | 기존 funded wallet, distinct recipient, real RPC/facilitator 필요 | 독립 RPC 검증을 통과한 실제 Devnet USDC만 |
| `live-capture` | 세 Cloud Run 서비스 + managed Firestore + IAM/Secret Manager | 실제 run을 수집하되 UI는 `LIVE UNVERIFIED`; evidence/report hash pin 전에는 verified 주장 금지 |
| `live-final` | 검증된 evidence/report를 exact SHA-256으로 pin한 새 revision | fresh verifier와 public/UI/manual QA까지 통과한 read-only evidence replay만 |

`pnpm dev`는 로컬 mission-control UI preview만 `http://localhost:3000`에
실행합니다. 이 화면의 fixture/timeline은 `local-simulated`이고 vendor, executor,
managed Firestore, Gemini live call, Devnet transaction을 시작하거나 증명하지 않습니다.
`CONTROL_PLANE_UI_LIVE_TRIGGER_ENABLED` 기본값도 `false`이므로 Google 로그인이나
mutation route를 활성화하지 않습니다.

```bash
pnpm run dev
```

Firestore emulator의 실제 transaction/concurrency test는 별도로 실행합니다.

```bash
NODE_BIN="$(command -v node)"
firebase emulators:exec --only firestore \
  "\"${NODE_BIN}\" node_modules/vitest/vitest.mjs run tests/persistence-firestore.test.ts tests/payment-authorization-firestore.test.ts --reporter=verbose"
```

Standalone Firebase 배포본은 child-process `PATH` 앞에 더 오래된 bundled Node를
넣을 수 있습니다. 위처럼 현재 binary를 명시하면 emulator test도 이 저장소의 Node 22
runtime으로 실행됩니다.

`.env.example`은 세 process의 superset reference라서 그대로 source하지 않습니다.
Credentialed runtime을 실행할 때만 process별 ignored env를 만들고 secret 값 대신
절대 key path를 구성합니다. Production vendor/executor/control live entrypoint는
필수값, public HTTPS origins, managed Firestore, signer mounts, Devnet identity가
없으면 fail closed하며 `FIRESTORE_EMULATOR_HOST`를 거부합니다.

모든 live/devnet 입력이 실제로 준비된 경우에만 역할별 ignored env
`.env.vendor.local`, `.env.executor.local`, `.env.control.local`을 만든 뒤 다음 명령을
사용합니다. 각 파일에는 `.env.example` 중 해당 프로세스가 필요한 값만 넣습니다.
Script가 vendor `PORT=4100`, executor `PORT=4200`, UI `3000`을 분리하지만 HTTPS
origins, IAM/ADC, Firestore, keys, funds, facilitator를 만들거나 simulation으로
대체하지 않습니다.

```bash
pnpm run dev:live
```

### Immutable offer와 최초 mandate 준비

두 offer는 live vendor URL, Agent Card URL/hash, recipient, 금액, expiry가 확정된 뒤
기존 vendor authority로 한 번 서명합니다. 다음 command는 기존 owner-only key만 읽고,
새 key를 만들지 않으며 기존 output을 덮어쓰지 않습니다.

```bash
pnpm offers:sign -- \
  --input /absolute/ignored/offers.unsigned.json \
  --output /absolute/ignored/offers.signed.json \
  --key-path /absolute/ignored/vendor/keypair.json \
  --key-root /absolute/ignored/vendor \
  --expected-public-key VENDOR_OFFER_SIGNER_PUBLIC_KEY \
  --key-id VENDOR_OFFER_SIGNER_KEY_ID
```

최초 mandate도 unsigned JSON을 operator의 기존 Ed25519 key로 서명한 뒤, 짧은 수명의
Google OIDC token 파일을 사용하는 인증 route로 한 번 arm합니다. 사람 token은
control-plane에서 종료되고, private executor에는 control-plane service identity만
전달됩니다. 이는 별도 admin service가 아닌 **application-role separation**입니다.

```bash
node --env-file=.env.operator.local --import tsx scripts/mandate-sign.ts
node --env-file=.env.operator.local --import tsx scripts/mandate-arm.ts
node --env-file=.env.operator.local --conditions=react-server --import tsx \
  scripts/mandate-run-incident.ts
node --env-file=.env.operator.local --conditions=react-server --import tsx \
  scripts/collect-live-denials.ts
node --env-file=.env.operator.local --import tsx scripts/mandate-revoke.ts
```

`mandate-run-incident`의 한 operator action은 primary recovery 뒤에 두 denial을 모두
자동 실행합니다. Server-owned `denialRequests`는 P0 cap `20000` base units를 명시하고,
counterfactual telemetry의 실제 선택·정책 결과가 `>20000` 및
`amount.per_transaction_limit`인지 검증합니다. 이어서 fresh payment/idempotency key와
primary nonce를 사용해 `identifier.nonce_fresh`를 요구합니다. Primary selected offer는
`≤20000`이어야 합니다. 두 denial 모두 `transactionCreated:false`, `txSignature:null`이고
paid retry를 보내지 않으며, 하나라도 다르면 one-shot slot을 fail-lock합니다. 따라서
live signed two-offer catalog에는 primary용 `≤20000` offer와 counterfactual용 `>20000`
offer가 실제로 있어야 하고 Gemini가 각 telemetry에서 그 offer를 선택해야 합니다.
token/key bytes는 stdout에 출력하지 않고, fresh full run capture는 ignored owner-only
파일에만 exclusive-create로 저장합니다.

`evidence:collect-denials`는 그 owner-only request/capture와 독립 settlement fragment를
bounded owner-only file로 다시 읽고 `createAutomaticDenialCaptures`로 두 result/binding,
원 transaction/Explorer를 결합합니다. Raw telemetry는 request binding projection에서
제거되며 output도 owner-only exclusive-create입니다. `.env.operator.local`에
`DENIAL_SETTLEMENT_CAPTURE_PATH/ROOT`와
`DENIAL_PROMOTION_FRAGMENT_PATH/ROOT`를 지정한 뒤 위 명령을 실행하고, 출력 JSON을
promotion manifest의 `denials` 값으로 넣습니다. 기존 output을 덮어쓰지 않습니다.

배포 시 선택적으로 활성화되는 mission-control의 one-click 경로도 같은 boundary를 사용합니다. Google
Identity Services용 OAuth Web client ID를 `CONTROL_PLANE_UI_GOOGLE_CLIENT_ID`에 두고
그 값을 exact `CONTROL_PLANE_OPERATOR_AUDIENCE`와 같게 설정합니다. 승인된 JavaScript
origin은 exact `CONTROL_PLANE_ORIGIN`입니다. ID token은 callback 메모리에서 같은-origin
Authorization header 한 번에만 사용되고 cookie/localStorage/sessionStorage/log에
기록되지 않습니다.

브라우저는 incident body나 execution policy를 보내지 않습니다. Control-plane이
`CONTROL_PLANE_UI_LIVE_REQUEST_ROOT` 아래 version-pinned read-only
`CONTROL_PLANE_UI_LIVE_REQUEST_PATH`를 strict JSON으로 읽어 실행합니다. UI route의
응답은 reduced events, outcome, `transactionCreated`, `runBindingHash`만
`LIVE UNVERIFIED`로 표시하며, promotion verifier 전에는 새 run의 Explorer, token
delta, confirmed payment 또는 verified receipt를 표시하지 않습니다. 기존
`DEVNET VERIFIED` 화면은 hash-pinned evidence trace replay이며 새 결제를 만들지 않는
별도 동작입니다. `runBindingHash`는 incident, mandate, operation, payment, nonce,
idempotency key, execution-policy hash를 canonical하게 묶습니다. Promotion 뒤에는 같은
값을 payment evidence에 기록하고 verifier와 UI adapter가 독립 재계산하므로, 촬영 전후
화면이 같은 server-owned primary request인지 비교할 수 있습니다. 이 값은 전체 실행
transcript hash가 아니며 offer·transaction·result는 request fingerprint, signed receipt,
outcome에서 별도로 검증합니다. 실제 evidence가 생기기 전에는 이 연결 역시 로컬
schema·mutation test 증거일 뿐입니다.

## Devnet 결제 재현과 검증

Devnet 승격에는 사용자가 이미 보유한 다음 입력이 필요합니다. secret 내용 대신 ignored 파일 경로나 Secret Manager resource만 구성합니다.

- `EXECUTOR_WALLET_KEYPAIR_PATH`: 수수료 SOL과 Devnet USDC가 있는 기존 저잔액 executor keypair 파일. owner-only permission 필요.
- `VENDOR_USDC_RECIPIENT`: payer와 다른 vendor USDC owner.
- `VENDOR_RECEIPT_KEY_PATH`: signed offer와 receipt가 함께 pin하는 vendor Agent Card Ed25519 authority의 existing key path. Offer catalog는 이 authority로 미리 서명되고 live runtime에는 catalog와 receipt-capable key만 전달됩니다.
- `CONTROL_PLANE_OUTCOME_KEY_PATH`: receipt authority와 다른 recovery-outcome key path.
- `VENDOR_OFFER_CATALOG_PATH`: live vendor origin, recipient, mint/network, expiry와 같은 vendor authority에 bind된 두 immutable signed offer JSON. P0 cap이 20,000 base units이므로 primary telemetry가 고르는 offer는 `≤20000`, over-cap counterfactual telemetry가 고르는 offer는 `>20000`이어야 합니다.
- `MANDATE_SIGNER_KEYPAIR_PATH`/`MANDATE_SIGNER_KEYPAIR_ROOT`: 최초 mandate attestation에만 쓰는 기존 owner-only operator key path. executor runtime에는 public key/key ID만 전달합니다.
- `MANDATE_SIGNER_PUBLIC_KEY`/`MANDATE_SIGNER_KEY_ID`와 operator-signed mandate attestation: executor가 authoritative activation 전에 검증할 public authority/evidence.
- `SOLANA_RPC_URL`: Devnet RPC. private/nonstandard RPC이면 공식 `https://api.devnet.solana.com`으로 2차 확인.
- `X402_FACILITATOR_URL`: pinned `@x402/core@2.20.0`과 공식 문서에서 확인한 기본 test facilitator는 `https://x402.org/facilitator`입니다. vendor startup은 `/supported`에서 Solana Devnet `exact`과 configured fee payer를 다시 확인합니다.
- `X402_FACILITATOR_FEE_PAYER`: 2026-08-03 공식 `/supported`에서 확인한 Devnet signer `CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5`. 공개 식별자이며 startup preflight가 drift를 fail closed합니다.
- `GEMINI_API_KEY` 또는 Vertex ADC identity: live Gemini structured decision.
- `RECOVERY_HEALTH_PROBE_URL`: exact `CONTROL_PLANE_ORIGIN/api/dependency-health`; applied paid route를 Firestore에서 독립적으로 다시 읽어 hash/activation/state/TTL을 검사합니다.
- `CONTROL_PLANE_UI_GOOGLE_CLIENT_ID`: Google Identity Services OAuth Web client ID. secret이 아니며 exact `CONTROL_PLANE_OPERATOR_AUDIENCE`와 같아야 합니다.
- `CONTROL_PLANE_UI_LIVE_REQUEST_PATH`/`CONTROL_PLANE_UI_LIVE_REQUEST_ROOT`: 브라우저가 바꿀 수 없는 기존 incident-run JSON과 그 허용 root. Cloud Run에서는 숫자 버전으로 pin한 read-only config mount를 사용합니다.

P0는 **application-enforced policy plus low-balance blast-radius isolation**입니다. Fixed Delegation의 x402 호환 end-to-end 증거가 없으므로 wallet을 `scoped` 또는 cryptographic cap이라고 부르지 않습니다.

### 현재 demo5 evidence — hash-pinned final replay

2026-08-03의 `finalist-demo-5` capture에는 다음 실제 값이 기록돼 있습니다.

- Flow: `request -> 402 -> policy reserve -> automatic PAYMENT-SIGNATURE -> paid retry -> facilitator verify/settle -> confirmed 200 -> signed receipt -> healthy outcome`
- Transaction: [`4P7YWm9Rt7w4MKbRvmfj3sjt5SW1NUfra7xyT9zUMD9uBsby4f3JC8LgYKUFPE1GXN24SoK8ABRx5YSf1HQAKtmZ`](https://explorer.solana.com/tx/4P7YWm9Rt7w4MKbRvmfj3sjt5SW1NUfra7xyT9zUMD9uBsby4f3JC8LgYKUFPE1GXN24SoK8ABRx5YSf1HQAKtmZ?cluster=devnet), `finalized`, slot `480903755`
- Network: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`; mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`; amount: `15000` base units = `0.015 USDC`
- Payer owner `5ZT11fqnqaZPbWLqx5o4PCNSisXLKV1YFtNUxjQSGPHu`: token account `3Xu6xWJQ8TKdTfM21qkqvjqdAJd7Wg6qQgAB8EsMJvQd`, `19970000 -> 19955000`, delta `-15000`
- Payee owner `GKW6kwSgTY1KkMi4ygAbZH1gZ13mYHfQJjrCASqYodmk`: token account `7XiW3QKwGEbBzCfZALeoNKCYSaLcBzqenB9YtGT6Z74J`, `30000 -> 45000`, delta `+15000`
- Gemini selection: baseline `rpc-recovery-standard`; counterfactual `rpc-recovery-emergency`
- Denials: `amount.per_transaction_limit` at `25000 > 20000`, and `identifier.nonce_fresh` with the primary nonce reused. Both record `transactionCreated:false` and `txSignature:null`.
- Recovery binding: vendor key `uptime402-vendor-v1` signs the fulfillment receipt; distinct control-plane key `uptime402-outcome-v1` binds it to `statusAfter: healthy`.

The capture bundle is [payment-evidence.json](artifacts/payment-evidence.json), generated `2026-08-03T11:39:06.877Z`, SHA-256 `sha256:0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4`. The independent [verification-report.json](artifacts/verification-report.json), produced `2026-08-03T12:24:50.914Z`, has SHA-256 `sha256:b147e7cfe2c71fee903f4052ca342d8266343694e48843ae017c8e55ae42cd3e` and binds those exact evidence bytes with all 13 machine checks true. Both hashes are configured on the live final control-plane revision, whose logged-out desktop/mobile replay was manually checked. Do not reuse `finalist-demo-5` or create another payment; the public submission payment claim is exactly the verified `0.015 USDC` run above.

실제 실행 뒤 `artifacts/payment-evidence.json`에는 `runBindingHash`, 402/200 raw x402 headers, CAIP-2 network, full genesis hash, USDC mint, integer base units, 서로 다른 payer/payee owner, tx signature/Explorer, confirmation, 관련 token account의 정확한 음·양 delta, signed fulfillment receipt, healthy outcome만 기록합니다. 검증 명령은 다음과 같습니다.

`promotion-manifest.json`은 증거 자체가 아니라 ignored local 수집 manifest입니다.
`recovered`, independently verified `settlement`, 두 signed `offers`, 실제 baseline과
counterfactual `selection`, no-payment dual `denials`, live `project`, runtime `attestations`의
일곱 strict fragment가 모두 있어야 promotion됩니다. `project` fragment에는 세 service
description/IAM 외에 `projectIamPolicyArtifact`와 그 exact
`projectIamPolicyArtifactSha256`도 필요합니다. 일부 fragment만 전달하면
`artifacts/live-capture/*.raw.json`만 기록되고 최종 evidence 파일은 바뀌지 않습니다.
Paid run이 반환한 exact `geminiBaseline`은 재호출하지 않고, production
`captureCounterfactual`/`collectGeminiSelectionForRecoveredResult`가 추가 Gemini 호출 한
번만 수행해 selection pair를 만듭니다.

`evidence:capture`는 owner-only promotion manifest와 live credentials가 있는 수집자용이며 fresh-clone public 검증 단계가 아닙니다. 기존 public evidence를 결제·settlement·배포 없이 다시 검증하려면 공식 Devnet RPC를 명시합니다. 다만 `evidence:verify`는 evidence가 선언한 exact `submission/Uptime402_Demo.mp4`도 요구하므로, 현재처럼 accepted final video가 없는 clone에서는 의도적으로 fail closed합니다. 영상 handoff 전에는 tracked report/evidence hash, Explorer, repo tests와 structural gate를 검사하고 이 명령을 실행하지 않습니다. 영상이 생긴 뒤에는 disposable clone에서 실행하세요. 이 명령은 transaction을 만들지 않지만 fresh nonce/timestamp 때문에 그 clone의 `verification-report.json`을 다시 씁니다. 새 report를 canonical artifact로 채택하려면 report hash pin과 final deployment를 다시 맞춰야 합니다.

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com \
UPTIME402_VERIFICATION_NONCE="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" \
  pnpm run evidence:verify
SOLANA_RPC_URL=https://api.devnet.solana.com \
python3 .agents/skills/ship-agentic-commerce-finalist/scripts/check_finalist_readiness.py \
  --root . --submission --run-repo-scripts \
  --rpc-url-env SOLANA_RPC_URL \
  --usdc-mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU \
  --strict
```

Verification nonce는 매 실행에만 ephemeral로 만들고 artifact나 문서에 고정하지
않습니다. Evidence가 비어 있거나 RPC/signature/delta/IAM/live URL 검증 하나라도
실패하면 verifier는 fail closed하고 fresh report를 만들지 않습니다.
private/nonstandard RPC를 썼다면 마지막 명령에
`--secondary-rpc-url https://api.devnet.solana.com`을 추가합니다. `manual.*` INFO는
사람이 영상·UX·Gemini materiality·서비스 분리를 확인해야 닫힙니다.

## Security invariants

- 금액은 float가 아닌 integer base units/decimal string만 사용합니다.
- browser, Gemini, logs, fixtures, evidence는 private key/seed를 볼 수 없습니다. Executor wallet은 private payment-executor만, vendor receipt key는 vendor만, recovery-outcome key는 control-plane server runtime만 읽습니다.
- executor는 signed payload를 반환할 뿐 먼저 broadcast하지 않습니다. vendor/facilitator가 paid retry를 verify/settle합니다.
- mandate/offer/challenge/policy/operation은 signer 직전에 authoritative storage에서 다시 읽고 해시·서명·recipient·mint·network·amount·fee/program/account·budget을 재검사합니다.
- reservation은 원자적 상태 전이를 사용하며 ambiguous submission은 `unknown`/reconcile로 남겨 재결제를 막습니다.
- paymentId, nonce, idempotency key, request fingerprint가 replay를 차단합니다.
- vendor description과 incident telemetry는 untrusted data입니다. allowlist/redaction 후 model과 logs에 전달하며 prompt-like text가 policy나 money fields를 바꾸지 못합니다.
- vendor URL은 pinned origin만 허용하며 credentials, fragment, redirect, private/link-local/metadata IP를 거부합니다.
- offer와 receipt는 같은 pinned vendor Agent Card authority입니다. 이 vendor authority, control-plane outcome authority, payer, payee는 서로 다른 identity입니다.
- Cloud Run은 세 service account를 분리하고 executor만 version-pinned signer secret의 `secretAccessor`를 가집니다. executor는 unauthenticated 401/403이어야 합니다.
- operator route는 Google-signed OIDC의 exact audience, verified email, allowlisted principal을 검사한 뒤에만 arm/revoke/run을 허용합니다. Firestore one-shot guard의 terminal failure는 자동 재시도하지 않습니다.
- UI live trigger는 exact same-origin, bodyless POST만 받고 policy·recipient·amount·nonce를 server-owned version-pinned config에서만 읽습니다. Google ID token은 browser persistence나 로그에 남기지 않습니다.
- Mainnet은 거부합니다.

## Cloud Run / Firestore

배포 계약과 실행 순서는 [deploy/README.md](deploy/README.md), 세 독립 manifest
template과 [ARCHITECTURE.md](docs/ARCHITECTURE.md)에 있습니다. 현재 project는
`uptime402-hack-260803`, region은 `asia-northeast3`입니다. Ready revision은 control
`uptime402-control-plane-ux-d8beb24`, executor `uptime402-payment-executor-00012-2dg`,
vendor `uptime402-vendor-agent-00011-88p`이며 각 latest revision이 100% traffic을 받습니다.
Executor/vendor는 검증된 payment runtime SHA `10ca5f2ccaf2af45e2d80f6065de9c623b24e559`를
유지합니다. Control만 evidence bytes를 바꾸지 않은 UX-only SHA
`d8beb2499486f02d78486710e6c9388b4624881e`로 재배포됐으며 Cloud Build
`8dd2da54-4d87-4731-8775-ba060373c3e9`과 digest
`sha256:5426343b1020824aae2eb6f1abf631759276dd7553f214b998673b68442d66e7`에 고정돼 있습니다.
이 후속 build/deploy는 executor, vendor, IAM, Secret, Firestore, Devnet transaction을
변경하지 않았습니다.

Control-plane은 두 단계로 배포합니다. `capture` stage는 evidence hash env 없이
렌더링되고 화면 전체를 `LIVE UNVERIFIED`로 유지합니다. 실제 capture와 verifier가
끝난 뒤 새 immutable image에 `payment-evidence.json`과 `verification-report.json`을
포함하고, 두 파일의 exact SHA-256을 설정한 `final` stage로 재배포합니다. Final은
evidence/report/hash binding 중 하나라도 없거나 다르면 verified 화면 대신 fail
closed합니다. 구체적인 변수와 순서는 [deploy/README.md](deploy/README.md)에 있습니다.

```bash
python3 deploy/render_cloudrun.py --check-templates
python3 deploy/render_cloudrun.py \
  --env-file .env.deploy \
  --output-dir /private/tmp/uptime402-cloudrun
```

배포 후 반드시 raw JSON을 보존합니다.

```bash
gcloud run services describe SERVICE --region REGION --format=json
gcloud run services get-iam-policy SERVICE --region REGION --format=json
gcloud projects get-iam-policy PROJECT_ID --format=json
gcloud secrets get-iam-policy SECRET --format=json
```

control-plane과 vendor만 공개합니다. executor `run.invoker`는 control-plane service
account만, signer secret `secretAccessor`는 executor service account만 허용합니다.
Project IAM export도 hash-bind하며 project-level invoker/secretAccessor 또는 runtime
identity의 primitive owner/editor grant가 있으면 live promotion을 거절합니다.

## 알려진 한계와 submission gate

- demo5의 Devnet transaction, Gemini two-offer selection, managed Firestore state, 세 Cloud Run boundary, IAM/Secret Manager export는 capture됐고 independent verifier report가 통과했습니다. 현재 live UI는 두 artifact hash를 pin한 `final` read-only replay입니다.
- Control-plane final root는 로그인 없이 핵심 결과를 먼저 보여 주며 Google 로그인과 live payment trigger를 렌더링하지 않습니다. 보호된 mutation route는 유지되지만 unauthenticated request는 `403`이고, 추가 결제 QA는 수행하지 않았습니다. OAuth exact audience/client ID는 prior successful operator capture와 동일한 config로 다시 확인했습니다.
- Executor Run IAM은 control-plane identity 하나로 유지하고 unauthenticated request는 `403`입니다. 구조 자체는 hard admin-service separation이 아니라 **application-role separation**입니다.
- QA에 실패한 `164.966667`초 provisional MP4는 Git 후보와 `submission/`에서 제거했습니다. Final evidence-stage walkthrough 파일 또는 접근 가능한 URL은 아직 없으며, 180초 이하·audio/playback·secret 미노출·full-screen read-only demo5 replay QA를 통과한 뒤에만 README에 링크합니다.
- [Uptime402_Deck.pdf](submission/Uptime402_Deck.pdf)는 demo5 실측값을 반영한 9페이지 export이며 overflow, template fidelity, source/final render QA를 통과했습니다. 이미지 기반 PDF라 태그/텍스트 검색은 지원하지 않고 editable PPTX를 함께 제공합니다.
- owned vendor P0이며 두 immutable offer를 제공합니다. 권장 production 확장인 Pub/Sub → Eventarc → Workflows → BigQuery audit pipeline과 두 번째 vendor deployment, MPP, AP2 conformance, passkey, gasless, KMS, Fixed Delegation은 P1입니다. P0는 Cloud Run + Firestore의 짧은 synchronous safety path를 먼저 증명합니다.
- P0는 AP2 conformance/compliance를 주장하지 않습니다. 설계 수준에서 AP2를 언급할 때만 `AP2-aligned`를 사용하고, official schema 검증 전에는 `AP2-validated` 또는 `AP2-compliant`라고 쓰지 않습니다.
- 마지막 `75 passed / 0 warned / 0 failed` submission checker 결과는 QA-failed provisional video가 존재하던 시점의 기록이므로 현재 tree에 재적용하지 않습니다. Payment evidence는 영상 bytes/hash를 포함하지 않지만 `submission/Uptime402_Demo.mp4`와 `165`초 계약을 선언합니다. 새 영상이 exact path와 duration 계약을 지키면 playback/manual claim QA와 submission checker만 다시 실행하면 되고, 경로나 선언 길이를 바꾸면 evidence→report→final hash pin을 다시 수행해야 합니다. 어느 경우에도 결제를 재실행하지 않습니다.

상세 상태: [BUILD_STATUS.md](docs/BUILD_STATUS.md) · 실제/목표 구조: [ARCHITECTURE.md](docs/ARCHITECTURE.md) · 촬영 순서: [DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)
