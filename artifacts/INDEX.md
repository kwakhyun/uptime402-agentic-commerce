# Artifact authority map

이 디렉터리의 파일은 모두 같은 증거 수준을 뜻하지 않습니다. 검토와 유지보수에서는 아래 순서를 사용합니다.

## 1. 보존된 실제 결제 증거

- `artifacts/payment-evidence.json`: `finalist-demo-5`에서 발생한 실제 Solana Devnet USDC 결제, x402 왕복, denial, receipt와 recovery outcome의 규범적 증거입니다.
- `artifacts/verification-report.json`: 위 payment evidence의 exact bytes와 13개 검증 항목을 묶은 보고서입니다.
- `artifacts/live-capture/`: 위 두 파일로 승격할 때 사용한 실제 runtime 조각입니다. 새 포트폴리오 배포를 뜻하지 않습니다.

이 계층만 `evidence=devnet` 결제 주장을 만들 수 있습니다. UX 수정이나 재배포는 이 파일들을 다시 쓰지 않습니다.

## 2. 역사적 final promotion

- `artifacts/final-release.json`
- `artifacts/final-deployment/`

2026-08-03 제출용 final promotion 당시 Cloud Run, IAM, Secret Manager 경계를 보존합니다. 현재 portfolio control revision의 상태로 해석하지 않습니다.

## 3. 현재 portfolio replay 배포

- `artifacts/portfolio-deployment/manifest.json`

현재 공개 read-only replay의 revision, image digest, evidence pin, live HTTP 결과와
최소화된 경계 assertion입니다. 원본 Cloud Run, IAM, Cloud Build export에는 개인·조직
권한 메타데이터가 있으므로 ignored `private/portfolio-deployment-raw/`에만 둡니다.
Manifest에는 원본의 SHA-256만 남깁니다.
`notPaymentEvidence: true`이며 새 결제나 새로운 Devnet evidence를 주장하지 않습니다.
`pnpm portfolio:verify-deployment`가 공개 attestation shape, evidence pin, mutation `404`와
replay-only 경계를 검사합니다. IAM assertion을 새로 만들려면 owner가 capture command로
GCP를 다시 읽고 private raw export와 그 hash를 함께 확인해야 합니다.

## 4. 로컬·시뮬레이션·QA 자료

- `artifacts/local/`: Firestore Emulator, deck render, local verification처럼 환경이 명시된 자료입니다.
- `artifacts/simulated/`: 실제 결제나 live deployment로 사용할 수 없는 fixture와 simulation입니다.

이 계층은 각각 `evidence=local` 또는 `evidence=simulated`입니다. RPC settlement나 현재 Cloud Run 상태를 증명하지 않습니다.
