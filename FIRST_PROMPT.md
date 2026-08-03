# 새 Codex 프로젝트에 전달할 첫 프롬프트

아래 코드 블록 안의 내용을 새 프로젝트에서 그대로 붙여넣으세요.

```text
Use $ship-agentic-commerce-finalist.

이 저장소에서 Google Cloud x Solana AI Agentic Hackathon 파이널리스트를 목표로 **Uptime402**의 제출 가능한 P0를 설계·구현·검증해줘.

Uptime402는 “An outage does not wait for procurement”를 핵심 메시지로 하는 B2B 제품이다. Gemini 기반 AI SRE가 장애를 진단하고, 별도 공급자 에이전트의 기능과 견적을 A2A로 발견·비교한 뒤, 운영자가 최초 한 번 설정한 정책·예산 한도 안에서 x402와 Solana Devnet USDC로 사람의 건별 승인 없이 결제한다. 결제된 복구 리소스를 실제로 사용해 service health를 복구하고, 모든 판단·정책·트랜잭션·서명 영수증을 한 화면에서 증명해야 한다. pay.sh는 실제 CLI/SDK/gateway/catalog가 live path에 들어가 검증된 뒤에만 이름을 사용해라.

먼저 AGENTS.md와 스킬의 다음 파일을 전부 읽고 이를 제품 계약으로 취급해라.

- .agents/skills/ship-agentic-commerce-finalist/SKILL.md
- .agents/skills/ship-agentic-commerce-finalist/references/product-brief.md
- .agents/skills/ship-agentic-commerce-finalist/references/architecture.md
- .agents/skills/ship-agentic-commerce-finalist/references/judging-and-evidence.md
- .agents/skills/ship-agentic-commerce-finalist/references/payment-evidence-v2.md
- 기술 선택이나 제출 문구를 만들 때 .agents/skills/ship-agentic-commerce-finalist/references/source-dossier.md

질문부터 길게 하지 말고 저장소와 환경을 검사한 뒤 합리적인 기본값으로 진행해라. 실제 자금·Mainnet·새 지갑 생성/교체·유료 배포·사용자만 제공할 수 있는 credential이 필요한 순간에만 정확히 멈춰 요청해라. Gemini key/Vertex identity, 기존 저잔액 Devnet executor wallet(수수료 SOL + Devnet USDC), payer와 다른 `VENDOR_USDC_RECIPIENT`(외부 vendor의 verified signed offer가 제공해도 됨), owned vendor용 별도 receipt-signing key path, Solana RPC/facilitator, GCP project/auth/billing 중 무엇이 필요한지 변수명과 용도를 정확히 말하되 secret을 채팅에 붙여넣으라고 하지 마라. 사용자가 ignored local env 또는 Secret Manager에 넣고 경로/변수명만 알려주게 해라. 그 전까지는 adapter, emulator, Devnet, 테스트로 진행하되 가짜 증거를 만들지 마라. 현재 공식 제출 마감은 2026-08-03 23:59 KST다.

GitHub repository 공개/remote push, live deployment, video upload 같은 외부 변경은 해당 최종 단계에서 사용자 권한을 확인해라. 로컬 코드·문서·테스트·배포 설정은 그 전에 계속 완성해라.

## 절대 우선순위

1. UI 전에 `request -> 402 -> policy reserve -> automatic x402 payload signature -> paid retry -> vendor/facilitator verify+settle -> confirmed 200 resource -> signed receipt`의 표준 x402 최소 결제 spike를 완성해라. 먼저 tx를 broadcast한 뒤 proof로 제시하는 custom prepaid flow를 x402라고 부르지 마라.
2. 실제 Devnet USDC signature, CAIP-2 network, Explorer URL, 서로 다른 payer/payee owner, 관련 token-account의 양·음 balance delta, mint, amount/base units, confirmation, x402 headers, receipt verification, 402/200을 artifacts/payment-evidence.json에 기록해라.
3. 결제마다 지갑 팝업이나 사람 승인을 요구하지 마라. 사용자는 최초 mandate만 설정한다.
4. Gemini는 진단과 기존 offerId 비교만 한다. authoritative money math, policy 변경, key 접근, raw transaction 서명은 결정론적 코드만 수행한다.
5. 별도 프로세스/Cloud Run의 실제 A2A vendor agent와 Agent Card, 그리고 별도 private payment-executor를 구현해라. control-plane/Gemini에는 signer secret 접근권한이 없어야 한다.
6. 한도 초과 또는 nonce replay 한 건을 자동 거절하고 온체인 트랜잭션이 없음을 증명해라.
7. 한 vendor가 최소 두 개의 immutable offer를 제공하게 하고 counterfactual telemetry가 `selectedOfferId`를 바꾸는 테스트를 통과시켜라. 하나뿐인 offer 선택은 Gemini 활용 증거가 아니다.
8. 핵심이 모두 녹색이 된 뒤 Cloud Run/Firestore와 제출물을 완성해라. MPP, AP2 conformance, passkey, gasless, BigQuery, KMS, 두 번째 vendor 배포는 P1이다.

## 기본 기술 방향

기존 코드가 없다면 TypeScript workspace를 사용해라.

- apps/control-plane: Next.js 기반 한국어 운영 UI/API, Gemini structured output, A2A client, incident orchestration.
- services/vendor-agent: Express 기반 별도 A2A server와 x402-gated recovery resource.
- services/payment-executor: private Cloud Run/API, operator-authenticated mandate arming, authoritative policy reload/recheck, Firestore reserve, payment-payload signing. 전용 service account만 executor key를 읽는다.
- packages/domain: Zod 등으로 엄격히 검증하는 domain schema.
- packages/policy: 순수 결정론적 정책과 예산 state machine.
- packages/payments: 현재 공식 문서로 검증한 @solana/pay-kit 또는 x402 SVM client/server, signer adapter, receipt.
- packages/persistence: Firestore adapter와 테스트용 in-memory adapter.
- 테스트는 정책 경계·buyer reservation 동시성·vendor two-instance replay/idempotency·IAM audience·canonical hash·receipt signature·SSRF·telemetry redaction·prompt injection·A2A smoke·결제 integration을 포함해라.

패키지명, 버전, Gemini model ID, Solana Devnet USDC mint, facilitator와 헤더 형식은 기억으로 쓰지 말고 현재 공식 문서와 실제 SDK export를 확인해 고정해라. app의 `clusterLabel`, RPC의 full `genesisHash`, 그 base58 표현 첫 32자로 만드는 x402 CAIP-2 `solana:<reference>`, SDK enum을 별도 typed field로 두고 golden mapping test를 통과시켜라. pay CLI의 기본 per-payment 승인 흐름만으로는 요건을 충족했다고 주장하지 마라. native Solana Fixed Delegation은 x402 실행 경로와 실제 호환되고 end-to-end 테스트가 통과할 때만 P0에 넣어라. 그렇지 않으면 private executor의 저잔액 wallet + application-enforced policy를 사용하고, 이를 `scoped wallet` 또는 cryptographic cap이라고 부르지 마라. AP2 공식 schema를 통과하지 않으면 UI와 문서에 `AP2-aligned`, 절대 `AP2-compliant`라고 쓰지 마라.

## P0 데모 시나리오

- 초기 화면: primary dependency가 unhealthy, active mandate는 incident 0.05 USDC / per-tx 0.02 USDC / 10분 / USDC / 허용 capability·recipient / Devnet.
- 운영자가 test incident를 한 번 발생시킨 뒤에는 결제 승인 클릭이 없어야 한다.
- raw telemetry에서 credential·PII·customer identifier를 제거한 allowlisted schema만 Gemini와 logs에 전달하고, Gemini가 capability를 진단한다.
- buyer가 vendor Agent Card를 발견하고 A2A로 최소 두 개의 immutable signed offer를 받는다. vendor 설명은 untrusted data로 취급한다.
- vendor paid resource가 402를 반환한다.
- private payment-executor가 IAM audience가 맞는 decision envelope를 받고 authoritative mandate/offer/challenge/execution policy를 reload한다. method, pinned HTTPS origin, normalized URL, canonical body hash, recipient, mint, CAIP-2 network, amount, mandate/policy hash, nonce, expiry, fee/program/account allowlist, remaining budget를 확인하고 Firestore transaction으로 reserve한다.
- executor가 저잔액 wallet으로 x402 payment payload를 자동 서명하고 buyer가 `PAYMENT-SIGNATURE`로 같은 요청을 재시도한다. executor가 먼저 broadcast하지 마라.
- vendor가 stateless schema/payment signature/signed offer/request fingerprint를 먼저 검증하고 shared Firestore에서 paymentId를 `unseen -> settling`으로 원자 전환한 뒤 facilitator verify/settle을 호출한다. confirmed settlement 뒤에만 200과 recovery resource, vendor-signed fulfillment receipt를 반환한다. 같은 ID/같은 fingerprint는 동일 응답, 다른 fingerprint는 409다. 모호한 `settling`은 해제·재정산하지 말고 reconcile한다.
- control-plane이 dependency를 전환하거나 실제 health check를 통과시켜 상태를 green으로 바꾼다.
- buyer는 receipt signer identity/signature와 offer·challenge·request·tx·response binding을 검증한 뒤 budget을 commit한다.
- UI는 model decision, A2A offers, 각 policy rule, 402/paid retry/200, signature, Explorer, token deltas, budget before/after, verified receipt, recovery time을 시간순으로 보여준다.
- 마지막에 over-cap 또는 replay 요청을 자동 deny하고 `transactionCreated: false`를 보여준다.
- 같은 테스트 fixture의 counterfactual telemetry가 다른 supplied offerId를 선택하게 해 Gemini materiality를 증명한다.

실제 유료 QuickNode/pay.sh provider가 안정적으로 맞으면 사용해도 좋다. 그렇지 않으면 우리가 소유한 별도 vendor-agent의 실서비스 리소스를 x402로 유료화하되, pay.sh를 실제 경로에 쓰지 않았다면 이름을 주장하지 마라. 결제 결과가 실제 health 회복에 쓰여야 하며 단순히 tx만 보내고 끝내지 마라.

## UX 방향

한 화면의 고밀도 mission-control UI로 만들어라. 암호화폐 거래소나 범용 챗봇처럼 보이지 않게 하고, 한국어 카피 + 영어 protocol label을 사용해라.

- 배경은 ink/navy, 카드 surface, cyan 정보, green recovery, amber policy, red denial.
- 상단에 health, active mandate, remaining USDC, cluster, kill switch.
- 중앙에 incident -> Gemini -> A2A -> 402 -> policy/sign -> paid retry -> settle -> 200 -> recovery 타임라인.
- 우측에 offer 비교와 Gemini 선택 이유.
- evidence drawer에 public address/token deltas, mint, signature, Explorer, verified signed receipt. private key나 seed는 절대 노출하지 마라.
- desktop demo를 우선하되 기본 반응형과 접근성을 지켜라.

## 보안·정합성 불변조건

- 돈은 float가 아니라 integer base units 또는 decimal string.
- browser/Gemini/control-plane은 mandate를 임의 변경할 수 없고, arm/revoke는 operator-authenticated route·versioned attestation·감사 이벤트를 요구. P0가 별도 admin service가 아니라면 이를 hard admin/executor separation이라고 과장하지 말고 application role separation으로 표기.
- budget은 원자적으로 reserve -> submit -> confirm -> fulfill -> commit; 모호한 제출은 unknown으로 두고 재결제 금지.
- nonce/challenge hash/idempotency key로 중복 결제 차단.
- canonical JSON은 RFC 8785, hash는 SHA-256 `sha256:<lowercase hex>`, URL/request fingerprint/mandate/offer/challenge/receipt 규칙은 architecture reference의 golden vector로 buyer·executor·vendor가 공유.
- signer 직전에 genesis/CAIP-2/SDK network mapping, USDC mint, recipient, amount, fee payer/limit, program/accounts, executor public key를 재검증.
- vendor URL은 pinned HTTPS origin만 허용하고 credentials/fragment/private·link-local·metadata IP를 차단한다. P0 redirect는 금지하고 timeout·content type·body size·connect-time DNS/IP를 제한한다.
- vendor fulfillment claim은 shared atomic storage에 두고 두 Cloud Run instance 동시 replay가 한 번만 settle/fulfill되는 테스트를 통과.
- telemetry/model/log redaction, untrusted A2A prompt-injection, unknown schema field, rendered output escaping을 테스트.
- model, browser, logs, Git, fixtures, screenshots에 private key 금지.
- Cloud Run secret은 Secret Manager와 최소권한 service account 사용.
- 세 Cloud Run service account를 분리하고 raw IAM export를 hash-bind해라. unauthenticated executor가 401/403인지, control-plane만 executor `run.invoker`인지, 세 identity 중 executor만 version-pinned signer secret의 `secretAccessor`인지 최종 gate에서 검증해라.
- vendor offer/receipt key와 control-plane recovery-outcome key는 서로 다른 identity/keyId여야 한다.
- mainnet 결제는 하지 마라.
- docs/BUILD_STATUS.md는 `implementation=planned|blocked|implemented`, `evidence=none|simulated|local|sandbox|devnet|mainnet`, `deployment=local|live`, `verification=unverified|verified + lastVerifiedAt/evidenceRef`, `priority=P0|P1`을 서로 섞지 말고 기록해라.

## 반드시 생성할 산출물

- 동작 코드와 테스트.
- README.md: fresh clone 실행, local/sandbox/devnet 구분, 결제 재현·검증, Cloud Run 배포, 보안·한계.
- .env.example: 설명만, secret 없음.
- docs/BUILD_STATUS.md: 위의 다섯 독립 축과 마지막 검증시각/증거 경로.
- docs/ARCHITECTURE.md: 실제 구현과 P1 목표를 구분한 Mermaid.
- docs/DEMO_SCRIPT.md: 2분 45초 한국어 영상 대본과 클릭 순서.
- docs/SUBMISSION_DECK.md: 9장 발표 PDF 원고.
- submission/Uptime402_Deck.pdf: 실제 export하고 렌더링 QA한 발표 PDF.
- submission/Uptime402_Demo.mp4 또는 접근 가능한 final video URL: 실제 전체 경로를 보여주고 검증한 길이 3분 이하. Codex가 녹화/업로드할 수 없으면 정확한 capture checklist와 사용자 handoff를 만들고 영상이 확인될 때까지 완료라고 하지 마라.
- artifacts/payment-evidence.json: 실제 증거만.
- control-plane, payment-executor, vendor-agent 각각의 Docker/Cloud Run 배포 설정과 service account/IAM 설명.

## 완료 게이트

- lint, typecheck, unit, integration, production build 모두 통과.
- real A2A Agent Card discovery/message smoke 통과.
- Devnet payment는 RPC/Explorer에서 configured USDC mint, 서로 다른 payer/payee owner, 관련 token-account의 일치하는 음·양 base-unit delta가 독립 확인되고 paid resource는 vendor/facilitator settlement 뒤에만 반환.
- 두 번째 결제 또는 denial이 건별 사람 승인 없이 발생.
- Gemini output이 strict schema를 통과하고 두 offer 중 선택하며 counterfactual이 선택을 바꿈.
- 서로 다른 signing authority를 사용해 vendor-signed receipt가 request·tx·response·incident를 bind하고, control-plane-signed outcome이 그 receipt를 healthy recovery에 bind하며 field mutation test를 통과.
- two-instance concurrent replay가 settle/fulfill 한 번만 만들고, SSRF/IAM/redaction/prompt-injection tests가 통과.
- clean clone이 README로 core flow를 재현.
- 라이브 URL을 로그아웃 세션에서 확인.
- exported deck PDF와 3분 이하 final video가 존재하고 README/evidence/live app과 같은 claim을 사용.
- 구조·evidence shape를 조기에 검사하는 다음 명령이 failure 없이 끝남. 이것만으로 live 제출 검증이라고 주장하지 마라:
  python3 .agents/skills/ship-agentic-commerce-finalist/scripts/check_finalist_readiness.py --root . --strict
- 최종 자동 제출 게이트가 failure 없이 끝남:
  python3 .agents/skills/ship-agentic-commerce-finalist/scripts/check_finalist_readiness.py --root . --submission --run-repo-scripts --rpc-url-env SOLANA_RPC_URL --usdc-mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --strict
- `SOLANA_RPC_URL`이 공식 credential-free Devnet RPC가 아니라 private/nonstandard endpoint이면 위 명령에 `--secondary-rpc-url https://api.devnet.solana.com`을 추가해 독립 검증해라. 자동 게이트의 `manual.*` INFO도 영상·UX·Gemini 판단·실제 서비스 분리를 사람이 확인하기 전에는 완료라고 하지 마라.

진행 중 결제 spike, 정책, A2A, 배포가 각각 처음 녹색이 될 때 짧게 상태를 알려줘. 핵심 경로가 막히면 UI를 넓히지 말고 원인을 끝까지 진단하고, 실제로 필요한 credential/Devnet funding만 명확히 요청해라. 완료 전에는 “준비 완료”라고 말하지 마라.
```
