#!/usr/bin/env python3

from __future__ import annotations

import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from check_finalist_readiness import (
    OFFICIAL_DEVNET_USDC_MINT,
    canonical_json,
    canonical_resource_url,
    check_attestations,
    check_denials,
    check_payment_shape,
    check_rpc_topology,
    check_secret_contents,
    check_secret_filenames,
    check_signed_commerce_evidence,
    check_submission_assets,
    file_digest,
    result,
    rpc_url_metadata,
    run_checks,
    sha256_value,
    verify_ed25519,
)


SIGNATURE = "3" * 88
PAYER = "7YttLkHDoVNGbLQhoY4vKQ9X4U4sQ8J1WXKf5tQdQmQm"
PAYEE = "8YttLkHDoVNGbLQhoY4vKQ9X4U4sQ8J1WXKf5tQdQmQn"
NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
HASH = "sha256:" + "a" * 64


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def base58_encode(raw: bytes) -> str:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number = int.from_bytes(raw, "big")
    encoded = ""
    while number:
        number, remainder = divmod(number, 58)
        encoded = alphabet[remainder] + encoded
    zeros = len(raw) - len(raw.lstrip(b"\0"))
    return "1" * zeros + (encoded or ("" if zeros else "1"))


def evidence_payload() -> dict[str, object]:
    return {
        "schemaVersion": "2.0",
        "generatedAt": "2026-08-02T00:00:00Z",
        "project": {},
        "attestations": {},
        "payments": [
            {
                "incidentId": "inc_1",
                "incidentAt": "2026-08-02T00:00:00Z",
                "mandateId": "mandate_1",
                "paymentId": "payment_1",
                "offerId": "offer_1",
                "idempotencyKey": "inc_1:offer_1:v1",
                "network": NETWORK,
                "cluster": "devnet",
                "asset": "USDC",
                "assetMint": OFFICIAL_DEVNET_USDC_MINT,
                "decimals": 6,
                "amount": "0.001",
                "amountBaseUnits": "1000",
                "payer": PAYER,
                "payee": PAYEE,
                "txSignature": SIGNATURE,
                "explorerUrl": f"https://explorer.solana.com/tx/{SIGNATURE}?cluster=devnet",
                "confirmationStatus": "confirmed",
                "confirmedAt": "2026-08-02T00:00:05Z",
                "resourceResponseHash": HASH,
                "executionPolicyHash": HASH,
                "challengeHash": HASH,
                "requestFingerprint": HASH,
                "x402": {},
                "outcome": {},
                "fulfillmentReceipt": {},
                "fulfillmentReceiptHash": HASH,
            }
        ],
        "denials": [
            {"reasonCode": "amount.per_transaction_limit"},
            {
                "reasonCode": "identifier.nonce_fresh",
                "replayProof": {"identifierType": "nonce"},
            },
        ],
    }


def structural_fixture(root: Path) -> None:
    write(
        root / "README.md",
        """# Uptime402
Run instructions and test commands for Solana Devnet USDC x402 on Cloud Run.
Security and transaction verification use an Explorer signature.
""",
    )
    write(root / ".env.example", "GEMINI_API_KEY=\nSOLANA_PRIVATE_KEY=\n")
    write(
        root / "package.json",
        json.dumps(
            {
                "scripts": {
                    "build": "node scripts/build.mjs",
                    "test": "node scripts/test.mjs",
                    "lint": "node scripts/lint.mjs",
                    "typecheck": "node scripts/typecheck.mjs",
                    "evidence:verify": "node scripts/evidence-verify.mjs",
                }
            }
        ),
    )
    write(root / "package-lock.json", "{}\n")
    write(root / "Dockerfile", "FROM node:22\nCOPY . .\nCMD [\"node\", \"server.js\"]\n")
    for name in ("BUILD_STATUS.md", "ARCHITECTURE.md", "DEMO_SCRIPT.md", "SUBMISSION_DECK.md"):
        write(root / "docs" / name, f"# {name}\n")
    write(root / "artifacts/payment-evidence.json", json.dumps(evidence_payload()))


class ReadinessTests(unittest.TestCase):
    def test_denial_gate_requires_over_cap_and_nonce_replay(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            original = {
                "incidentId": "incident-paid",
                "mandateId": "mandate-1",
                "paymentId": "payment-paid",
                "nonce": "nonce-paid",
                "idempotencyKey": "reservation-paid",
                "amountBaseUnits": "18000",
                "txSignature": SIGNATURE,
                "explorerUrl": f"https://explorer.solana.com/tx/{SIGNATURE}?cluster=devnet",
            }
            over_cap = {
                "incidentId": "incident-over-cap",
                "mandateId": "mandate-1",
                "reasonCode": "amount.per_transaction_limit",
                "attemptedAt": "2026-08-03T00:00:10Z",
                "attemptedAmountBaseUnits": "21000",
                "perTransactionLimitBaseUnits": "20000",
                "executionPolicyHash": HASH,
                "transactionCreated": False,
                "txSignature": None,
                "artifactPath": "artifacts/over-cap.json",
            }
            replay = {
                "incidentId": "incident-replay",
                "mandateId": "mandate-1",
                "reasonCode": "identifier.nonce_fresh",
                "attemptedAt": "2026-08-03T00:00:11Z",
                "attemptedAmountBaseUnits": "18000",
                "perTransactionLimitBaseUnits": "20000",
                "executionPolicyHash": HASH,
                "transactionCreated": False,
                "txSignature": None,
                "replayProof": {
                    "identifierType": "nonce",
                    "identifierValue": "nonce-paid",
                    "originalPaymentId": "payment-paid",
                    "deniedPaymentId": "payment-replay",
                    "originalIncidentId": "incident-paid",
                    "deniedIncidentId": "incident-replay",
                    "originalNonce": "nonce-paid",
                    "deniedNonce": "nonce-paid",
                    "originalIdempotencyKey": "reservation-paid",
                    "deniedIdempotencyKey": "reservation-replay",
                    "originalTxSignature": SIGNATURE,
                    "originalExplorerUrl": original["explorerUrl"],
                },
                "artifactPath": "artifacts/replay.json",
            }
            for denial in (over_cap, replay):
                artifact = {
                    key: denial.get(key)
                    for key in (
                        "incidentId",
                        "reasonCode",
                        "transactionCreated",
                        "executionPolicyHash",
                        "replayProof",
                    )
                }
                path = root / str(denial["artifactPath"])
                write(path, json.dumps(artifact, sort_keys=True, separators=(",", ":")))
                denial["artifactSha256"] = file_digest(path)
            payload = {"payments": [original], "denials": [over_cap, replay]}
            results = check_denials(root, payload)
            self.assertIn(
                "evidence.denial",
                {item.code for item in results if item.level == "PASS"},
            )

            payload["denials"] = [over_cap]
            results = check_denials(root, payload)
            self.assertIn(
                "evidence.denial.count",
                {item.code for item in results if item.level == "FAIL"},
            )

    def test_ed25519_verifier_matches_rfc8032_vector(self) -> None:
        public_key = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        signature = bytes.fromhex(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
            "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        )
        self.assertTrue(verify_ed25519(base58_encode(public_key), base58_encode(signature), b""))
        self.assertFalse(verify_ed25519(base58_encode(public_key), base58_encode(signature), b"mutated"))

    def test_structural_mode_never_calls_live_rpc_or_claims_live_truth(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            structural_fixture(root)
            with mock.patch(
                "check_finalist_readiness.rpc_call",
                side_effect=AssertionError("structural mode must not call RPC"),
            ):
                results = run_checks(root)
            codes = {item.code for item in results}
            self.assertIn("mode.structural", codes)
            self.assertIn("submission.not_run", codes)
            self.assertNotIn("mode.submission", codes)
            self.assertEqual([], [item for item in results if item.level in {"FAIL", "WARN"}])

    def test_invalid_caip_amount_and_signature_fail_shape(self) -> None:
        payload = evidence_payload()
        payment = payload["payments"][0]
        payment["network"] = "solana-devnet"
        payment["amountBaseUnits"] = "999"
        payment["txSignature"] = "not-a-solana-signature"
        failure_codes = {item.code for item in check_payment_shape(payload) if item.level == "FAIL"}
        self.assertIn("evidence.payment[0].network", failure_codes)
        self.assertIn("evidence.payment[0].amount", failure_codes)
        self.assertIn("evidence.payment[0].signature", failure_codes)

    def test_rpc_metadata_rejects_loopback_and_http_but_allows_official_devnet(self) -> None:
        for value in ("http://127.0.0.1:8899", "http://api.devnet.solana.com"):
            parsed, error = rpc_url_metadata(value, from_env=False)
            self.assertIsNone(parsed)
            self.assertIsNotNone(error)

        parsed, error = rpc_url_metadata("https://api.devnet.solana.com", from_env=False)
        self.assertIsNotNone(parsed)
        self.assertIsNone(error)
        topology = check_rpc_topology(
            "https://api.devnet.solana.com",
            primary_from_env=False,
            secondary=None,
        )
        self.assertEqual([], [item for item in topology if item.level == "FAIL"])
        self.assertIn("rpc.topology", {item.code for item in topology if item.level == "PASS"})

    def test_resource_url_rejects_credentials_fragments_and_noncanonical_query(self) -> None:
        self.assertEqual(
            "https://vendor.run.app/recover?a=1&b=2",
            canonical_resource_url("https://vendor.run.app/recover?a=1&b=2"),
        )
        for value in (
            "https://user:pass@vendor.run.app/recover",
            "https://vendor.run.app/recover#paid",
            "https://vendor.run.app:443/recover",
            "https://VENDOR.run.app/recover",
            "https://vendor.run.app/a/../recover",
            "https://vendor.run.app/recover?b=2&a=1",
            "https://vendor.run.app/recover?a=1&a=2",
            "https://127.0.0.1/recover",
            "https://2130706433/recover",
            "https://0x7f000001/recover",
            "https://0177.0.0.1/recover",
            "https://metadata.google.internal/computeMetadata/v1/",
            "https://ｌｏｃａｌｈｏｓｔ/recover",
            "https://ⓛⓞⓒⓐⓛⓗⓞⓢⓣ/recover",
            "https://ℓocalhost/recover",
            "https://ⓜetadata.google.internal/computeMetadata/v1/",
        ):
            self.assertIsNone(canonical_resource_url(value), value)

    def test_secret_like_keypair_file_is_a_submission_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write(root / "wallet-keypair.json", json.dumps(list(range(64))))
            filename_results = check_secret_filenames(root, submission=True)
            content_results = check_secret_contents(root, submission=True)
            self.assertIn("security.secret_files", {item.code for item in filename_results if item.level == "FAIL"})
            self.assertIn("security.secret_content", {item.code for item in content_results if item.level == "FAIL"})

    def test_pem_parser_markers_are_safe_but_real_and_escaped_bodies_fail(self) -> None:
        begin = "-----BEGIN " + "PRIVATE KEY-----"
        end = "-----END " + "PRIVATE KEY-----"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parser_chunk = root / ".next/server/chunks/parser.js"
            write(
                parser_chunk,
                f"const keyPattern = /(?<key>{begin}.*?{end})/s;\n",
            )
            safe_results = check_secret_contents(root, submission=True)
            self.assertIn(
                "security.secret_content",
                {item.code for item in safe_results if item.level == "PASS"},
            )

            # RFC 8410-shaped Ed25519 PKCS#8 DER with a deterministic throwaway
            # seed; it exists only in this temporary directory during the test.
            private_key_der = bytes.fromhex("302e020100300506032b657004220420") + bytes(range(32))
            payload = base64.b64encode(private_key_der).decode("ascii")
            for filename, newline in (("raw.js", "\n"), ("escaped.js", r"\n")):
                with self.subTest(filename=filename):
                    write(
                        root / ".next/server/chunks" / filename,
                        f'const leaked = "{begin}{newline}{payload}{newline}{end}";\n',
                    )
                    failure_results = check_secret_contents(root, submission=True)
                    self.assertIn(
                        "security.secret_content",
                        {item.code for item in failure_results if item.level == "FAIL"},
                    )
                    (root / ".next/server/chunks" / filename).unlink()

    def test_submission_requires_explicit_repo_script_opt_in(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            structural_fixture(root)
            results = run_checks(root, submission=True, run_repo_scripts=False)
            self.assertIn("commands.opt_in", {item.code for item in results if item.level == "FAIL"})

    def test_counterfactual_must_change_verified_offer_selection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agent_card_hash = HASH
            offers = []
            for index in (1, 2):
                offers.append(
                    {
                        "payload": {
                            "offerId": f"offer_{index}",
                            "providerAgentId": "vendor_1",
                            "providerAgentCardUrl": "https://vendor.run.app/.well-known/agent-card.json",
                            "providerAgentCardHash": agent_card_hash,
                            "resourceUrl": f"https://vendor.run.app/recover/{index}",
                            "network": NETWORK,
                            "asset": "USDC",
                            "assetMint": OFFICIAL_DEVNET_USDC_MINT,
                            "amountBaseUnits": str(index * 1000),
                            "payee": PAYEE,
                            "expiresAt": "2026-08-02T00:10:00Z",
                        },
                        "signer": PAYER,
                        "keyId": "did:web:vendor.run.app#receipt-1",
                        "signature": SIGNATURE,
                    }
                )
            selection = {
                "candidateOfferIds": ["offer_1", "offer_2"],
                "baseline": {
                    "telemetryHash": "sha256:" + "1" * 64,
                    "modelOutputHash": "sha256:" + "2" * 64,
                    "selectedOfferId": "offer_1",
                    "schemaValidated": True,
                    "capturedAt": "2026-08-02T00:00:01Z",
                },
                "counterfactual": {
                    "telemetryHash": "sha256:" + "3" * 64,
                    "modelOutputHash": "sha256:" + "4" * 64,
                    "selectedOfferId": "offer_2",
                    "schemaValidated": True,
                    "capturedAt": "2026-08-02T00:00:02Z",
                },
                "artifactPath": "artifacts/selection.json",
            }
            artifact = {key: selection[key] for key in ("candidateOfferIds", "baseline", "counterfactual")}
            write(root / "artifacts/selection.json", json.dumps(artifact, sort_keys=True, separators=(",", ":")))
            selection["artifactSha256"] = file_digest(root / "artifacts/selection.json")
            payload = {
                "offers": offers,
                "selection": selection,
                "payments": [],
                "attestations": {
                    "a2a": {
                        "verificationPublicKey": PAYER,
                        "verificationKeyId": "did:web:vendor.run.app#receipt-1",
                        "agentCardHash": agent_card_hash,
                        "runtimeArtifactSha256": agent_card_hash,
                    }
                },
            }
            with mock.patch("check_finalist_readiness.verify_ed25519", return_value=True):
                results = check_signed_commerce_evidence(root, payload)
            self.assertIn(
                "evidence.selection.materiality",
                {item.code for item in results if item.level == "PASS"},
            )

            selection["counterfactual"]["selectedOfferId"] = "offer_1"
            with mock.patch("check_finalist_readiness.verify_ed25519", return_value=True):
                results = check_signed_commerce_evidence(root, payload)
            self.assertIn(
                "evidence.selection.materiality",
                {item.code for item in results if item.level == "FAIL"},
            )

    def test_vendor_receipt_and_recovery_keys_must_differ(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for name in ("gemini", "a2a", "autonomy", "policy"):
                write(root / "src" / f"{name}.ts", f"export const {name} = true;\n")
            runtimes = {
                "gemini": {"model": "gemini-stable-flash"},
                "a2a": {
                    "verificationMethods": [
                        {"id": "did:web:vendor.run.app#receipt-1", "publicKeyBase58": PAYER}
                    ]
                },
                "autonomy": {
                    "verificationMethods": [
                        {"id": "did:web:control.run.app#outcome-1", "publicKeyBase58": PAYER}
                    ]
                },
                "policy": {"perTransactionBaseUnits": "2000", "dailyBaseUnits": "10000"},
            }
            artifacts: dict[str, tuple[str, str]] = {}
            for name, runtime in runtimes.items():
                path = root / "artifacts/runtime" / f"{name}.json"
                write(path, json.dumps(runtime, sort_keys=True, separators=(",", ":")))
                artifacts[name] = (str(path.relative_to(root)), file_digest(path))
            attestations = {
                "gemini": {
                    "implemented": True,
                    "model": "gemini-stable-flash",
                    "sourcePaths": ["src/gemini.ts"],
                    "runtimeArtifact": artifacts["gemini"][0],
                    "runtimeArtifactSha256": artifacts["gemini"][1],
                },
                "a2a": {
                    "implemented": True,
                    "separateService": True,
                    "agentCardUrl": "https://vendor.run.app/.well-known/agent-card.json",
                    "verificationKeyId": "did:web:vendor.run.app#receipt-1",
                    "verificationPublicKey": PAYER,
                    "agentCardHash": sha256_value(canonical_json(runtimes["a2a"])),
                    "sourcePaths": ["src/a2a.ts"],
                    "runtimeArtifact": artifacts["a2a"][0],
                    "runtimeArtifactSha256": artifacts["a2a"][1],
                },
                "autonomy": {
                    "implemented": True,
                    "humanApprovalPerPayment": False,
                    "automaticSigning": True,
                    "verificationKeyId": "did:web:control.run.app#outcome-1",
                    "verificationPublicKey": PAYER,
                    "sourcePaths": ["src/autonomy.ts"],
                    "runtimeArtifact": artifacts["autonomy"][0],
                    "runtimeArtifactSha256": artifacts["autonomy"][1],
                },
                "policy": {
                    "implemented": True,
                    "deterministic": True,
                    "enforcedLimits": {"perTransactionBaseUnits": "2000"},
                    "executionPolicyHash": sha256_value(canonical_json(runtimes["policy"])),
                    "sourcePaths": ["src/policy.ts"],
                    "runtimeArtifact": artifacts["policy"][0],
                    "runtimeArtifactSha256": artifacts["policy"][1],
                },
            }
            payload = {"attestations": attestations, "payments": []}
            results = check_attestations(root, payload)
            self.assertIn(
                "evidence.attestation.key_separation",
                {item.code for item in results if item.level == "FAIL"},
            )

            runtimes["autonomy"]["verificationMethods"][0]["publicKeyBase58"] = PAYEE
            autonomy_path = root / "artifacts/runtime/autonomy.json"
            write(autonomy_path, json.dumps(runtimes["autonomy"], sort_keys=True, separators=(",", ":")))
            attestations["autonomy"]["verificationPublicKey"] = PAYEE
            attestations["autonomy"]["runtimeArtifactSha256"] = file_digest(autonomy_path)
            results = check_attestations(root, payload)
            self.assertIn(
                "evidence.attestation.key_separation",
                {item.code for item in results if item.level == "PASS"},
            )

    def test_submission_manifest_requires_private_executor_role(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            write(root / "Dockerfile", "FROM node:22\nCOPY . .\nCMD [\"node\", \"server.js\"]\n")
            accounts = {
                "control-plane": "uptime-control@uptime402-demo.iam.gserviceaccount.com",
                "payment-executor": "uptime-executor@uptime402-demo.iam.gserviceaccount.com",
                "vendor-agent": "uptime-vendor@uptime402-demo.iam.gserviceaccount.com",
            }
            for role, name in (
                ("control-plane", "control.yaml"),
                ("payment-executor", "executor.yaml"),
                ("vendor-agent", "vendor.yaml"),
            ):
                write(
                    root / "deploy" / name,
                    "apiVersion: serving.knative.dev/v1\nkind: Service\nspec:\n  template:\n    spec:\n"
                    f"      serviceAccountName: {accounts[role]}\n",
                )
            iam_payloads = {
                "control": {"bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]},
                "executor": {
                    "bindings": [
                        {
                            "role": "roles/run.invoker",
                            "members": [f"serviceAccount:{accounts['control-plane']}"],
                        }
                    ]
                },
                "vendor": {"bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]},
                "secret": {
                    "bindings": [
                        {
                            "role": "roles/secretmanager.secretAccessor",
                            "members": [f"serviceAccount:{accounts['payment-executor']}"],
                        }
                    ]
                },
            }
            iam_hashes: dict[str, str] = {}
            for name, iam_payload in iam_payloads.items():
                path = root / "artifacts/iam" / f"{name}.json"
                write(path, json.dumps(iam_payload, sort_keys=True, separators=(",", ":")))
                iam_hashes[name] = file_digest(path)
            def cloud_run_description(name: str, url: str, account: str) -> dict[str, object]:
                return {
                    "apiVersion": "serving.knative.dev/v1",
                    "kind": "Service",
                    "metadata": {
                        "name": name,
                        "namespace": "123456789012",
                        "uid": f"12345678-1234-4234-8234-{name:0<12}"[:36],
                        "generation": 1,
                        "creationTimestamp": "2026-08-02T00:00:00Z",
                    },
                    "spec": {"template": {"spec": {"serviceAccountName": account}}},
                    "status": {
                        "observedGeneration": 1,
                        "conditions": [
                            {
                                "type": "Ready",
                                "status": "True",
                                "lastTransitionTime": "2026-08-02T00:01:00Z",
                            }
                        ],
                        "latestReadyRevisionName": f"{name}-00001-abc",
                        "url": url,
                    },
                }

            descriptions = {
                "control": cloud_run_description("uptime-control", "https://control.run.app", accounts["control-plane"]),
                "executor": cloud_run_description("uptime-executor", "https://executor.run.app", accounts["payment-executor"]),
                "vendor": cloud_run_description("uptime-vendor", "https://vendor.run.app", accounts["vendor-agent"]),
            }
            description_hashes: dict[str, str] = {}
            for name, description in descriptions.items():
                path = root / "artifacts/describe" / f"{name}.json"
                write(path, json.dumps(description, sort_keys=True, separators=(",", ":")))
                description_hashes[name] = file_digest(path)
            (root / "submission").mkdir(parents=True, exist_ok=True)
            (root / "submission/deck.pdf").write_bytes(b"%PDF-" + b"0" * 2048)
            (root / "submission/demo.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"0" * 2048)
            payload = {
                "project": {
                    "liveUrl": "https://control.run.app",
                    "deploymentArtifact": "Dockerfile",
                    "deckPdf": "submission/deck.pdf",
                    "demoVideo": "submission/demo.mp4",
                    "demoVideoDurationSeconds": 165,
                    "services": [
                        {
                            "role": "control-plane",
                            "url": "https://control.run.app",
                            "healthUrl": "https://control.run.app/health",
                            "public": True,
                            "serviceAccount": accounts["control-plane"],
                            "deploymentArtifact": "deploy/control.yaml",
                            "serviceDescribeArtifact": "artifacts/describe/control.json",
                            "serviceDescribeArtifactSha256": description_hashes["control"],
                            "iamPolicyArtifact": "artifacts/iam/control.json",
                            "iamPolicyArtifactSha256": iam_hashes["control"],
                        },
                        {
                            "role": "payment-executor",
                            "url": "https://executor.run.app",
                            "public": False,
                            "iamProtected": True,
                            "audience": "https://executor.run.app",
                            "serviceAccount": accounts["payment-executor"],
                            "deploymentArtifact": "deploy/executor.yaml",
                            "serviceDescribeArtifact": "artifacts/describe/executor.json",
                            "serviceDescribeArtifactSha256": description_hashes["executor"],
                            "iamPolicyArtifact": "artifacts/iam/executor.json",
                            "iamPolicyArtifactSha256": iam_hashes["executor"],
                            "signerSecretResource": "projects/uptime402-demo/secrets/executor-signer/versions/1",
                            "secretIamPolicyArtifact": "artifacts/iam/secret.json",
                            "secretIamPolicyArtifactSha256": iam_hashes["secret"],
                        },
                        {
                            "role": "vendor-agent",
                            "url": "https://vendor.run.app",
                            "healthUrl": "https://vendor.run.app/health",
                            "public": True,
                            "serviceAccount": accounts["vendor-agent"],
                            "deploymentArtifact": "deploy/vendor.yaml",
                            "serviceDescribeArtifact": "artifacts/describe/vendor.json",
                            "serviceDescribeArtifactSha256": description_hashes["vendor"],
                            "iamPolicyArtifact": "artifacts/iam/vendor.json",
                            "iamPolicyArtifactSha256": iam_hashes["vendor"],
                        },
                    ],
                }
            }
            calls: list[str] = []
            private_calls: list[str] = []

            def reachable(url: str, timeout: int, code: str) -> list[object]:
                calls.append(url)
                return [result("PASS", code, "reachable")]

            def private(url: str, timeout: int, code: str) -> list[object]:
                private_calls.append(url)
                return [result("PASS", code, "private")]

            with mock.patch("check_finalist_readiness.verify_reachable_url", side_effect=reachable), mock.patch(
                "check_finalist_readiness.verify_private_url", side_effect=private
            ):
                results = check_submission_assets(root, payload, timeout=1)
            self.assertIn("submission.services", {item.code for item in results if item.level == "PASS"})
            self.assertNotIn("https://executor.run.app", calls)
            self.assertEqual(["https://executor.run.app"], private_calls)
            self.assertIn("https://control.run.app/health", calls)
            self.assertIn("https://vendor.run.app/health", calls)

            executor_description_path = root / "artifacts/describe/executor.json"
            minimal_description = {
                "uri": "https://executor.run.app",
                "template": {"serviceAccount": accounts["payment-executor"]},
            }
            write(executor_description_path, json.dumps(minimal_description, sort_keys=True, separators=(",", ":")))
            payload["project"]["services"][1]["serviceDescribeArtifactSha256"] = file_digest(
                executor_description_path
            )
            with mock.patch("check_finalist_readiness.verify_reachable_url", side_effect=reachable), mock.patch(
                "check_finalist_readiness.verify_private_url", side_effect=private
            ):
                results = check_submission_assets(root, payload, timeout=1)
            self.assertIn(
                "submission.service[1].describe_binding",
                {item.code for item in results if item.level == "FAIL"},
            )
            write(
                executor_description_path,
                json.dumps(descriptions["executor"], sort_keys=True, separators=(",", ":")),
            )
            payload["project"]["services"][1]["serviceDescribeArtifactSha256"] = file_digest(
                executor_description_path
            )

            iam_payloads["executor"]["bindings"][0]["members"].append(
                f"serviceAccount:{accounts['vendor-agent']}"
            )
            executor_iam_path = root / "artifacts/iam/executor.json"
            write(executor_iam_path, json.dumps(iam_payloads["executor"], sort_keys=True, separators=(",", ":")))
            payload["project"]["services"][1]["iamPolicyArtifactSha256"] = file_digest(executor_iam_path)
            with mock.patch("check_finalist_readiness.verify_reachable_url", side_effect=reachable), mock.patch(
                "check_finalist_readiness.verify_private_url", side_effect=private
            ):
                results = check_submission_assets(root, payload, timeout=1)
            self.assertIn(
                "submission.payment-executor.invoker",
                {item.code for item in results if item.level == "FAIL"},
            )


if __name__ == "__main__":
    unittest.main()
