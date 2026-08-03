# Vendor agent production environment

The vendor process refuses to listen until Firestore, the Devnet RPC, the live
facilitator `/supported` response, the two immutable signed offers, and the
existing receipt-signing key all validate. Secret values are never logged.

Required runtime variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Cloud Run listener port. |
| `FIRESTORE_PROJECT_ID` | Shared claim and recovery-resource project, using ADC. |
| `FIRESTORE_COLLECTION_PREFIX` | Collection namespace shared by all vendor instances. |
| `PUBLIC_VENDOR_ORIGIN` | Exact public HTTPS origin used by Agent Card and paid resource URLs. |
| `VENDOR_AGENT_ID` | Stable receipt issuer agent ID. |
| `VENDOR_AGENT_NAME` | Public Agent Card name. |
| `VENDOR_TENANT` | Stable namespace for atomic payment claims. |
| `VENDOR_OFFER_CATALOG_PATH` | Absolute path to a Secret Manager-mounted JSON catalog containing exactly two immutable signed offers. In-root managed symlink indirection is accepted. |
| `VENDOR_OFFER_CATALOG_ROOT` | Absolute service-specific catalog mount root; both the configured path and its resolved symlink target must remain inside it. |
| `VENDOR_OFFER_SIGNER_PUBLIC_KEY` | Pinned Ed25519 offer verification key. |
| `VENDOR_OFFER_SIGNER_KEY_ID` | Pinned offer key ID. |
| `VENDOR_RECEIPT_KEY_PATH` | Absolute path to the existing Secret Manager-mounted receipt-signing Solana CLI keypair; never the payee key. |
| `VENDOR_RECEIPT_SECRET_ROOT` | Absolute service-specific mount root; resolved symlink targets cannot escape it. |
| `VENDOR_RECEIPT_PUBLIC_KEY` | Expected receipt signer identity. |
| `VENDOR_RECEIPT_KEY_ID` | Receipt key ID. Must exactly match `VENDOR_OFFER_SIGNER_KEY_ID`; signed offers and fulfillment receipts share the single pinned vendor Agent Card authority. |
| `VENDOR_USDC_RECIPIENT` | Payee owner bound by both immutable offers; must differ from the payer. |
| `VENDOR_EXPECTED_PAYER_PUBLIC_KEY` | Public executor address pinned for independent reconciliation of an existing settlement; no signer material. Must differ from payee and vendor authority. |
| `VENDOR_RECONCILE_EXPECTED_AUDIENCE` | Exact Google-signed Cloud Run ID-token audience for `/v1/recovery/reconcile`; must equal `PUBLIC_VENDOR_ORIGIN`. |
| `VENDOR_RECONCILE_CONTROL_PLANE_PRINCIPAL` | The single control-plane service-account email allowed to invoke fulfillment reconciliation. |
| `SOLANA_RPC_URL` | HTTPS RPC checked against the full Devnet genesis hash. |
| `X402_FACILITATOR_URL` | Pinned HTTPS facilitator base URL, including any base path. |
| `X402_FACILITATOR_FEE_PAYER` | Deterministically pinned fee payer; startup confirms it in `/supported` and uses the official `ExactSvmScheme.enhancePaymentRequirements` path. |
| `X402_MAX_TIMEOUT_SECONDS` | Positive integer included in exact SVM requirements. |
| `SOLANA_CLUSTER_LABEL` | Must be `devnet`. |
| `SOLANA_GENESIS_HASH` | Must be `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. |
| `X402_NETWORK_ID` | Must be `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`. |
| `X402_SDK_NETWORK_ID` | Must equal the same typed SDK network ID. |
| `USDC_MINT` | Must be Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. |
| `USDC_DECIMALS` | Must be `6`. |

Optional: `HOST` defaults to `0.0.0.0`, `FIRESTORE_DATABASE_ID` defaults to
`(default)`, `VENDOR_AGENT_DESCRIPTION` has a non-sensitive default, and the
bounded settlement confirmation loop is configurable through
`SETTLEMENT_CONFIRMATION_ATTEMPTS` and `SETTLEMENT_CONFIRMATION_DELAY_MS`.
`FIRESTORE_EMULATOR_HOST` is rejected by this production entrypoint.

After confirmed settlement, the vendor atomically persists an actual
`firestore_recovery_route` resource. The control plane must consume that route
and independently prove the resulting health recovery before claiming success.
If settlement is already verified but fulfillment was interrupted, the
OIDC-protected `/v1/recovery/reconcile` route independently checks that existing
transaction on Solana and resumes only resource/receipt transitions. It never
accepts `PAYMENT-SIGNATURE` and never calls facilitator verify or settle.
