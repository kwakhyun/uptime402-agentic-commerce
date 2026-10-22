# 구매한 Devnet RPC 호출과 복구 검증

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

검증 시각: `2026-10-21T21:45:03.839Z`. 독립 verifier의 13개 검사가 모두 통과했다. 새 번들은 [payment evidence](../artifacts/runs/rpc-recovery-2026-10-22/payment-evidence.json), [verification report](../artifacts/runs/rpc-recovery-2026-10-22/verification-report.json), [RPC 응답 증거](../artifacts/runs/rpc-recovery-2026-10-22/live-capture/rpc-recovery-proof.json)에 있다. [첫 거래의 실패 경위](../artifacts/runs/rpc-recovery-2026-10-22/attempts/first-paid-recovery-incomplete.json)도 공개한다.

공급자 영수증은 구매한 endpoint를 포함한 리소스 해시를 서명한다. 별도 control-plane outcome은 실제 응답, response hash와 관측 시각을 포함한 health probe hash를 서명한다. 두 서명이 동일한 결제와 트랜잭션에 연결되는지 독립 검사한다. Google IAM token은 저장하지 않는다.

인증 없는 vendor RPC 요청은 실제 배포에서 401로 거절됐다. 같은 접근권으로 추가 결제 없이 다시 호출한 결과도 200 healthy였다. 미결제 claim, 만료, 잘못된 audience/principal, 영수증 변경과 다른 네트워크 응답 거절은 자동 테스트로 확인했다. [실측 기록](verification/paid-rpc-live.json).

소스 `8155948a5f9fdf90171e8800f5da0e52fed137ce`에서 첫 문제를 발견했고, `b2855e2a5190979ffb609d74924f484b6a667303`의 짧은 접근권 허용 및 잘못된 기한 거절 테스트로 수정했다. 수정 소스의 GitHub Actions [39680174198](https://github.com/kwakhyun/uptime402-agentic-commerce/actions/runs/39680174198)가 통과했다. 성공 capture는 control revision `uptime402-control-plane-00028-nsm`에서 실행했다.

[운영 절차](PAID_RPC_RUNBOOK.md)에 연결 설정, 재결제 방지, 별도 번들 검증 및 final 공개 배포 방법을 정리했다. 공개 진단과 견적 비교는 결제를 실행하지 않으며, 검증된 구매 기록만 재생한다. 당시의 10분 접근권이 만료된 뒤에도 영수증과 응답 증거는 보존된다.

기존 제출 영상과 PDF/PPTX는 demo5를 설명하는 역사 기록이다. 새 결제의 영상으로 표시하지 않는다. 현재 배포의 source, build, revision과 권한 회수 근거는 [BUILD_STATUS](BUILD_STATUS.md) 및 [deployment manifest](../artifacts/portfolio-deployment/manifest.json)를 따른다.

## 2026-10-22 새 RPC 증거의 최종 공개 배포

- Runtime source: `a752c708d17ba6e472cc72d48de39982fc16013b`. Cloud Build `740335a5-b962-4d89-ad2a-4f17758f2e74` (`global`), digest `sha256:e38f625364435e8634dd28aa4a08ca1dc02da808092a52c39c7bda673bbd17db`.
- Control revision: `uptime402-control-plane-00029-jsh`, traffic 100%. Vendor `uptime402-vendor-agent-00012-n6w`, executor `uptime402-payment-executor-00013-rpc`.
- 새 RPC bundle hash pin, mutation 404, executor unauthenticated 403, UI/health/vendor 200을 `2026-10-21T21:59:27.023Z`에 확인했다. 임시 control Firestore, executor invoke와 outcome secret 권한을 회수했고 예측 전용 custom role은 유지했다.

최종 공개 화면도 검증했다. 390px 기본 장애 조건은 standard, 320px 심한 장애 조건은 emergency를 선택했고 두 견적을 표시했다. 새 RPC 증거, receipt/outcome 상세 로딩과 기록 재생 완료를 확인했다. 추가 결제와 콘솔 오류는 없다. 실제 모바일 하드웨어 검증은 포함하지 않는다. [브라우저 검증 기록](verification/paid-rpc-deployment-ui.json).

## 첫 거래 후속 점검

2026-10-22 14:22 KST에 첫 거래의 finalized 정산과 영수증을 재확인했다. 기존 RPC 접근권과 mandate가 만료됐고 정상 응답 proof가 없어 현재 권한으로는 무결제 복구를 완료할 수 없다. 첫 예산은 0.015 USDC 잠금, 계산상 잔여 0.035 USDC, 현재 승인된 사용 가능액 0 USDC다. 지갑 잔액은 19.925 Devnet USDC다. 추가 결제와 cloud state 변경 없이 [별도 점검 기록](FIRST_PAYMENT_REVIEW_2026-10-22.md)을 추가했고 기존 결제 증거를 보존했다.
