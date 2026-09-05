#!/usr/bin/env python3
"""Validate and render Uptime402 Cloud Run manifests without reading key bytes."""

from __future__ import annotations

import argparse
import json
import ipaddress
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
DEPLOY_DIR = ROOT / "deploy"
CONTROL_PLANE_CAPTURE_TEMPLATE = DEPLOY_DIR / "control-plane.service.yaml.tmpl"
CONTROL_PLANE_REPLAY_TEMPLATE = DEPLOY_DIR / "control-plane.replay.service.yaml.tmpl"
TEMPLATES = {
    "control-plane": CONTROL_PLANE_CAPTURE_TEMPLATE,
    "payment-executor": DEPLOY_DIR / "payment-executor.service.yaml.tmpl",
    "vendor-agent": DEPLOY_DIR / "vendor-agent.service.yaml.tmpl",
}
ALL_TEMPLATE_PATHS = [*TEMPLATES.values(), CONTROL_PLANE_REPLAY_TEMPLATE]
PLACEHOLDER = re.compile(r"\{\{([A-Z][A-Z0-9_]*)\}\}")
ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
RESOURCE_NAME = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
COLLECTION_PREFIX = re.compile(r"^[a-z][a-z0-9_-]{0,47}$")
SERVICE_ACCOUNT = re.compile(
    r"^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$"
)
BASE58_KEY = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
FINAL_EVIDENCE_BLOCK = re.compile(
    r"^\s*# UPTIME402_FINAL_EVIDENCE_ENV_BEGIN\s*$.*?"
    r"^\s*# UPTIME402_FINAL_EVIDENCE_ENV_END\s*$\n?",
    re.MULTILINE | re.DOTALL,
)

PINNED_RUNTIME_ENV = {
    "SOLANA_CLUSTER_LABEL",
    "SOLANA_GENESIS_HASH",
    "X402_NETWORK_ID",
    "X402_SDK_NETWORK_ID",
    "USDC_MINT",
    "USDC_DECIMALS",
}


def fail(message: str) -> "NoReturn":
    raise ValueError(message)


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            fail(f"{path}:{line_number}: expected NAME=value")
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip()
        if not ENV_NAME.fullmatch(name):
            fail(f"{path}:{line_number}: invalid variable name {name!r}")
        if name in values:
            fail(f"{path}:{line_number}: duplicate variable {name}")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if any(ord(character) < 32 for character in value):
            fail(f"{path}:{line_number}: control characters are forbidden")
        values[name] = value
    return values


def template_env_names(text: str) -> set[str]:
    return set(re.findall(r"^\s*- name: ([A-Z][A-Z0-9_]*)\s*$", text, re.MULTILINE))


def required_runtime_names(source: Path, variable: str) -> set[str]:
    text = source.read_text(encoding="utf-8")
    return set(
        re.findall(
            rf'required\({re.escape(variable)},\s*"([A-Z][A-Z0-9_]*)"\)',
            text,
        )
    )


def deployment_stage(values: dict[str, str]) -> str:
    stage = values.get("UPTIME402_UI_EVIDENCE_STAGE", "").strip()
    if stage not in {"capture", "final"}:
        fail("UPTIME402_UI_EVIDENCE_STAGE must be capture or final for Cloud Run")
    return stage


def control_plane_template_for_stage(stage: str) -> str:
    if stage == "capture":
        text = CONTROL_PLANE_CAPTURE_TEMPLATE.read_text(encoding="utf-8")
        matches = list(FINAL_EVIDENCE_BLOCK.finditer(text))
        if len(matches) != 1:
            fail("capture control-plane template must contain one final evidence env block")
        return FINAL_EVIDENCE_BLOCK.sub("", text)
    if stage == "final":
        return CONTROL_PLANE_REPLAY_TEMPLATE.read_text(encoding="utf-8")
    fail("control-plane template stage must be capture or final")


def assert_control_plane_evidence_env(text: str, stage: str) -> None:
    names = template_env_names(text)
    final_only = {
        "UPTIME402_UI_EVIDENCE_SHA256",
        "UPTIME402_UI_VERIFICATION_REPORT_SHA256",
    }
    if "UPTIME402_UI_EVIDENCE_STAGE" not in names:
        fail("control-plane manifest must declare its evidence deployment stage")
    if stage == "capture" and final_only & names:
        fail("capture manifest must omit final evidence hash variables")
    if stage == "final" and not final_only <= names:
        fail("final manifest must pin evidence and verification report hashes")


def assert_control_plane_operational_boundary(text: str, stage: str) -> None:
    if stage == "capture":
        required_fragments = (
            'name: CONTROL_PLANE_MUTATIONS_ENABLED\n              value: "true"',
            'name: CONTROL_PLANE_UI_LIVE_TRIGGER_ENABLED\n              value: "true"',
            "run.googleapis.com/secrets:",
            "CONTROL_PLANE_OUTCOME_KEY_PATH",
            "CONTROL_PLANE_UI_LIVE_REQUEST_PATH",
        )
        missing = [fragment for fragment in required_fragments if fragment not in text]
        if missing:
            fail("capture control-plane manifest is missing its protected mutation boundary")
        return

    required_fragments = (
        'name: CONTROL_PLANE_MUTATIONS_ENABLED\n              value: "false"',
        'name: CONTROL_PLANE_UI_LIVE_TRIGGER_ENABLED\n              value: "false"',
        "name: UPTIME402_UI_EVIDENCE_STAGE\n              value: final",
    )
    if any(fragment not in text for fragment in required_fragments):
        fail("final control-plane manifest must be an explicit replay-only runtime")
    forbidden_fragments = (
        "run.googleapis.com/secrets:",
        "CONTROL_PLANE_OUTCOME_KEY_PATH",
        "CONTROL_PLANE_OPERATOR_AUDIENCE",
        "CONTROL_PLANE_UI_GOOGLE_CLIENT_ID",
        "CONTROL_PLANE_UI_LIVE_REQUEST_PATH",
        "CONTROL_PLANE_DEMO_RUN_SLOT",
        "PAYMENT_EXECUTOR_ORIGIN",
        "FIRESTORE_PROJECT_ID",
        "GOOGLE_CLOUD_PROJECT",
        "volumeMounts:",
        "volumes:",
    )
    present = [fragment for fragment in forbidden_fragments if fragment in text]
    if present:
        fail(
            "final replay control-plane manifest retains mutation dependency: "
            + ", ".join(present)
        )


def validate_template_contract() -> None:
    env_example = parse_env_file(ROOT / ".env.example")
    all_placeholders: set[str] = set()
    rendered_env: dict[str, set[str]] = {}
    for path in ALL_TEMPLATE_PATHS:
        text = path.read_text(encoding="utf-8")
        all_placeholders.update(PLACEHOLDER.findall(text))
        if "latest" in text.lower():
            fail(f"{path}: version-pinned templates must not contain 'latest'")
        if "FIRESTORE_EMULATOR_HOST" in text:
            fail(f"{path}: production manifest must not set FIRESTORE_EMULATOR_HOST")
    rendered_env = {
        role: template_env_names(path.read_text(encoding="utf-8"))
        for role, path in TEMPLATES.items()
    }

    capture_template = control_plane_template_for_stage("capture")
    final_template = control_plane_template_for_stage("final")
    assert_control_plane_evidence_env(capture_template, "capture")
    assert_control_plane_evidence_env(final_template, "final")
    assert_control_plane_operational_boundary(capture_template, "capture")
    assert_control_plane_operational_boundary(final_template, "final")

    missing_example = sorted(all_placeholders - set(env_example))
    if missing_example:
        fail(f".env.example is missing renderer inputs: {', '.join(missing_example)}")

    runtime_contracts = {
        "control-plane": (
            [
                ROOT / "apps/control-plane/src/server/runtime.ts",
                ROOT / "apps/control-plane/src/server/operator-runtime.ts",
                ROOT / "apps/control-plane/src/server/operator-ui-trigger.ts",
            ],
            "environment",
            {
                "CONTROL_PLANE_OPERATOR_AUDIENCE",
                "CONTROL_PLANE_OPERATOR_PRINCIPALS",
                "CONTROL_PLANE_MUTATIONS_ENABLED",
                "CONTROL_PLANE_UI_LIVE_TRIGGER_ENABLED",
                "UPTIME402_UI_EVIDENCE_STAGE",
                "UPTIME402_UI_EVIDENCE_SHA256",
                "UPTIME402_UI_VERIFICATION_REPORT_SHA256",
            },
        ),
        "payment-executor": (
            [ROOT / "services/payment-executor/src/runtime.ts"],
            "env",
            PINNED_RUNTIME_ENV,
        ),
        "vendor-agent": (
            [ROOT / "services/vendor-agent/src/runtime.ts"],
            "env",
            PINNED_RUNTIME_ENV,
        ),
    }
    for role, (sources, variable, extra) in runtime_contracts.items():
        required = set().union(
            *(required_runtime_names(source, variable) for source in sources)
        ) | extra
        required.discard("PORT")  # injected by Cloud Run
        missing_manifest = sorted(required - rendered_env[role])
        if missing_manifest:
            fail(f"{role} manifest is missing runtime env: {', '.join(missing_manifest)}")

    cloudbuild = (ROOT / "cloudbuild.yaml").read_text(encoding="utf-8")
    for image in ("control-plane", "payment-executor", "vendor-agent"):
        if f"/{image}:" not in cloudbuild:
            fail(f"cloudbuild.yaml does not publish the {image} image")


def credential_free_https(value: str, name: str, *, origin_only: bool) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        fail(f"{name} must be a credential-free HTTPS URL")
    if parsed.fragment:
        fail(f"{name} must not contain a fragment")
    if origin_only and (parsed.path not in ("", "/") or parsed.query):
        fail(f"{name} must be an exact HTTPS origin")
    hostname = parsed.hostname.lower().rstrip(".")
    if hostname in {"localhost", "metadata.google.internal"}:
        fail(f"{name} must not target localhost or metadata")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address and not address.is_global:
        fail(f"{name} must not contain a private/link-local IP literal")
    return f"{parsed.scheme}://{parsed.netloc}" if origin_only else value


def positive_integer(values: dict[str, str], name: str, low: int, high: int) -> None:
    raw = values[name]
    if not raw.isdigit() or not low <= int(raw) <= high:
        fail(f"{name} must be an integer from {low} through {high}")


def validate_values(values: dict[str, str], placeholders: set[str]) -> None:
    stage = deployment_stage(values)
    validation_only = {"CONTROL_PLANE_ORIGIN"}
    missing = sorted(name for name in placeholders | validation_only if not values.get(name))
    if missing:
        fail(f"deployment env is missing non-empty values: {', '.join(missing)}")

    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", values["PROJECT_ID"]):
        fail("PROJECT_ID is not a valid Google Cloud project ID")
    if values["FIRESTORE_PROJECT_ID"] != values["PROJECT_ID"]:
        fail("P0 requires Firestore and Cloud Run to use the same project")
    if values["GOOGLE_CLOUD_PROJECT"] != values["PROJECT_ID"]:
        fail("Vertex AI project must equal PROJECT_ID in the P0 manifest")
    if not re.fullmatch(r"[a-z]+-[a-z0-9]+[0-9]", values["GCP_REGION"]):
        fail("GCP_REGION is invalid")
    for name in (
        "ARTIFACT_REPOSITORY",
        "CONTROL_PLANE_SERVICE_NAME",
        "PAYMENT_EXECUTOR_SERVICE_NAME",
        "VENDOR_AGENT_SERVICE_NAME",
        "EXECUTOR_SIGNER_SECRET_NAME",
        "VENDOR_RECEIPT_SECRET_NAME",
        "CONTROL_PLANE_OUTCOME_SECRET_NAME",
        "CONTROL_PLANE_DEMO_REQUEST_SECRET_NAME",
        "CONTROL_PLANE_DEMO_MANDATE_SECRET_NAME",
        "VENDOR_OFFER_CATALOG_SECRET_NAME",
    ):
        if not RESOURCE_NAME.fullmatch(values[name]):
            fail(f"{name} is not a valid lowercase resource name")
    for name in (
        "CONTROL_PLANE_SERVICE_NAME",
        "PAYMENT_EXECUTOR_SERVICE_NAME",
        "VENDOR_AGENT_SERVICE_NAME",
    ):
        if len(values[name]) > 49:
            fail(f"{name} exceeds the Cloud Run 49-character limit")
    if not re.fullmatch(r"[0-9a-f]{7,64}", values["IMAGE_TAG"]):
        fail("IMAGE_TAG must be an immutable lowercase hexadecimal commit/build identifier")
    if not COLLECTION_PREFIX.fullmatch(values["FIRESTORE_COLLECTION_PREFIX"]):
        fail("FIRESTORE_COLLECTION_PREFIX is invalid")

    service_accounts = [
        values["CONTROL_PLANE_SERVICE_ACCOUNT"],
        values["EXECUTOR_SERVICE_ACCOUNT"],
        values["VENDOR_SERVICE_ACCOUNT"],
    ]
    if len(set(service_accounts)) != 3:
        fail("The three Cloud Run service accounts must be distinct")
    for account in service_accounts:
        if not SERVICE_ACCOUNT.fullmatch(account) or not account.endswith(
            f"@{values['PROJECT_ID']}.iam.gserviceaccount.com"
        ):
            fail(f"Invalid in-project service account: {account}")

    origins = {
        name: credential_free_https(values[name], name, origin_only=True)
        for name in (
            "CONTROL_PLANE_ORIGIN",
            "VENDOR_AGENT_ORIGIN",
            "PUBLIC_VENDOR_ORIGIN",
            "PAYMENT_EXECUTOR_ORIGIN",
            "EXECUTOR_EXPECTED_AUDIENCE",
        )
    }
    if values["VENDOR_AGENT_ORIGIN"] != values["PUBLIC_VENDOR_ORIGIN"]:
        fail("VENDOR_AGENT_ORIGIN and PUBLIC_VENDOR_ORIGIN must be identical")
    if values["PAYMENT_EXECUTOR_ORIGIN"] != values["EXECUTOR_EXPECTED_AUDIENCE"]:
        fail("Executor origin and ID-token audience must be identical")
    distinct_origins = {
        origins["CONTROL_PLANE_ORIGIN"],
        origins["VENDOR_AGENT_ORIGIN"],
        origins["PAYMENT_EXECUTOR_ORIGIN"],
    }
    if len(distinct_origins) != 3:
        fail("Control-plane, executor, and vendor origins must be distinct")
    if values["ALLOWED_VENDOR_ORIGINS"] != values["VENDOR_AGENT_ORIGIN"]:
        fail("P0 ALLOWED_VENDOR_ORIGINS must pin the single vendor origin")
    expected_probe = f'{origins["CONTROL_PLANE_ORIGIN"]}/api/dependency-health'
    if values["RECOVERY_HEALTH_PROBE_URL"] != expected_probe:
        fail("RECOVERY_HEALTH_PROBE_URL must be CONTROL_PLANE_ORIGIN/api/dependency-health")

    if stage == "capture":
        try:
            routes = json.loads(values["RECOVERY_RPC_ROUTES_JSON"])
        except (ValueError, KeyError):
            fail("RECOVERY_RPC_ROUTES_JSON must contain the paid offer RPC bindings")
        if not isinstance(routes, list) or not 1 <= len(routes) <= 64:
            fail("Recovery RPC bindings must be a non-empty bounded list")
        offer_ids = set()
        for route in routes:
            if not isinstance(route, dict) or set(route) != {"offerId", "resourceUrl", "rpcUrl"}:
                fail("Recovery RPC binding fields are invalid")
            if not isinstance(route["offerId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", route["offerId"]) or route["offerId"] in offer_ids:
                fail("Recovery RPC offer IDs must be valid and distinct")
            offer_ids.add(route["offerId"])
            for field in ("resourceUrl", "rpcUrl"):
                credential_free_https(route[field], field, origin_only=False)

    for name in ("SOLANA_RPC_URL", "X402_FACILITATOR_URL", "RECOVERY_HEALTH_PROBE_URL"):
        credential_free_https(values[name], name, origin_only=False)

    distinct_public_identities = [
        values["EXECUTOR_WALLET_PUBLIC_KEY"],
        values["VENDOR_USDC_RECIPIENT"],
        values["VENDOR_OFFER_SIGNER_PUBLIC_KEY"],
        values["CONTROL_PLANE_OUTCOME_PUBLIC_KEY"],
    ]
    for key in distinct_public_identities + [
        values["VENDOR_RECEIPT_PUBLIC_KEY"],
        values["MANDATE_SIGNER_PUBLIC_KEY"],
        values["X402_FACILITATOR_FEE_PAYER"],
    ]:
        if not BASE58_KEY.fullmatch(key):
            fail("A configured public identity is not a plausible Base58 32-byte key")
    if values["VENDOR_OFFER_SIGNER_PUBLIC_KEY"] != values["VENDOR_RECEIPT_PUBLIC_KEY"]:
        fail("Offer and receipt public keys must pin the same vendor Agent Card authority")
    if values["VENDOR_OFFER_SIGNER_KEY_ID"] != values["VENDOR_RECEIPT_KEY_ID"]:
        fail("Offer and receipt key IDs must pin the same vendor Agent Card authority")
    if len(set(distinct_public_identities)) != len(distinct_public_identities):
        fail("Payer, payee, vendor authority, and outcome identities must be distinct")
    if values["CONTROL_PLANE_OUTCOME_KEY_ID"] == values["VENDOR_RECEIPT_KEY_ID"]:
        fail("Vendor authority and control-plane outcome key IDs must be distinct")

    operator_audience = values["CONTROL_PLANE_OPERATOR_AUDIENCE"]
    if len(operator_audience) > 512 or any(character.isspace() for character in operator_audience):
        fail("CONTROL_PLANE_OPERATOR_AUDIENCE must be an exact non-space audience")
    operator_ui_client_id = values["CONTROL_PLANE_UI_GOOGLE_CLIENT_ID"]
    if not re.fullmatch(r"[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com", operator_ui_client_id):
        fail("CONTROL_PLANE_UI_GOOGLE_CLIENT_ID must be a Google OAuth Web client ID")
    if operator_ui_client_id != operator_audience:
        fail("CONTROL_PLANE_UI_GOOGLE_CLIENT_ID must exactly equal CONTROL_PLANE_OPERATOR_AUDIENCE")
    operator_principals = [
        principal.strip()
        for principal in values["CONTROL_PLANE_OPERATOR_PRINCIPALS"].split(",")
        if principal.strip()
    ]
    if not operator_principals or len(set(operator_principals)) != len(operator_principals):
        fail("CONTROL_PLANE_OPERATOR_PRINCIPALS must be a distinct non-empty list")
    if any(not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", principal) for principal in operator_principals):
        fail("CONTROL_PLANE_OPERATOR_PRINCIPALS contains an invalid email principal")
    for name in ("CONTROL_PLANE_DEMO_RUN_SLOT", "CONTROL_PLANE_DEMO_MANDATE_ID"):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", values[name]):
            fail(f"{name} is not a valid immutable identifier")
    if values["CONTROL_PLANE_DEMO_AUTO_ARM_ENABLED"] not in ("true", "false"):
        fail("CONTROL_PLANE_DEMO_AUTO_ARM_ENABLED must be true or false")
    if stage == "capture":
        if values.get("UPTIME402_UI_EVIDENCE_SHA256", "").strip() or values.get(
            "UPTIME402_UI_VERIFICATION_REPORT_SHA256", ""
        ).strip():
            fail("capture stage must not configure final evidence hash variables")
    else:
        if not re.fullmatch(
            r"sha256:[0-9a-f]{64}", values["UPTIME402_UI_EVIDENCE_SHA256"]
        ):
            fail("UPTIME402_UI_EVIDENCE_SHA256 must pin the verified evidence bytes")
        if not re.fullmatch(
            r"sha256:[0-9a-f]{64}",
            values["UPTIME402_UI_VERIFICATION_REPORT_SHA256"],
        ):
            fail(
                "UPTIME402_UI_VERIFICATION_REPORT_SHA256 must pin the verified report bytes"
            )

    # With executor Cloud Run IAM restricted to the control-plane identity, the
    # current application sees that proxy identity. This does not prove a human
    # operator-authenticated control-plane admin route.
    if values["OPERATOR_PRINCIPAL"] != values["CONTROL_PLANE_SERVICE_ACCOUNT"]:
        fail("Current executor IAM contract requires OPERATOR_PRINCIPAL to equal the control-plane SA")

    for name in (
        "EXECUTOR_SIGNER_SECRET_VERSION",
        "VENDOR_RECEIPT_SECRET_VERSION",
        "CONTROL_PLANE_OUTCOME_SECRET_VERSION",
        "CONTROL_PLANE_DEMO_REQUEST_SECRET_VERSION",
        "CONTROL_PLANE_DEMO_MANDATE_SECRET_VERSION",
        "VENDOR_OFFER_CATALOG_SECRET_VERSION",
    ):
        if not values[name].isdigit() or int(values[name]) <= 0:
            fail(f"{name} must be a positive numeric version, never latest")
    positive_integer(values, "HTTP_TIMEOUT_MS", 100, 60_000)
    positive_integer(values, "HTTP_MAX_RESPONSE_BYTES", 1, 4_194_304)
    positive_integer(values, "ESTIMATED_NETWORK_FEE_LAMPORTS", 1, 10_000_000)
    positive_integer(values, "X402_MAX_TIMEOUT_SECONDS", 1, 3_600)
    positive_integer(values, "SETTLEMENT_CONFIRMATION_ATTEMPTS", 1, 20)
    positive_integer(values, "SETTLEMENT_CONFIRMATION_DELAY_MS", 50, 10_000)


def render(values: dict[str, str], output_dir: Path) -> list[Path]:
    stage = deployment_stage(values)
    template_sources = {
        role: control_plane_template_for_stage(stage)
        if role == "control-plane"
        else path.read_text(encoding="utf-8")
        for role, path in TEMPLATES.items()
    }
    placeholders = {
        name
        for text in template_sources.values()
        for name in PLACEHOLDER.findall(text)
    }
    validate_values(values, placeholders)
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs: list[Path] = []
    for role, path in TEMPLATES.items():
        text = template_sources[role]
        rendered = PLACEHOLDER.sub(
            lambda match: values[match.group(1)].replace("\\", "\\\\").replace('"', '\\"'),
            text,
        )
        if PLACEHOLDER.search(rendered):
            fail(f"Unresolved placeholder in {path}")
        if role == "control-plane":
            assert_control_plane_evidence_env(rendered, stage)
            assert_control_plane_operational_boundary(rendered, stage)
        output = output_dir / f"{role}.service.yaml"
        output.write_text(rendered, encoding="utf-8")
        outputs.append(output)
    return outputs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-templates", action="store_true")
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    if not args.check_templates and args.env_file is None:
        parser.error("use --check-templates or provide --env-file")

    validate_template_contract()
    if args.env_file is None:
        print("deployment templates: valid")
        return 0

    file_values = parse_env_file(args.env_file.resolve())
    values = {**file_values, **{key: value for key, value in os.environ.items() if key in file_values}}
    if args.output_dir:
        outputs = render(values, args.output_dir.resolve())
        for output in outputs:
            print(output)
    else:
        with tempfile.TemporaryDirectory(prefix="uptime402-cloudrun-") as directory:
            render(values, Path(directory))
        print("deployment values: valid")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"deployment packaging error: {error}", file=sys.stderr)
        raise SystemExit(1)
