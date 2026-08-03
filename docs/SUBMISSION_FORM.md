# Uptime402 submission form copy

## 프로젝트 명

Uptime402

## 프로젝트 트랙

**B. Autonomous On-chain Settlement — 정책·예산 한도 내 에이전트가 직접 지갑 서명·결제**

보조 주제: C. Multi-Agent Commerce

## 프로젝트 소개

### 1) 문제 정의 (Problem Statement)

장애는 구매 절차를 기다리지 않습니다. On-call SRE가 복구에 필요한 외부 RPC, 라우팅,
capacity 또는 진단 리소스를 즉시 확보해야 할 때, 기존의 공급자 탐색 → 계정 생성 → 견적 →
승인 → 결제 → provisioning 절차는 MTTR을 늘리고 매출·SLA·고객 신뢰 손실을 키웁니다.
반대로 AI agent에 일반 지갑이나 무제한 API key를 맡기면 금액 초과, 잘못된 수취인,
replay와 감사 불가능성이라는 새로운 운영 위험이 생깁니다. 필요한 것은 사람의 건별 결제
승인을 제거하면서도, 최초에 승인한 정책·예산·대상 안에서만 동작하고 결과를 끝까지 증명하는
B2B 복구 구매 제어면입니다.

### 2) 솔루션 요약 (Solution Overview)

Uptime402는 Gemini 기반 AI SRE가 allowlist·redaction을 거친 telemetry로 필요한 복구
capability를 진단하고, 별도 Cloud Run의 A2A vendor agent가 제공한 두 개의 immutable signed
offer를 비교해 supplied offerId 하나를 선택하는 B2B 제품입니다. Gemini는 진단과 offer 선택만
담당합니다. 금액 계산, 정책 변경, key 접근과 transaction 서명은 모델과 분리된 private payment
executor의 결정론적 코드가 수행합니다.

운영자가 incident 0.05 USDC, per-transaction 0.02 USDC 등의 mandate를 최초 한 번 설정하면,
executor가 network·USDC mint·recipient·capability·금액·nonce·URL/body hash·잔여 예산을
authoritative state에서 다시 검사하고 Firestore transaction으로 예산을 reserve합니다. Vendor의
유료 recovery endpoint가 HTTP 402를 반환하면 executor가 x402 `PAYMENT-SIGNATURE` payload를
자동 서명하고, buyer가 같은 요청을 건별 승인이나 wallet popup 없이 재시도합니다. Vendor와
facilitator가 Solana Devnet USDC 결제를 verify·settle한 뒤에만 HTTP 200 복구 리소스와
vendor-signed receipt를 반환합니다. Control plane은 이 리소스를 실제 health recovery에 적용하고,
별도 서명의 outcome으로 receipt와 `healthy` 상태를 결합합니다.

검증된 `finalist-demo-5`에서 Uptime402는 실제 0.015 USDC를 결제해 payer `-15000`, payee
`+15000` base-unit delta와 finalized transaction을 만들고, 예산을 0.050000 → 0.035000 USDC로
갱신한 뒤 9.340초 만에 dependency를 green으로 복구했습니다. 이어 0.025 USDC over-cap 요청과
nonce replay를 모두 자동 거절했으며 두 경우 모두 `transactionCreated:false`,
`txSignature:null`입니다. 세 Cloud Run 서비스, Firestore atomic state, A2A/x402 증거,
signed receipt/outcome과 독립 RPC 검증 결과는 로그인 없는 read-only 공개 화면에서 재생됩니다.

## 한 줄 요약

Gemini가 A2A로 복구 리소스를 선택하고, 사전 정책·예산 안에서 Solana USDC를 자동 결제해
장애를 복구하고 증명하는 B2B AI SRE control plane.
