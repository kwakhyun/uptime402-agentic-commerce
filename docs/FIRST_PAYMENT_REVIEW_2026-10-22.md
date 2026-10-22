# 첫 번째 Devnet 결제의 무결제 재개와 예산 점검

검증 시각: `2026-10-22T14:22:56.318000+09:00`. 실행 소스: `6c633c8d99fb3c04ecc76ce2ab0bea1b55b986fe`. 대상은 `rpc-20261022-4d574608`이며 [기존 실패 증거](../artifacts/runs/rpc-recovery-2026-10-22/attempts/first-paid-recovery-incomplete.json)는 변경하지 않았다. [새 읽기 전용 점검 증거](../artifacts/runs/rpc-recovery-2026-10-22/follow-ups/first-payment-review-2026-10-22.json)를 별도 파일로 추가했다.

## 결론

첫 거래의 **0.015 Devnet USDC 정산은 finalized**이고 공급자 영수증 서명도 유효하다. 그러나 구매한 10분 RPC 접근권은 **2026-10-22 06:38:54.891 KST**에 만료됐다. 해당 실행에는 `request` 체크포인트만 있고 정상 RPC 응답과 서명된 복구 결과를 담은 `proof`, 완료 `result`가 없다. 현재 권한으로는 추가 결제 없이 실제 RPC 복구를 완료할 수 없다.

원래 실패 원인은 접근권 만료와 견적 만료를 같아야 한다고 검사하던 오류였다. 이 오류는 이미 수정됐지만, 지금 막는 조건은 실제 접근권 만료다. 저장된 영수증을 재조회해도 최초 접근 기간이 연장되지 않는다. 성공했던 과거 probe를 검증하고 commit만 마무리할 자료도 없어 첫 거래를 복구 성공으로 바꾸지 않았다.

이번 점검에서는 추가 결제, 재서명, 재정산, 환불, 예산 해제, Firestore 갱신, IAM 변경과 접근권 연장을 수행하지 않았다. 전체 `incident:resume`은 실행하지 않았다. 새 정상 응답을 얻을 수 없는 상태에서 만료된 라우트를 적용하거나 과거 기록을 성공으로 바꾸지 않기 위해서다.

## 정산과 저장 상태

- [첫 거래](https://explorer.solana.com/tx/3BbwAMZjVyX43qwqpMr6dWs7g5zLEPygLd9f5EjgmxTLHua9vLhK3ppTcUAZSR8U5ns98gnhv9BwvpB5FPJQHhwT?cluster=devnet): `finalized`, slot `513658504`, payer `-15000`, payee `+15000` base units. 현재 공식 Solana Devnet RPC로 다시 검증했다.
- 두 번째 거래도 `finalized`다. 첫 거래 이후 검증된 두 번째 거래가 현재 payer token account의 가장 최근 거래이며, 현재 잔액도 당시 결과와 일치한다.
- 공급자 claim은 `receipt_signed`다. 기존 영수증 서명과 리소스 해시를 검증했고 최초 영수증 및 접근권과 동일함을 확인했다.
- 첫 control reservation은 원래의 `unknown` / `paid_response_invalid` 상태다. 이것은 control의 미완료 처리 상태이며, 현재 확인된 온체인 정산이 불명확하다는 뜻은 아니다.
- 첫 operator outcome은 `reconciliation_required`이며 추가 완료 기록은 없다. 의존성 라우트도 생성되지 않았다.
- 현재 Firestore에서 읽은 원본 접근권과 실제 점검 시각을 production `executePaidRpc` 함수에 넣으면 `410 paid_activation_expired`가 반환된다. upstream 호출은 0회다. 이는 **라이브 저장 데이터에 대한 로컬 코드 검사**이며, 배포 endpoint에서 받은 HTTP 410 응답으로 표시하지 않는다. IAM 경계를 바꾸거나 우회하지 않았다.

## 남은 예산과 지갑 잔액

| 구분 | 첫 실행 | 두 번째 성공 실행 |
|---|---:|---:|
| 각 mandate의 장애 한도 | 0.050 USDC | 0.050 USDC |
| 각 mandate의 건별 한도 | 0.020 USDC | 0.020 USDC |
| 실제 정산액 | 0.015 USDC | 0.015 USDC |
| 앱 예산에 반영된 금액 | 0.015 USDC, 잠금 유지 | 0.015 USDC, committed |
| 장애 및 원래 UTC 일자 예산의 계산상 잔여액 | **0.035 USDC** | **0.035 USDC** |
| 현재 이 mandate로 사용 가능한 금액 | **0 USDC — 만료** | **0 USDC — 만료** |

첫 mandate는 **06:38:24.881 KST**, 두 번째는 **06:52:36.394 KST**에 만료됐다. 첫 결제의 정산액과 예약 잠금 0.015 USDC는 같은 지출을 나타내므로 더해서 0.030 USDC로 계산하지 않는다. 실제 정산이 확인됐기 때문에 잠금을 해제하거나 미사용 예산으로 돌리지 않았다.

두 실행은 별도 mandate를 사용한다. 일일 카운터는 **mandate별 UTC 일자**로 나뉘며 지갑 전체의 공통 일일 한도가 아니다. 결제일인 UTC `2026-10-21`에는 각 카운터가 `15000`, 점검일 UTC `2026-10-22`에는 일일 카운터가 각각 `0`이다. 날짜가 바뀌어도 만료된 mandate가 다시 활성화되거나 과거 지출이 환급되는 것은 아니다.

현재 payer 지갑 잔액은 **19.925 Devnet USDC** (`19925000` base units, finalized slot `513777585`), SOL 잔액은 **0.497955720 SOL**이다. payee USDC 잔액은 0.075다. 지갑 잔액은 결제 권한 또는 남은 mandate 예산과 별개다. 이전 작업의 두 결제 합계 0.030 USDC는 그대로이며 이번 점검의 추가 결제는 0건이다.

## 보존과 검증 방법

- 점검 시작 시 존재한 artifact **72개를 모두 바이트 단위로 보존**했다. root demo5, 첫 실패 기록, 새 성공 번들, verification report 및 기존 배포 manifest를 변경하지 않았다.
- Firestore repository의 해시 검증을 거쳐 reservation, mandate, vendor claim, checkpoint와 operator capture를 읽었다. 기존 캡처 원본과 continuation 유무도 확인했다.
- 원본 Firestore 응답은 개인정보와 내부 실행 문맥이 있어 ignored `private/first-payment-reconciliation-2026-10-22/live-inspection.json`에 저장했다. 공개 후속 증거에는 필요한 필드와 원본 SHA-256 `sha256:5886a9d5504551b94a344272d9ae371c20e44ddd6d1365aa4336f6cd47ddd1d0`만 넣었다.
- 결제/정산 재시도 없는 재개, 만료 접근 거절, 기존 operator capture 보존에 대한 관련 회귀 테스트 29개가 모두 통과했다. 실제 복구 성공을 새로 주장하는 증거는 생성하지 않았다.

향후 첫 실행을 복구 성공으로 만들려면 유효한 접근권과 실제 정상 RPC 응답이 새로 필요하다. 현재 계약은 무상 재발급이나 만료 연장을 지원하지 않으며, 기존 서명 리소스의 시각을 바꿔 증거를 대체할 수 없다.
