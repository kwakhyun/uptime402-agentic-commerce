# Payment executor production environment

This service is the only process that may receive the existing low-balance
Devnet executor key. It refuses to listen until every required value validates,
the RPC reports the pinned Devnet genesis hash, and the mounted key matches the
pinned public key. Values that name key files are paths only; never place key
bytes in environment variables.

Required runtime variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Cloud Run listener port. |
| `FIRESTORE_PROJECT_ID` | Shared authoritative-state project, using ADC. |
| `FIRESTORE_COLLECTION_PREFIX` | Shared collection namespace. |
| `EXECUTOR_EXPECTED_AUDIENCE` | Exact HTTPS Cloud Run audience for Google ID tokens. |
| `CONTROL_PLANE_SERVICE_ACCOUNT` | Exact caller service-account email allowed to sign payments. |
| `OPERATOR_PRINCIPAL` | Comma-separated operator identities allowed to arm/revoke mandates. |
| `MANDATE_ISSUER_PRINCIPAL` | Issuer string required by deterministic policy. |
| `MANDATE_SIGNER_PUBLIC_KEY` | Pinned Ed25519 authority for mandate attestations. |
| `MANDATE_SIGNER_KEY_ID` | Pinned mandate attestation key ID. |
| `VENDOR_OFFER_SIGNER_PUBLIC_KEY` | Pinned vendor offer verification key. |
| `VENDOR_OFFER_SIGNER_KEY_ID` | Pinned vendor offer key ID. |
| `EXECUTOR_WALLET_KEYPAIR_PATH` | Absolute path to an existing Secret Manager-mounted Solana CLI keypair file available only here. |
| `EXECUTOR_WALLET_SECRET_ROOT` | Absolute service-specific mount root; resolved symlink targets cannot escape it. |
| `EXECUTOR_WALLET_PUBLIC_KEY` | Expected low-balance Devnet payer owner. |
| `SOLANA_RPC_URL` | HTTPS RPC checked against the full Devnet genesis hash. |
| `X402_FACILITATOR_URL` | Pinned HTTPS facilitator base URL, including any base path. |
| `ALLOWED_VENDOR_ORIGINS` | Comma-separated exact HTTPS origins allowed by SSRF policy. |
| `ESTIMATED_NETWORK_FEE_LAMPORTS` | Integer fee bound fed into the deterministic policy check. |
| `SOLANA_CLUSTER_LABEL` | Must be `devnet`. |
| `SOLANA_GENESIS_HASH` | Must be `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. |
| `X402_NETWORK_ID` | Must be `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`. |
| `X402_SDK_NETWORK_ID` | Must equal the same typed SDK network ID. |
| `USDC_MINT` | Must be Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. |
| `USDC_DECIMALS` | Must be `6`. |

Optional: `HOST` defaults to `0.0.0.0`; `FIRESTORE_DATABASE_ID` defaults to
`(default)`. `FIRESTORE_EMULATOR_HOST` is explicitly rejected by this
production entrypoint.

The guarantee is application-enforced policy plus low-balance blast-radius
isolation. This is not a cryptographic allowance and is not described as a
scoped wallet.

The production loader accepts Cloud Run's root-owned/read-only secret-file and
in-root symlink semantics. It bounds and validates the JSON bytes, pins the
derived public key, rejects writable or out-of-root targets, and zeroizes input
buffers. The stricter local 0600 non-symlink loader remains separate.
