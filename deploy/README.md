# Cloud Run deployment contract

이 디렉터리는 실제 demo5 `capture` 배포에 사용한 세 서비스 계약과, 같은 증거를
hash-pin한 `final` revision으로 승격하는 절차를 함께 설명합니다. Capture 당시 raw
Cloud Run/IAM exports는 `artifacts/live-capture/`에 보존돼 있고, 현재 public control UI는
exact evidence/report hash를 고정한 `DEVNET VERIFIED` read-only final replay입니다.
Template 파일 존재만으로 live 증거가 되는 것은 아니며, 새 image build·final 배포·IAM
변경·Secret version 추가는 매번 승인된 GCP 범위와 fresh raw export로 다시 검증합니다.

현재 P0 경계는 다음과 같습니다.

| Service | Exposure | Service account | Secret mount |
| --- | --- | --- | --- |
| `control-plane` | UI/health 공개, mutation은 app auth 필요 | `uptime402-control@PROJECT_ID.iam.gserviceaccount.com` | control-plane outcome key + immutable demo-request config |
| `payment-executor` | Cloud Run IAM private | `uptime402-executor@PROJECT_ID.iam.gserviceaccount.com` | 기존 저잔액 Devnet executor key만 |
| `vendor-agent` | Agent Card/A2A/paid resource/health 공개 | `uptime402-vendor@PROJECT_ID.iam.gserviceaccount.com` | vendor receipt key + immutable signed offer catalog |

Offer catalog와 fulfillment receipt는 같은 Agent Card Ed25519 authority/key ID를
사용합니다. 그 vendor authority, control-plane outcome authority, payer, payee는
서로 달라야 합니다. Offer private key는 vendor runtime에 배포하지 않고, 이미
서명된 두-offer catalog만 version-pinned mount로 전달합니다.

## 파일과 로컬 검증

- `../cloudbuild.yaml`: 세 이미지를 build/push만 함. 배포/IAM/Secret 변경은 하지 않음.
- `*.service.yaml.tmpl`: 세 개의 독립 Cloud Run Knative v1 template.
- `render_cloudrun.py`: 런타임 필수 env와 template 정합성, distinct identities,
  exact origins/audience, numeric secret versions를 fail-closed 검증하고 렌더링.

Fresh clone에서 credential 없이 가능한 검증:

```bash
python3 deploy/render_cloudrun.py --check-templates
pnpm run build
```

실제 값 검증/렌더링은 `.env.example`을 ignored `.env.deploy`로 복사해 필요한
public config와 Secret Manager **이름/버전만** 채운 뒤 실행합니다. Private-key
bytes나 API key를 이 파일에 넣지 않습니다.

Control-plane evidence stage는 반드시 둘 중 하나입니다.

- `UPTIME402_UI_EVIDENCE_STAGE=capture`: 두 evidence hash를 비워 둡니다. Renderer는
  manifest에서 hash env 자체를 제거하고, UI는 bundled/stale artifact가 있어도 항상
  `LIVE UNVERIFIED` 상태만 선택합니다.
- `UPTIME402_UI_EVIDENCE_STAGE=final`: 실제 검증이 끝난
  `artifacts/payment-evidence.json`과 `artifacts/verification-report.json` 각각의 exact
  `sha256:<lowercase hex>`를 설정해야 합니다. 하나라도 없거나 bytes가 달라지면 UI
  request가 fail closed하며 local/capture 화면으로 fallback하지 않습니다.

```bash
python3 deploy/render_cloudrun.py --env-file .env.deploy
python3 deploy/render_cloudrun.py \
  --env-file .env.deploy \
  --output-dir /private/tmp/uptime402-cloudrun
```

두 번째 명령의 출력은 검토용 임시 manifest입니다. 실제 배포 후에는 Cloud Run이
내보낸 raw service description이 증거의 기준입니다.

## 승인 후 GCP 준비

필요 API: Cloud Run, Artifact Registry, Cloud Build, Firestore, Secret Manager,
Vertex AI, 검증용 Cloud Asset Inventory. 세 service account를 별도로 만들고 세 계정 모두에 shared Firestore를
사용할 최소 `roles/datastore.user`를 부여합니다. Vertex 경로를 쓰면 control-plane
계정만 `roles/aiplatform.user`를 가집니다. Deployer에는 세 service account에 대한
`iam.serviceAccounts.actAs`가 필요합니다.

Artifact Registry repository는 `ARTIFACT_REPOSITORY`와 같은 region에 만들고,
build identity에는 그 repository의 writer만 부여합니다. 이미지는 mutable
`latest`가 아니라 현재 commit/build의 lowercase hexadecimal ID로 고정합니다.

```bash
gcloud builds submit \
  --config cloudbuild.yaml \
  --substitutions=_REGION=asia-northeast3,_REPOSITORY=uptime402,_IMAGE_TAG=GIT_COMMIT_HEX \
  .
```

현재 final images는 Git SHA `10ca5f2ccaf2af45e2d80f6065de9c623b24e559`로 build됐습니다.
Cloud Build `793d0ada-8859-4ed6-b2ad-bf3a5fd13ee3`은 `SUCCESS`이며 control/executor/vendor
digest는 각각 `sha256:1f9313ae…53db`, `sha256:766bed6a…50ad`,
`sha256:cc249b8f…f694`입니다. 후속 build도 audited commit의 actual
`GIT_COMMIT_HEX`와 renderer `IMAGE_TAG`를 일치시켜야 합니다.

## Secret Manager 계약

키를 새로 만들지 않습니다. 사용자가 이미 소유하거나 검토한 다음 여섯 파일만 각자 다른
Secret Manager secret의 새 버전으로 올립니다.

1. 기존 저잔액 Devnet executor Solana CLI keypair → executor service account만
   `secretAccessor`.
2. 기존 vendor Agent Card/receipt Solana CLI keypair → vendor service account만
   `secretAccessor`.
3. 기존 control-plane recovery-outcome Solana CLI keypair → control-plane service
   account만 `secretAccessor`.
4. 정확히 두 immutable signed offer를 담은 public JSON catalog → vendor service
   account만 `secretAccessor` (confidential secret가 아니라 immutable mount 용도).
5. operator가 검토한 exact incident-run JSON → control-plane service account만
   `secretAccessor` (credential이 아니라 browser에서 변경할 수 없는 immutable config mount).
6. operator가 기존 key로 서명한 exact demo mandate JSON → control-plane service account만
   `secretAccessor` (capture revision의 동일 Google OIDC callback이 audited arm route를 먼저
   호출할 때만 사용하며 signing key는 control-plane에 제공하지 않음).

각 manifest는 Secret Manager의 **숫자 버전**을 mount합니다. `latest`는 금지합니다.
Secret 내용은 chat, env, Git, Cloud Build args, manifest, 로그에 넣지 않습니다.
Secret 이름과 숫자 버전만 `.env.deploy`에 기록합니다. Cloud Run secret volume과
version pin 문법은 [Google Cloud 공식 문서](https://cloud.google.com/run/docs/configuring/services/secrets)를 따릅니다.

Vendor offer catalog loader는 `VENDOR_OFFER_CATALOG_ROOT`의 resolved mount root 안에
최종 target이 남는 Cloud Run형 version symlink chain만 허용합니다. Configured parent나
resolved target이 root를 벗어나거나, leaf가 다시 symlink이거나, regular file이 아니거나,
비어 있거나 256 KiB를 넘거나 read 중 크기가 바뀌면 startup을 거절합니다.

Vendor catalog는 다음 live 값에 서명되어야 하므로 service URL 결정 전 fixture를
복사해 만들면 안 됩니다.

- `providerAgentUrl = ${PUBLIC_VENDOR_ORIGIN}/a2a`
- `resourceUrl = ${PUBLIC_VENDOR_ORIGIN}/v1/recovery`
- pinned Agent Card hash + vendor authority/key ID
- Devnet CAIP-2, Devnet USDC mint, distinct `VENDOR_USDC_RECIPIENT`
- integer amount base units, unexpired expiry, canonical offer hash/signature
- P0 `20000` base-unit cap을 사이에 둔 두 가격: primary telemetry가 선택할
  `≤20000` offer와 over-cap counterfactual telemetry가 선택할 `>20000` offer

저장소의 `pnpm offers:sign`은 기존 owner-only vendor key, pinned public key/key ID,
unsigned two-offer input만 받아 exact Agent Card hash를 계산하고 schema v2 catalog를
exclusive-create합니다. `scripts/mandate-sign.ts`도 기존 operator key만 사용합니다.
두 command 모두 key를 생성하거나 출력하지 않습니다. 실제 signed catalog와
operator-signed mandate attestation이 제공되기 전에는 live path를 배포 완료라고
부를 수 없습니다.

### Mission-control one-click operator trigger

`CONTROL_PLANE_UI_LIVE_TRIGGER_ENABLED`는 로컬에서 기본 `false`이고 배포 template에서
`true`입니다. `final` evidence stage의 public root는 이 설정이 있어도 operator login과
live trigger를 렌더링하지 않고 read-only replay만 기본으로 제공합니다. 보호된 route는
capture/운영 audit를 위해 남지만 same-origin + Google OIDC 검사를 계속 적용합니다.
Google Identity Services용 OAuth **Web** client ID를
`CONTROL_PLANE_UI_GOOGLE_CLIENT_ID`와 `CONTROL_PLANE_OPERATOR_AUDIENCE`에 같은 값으로
넣고, OAuth client의 Authorized JavaScript origin을 exact `CONTROL_PLANE_ORIGIN`으로
등록합니다. OAuth client ID는 공개 식별자이며 client secret을 생성하거나 UI에
전달하지 않습니다. 설정 기준은 [Google GIS button 문서](https://developers.google.com/identity/gsi/web/guides/display-button)와
[server-side ID token verification 문서](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)입니다.

`CONTROL_PLANE_DEMO_REQUEST_SECRET_NAME`의 숫자 버전에는 CLI의
`INCIDENT_RUN_REQUEST_PATH`와 같은 strict `schemaVersion: "1"` request를 넣습니다.
Cloud Run은 이를 `/var/run/config/uptime402/demo-request/request.json`에 read-only로
mount합니다. Loader는 realpath가 mount root 안에 남는 numeric-version symlink만
허용하고, 512 KiB 이하 regular file, owner-readable, group/other non-writable,
duplicate-key-free UTF-8 JSON을 강제합니다. Browser POST는 body와 content type을
거부하므로 money/policy/recipient/nonce는 UI에서 변경할 수 없습니다.

GIS popup callback이 받은 ID token은 React state/ref, cookie, local/session storage,
로그에 저장하지 않고 같은-origin Authorization header 한 번에만 사용합니다. Route는
exact origin과 optional Fetch Metadata를 확인한 뒤 기존 exact-audience/verified-email/
principal allowlist를 적용합니다. Fresh response도 raw result 전체가 아니라 reduced
event projection이며 항상 `LIVE UNVERIFIED`입니다. Evidence promotion 전에는 이
응답의 transaction 여부를 Devnet confirmation, Explorer, token delta 또는 verified
receipt로 주장하지 않습니다.

## 세 service URL bootstrap

Cloud Run ID-token audience는 호출 대상 service의 정확한 `*.run.app` URL이어야
합니다. Custom domain을 audience로 사용하지 않습니다. 공식 service-to-service
절차는 [Cloud Run authentication 문서](https://cloud.google.com/run/docs/authenticating/service-to-service)를 따릅니다.

최초 URL이 아직 없으면, 승인 후 다음 순서로 bootstrap합니다.

1. 세 service account와 build image를 준비합니다.
2. 세 service name을 **모두 unauthenticated 비활성** 상태로 임시 생성해 URL만
   할당합니다. 임시 revision은 제출/배포 증거가 아닙니다.
3. `gcloud run services describe SERVICE --region REGION --format='value(status.url)'`
   로 세 URL을 읽습니다.
4. URL을 `CONTROL_PLANE_ORIGIN`, `VENDOR_AGENT_ORIGIN`/`PUBLIC_VENDOR_ORIGIN`,
   `PAYMENT_EXECUTOR_ORIGIN`/`EXECUTOR_EXPECTED_AUDIENCE`에 넣습니다.
5. 실제 vendor URL에 bound된 signed catalog를 준비하고 version-pinned secrets를
   구성한 뒤 renderer와 final manifests를 적용합니다.

Bootstrap 때 control-plane image를 세 이름에 임시로 사용해도 되지만 전부 private로
유지하고, final role image/identity/env/secret가 적용되기 전에는 endpoint를 공개하거나
evidence로 저장하지 않습니다.

## Capture → final 두 단계 적용

첫 배포는 `.env.deploy`에 다음 값을 사용합니다.

```dotenv
UPTIME402_UI_EVIDENCE_STAGE=capture
UPTIME402_UI_EVIDENCE_SHA256=
UPTIME402_UI_VERIFICATION_REPORT_SHA256=
```

이 capture manifest에는 두 hash env가 포함되지 않습니다. 로그아웃 UI와 operator
실행 결과는 `LIVE UNVERIFIED`이며, 이 revision은 Devnet verified evidence가 아닙니다.
Capture에서 실제 실행 artifact를 수집하고 `pnpm run evidence:verify`가 fresh
`verification-report.json`을 만든 뒤 두 파일의 exact bytes를 SHA-256으로 계산합니다.

```bash
shasum -a 256 artifacts/payment-evidence.json
shasum -a 256 artifacts/verification-report.json
```

그 다음 **새 immutable image tag**로 control-plane image를 다시 build하여 두 artifact를
image에 고정하고 `.env.deploy`을 `final`과 두 `sha256:` 값으로 바꿔 재렌더링합니다.
Final loader는 configured evidence hash, configured report hash, report 안의
`evidenceSha256`, report의 모든 verification check를 함께 검사합니다. Final revision을
로그아웃 세션에서 다시 확인하기 전에는 `VERIFIED`로 승격하지 않습니다.

현재 final 배포는 evidence SHA-256
`sha256:0a7bfbb00b07ad29d0a74a4d28e5f8d443c94e6bd5034eeb6b7463463b332df4`와 report SHA-256
`sha256:b147e7cfe2c71fee903f4052ca342d8266343694e48843ae017c8e55ae42cd3e`를 pin했습니다.
Ready revisions are control `uptime402-control-plane-00015-sqw`, executor
`uptime402-payment-executor-00012-2dg`, vendor `uptime402-vendor-agent-00011-88p`, all at
100% traffic. Logged-out desktop/mobile, evidence drawer, unauthenticated mutation/executor
`403`, IAM/Secret boundaries, and zero recent ERROR logs were checked without another payment.

## Manifest 적용과 IAM

렌더링한 세 manifest를 각각 적용합니다.

```bash
gcloud run services replace /private/tmp/uptime402-cloudrun/control-plane.service.yaml --region REGION
gcloud run services replace /private/tmp/uptime402-cloudrun/payment-executor.service.yaml --region REGION
gcloud run services replace /private/tmp/uptime402-cloudrun/vendor-agent.service.yaml --region REGION
```

서비스가 Ready가 된 뒤 IAM을 다음 exact boundary로 설정합니다.

- control-plane: `allUsers roles/run.invoker`.
- vendor-agent: `allUsers roles/run.invoker`.
- payment-executor: `serviceAccount:CONTROL_PLANE_SERVICE_ACCOUNT`만
  `roles/run.invoker`; `allUsers`/`allAuthenticatedUsers` 금지.
- executor signer secret: 세 runtime identity 중 executor만 `secretAccessor`.
- vendor receipt/catalog secrets: vendor만 `secretAccessor`.
- control outcome/demo-request config: control-plane만 `secretAccessor`.

승인된 project에서 placeholder를 실제 값으로 바꿔 적용·감사하는 최소 명령 형태는
다음과 같습니다. Capture IAM은 적용되어 raw export로 검증됐고 final revision에서도
effective IAM과 unauthenticated executor `403`을 다시 확인했습니다.

```bash
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member=serviceAccount:CONTROL_PLANE_SERVICE_ACCOUNT \
  --role=roles/datastore.user
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member=serviceAccount:EXECUTOR_SERVICE_ACCOUNT \
  --role=roles/datastore.user
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member=serviceAccount:VENDOR_SERVICE_ACCOUNT \
  --role=roles/datastore.user
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member=serviceAccount:CONTROL_PLANE_SERVICE_ACCOUNT \
  --role=roles/aiplatform.user

gcloud secrets add-iam-policy-binding EXECUTOR_SIGNER_SECRET_NAME \
  --project=PROJECT_ID \
  --member=serviceAccount:EXECUTOR_SERVICE_ACCOUNT \
  --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding VENDOR_RECEIPT_SECRET_NAME \
  --project=PROJECT_ID \
  --member=serviceAccount:VENDOR_SERVICE_ACCOUNT \
  --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding VENDOR_OFFER_CATALOG_SECRET_NAME \
  --project=PROJECT_ID \
  --member=serviceAccount:VENDOR_SERVICE_ACCOUNT \
  --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding CONTROL_PLANE_OUTCOME_SECRET_NAME \
  --project=PROJECT_ID \
  --member=serviceAccount:CONTROL_PLANE_SERVICE_ACCOUNT \
  --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding CONTROL_PLANE_DEMO_REQUEST_SECRET_NAME \
  --project=PROJECT_ID \
  --member=serviceAccount:CONTROL_PLANE_SERVICE_ACCOUNT \
  --role=roles/secretmanager.secretAccessor

gcloud run services add-iam-policy-binding CONTROL_PLANE_SERVICE_NAME \
  --project=PROJECT_ID --region=REGION \
  --member=allUsers --role=roles/run.invoker
gcloud run services add-iam-policy-binding VENDOR_AGENT_SERVICE_NAME \
  --project=PROJECT_ID --region=REGION \
  --member=allUsers --role=roles/run.invoker
gcloud run services add-iam-policy-binding PAYMENT_EXECUTOR_SERVICE_NAME \
  --project=PROJECT_ID --region=REGION \
  --member=serviceAccount:CONTROL_PLANE_SERVICE_ACCOUNT \
  --role=roles/run.invoker
```

Inherited/project-level invoker나 secret access까지 포함해 예상 밖 principal이 없는지
반드시 audit합니다. Manifest는 IAM policy를 설정하지 않으므로 이 단계는 별도입니다.

Control-plane은 ADC로 executor URL을 audience로 한 Google-signed ID token을 발급해
호출합니다. Executor application도 `EXECUTOR_EXPECTED_AUDIENCE`와
`CONTROL_PLANE_SERVICE_ACCOUNT`를 다시 검사합니다.

### Operator-authenticated mandate 및 one-shot incident

Final executor Run IAM을 control-plane identity 하나로 제한하므로 executor가 보는
caller principal은 control-plane service account입니다. Manifest는
`OPERATOR_PRINCIPAL=CONTROL_PLANE_SERVICE_ACCOUNT`로 렌더링됩니다. 사람의
Google-signed OIDC token은 control-plane의 protected arm/revoke/incident routes에서
exact audience, verified email, principal allowlist로 검증된 뒤 폐기되고, proxy가
executor audience용 control-plane service-account ID token을 새로 발급합니다.

`CONTROL_PLANE_DEMO_RUN_SLOT`은 Firestore transaction으로 한 번만 claim됩니다. primary
recovery 뒤 configured over-cap request와 nonce-replay request를 같은 action 안에서
순서대로 자동 실행합니다. Server-owned config와 selected signed offer를 preflight해
primary amount `≤20000`, over-cap amount `>20000`을 강제하고 각각
`amount.per_transaction_limit`, `identifier.nonce_fresh`,
`transactionCreated:false`, `txSignature:null`을 요구합니다. 하나라도 다르면 slot은
자동 retry하지 않고 `failed_locked`로 남기므로 수동 reconcile 뒤에만 새 slot을
사용합니다.

이 구조는 로컬 suite와 demo5의 live OIDC/IAM/operator capture에서 검증됐습니다. Final
revision은 prior successful OAuth capture와 동일한 audience/client ID를 사용하고, public
read-only root에서 로그인/trigger를 숨기며 unauthenticated mutation을 `403`으로 거절합니다.
새 payment를 피하기 위해 authenticated incident mutation은 반복하지 않았습니다. 별도 admin service가 아니므로 문구는
**application-role/proxied separation**으로 제한하며 hard admin/executor separation을
주장하지 않습니다. Executor IAM에 human principal을 추가해 이 경계를 우회하면 안
됩니다.

## Firestore 및 recovery probe

세 서비스는 같은 `FIRESTORE_PROJECT_ID`, `FIRESTORE_DATABASE_ID`,
`FIRESTORE_COLLECTION_PREFIX`를 사용합니다. Production entrypoint는
`FIRESTORE_EMULATOR_HOST`가 있으면 시작을 거부합니다. Emulator 검증은 로컬 test
evidence이고 managed Firestore 증거가 아닙니다.

Control-plane은 paid `firestore_recovery_route`를 shared Firestore에 적용한 뒤
`CONTROL_PLANE_ORIGIN/api/dependency-health`를 pinned HTTPS fetch로 다시 호출합니다.
이 별도 route는 Firestore를 독립적으로 다시 읽어 canonical hash, incident,
activation ID, active state, TTL을 검사하고 다음 구조를 반환합니다.

```json
{"status":"healthy","routeActivationId":"the-applied-activation-id","details":{}}
```

Renderer는 `RECOVERY_HEALTH_PROBE_URL`이 정확히 이 control-plane URL인지 검사합니다.
로컬 mutation/missing/expired tests와 demo5 managed-Firestore capture의 probe가
통과했습니다. Final Cloud Run revision에서는 같은 evidence replay/UI binding을
로그아웃 상태로 다시 확인했습니다. 이 probe는 paid route activation 회복을 증명하며 외부 Solana RPC
자체의 성능 개선으로 과장하지 않습니다.

## 배포 후 증거 수집

아래 raw 출력은 final service가 Ready인 뒤에만 `artifacts/final-deployment/`에 저장합니다.
Handwritten summary나 template은 live evidence가 아닙니다.

```bash
gcloud run services describe SERVICE --region REGION --format=json
gcloud run services describe SERVICE --region REGION --format=export
gcloud run services get-iam-policy SERVICE --region REGION --format=json
gcloud projects get-iam-policy PROJECT_ID --format=json
gcloud asset get-effective-iam-policy \
  --scope=projects/PROJECT_ID \
  --names=//run.googleapis.com/projects/PROJECT_ID/locations/REGION/services/PAYMENT_EXECUTOR_SERVICE_NAME,//secretmanager.googleapis.com/projects/PROJECT_ID/secrets/EXECUTOR_SIGNER_SECRET_NAME \
  --format=json
gcloud secrets get-iam-policy EXECUTOR_SIGNER_SECRET --format=json
gcloud secrets get-iam-policy VENDOR_RECEIPT_SECRET --format=json
gcloud secrets get-iam-policy CONTROL_OUTCOME_SECRET --format=json
gcloud secrets get-iam-policy CONTROL_PLANE_DEMO_REQUEST_SECRET_NAME --format=json
```

세 raw JSON description에는 Knative Service metadata, generation/
observedGeneration, Ready condition, revision, URL, service account가 있어야 합니다.
각 exact byte file을 SHA-256 hash-bind합니다. Executor URL을 credential 없이 호출해
401/403인지, control-plane만 invoker인지, executor signer secret을 세 identity 중
executor만 읽는지 확인합니다. Project IAM raw export도 별도로 hash-bind하며 project
level `roles/run.invoker`/`roles/secretmanager.secretAccessor`와 runtime identity의
`roles/owner`/`roles/editor`가 있으면 promotion을 거절합니다. 공개 검증은
control-plane `/api/health`, vendor
`/health`, vendor `/.well-known/agent-card.json`도 포함합니다.

Cloud Asset 명령은 exact executor/secret resource의 ancestor policy까지 포함한 effective
allow policy를 보여 주므로 unexpected principal, custom role, conditional binding을 final
human IAM audit에서 확인합니다. 필요한 permission과 full resource name 형식은
[Google Cloud 공식 effective IAM 문서](https://docs.cloud.google.com/sdk/gcloud/reference/asset/get-effective-iam-policy)를 기준으로 합니다. 이 출력은 raw
service/project/secret IAM artifact를 대체하지 않고 보완합니다.

최종적으로 로그아웃 브라우저 UI, 실제 A2A, managed Firestore, live Gemini,
standard x402 Devnet payment, signed receipt/outcome, route-aware health recovery가 모두
일치해야 `deployment=live` 또는 `evidence=devnet`으로 승격할 수 있습니다.

`artifacts/payment-evidence.json` 승격과 `evidence:verify`가 끝난 뒤에는 두 artifact의
exact byte hash를 각각 `UPTIME402_UI_EVIDENCE_SHA256`과
`UPTIME402_UI_VERIFICATION_REPORT_SHA256`에 넣고 control-plane image를 새 immutable
tag로 다시 build/deploy합니다. UI adapter는 image 안 evidence와 verification report,
두 configured hash, report의 evidence binding이 모두 일치하지 않으면 Devnet evidence를
표시하지 않습니다. 이 최종 revision을 로그아웃 세션에서 다시 확인해야 합니다.
