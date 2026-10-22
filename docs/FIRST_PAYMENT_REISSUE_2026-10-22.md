# 첫 거래 RPC 접근권의 무결제 재발급

대상은 `payment-rpc-20261022-4d574608-primary`의 기존 0.015 Devnet USDC 거래다. 운영자가 승인한 무결제 복구 후속 작업이며 새로운 구매나 결제 허용 기간 연장이 아니다. 2026-10-22 15:16:13.666 KST에 실제 RPC 복구를 완료했다.

## 보존과 발급 규칙

- 기존 `recovery_resources` 문서, vendor claim, 서명 영수증, 원본 operator capture, 실패 및 만료 증거를 수정하지 않는다.
- 운영자가 Firestore에 별도로 기록한 승인에는 원래 payment ID, activation ID, 영수증 해시, 승인 시각과 만료 시각, 추가 금액 0, 최대 600초 접근 기간이 들어간다.
- `/v1/recovery/reissue`는 정확한 audience와 control 서비스 계정을 인증한 뒤 승인 문서를 읽는다. `PAYMENT-SIGNATURE`는 거절한다. 기존 온체인 정산을 다시 읽어 금액, 자산, 수신자를 검증한다.
- 새 activation과 새 영수증은 원본 영수증 및 승인 해시를 서명으로 연결한다. payment별 Firestore transaction으로 한 번만 생성한다. 재시도와 동시 호출은 처음 발급한 접근권을 반환하며, 만료 시각을 늘리지 않는다.
- 원본 만료 접근권은 계속 HTTP 410을 반환한다. 새 접근권도 최대 10분 뒤 만료된다. 공급자 RPC는 `getHealth`와 `getGenesisHash`만 허용한다.
- control은 원본 영수증을 원래 결제 허용 기간으로 검증한 뒤, 새 영수증을 별도 재발급 기간으로 검증한다. 만료된 mandate는 바꾸지 않고 기존 예약을 확정한다.

## 실행 경계

일회성 Cloud Run Job은 control identity와 별도 outcome 서명 키를 사용한다. 결제 실행 서비스의 `run.invoker`는 부여하지 않으며, 작업 시작 때 실제 인증 요청이 403으로 거절되는지 확인한다. 공개 결제 mutation은 꺼둔다. 복구 작업은 Firestore에 적용된 라우트를 독립적으로 다시 읽고 실제 공급자 RPC 두 메서드를 호출한 뒤 건강 상태에 서명한다. 완료 후 임시 datastore 및 outcome secret 권한을 회수한다.

Cloud Run Job은 요청을 받는 서비스가 아니라 실행 후 종료하는 작업이다. Secret Manager의 키는 고정된 버전을 파일로 마운트한다. [공식 Job 문서](https://docs.cloud.google.com/run/docs/create-jobs), [Job secret 설정](https://docs.cloud.google.com/run/docs/configuring/jobs/secrets).

## 검증 방법

`tests/reissue.test.ts`는 재발급 서명 연결, 정산 불일치, 원본 만료, 추가 발급 거절, 재시도 시 만료 시각 고정을 검사한다. `tests/control-plane-live-flow.test.ts`는 원래 허용 기간이 끝난 거래의 무결제 복구와 체크포인트 재개를 검사한다. `tests/recovery-checkpoints-firestore.test.ts`는 두 인스턴스의 동시 발급과 원본 문서 보존을 검사한다.

새 후속 증거는 원본 payment evidence와 구분한다. `scripts/verify-free-recovery.ts`는 과거 파일 해시, 원본/신규 공급자 서명, 독립 control 서명, 실제 RPC 응답 해시, 예산 및 지갑 전후 상태를 검사한다. `--live`는 기존 거래를 읽기 전용으로 다시 검증한다. 기존 verification report는 덮어쓰지 않는다.

## 실행 결과

- 기존 거래: `3BbwAMZjVyX43qwqpMr6dWs7g5zLEPygLd9f5EjgmxTLHua9vLhK3ppTcUAZSR8U5ns98gnhv9BwvpB5FPJQHhwT`, `finalized`, 기존 금액 0.015 Devnet USDC. 추가 거래와 추가 금액은 모두 0이다.
- 원본 접근권 만료: `2026-10-21T21:38:54.891Z`(10월 22일 06:38:54.891 KST). 원본 HTTP 요청은 410으로 거절됐다.
- 새 activation: `ecac2dd15c885a868db0690be30128d107d2900d08c0cc32961a9b4ed51f026a`. 발급 `2026-10-22T06:16:12.941Z`, 만료 `2026-10-22T06:26:12.941Z`. 재시도로 연장되지 않는다.
- 실제 응답: `getHealth=ok`, `getGenesisHash=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. 두 RPC 호출에 223.2ms가 걸렸다. 서명된 복구 시각은 `2026-10-22T06:16:13.666Z`다.
- 기존 예약: `unknown → confirmed → fulfilled → committed`. 원본 `paid_response_invalid` 이력과 실패 capture는 남아 있고, 성공 continuation을 별도로 추가했다.
- 첫 mandate의 결제일 예산: incident와 daily가 각각 15000 base units(0.015 USDC)로 전후 동일하다. 한도 50000에서 계산상 잔여는 35000(0.035 USDC)다. mandate는 이미 만료됐으므로 신규 지출 가능액은 0이다. daily counter는 mandate별 UTC 날짜에 묶이며 현재 UTC 날짜 22일의 counter는 0이다. 이를 전체 지갑의 공통 일일 한도로 해석하지 않는다.
- 재검증 시각 `2026-10-22T06:18:21.331Z`: payer 19.925 USDC, payee 0.075 USDC, payer 0.497955720 SOL. 전후 잔액과 최근 거래 목록이 동일하다. 최근 거래는 이전 두 번째 결제 그대로다.
- 원본 resource, vendor claim, receipt, request checkpoint, operator capture와 두 번째 거래 기록의 canonical hash가 전후 같다. 기존 tracked artifacts 73개도 재발급 완료 시점까지 모두 원본 바이트와 같았다. 최종 배포 manifest는 결제 증거가 아닌 현재 상태 파일로 별도 갱신하고 이전 사본은 private에 보존한다.
- 실행: Cloud Run Job `uptime402-free-recovery-hrw5w`, 12.3초 만에 성공 종료. vendor revision `uptime402-vendor-agent-free-reissue`, worker/vendor source `3b7299317f5465ba6c80dfd9b5dc18b8ea829d27`, Cloud Build `cfefcbe9-9c05-40f8-9362-d4d63138d1f2` 성공.
- worker의 인증된 executor 요청은 HTTP 403, 기존 만료 RPC는 410이었다. 임시 `datastore.user`와 outcome `secretAccessor`는 실행 직후 회수했다. executor 호출 권한과 payer key 접근 권한은 부여하지 않았다.
- 새 후속 증거: `artifacts/runs/first-payment-reissue-2026-10-22/evidence.json`, `sha256:889e60ae932e1a383d05adadfeb60d3aa5952b428093b823cf90d98a70fbb873`.
- 새 검증 보고서: `artifacts/runs/first-payment-reissue-2026-10-22/verification-report.json`, `sha256:cdad85f57cdcbcde512f04075fad0accbb338afbee97582009f85d76aceb307c`. 서명 및 보존 검증 10개와 실시간 기존 정산 재검증이 통과했다.

검증 명령은 `pnpm evidence:verify-free-recovery`다. `-- --live` 대신 `pnpm evidence:verify-free-recovery --live`로 실행하면 기존 거래를 읽기 전용으로 재검증한다. 보고서는 표준 출력에만 쓰며 역사 파일을 수정하지 않는다.

구현 CI [39731050290](https://github.com/kwakhyun/uptime402-agentic-commerce/actions/runs/39731050290)의 maintenance와 Firestore emulator가 모두 통과했다. 기본 테스트 256개와 emulator 전용 14개, 고유 테스트 270개를 검증했다. 로컬 emulator는 시작 시간 초과가 발생해 정상 완료한 GitHub Actions의 동일 버전 emulator 결과를 기준으로 삼았다.

새 화면은 이 복구가 성공한 시점과 재발급 접근권의 별도 만료 시각을 함께 표시한다. 영구적인 RPC 접근권이나 현재 운영 서비스 전체의 정상 상태를 주장하지 않는다.
