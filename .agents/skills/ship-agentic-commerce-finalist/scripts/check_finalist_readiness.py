#!/usr/bin/env python3
"""Validate an Uptime402 repository in structural or live submission mode.

The default mode checks repository structure and evidence shape only. It does not
claim that a transaction, deployment, protocol exchange, or product outcome is
real. ``--submission`` is an intentionally expensive final gate: it executes the
repository's verification scripts, calls the explicitly supplied Solana RPC, and
verifies live URLs and final submission media.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import ipaddress
import json
import os
import re
import secrets
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable


IGNORED_DIRS = {
    ".git",
    ".next",
    ".turbo",
    ".venv",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
}
BASE58_SIGNATURE_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{64,100}$")
BASE58_PUBKEY_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
SERVICE_ACCOUNT_RE = re.compile(
    r"^[a-z][a-z0-9-]{2,62}@[a-z][a-z0-9-]{4,62}\.iam\.gserviceaccount\.com$"
)
PLACEHOLDER_RE = re.compile(
    r"(?:replace[-_ ]with|placeholder|todo|changeme|dummy|fake|"
    r"example(?:\.com)?|your[-_ ]?(?:key|token|secret))",
    re.IGNORECASE,
)
HASH_RE = re.compile(r"^sha256:([0-9a-f]{64})$", re.IGNORECASE)
REQUIRED_PACKAGE_SCRIPTS = ("build", "test", "lint", "typecheck", "evidence:verify")
CAIP2_SOLANA_RE = re.compile(r"^solana:([1-9A-HJ-NP-Za-km-z]{32})$")
APPROVED_PUBLIC_RPC_HOSTS = {"api.devnet.solana.com"}
X402_HEADER_NAMES = {
    "challenge": {"payment-required"},
    "payment": {"payment-signature"},
    "settlement": {"payment-response"},
}
OFFICIAL_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
DEVNET_CAIP2 = f"solana:{DEVNET_GENESIS_HASH[:32]}"


@dataclass(frozen=True)
class Result:
    level: str
    code: str
    message: str


@dataclass(frozen=True)
class CommandRun:
    results: list[Result]
    nonce: str
    started_at: datetime
    finished_at: datetime


def result(level: str, code: str, message: str) -> Result:
    return Result(level=level, code=code, message=message)


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def first_existing(root: Path, candidates: Iterable[str]) -> Path | None:
    for candidate in candidates:
        path = root / candidate
        if path.is_file():
            return path
    return None


def walk_files(root: Path, *, include_build_outputs: bool = False) -> Iterable[Path]:
    ignored = IGNORED_DIRS if not include_build_outputs else IGNORED_DIRS - {".next", "dist", "out"}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            relative_parts = path.relative_to(root).parts
        except ValueError:
            continue
        if any(part in ignored for part in relative_parts):
            continue
        yield path


def resolve_repo_file(root: Path, value: object) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    relative = Path(value)
    if relative.is_absolute():
        return None
    try:
        candidate = (root / relative).resolve()
        candidate.relative_to(root.resolve())
    except (OSError, ValueError):
        return None
    return candidate if candidate.is_file() else None


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def parse_decimal(value: object) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def parse_positive_int(value: object) -> int | None:
    try:
        parsed = int(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def canonical_json(value: object) -> bytes:
    """Encode the checker's constrained JSON evidence subset deterministically.

    The target repository's ``evidence:verify`` command remains authoritative for
    RFC 8785 JCS, duplicate-key rejection, and the shared golden vectors. Evidence
    objects hashed here deliberately use strings, booleans, nulls, arrays, objects,
    and integers only; monetary values are decimal strings, never JSON floats.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256_value(value: bytes | str) -> str:
    raw = value.encode("utf-8") if isinstance(value, str) else value
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def base58_decode(value: str) -> bytes | None:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number = 0
    try:
        for character in value:
            number = number * 58 + alphabet.index(character)
    except ValueError:
        return None
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    return b"\0" * (len(value) - len(value.lstrip("1"))) + raw


# Pure-stdlib Ed25519 verification for signed offers and fulfillment receipts.
_ED_Q = 2**255 - 19
_ED_L = 2**252 + 27742317777372353535851937790883648493
_ED_D = (-121665 * pow(121666, _ED_Q - 2, _ED_Q)) % _ED_Q
_ED_I = pow(2, (_ED_Q - 1) // 4, _ED_Q)


def _ed_xrecover(y: int) -> int:
    xx = (y * y - 1) * pow(_ED_D * y * y + 1, _ED_Q - 2, _ED_Q)
    x = pow(xx, (_ED_Q + 3) // 8, _ED_Q)
    if (x * x - xx) % _ED_Q:
        x = (x * _ED_I) % _ED_Q
    if x & 1:
        x = _ED_Q - x
    return x


_ED_B_Y = 4 * pow(5, _ED_Q - 2, _ED_Q) % _ED_Q
_ED_B = (_ed_xrecover(_ED_B_Y), _ED_B_Y)


def _ed_add(left: tuple[int, int], right: tuple[int, int]) -> tuple[int, int]:
    x1, y1 = left
    x2, y2 = right
    denominator_x = pow(1 + _ED_D * x1 * x2 * y1 * y2, _ED_Q - 2, _ED_Q)
    denominator_y = pow(1 - _ED_D * x1 * x2 * y1 * y2, _ED_Q - 2, _ED_Q)
    return (
        (x1 * y2 + x2 * y1) * denominator_x % _ED_Q,
        (y1 * y2 + x1 * x2) * denominator_y % _ED_Q,
    )


def _ed_scalarmult(point: tuple[int, int], scalar: int) -> tuple[int, int]:
    result_point = (0, 1)
    addend = point
    while scalar:
        if scalar & 1:
            result_point = _ed_add(result_point, addend)
        addend = _ed_add(addend, addend)
        scalar >>= 1
    return result_point


def _ed_decodepoint(encoded: bytes) -> tuple[int, int] | None:
    if len(encoded) != 32:
        return None
    value = int.from_bytes(encoded, "little")
    y = value & ((1 << 255) - 1)
    if y >= _ED_Q:
        return None
    x = _ed_xrecover(y)
    if (x & 1) != (value >> 255):
        x = _ED_Q - x
    if (-x * x + y * y - 1 - _ED_D * x * x * y * y) % _ED_Q:
        return None
    return x, y


def verify_ed25519(public_key_b58: object, signature_b58: object, message: bytes) -> bool:
    if not isinstance(public_key_b58, str) or not isinstance(signature_b58, str):
        return False
    public_key = base58_decode(public_key_b58)
    signature = base58_decode(signature_b58)
    if public_key is None or signature is None or len(public_key) != 32 or len(signature) != 64:
        return False
    point_a = _ed_decodepoint(public_key)
    point_r = _ed_decodepoint(signature[:32])
    scalar_s = int.from_bytes(signature[32:], "little")
    if point_a is None or point_r is None or scalar_s >= _ED_L:
        return False
    challenge = int.from_bytes(hashlib.sha512(signature[:32] + public_key + message).digest(), "little") % _ED_L
    return _ed_scalarmult(_ED_B, scalar_s) == _ed_add(point_r, _ed_scalarmult(point_a, challenge))


def is_web_url(value: object, *, allow_loopback_http: bool = False) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urllib.parse.urlparse(value)
    if (
        parsed.scheme == "https"
        and parsed.hostname
        and parsed.username is None
        and parsed.password is None
        and not parsed.fragment
    ):
        return True
    if allow_loopback_http and parsed.scheme == "http" and parsed.hostname in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        return True
    return False


def canonical_resource_url(value: object) -> str | None:
    """Accept only an already-normalized, non-credentialed HTTPS resource URL.

    The repository verifier must still implement the normative WHATWG/golden
    vector algorithm. This independent gate rejects the high-risk divergence
    classes that must never be hashed as-is: credentials, fragments, default
    ports, private literals, dot segments, malformed escapes, duplicate query
    keys, and non-deterministic query ordering.
    """
    if not isinstance(value, str) or value != value.strip():
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    host = parsed.hostname
    if (
        parsed.scheme != "https"
        or not host
        or not host.isascii()
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or host != host.lower()
        or host not in parsed.netloc
        or host.endswith(".")
        or port == 443
        or not parsed.path.startswith("/")
        or re.search(r"%(?![0-9A-Fa-f]{2})", parsed.path + parsed.query)
    ):
        return None
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None and not literal.is_global:
        return None
    numeric_host = re.fullmatch(r"(?:(?:0[xX][0-9A-Fa-f]+|[0-9]+)(?:\.|$))+", host)
    if (
        (literal is None and numeric_host is not None)
        or host == "metadata.google.internal"
        or "%" in host
    ):
        return None
    decoded_segments = [urllib.parse.unquote(segment) for segment in parsed.path.split("/")]
    if any(segment in {".", ".."} for segment in decoded_segments):
        return None
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query_keys = [key for key, _ in query_pairs]
    if len(query_keys) != len(set(query_keys)) or query_pairs != sorted(query_pairs):
        return None
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".localhost"):
        return None
    return value


def rpc_url_metadata(value: object, *, from_env: bool) -> tuple[urllib.parse.ParseResult | None, str | None]:
    """Validate without ever returning a credential-bearing URL in an error."""
    if not isinstance(value, str):
        return None, "RPC URL is missing"
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        return None, "RPC URL must be HTTP(S)"
    if parsed.hostname in {"127.0.0.1", "localhost", "::1"}:
        return None, "Loopback RPC is forbidden in submission mode"
    if parsed.scheme != "https":
        return None, "Submission RPC must use HTTPS"
    if not from_env and (parsed.username or parsed.password or parsed.query or parsed.fragment):
        return None, "Credential-bearing RPC URLs must be supplied through --rpc-url-env"
    return parsed, None


def check_required_files(root: Path) -> list[Result]:
    checks = {
        "README": ["README.md"],
        "environment template": [".env.example"],
        "build status": ["docs/BUILD_STATUS.md", "docs/build-status.md"],
        "architecture": ["docs/ARCHITECTURE.md", "docs/architecture.md"],
        "demo script": ["docs/DEMO_SCRIPT.md", "docs/demo-script.md"],
        "submission deck source": ["docs/SUBMISSION_DECK.md", "docs/submission-deck.md"],
        "payment evidence": ["artifacts/payment-evidence.json"],
    }
    results: list[Result] = []
    for label, candidates in checks.items():
        path = first_existing(root, candidates)
        if path:
            results.append(result("PASS", f"file.{label}", f"Found {path.relative_to(root)}"))
        else:
            results.append(result("FAIL", f"file.{label}", f"Missing {label}: expected {candidates}"))

    manifest = root / "package.json"
    if manifest.is_file():
        results.append(result("PASS", "file.manifest", "Found package.json"))
    else:
        results.append(result("FAIL", "file.manifest", "Missing package.json"))

    lockfile = first_existing(root, ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"])
    if lockfile:
        results.append(result("PASS", "file.lock", f"Found {lockfile.name}"))
    else:
        results.append(result("FAIL", "file.lock", "Missing dependency lockfile"))

    deployment = first_existing(
        root,
        ["Dockerfile", "cloudbuild.yaml", "cloudbuild.yml", "service.yaml", "app.yaml"],
    )
    if deployment:
        results.append(result("PASS", "file.deploy", f"Found {deployment.name}"))
    else:
        results.append(result("FAIL", "file.deploy", "Missing Cloud Run/deployment artifact"))
    return results


def load_package(root: Path) -> tuple[dict[str, Any] | None, list[Result]]:
    path = root / "package.json"
    if not path.is_file():
        return None, []
    try:
        payload = json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        return None, [result("FAIL", "package.json", f"Invalid package.json: {exc}")]
    if not isinstance(payload, dict):
        return None, [result("FAIL", "package.json", "package.json root must be an object")]
    return payload, []


def check_package_scripts(root: Path) -> list[Result]:
    payload, results = load_package(root)
    if payload is None:
        return results
    scripts = payload.get("scripts")
    if not isinstance(scripts, dict):
        scripts = {}
    for name in REQUIRED_PACKAGE_SCRIPTS:
        command = scripts.get(name)
        if isinstance(command, str) and command.strip():
            results.append(result("PASS", f"script.{name}", f"Package script '{name}' is defined"))
        else:
            results.append(result("FAIL", f"script.{name}", f"Missing package script '{name}'"))
    return results


def package_manager(root: Path) -> str:
    if (root / "pnpm-lock.yaml").is_file():
        return "pnpm"
    if (root / "yarn.lock").is_file():
        return "yarn"
    if (root / "bun.lock").is_file():
        return "bun"
    return "npm"


def is_trivial_script(command: str) -> bool:
    normalized = re.sub(r"\s+", " ", command.strip().lower())
    return bool(
        re.fullmatch(r"(?:(?:echo|printf)\b.*|true|:|exit 0)", normalized)
        or re.fullmatch(r"(?:node|python3?) -e ['\"]?(?:process\.exit\(0\)|pass)['\"]?", normalized)
    )


def run_repository_scripts(root: Path, timeout: int) -> CommandRun:
    """Execute, rather than trust, every package script needed by submission mode."""
    payload, load_results = load_package(root)
    now = datetime.now(timezone.utc)
    nonce = secrets.token_hex(24)
    if payload is None:
        return CommandRun(
            load_results or [result("FAIL", "commands.manifest", "Cannot run scripts without package.json")],
            nonce,
            now,
            datetime.now(timezone.utc),
        )
    scripts = payload.get("scripts")
    if not isinstance(scripts, dict):
        scripts = {}
    missing = [name for name in REQUIRED_PACKAGE_SCRIPTS if not isinstance(scripts.get(name), str)]
    if missing:
        return CommandRun(
            [result("FAIL", "commands.scripts", f"Cannot execute missing scripts: {missing}")],
            nonce,
            now,
            datetime.now(timezone.utc),
        )

    manager = package_manager(root)
    results: list[Result] = []
    # Verification scripts must not inherit wallet/model/cloud credentials merely
    # because the caller had them exported. Repositories that genuinely need a
    # test value should load an ignored test env explicitly inside that script.
    allowed_environment = {
        "CI",
        "HOME",
        "LANG",
        "LC_ALL",
        "NO_COLOR",
        "PATH",
        "SHELL",
        "TEMP",
        "TERM",
        "TMP",
        "TMPDIR",
        "USER",
    }
    environment = {key: value for key, value in os.environ.items() if key in allowed_environment}
    environment["UPTIME402_VERIFICATION_NONCE"] = nonce
    for name in REQUIRED_PACKAGE_SCRIPTS:
        declared = str(scripts[name])
        if is_trivial_script(declared):
            results.append(result("FAIL", f"commands.{name}", f"Package script '{name}' is a trivial no-op"))
            continue
        command = [manager, "run", name]
        try:
            completed = subprocess.run(
                command,
                cwd=root,
                env=environment,
                check=False,
                capture_output=True,
                text=False,
                timeout=timeout,
            )
        except FileNotFoundError:
            results.append(result("FAIL", f"commands.{name}", f"Executable not found: {manager}"))
            continue
        except subprocess.TimeoutExpired:
            results.append(result("FAIL", f"commands.{name}", f"Timed out after {timeout}s"))
            continue
        output = (completed.stdout or b"") + (completed.stderr or b"")
        output_hash = hashlib.sha256(output).hexdigest()
        if completed.returncode == 0:
            results.append(
                result(
                    "PASS",
                    f"commands.{name}",
                    f"Executed {' '.join(command)} (exit 0, output sha256:{output_hash})",
                )
            )
        else:
            results.append(
                result(
                    "FAIL",
                    f"commands.{name}",
                    f"Executed {' '.join(command)} (exit {completed.returncode}, output sha256:{output_hash})",
                )
            )
    return CommandRun(results, nonce, now, datetime.now(timezone.utc))


def check_verification_report(root: Path, command_run: CommandRun) -> list[Result]:
    """Require a nonce-bound report freshly emitted by the integration verifier."""
    path = root / "artifacts/verification-report.json"
    if not path.is_file():
        return [result("FAIL", "commands.verification_report", "evidence:verify did not emit verification-report.json")]
    try:
        payload = json.loads(read_text(path))
    except json.JSONDecodeError:
        return [result("FAIL", "commands.verification_report", "Verification report is invalid JSON")]
    if not isinstance(payload, dict):
        return [result("FAIL", "commands.verification_report", "Verification report must be an object")]
    results: list[Result] = []
    if payload.get("schemaVersion") != "1.0" or payload.get("nonce") != command_run.nonce:
        results.append(result("FAIL", "commands.verification_nonce", "Report is not bound to this checker invocation"))
    produced_at = parse_timestamp(payload.get("producedAt"))
    if produced_at is None or not (
        command_run.started_at.replace(microsecond=0) <= produced_at <= command_run.finished_at.replace(microsecond=999999)
    ):
        results.append(result("FAIL", "commands.verification_time", "Report was not freshly produced during this run"))
    evidence_path = root / "artifacts/payment-evidence.json"
    if not evidence_path.is_file() or payload.get("evidenceSha256") != file_digest(evidence_path):
        results.append(result("FAIL", "commands.verification_evidence", "Report does not hash-bind final payment evidence"))
    checks = payload.get("checks")
    required = {
        "geminiRuntime",
        "a2aRemoteService",
        "autonomousNoPrompt",
        "policyAllow",
        "policyDeny",
        "recoveryOutcome",
        "x402RoundTrip",
        "offerSignature",
        "fulfillmentReceiptSignature",
        "cloudRunIdentityBoundary",
        "executorUnauthenticatedDenied",
        "signerSecretLeastPrivilege",
        "urlCanonicalization",
    }
    if not isinstance(checks, dict) or any(checks.get(key) is not True for key in required):
        results.append(result("FAIL", "commands.verification_checks", f"Verifier must pass checks: {sorted(required)}"))
    if not results:
        results.append(result("PASS", "commands.verification_report", "Fresh nonce/evidence-bound integration report verified"))
    return results


def check_readme(root: Path) -> list[Result]:
    path = root / "README.md"
    if not path.is_file():
        return []
    text = read_text(path)
    patterns = {
        "run instructions": r"(?:run|실행|quickstart|getting started)",
        "tests": r"(?:test|테스트)",
        "Devnet": r"devnet",
        "Solana": r"solana",
        "USDC": r"usdc",
        "x402": r"x402",
        "Cloud Run": r"cloud\s*run",
        "security": r"(?:security|보안|threat model)",
        "transaction verification": r"(?:explorer|transaction|트랜잭션|signature|서명)",
    }
    results: list[Result] = []
    for label, pattern in patterns.items():
        if re.search(pattern, text, re.IGNORECASE):
            results.append(result("PASS", f"readme.{label}", f"README covers {label}"))
        else:
            results.append(result("FAIL", f"readme.{label}", f"README does not cover {label}"))
    return results


def find_secret_arrays(value: object, location: str = "$") -> list[str]:
    issues: list[str] = []
    if isinstance(value, list):
        if len(value) in {32, 64} and all(isinstance(item, int) and 0 <= item <= 255 for item in value):
            issues.append(f"{location} contains a {len(value)}-byte integer key array")
        for index, item in enumerate(value):
            issues.extend(find_secret_arrays(item, f"{location}[{index}]"))
    elif isinstance(value, dict):
        for key, item in value.items():
            normalized = re.sub(r"[^a-z]", "", str(key).lower())
            if normalized in {"privatekey", "secretkey", "keypair", "mnemonic", "seedphrase"}:
                if isinstance(item, str) and looks_like_literal_secret(item):
                    decoded = base58_decode(item)
                    if decoded is not None and len(decoded) in {32, 64}:
                        issues.append(f"{location}.{key} contains a base58 private-key-like value")
                    elif normalized in {"mnemonic", "seedphrase"} and len(item.split()) in {12, 15, 18, 21, 24}:
                        issues.append(f"{location}.{key} contains a mnemonic-like phrase")
            issues.extend(find_secret_arrays(item, f"{location}.{key}"))
    return issues


def looks_like_literal_secret(value: str) -> bool:
    cleaned = value.strip().strip("'\"`,;")
    if not cleaned or len(cleaned) < 16 or PLACEHOLDER_RE.search(cleaned):
        return False
    lower = cleaned.lower()
    if lower.startswith(("process.env", "os.environ", "import.meta.env", "deno.env")):
        return False
    if cleaned.startswith(("$", "${")) or lower in {"null", "none", "undefined"}:
        return False
    return True


def git_file_sets(root: Path) -> tuple[set[Path], set[Path]]:
    try:
        git_root_result = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        git_root = Path(git_root_result.stdout.strip()).resolve()
        tracked_result = subprocess.run(
            ["git", "-C", str(git_root), "ls-files", "--cached"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        ignored_result = subprocess.run(
            ["git", "-C", str(git_root), "ls-files", "--others", "--ignored", "--exclude-standard"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return set(), set()
    tracked = {(git_root / line).resolve() for line in tracked_result.stdout.splitlines() if line}
    ignored = {(git_root / line).resolve() for line in ignored_result.stdout.splitlines() if line}
    return tracked, ignored


def secret_results(root: Path, issues: list[tuple[Path, str]], submission: bool, code: str) -> list[Result]:
    if not issues:
        return [result("PASS", code, "No secret-like material detected")]
    tracked, ignored = git_file_sets(root)
    hard: list[str] = []
    local: list[str] = []
    for path, detail in issues:
        label = f"{path.relative_to(root).as_posix()}: {detail}"
        parts = path.relative_to(root).parts
        in_bundle = any(part in {".next", "dist", "out"} for part in parts)
        is_ignored = path.resolve() in ignored
        if path.resolve() in tracked or in_bundle or (submission and not is_ignored):
            hard.append(label)
        else:
            qualifier = "ignored local" if is_ignored else "untracked/local"
            local.append(f"{label} ({qualifier})")
    results: list[Result] = []
    if hard:
        results.append(result("FAIL", code, f"Tracked/submission/bundle secret leak: {hard[:20]}"))
    if local:
        results.append(result("WARN", f"{code}.local", f"Local secret-like material (do not bundle/commit): {local[:20]}"))
    return results


def check_secret_contents(root: Path, *, submission: bool) -> list[Result]:
    issues: list[tuple[Path, str]] = []
    assignment_re = re.compile(
        r"(?im)^[ \t]*(?:export[ \t]+)?(?:SOLANA_(?:PRIVATE|SECRET)_KEY|PRIVATE_KEY|SECRET_KEY|"
        r"WALLET_(?:PRIVATE_)?KEY|KEYPAIR|GEMINI_API_KEY|GOOGLE_API_KEY)[ \t]*[:=][ \t]*([^\r\n]*)[ \t]*$"
    )
    inline_array_re = re.compile(r"\[(?:\s*\d{1,3}\s*,){31,63}\s*\d{1,3}\s*\]")
    mnemonic_re = re.compile(
        r"(?im)^[ \t]*(?:MNEMONIC|SEED_PHRASE)[ \t]*[:=][ \t]*([^\r\n]+)$"
    )
    for path in walk_files(root, include_build_outputs=True):
        try:
            if path.stat().st_size > 2 * 1024 * 1024:
                continue
            raw = path.read_bytes()
        except OSError:
            continue
        if b"\x00" in raw[:4096]:
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        relative = path.relative_to(root).as_posix()
        if "-----BEGIN PRIVATE KEY-----" in text or "-----BEGIN EC PRIVATE KEY-----" in text:
            issues.append((path, "PEM private key"))
        for match in assignment_re.finditer(text):
            if looks_like_literal_secret(match.group(1)):
                issues.append((path, f"literal secret assigned on line {text.count(chr(10), 0, match.start()) + 1}"))
        for match in mnemonic_re.finditer(text):
            words = match.group(1).strip().strip("'\"").split()
            if len(words) in {12, 15, 18, 21, 24} and not PLACEHOLDER_RE.search(match.group(1)):
                issues.append((path, f"mnemonic-like phrase on line {text.count(chr(10), 0, match.start()) + 1}"))
        for match in inline_array_re.finditer(text):
            try:
                numbers = json.loads(match.group(0))
            except json.JSONDecodeError:
                continue
            if len(numbers) in {32, 64} and all(isinstance(item, int) and 0 <= item <= 255 for item in numbers):
                issues.append((path, f"inline {len(numbers)}-byte key-like array"))
        if path.suffix.lower() == ".json":
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue
            for issue in find_secret_arrays(payload):
                issues.append((path, issue))
        if len(issues) >= 20:
            break
    return secret_results(root, issues, submission, "security.secret_content")


def check_secret_filenames(root: Path, *, submission: bool) -> list[Result]:
    suspicious: list[tuple[Path, str]] = []
    patterns = (
        re.compile(r"^\.env(?:\..+)?$", re.I),
        re.compile(r"(?:keypair|private[-_]?key|seed|wallet|secret).*(?:\.json|\.txt|\.key|\.pem)$", re.I),
        re.compile(r"^id\.json$", re.I),
    )
    safe_names = {".env.example", ".env.sample", "payment-evidence.json"}
    for path in walk_files(root):
        if path.name.lower() in safe_names:
            continue
        if any(pattern.search(path.name) for pattern in patterns):
            suspicious.append((path, "secret-like filename"))
    return secret_results(root, suspicious, submission, "security.secret_files")


def load_evidence(root: Path) -> tuple[dict[str, Any] | None, list[Result]]:
    path = root / "artifacts/payment-evidence.json"
    if not path.is_file():
        return None, []
    try:
        payload = json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        return None, [result("FAIL", "evidence.json", f"Invalid payment evidence JSON: {exc}")]
    if not isinstance(payload, dict):
        return None, [result("FAIL", "evidence.shape", "Evidence root must be an object")]
    return payload, []


def check_payment_shape(payload: dict[str, Any]) -> list[Result]:
    results: list[Result] = []
    if payload.get("schemaVersion") == "2.0":
        results.append(result("PASS", "evidence.version", "Evidence schemaVersion is 2.0"))
    else:
        results.append(result("FAIL", "evidence.version", "Evidence schemaVersion must be '2.0'"))
    if parse_timestamp(payload.get("generatedAt")) is None:
        results.append(result("FAIL", "evidence.generated_at", "generatedAt must be a timezone-aware ISO timestamp"))

    for key in ("project", "attestations"):
        if isinstance(payload.get(key), dict):
            results.append(result("PASS", f"evidence.{key}", f"{key} object is present"))
        else:
            results.append(result("FAIL", f"evidence.{key}", f"{key} must be an object"))

    payments = payload.get("payments")
    if not isinstance(payments, list) or not payments:
        results.append(result("FAIL", "evidence.payments", "At least one payment is required"))
        payments = []
    required = {
        "incidentId",
        "incidentAt",
        "mandateId",
        "paymentId",
        "offerId",
        "idempotencyKey",
        "network",
        "cluster",
        "asset",
        "assetMint",
        "decimals",
        "amount",
        "amountBaseUnits",
        "payer",
        "payee",
        "txSignature",
        "explorerUrl",
        "confirmationStatus",
        "confirmedAt",
        "resourceResponseHash",
        "executionPolicyHash",
        "challengeHash",
        "requestFingerprint",
        "x402",
        "outcome",
        "fulfillmentReceipt",
        "fulfillmentReceiptHash",
    }
    for index, item in enumerate(payments):
        prefix = f"payment[{index}]"
        if not isinstance(item, dict):
            results.append(result("FAIL", f"evidence.{prefix}", f"{prefix} must be an object"))
            continue
        missing = sorted(required - set(item))
        if missing:
            results.append(result("FAIL", f"evidence.{prefix}.fields", f"Missing fields: {missing}"))
        else:
            results.append(result("PASS", f"evidence.{prefix}.fields", "Required payment fields are present"))
        strings_to_check = (
            item.get("incidentId"),
            item.get("mandateId"),
            item.get("paymentId"),
            item.get("offerId"),
            item.get("idempotencyKey"),
            item.get("txSignature"),
        )
        if any(isinstance(value, str) and PLACEHOLDER_RE.search(value) for value in strings_to_check):
            results.append(result("FAIL", f"evidence.{prefix}.placeholders", "Placeholder-like payment value"))
        signature = str(item.get("txSignature", ""))
        if not BASE58_SIGNATURE_RE.fullmatch(signature):
            results.append(result("FAIL", f"evidence.{prefix}.signature", "Invalid Solana signature shape"))
        explorer = str(item.get("explorerUrl", ""))
        if not (explorer.startswith("https://explorer.solana.com/tx/") and signature in explorer):
            results.append(result("FAIL", f"evidence.{prefix}.explorer", "Explorer URL must bind the signature"))
        else:
            query = urllib.parse.parse_qs(urllib.parse.urlparse(explorer).query)
            explorer_cluster = query.get("cluster", [None])[0]
            if (item.get("cluster") == "devnet" and explorer_cluster != "devnet") or (
                item.get("cluster") == "mainnet-beta" and explorer_cluster not in {None, "mainnet-beta"}
            ):
                results.append(result("FAIL", f"evidence.{prefix}.explorer_cluster", "Explorer cluster mismatches evidence"))
        network = item.get("network")
        if not isinstance(network, str) or not CAIP2_SOLANA_RE.fullmatch(network):
            results.append(result("FAIL", f"evidence.{prefix}.network", "Network must be a Solana CAIP-2 identifier"))
        elif network != DEVNET_CAIP2:
            results.append(result("FAIL", f"evidence.{prefix}.network", "Network must equal the pinned Solana Devnet CAIP-2 identifier"))
        if item.get("cluster") != "devnet" or item.get("assetMint") != OFFICIAL_DEVNET_USDC_MINT:
            results.append(result("FAIL", f"evidence.{prefix}.cluster", "This harness only accepts official Solana Devnet USDC"))
        if str(item.get("asset", "")).upper() != "USDC":
            results.append(result("FAIL", f"evidence.{prefix}.asset", "Asset must be USDC"))
        if item.get("decimals") != 6:
            results.append(result("FAIL", f"evidence.{prefix}.decimals", "USDC decimals must be 6"))
        amount = parse_decimal(item.get("amount"))
        base_units = parse_positive_int(item.get("amountBaseUnits"))
        if (
            not isinstance(item.get("amount"), str)
            or not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?", item["amount"])
            or not isinstance(item.get("amountBaseUnits"), str)
            or not re.fullmatch(r"[1-9][0-9]*", item["amountBaseUnits"])
            or amount is None
            or amount <= 0
            or base_units is None
            or amount * Decimal(1_000_000) != base_units
        ):
            results.append(result("FAIL", f"evidence.{prefix}.amount", "Amount and base units are incoherent"))
        for party in ("payer", "payee"):
            if not BASE58_PUBKEY_RE.fullmatch(str(item.get(party, ""))):
                results.append(result("FAIL", f"evidence.{prefix}.{party}", f"Invalid {party} pubkey"))
        if item.get("payer") == item.get("payee"):
            results.append(result("FAIL", f"evidence.{prefix}.parties", "Payer and payee must differ"))
        if not HASH_RE.fullmatch(str(item.get("resourceResponseHash", ""))):
            results.append(result("FAIL", f"evidence.{prefix}.resource_hash", "Invalid resource response hash"))
        for hash_field in ("executionPolicyHash", "challengeHash", "requestFingerprint", "fulfillmentReceiptHash"):
            if not HASH_RE.fullmatch(str(item.get(hash_field, ""))):
                results.append(result("FAIL", f"evidence.{prefix}.{hash_field}", f"Invalid {hash_field}"))
        if item.get("confirmationStatus") not in {"confirmed", "finalized"}:
            results.append(result("FAIL", f"evidence.{prefix}.confirmation", "Invalid confirmationStatus"))
        confirmed_at = parse_timestamp(item.get("confirmedAt"))
        incident_at = parse_timestamp(item.get("incidentAt"))
        if confirmed_at is None or incident_at is None:
            results.append(result("FAIL", f"evidence.{prefix}.timestamps", "incidentAt/confirmedAt must be timezone-aware ISO timestamps"))
        elif confirmed_at < incident_at:
            results.append(result("FAIL", f"evidence.{prefix}.timestamps", "confirmedAt cannot precede incidentAt"))

    denials = payload.get("denials")
    if isinstance(denials, list) and denials:
        results.append(result("PASS", "evidence.denials", "At least one denial object is present"))
    else:
        results.append(result("FAIL", "evidence.denials", "At least one denial object is required"))
    return results


def decode_header_json(value: object) -> dict[str, Any] | None:
    if not isinstance(value, str) or len(value.strip()) < 8 or PLACEHOLDER_RE.search(value):
        return None
    encoded = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9+/_-]+={0,2}", encoded):
        return None
    try:
        padding = "=" * (-len(encoded) % 4)
        candidate = base64.b64decode(encoded + padding, altchars=b"-_", validate=True).decode("utf-8")
        payload = json.loads(candidate)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def scalar_strings(value: object) -> list[str]:
    values: list[str] = []
    if isinstance(value, dict):
        for item in value.values():
            values.extend(scalar_strings(item))
    elif isinstance(value, list):
        for item in value:
            values.extend(scalar_strings(item))
    elif isinstance(value, bool):
        values.append("true" if value else "false")
    elif value is not None:
        values.append(str(value))
    return values


def nested_value(value: object, key: str) -> object | None:
    if isinstance(value, dict):
        for candidate, item in value.items():
            if str(candidate).lower() == key.lower():
                return item
            found = nested_value(item, key)
            if found is not None:
                return found
    elif isinstance(value, list):
        for item in value:
            found = nested_value(item, key)
            if found is not None:
                return found
    return None


def check_x402(payment: dict[str, Any], index: int) -> list[Result]:
    prefix = f"evidence.payment[{index}].x402"
    x402 = payment.get("x402")
    if not isinstance(x402, dict):
        return [result("FAIL", prefix, "x402 must be an object")]
    results: list[Result] = []
    decoded: dict[str, dict[str, Any]] = {}
    expected_status = {"challenge": 402, "settlement": 200}
    captured: dict[str, datetime] = {}
    for stage in ("challenge", "payment", "settlement"):
        item = x402.get(stage)
        if not isinstance(item, dict):
            results.append(result("FAIL", f"{prefix}.{stage}", f"Missing {stage} header evidence"))
            continue
        header_name = str(item.get("headerName", "")).lower()
        if header_name not in X402_HEADER_NAMES[stage]:
            results.append(result("FAIL", f"{prefix}.{stage}.name", f"Unexpected {stage} header name"))
        if stage in expected_status and item.get("status") != expected_status[stage]:
            results.append(result("FAIL", f"{prefix}.{stage}.status", f"{stage} status must be {expected_status[stage]}"))
        timestamp = parse_timestamp(item.get("capturedAt"))
        if timestamp is None:
            results.append(result("FAIL", f"{prefix}.{stage}.time", f"{stage}.capturedAt must be ISO-8601"))
        else:
            captured[stage] = timestamp
        parsed = decode_header_json(item.get("headerValue"))
        if parsed is None:
            results.append(result("FAIL", f"{prefix}.{stage}.value", f"{stage} header is not Base64-encoded JSON"))
        else:
            decoded[stage] = parsed

    incident_at = parse_timestamp(payment.get("incidentAt"))
    if incident_at and len(captured) == 3 and not (
        incident_at <= captured["challenge"] <= captured["payment"] <= captured["settlement"]
    ):
        results.append(result("FAIL", f"{prefix}.timeline", "Incident/challenge/payment/settlement timestamps are out of order"))

    challenge = decoded.get("challenge")
    selected: dict[str, Any] | None = None
    request = x402.get("request")
    resource_url = request.get("resourceUrl") if isinstance(request, dict) else None
    method = request.get("method") if isinstance(request, dict) else None
    canonical_url = canonical_resource_url(resource_url)
    if canonical_url is None or not isinstance(method, str) or method.upper() not in {"GET", "POST"}:
        results.append(
            result(
                "FAIL",
                f"{prefix}.request",
                "x402 request needs an already-normalized, credential-free public HTTPS resourceUrl and GET/POST method",
            )
        )
    if challenge is not None:
        if challenge.get("x402Version") != 2:
            results.append(result("FAIL", f"{prefix}.challenge.version", "Challenge must use x402Version 2"))
        resource = challenge.get("resource")
        if not isinstance(resource, dict) or resource.get("url") != resource_url:
            results.append(result("FAIL", f"{prefix}.challenge.resource", "Challenge resource URL mismatches request"))
        accepts = challenge.get("accepts")
        requirements = {
            "scheme": "exact",
            "network": payment.get("network"),
            "amount": str(payment.get("amountBaseUnits")),
            "asset": payment.get("assetMint"),
            "payTo": payment.get("payee"),
        }
        if isinstance(accepts, list):
            for candidate in accepts:
                if isinstance(candidate, dict) and all(candidate.get(key) == value for key, value in requirements.items()):
                    selected = candidate
                    break
        if selected is None or not isinstance(selected.get("maxTimeoutSeconds"), int) or selected["maxTimeoutSeconds"] <= 0:
            results.append(result("FAIL", f"{prefix}.challenge.schema", "No complete matching x402 exact requirement"))
        if sha256_value(canonical_json(challenge)) != payment.get("challengeHash"):
            results.append(result("FAIL", f"{prefix}.challenge.hash", "challengeHash does not bind canonical PaymentRequired"))

    payment_header = decoded.get("payment")
    if payment_header is not None:
        if payment_header.get("x402Version") != 2 or payment_header.get("accepted") != selected:
            results.append(result("FAIL", f"{prefix}.payment.schema", "Payment payload does not bind selected requirement"))
        payload = payment_header.get("payload")
        transaction_b64 = payload.get("transaction") if isinstance(payload, dict) else None
        try:
            transaction_bytes = base64.b64decode(str(transaction_b64), validate=True)
        except (ValueError, base64.binascii.Error):
            transaction_bytes = b""
        payment_item = x402.get("payment")
        claimed_tx_hash = payment_item.get("signedTransactionSha256") if isinstance(payment_item, dict) else None
        if not transaction_bytes or sha256_value(transaction_bytes) != claimed_tx_hash:
            results.append(result("FAIL", f"{prefix}.payment.transaction", "Signed transaction bytes/hash are invalid"))
        if isinstance(payment_item, dict) and canonical_url is not None and isinstance(method, str) and selected:
            fingerprint_payload = {
                "method": method.upper(),
                "resourceUrl": canonical_url,
                "operationId": request.get("operationId") if isinstance(request, dict) else None,
                "canonicalBodyHash": request.get("canonicalBodyHash") if isinstance(request, dict) else None,
                "paymentId": payment.get("paymentId"),
                "scheme": selected.get("scheme"),
                "network": selected.get("network"),
                "assetMint": selected.get("asset"),
                "amountBaseUnits": selected.get("amount"),
                "payee": selected.get("payTo"),
            }
            if not isinstance(fingerprint_payload["operationId"], str) or not HASH_RE.fullmatch(
                str(fingerprint_payload["canonicalBodyHash"] or "")
            ):
                results.append(result("FAIL", f"{prefix}.request.binding", "Request needs operationId and canonicalBodyHash"))
            if sha256_value(canonical_json(fingerprint_payload)) != payment.get("requestFingerprint"):
                results.append(result("FAIL", f"{prefix}.payment.fingerprint", "requestFingerprint mismatch"))
    settlement = decoded.get("settlement")
    if settlement is not None:
        if settlement.get("success") is not True:
            results.append(result("FAIL", f"{prefix}.settlement.success", "Settlement header is not successful"))
        if settlement.get("transaction") != payment.get("txSignature"):
            results.append(result("FAIL", f"{prefix}.settlement.binding", "Settlement header does not bind tx signature"))
        else:
            results.append(result("PASS", f"{prefix}.settlement.binding", "Settlement header binds tx signature"))
        if settlement.get("network") != payment.get("network") or settlement.get("payer") != payment.get("payer"):
            results.append(result("FAIL", f"{prefix}.settlement.parties", "Settlement network/payer mismatch"))
    if not any(item.level == "FAIL" for item in results):
        results.append(result("PASS", prefix, "Raw x402 challenge/payment/settlement evidence is coherent"))
    return results


def check_signed_commerce_evidence(root: Path, payload: dict[str, Any]) -> list[Result]:
    offers = payload.get("offers")
    payments = payload.get("payments")
    if not isinstance(offers, list) or len(offers) < 2:
        return [result("FAIL", "evidence.offers", "At least two provider-signed offers are required")]
    offer_map: dict[str, dict[str, Any]] = {}
    results: list[Result] = []
    attestations = payload.get("attestations")
    a2a = attestations.get("a2a") if isinstance(attestations, dict) else None
    pinned_key = a2a.get("verificationPublicKey") if isinstance(a2a, dict) else None
    pinned_key_id = a2a.get("verificationKeyId") if isinstance(a2a, dict) else None
    pinned_card_hash = a2a.get("agentCardHash") if isinstance(a2a, dict) else None
    if not BASE58_PUBKEY_RE.fullmatch(str(pinned_key or "")) or not isinstance(pinned_key_id, str):
        results.append(result("FAIL", "evidence.agent_key", "A2A attestation must pin Agent Card verification key id/public key"))
    required_offer = {
        "offerId",
        "providerAgentId",
        "providerAgentCardUrl",
        "providerAgentCardHash",
        "resourceUrl",
        "network",
        "asset",
        "assetMint",
        "amountBaseUnits",
        "payee",
        "expiresAt",
    }
    for index, signed in enumerate(offers):
        prefix = f"evidence.offer[{index}]"
        offer = signed.get("payload") if isinstance(signed, dict) else None
        signer = signed.get("signer") if isinstance(signed, dict) else None
        key_id = signed.get("keyId") if isinstance(signed, dict) else None
        signature = signed.get("signature") if isinstance(signed, dict) else None
        if not isinstance(offer, dict) or required_offer - set(offer):
            results.append(result("FAIL", prefix, "Signed offer payload is incomplete"))
            continue
        if (
            signer != pinned_key
            or signer == offer.get("payee")
            or key_id != pinned_key_id
            or offer.get("providerAgentCardHash") != pinned_card_hash
            or not verify_ed25519(signer, signature, canonical_json(offer))
        ):
            results.append(result("FAIL", f"{prefix}.signature", "Offer signature is not pinned to the separate Agent Card key"))
            continue
        if not is_web_url(offer.get("providerAgentCardUrl")) or not is_web_url(offer.get("resourceUrl")):
            results.append(result("FAIL", f"{prefix}.urls", "Offer URLs must be public HTTPS"))
        if parse_timestamp(offer.get("expiresAt")) is None:
            results.append(result("FAIL", f"{prefix}.expiry", "Offer expiresAt must be ISO-8601"))
        offer_map[str(offer["offerId"])] = offer
        results.append(result("PASS", prefix, "Provider-signed offer verified"))

    selection = payload.get("selection")
    if not isinstance(selection, dict):
        results.append(result("FAIL", "evidence.selection", "Counterfactual offer selection proof is required"))
    else:
        candidate_ids = selection.get("candidateOfferIds")
        baseline = selection.get("baseline")
        counterfactual = selection.get("counterfactual")
        candidates_valid = (
            isinstance(candidate_ids, list)
            and len(candidate_ids) == len(set(candidate_ids))
            and len(candidate_ids) >= 2
            and all(isinstance(candidate, str) and candidate in offer_map for candidate in candidate_ids)
        )
        if not candidates_valid:
            results.append(result("FAIL", "evidence.selection.candidates", "Selection must compare >=2 unique verified offers"))
        decisions_valid = True
        for label, decision in (("baseline", baseline), ("counterfactual", counterfactual)):
            if (
                not isinstance(decision, dict)
                or decision.get("selectedOfferId") not in (candidate_ids if isinstance(candidate_ids, list) else [])
                or not HASH_RE.fullmatch(str(decision.get("telemetryHash", "")))
                or not HASH_RE.fullmatch(str(decision.get("modelOutputHash", "")))
                or decision.get("schemaValidated") is not True
                or parse_timestamp(decision.get("capturedAt")) is None
            ):
                decisions_valid = False
                results.append(
                    result(
                        "FAIL",
                        f"evidence.selection.{label}",
                        f"{label} must be timestamped, schema-validated, hash-bound, and select a supplied offer",
                    )
                )
        if isinstance(baseline, dict) and isinstance(counterfactual, dict):
            if baseline.get("telemetryHash") == counterfactual.get("telemetryHash"):
                decisions_valid = False
                results.append(result("FAIL", "evidence.selection.telemetry", "Counterfactual telemetry hash must differ"))
            if baseline.get("selectedOfferId") == counterfactual.get("selectedOfferId"):
                decisions_valid = False
                results.append(result("FAIL", "evidence.selection.materiality", "Counterfactual must change selectedOfferId"))
        selection_path, selection_results = check_hashed_artifact(
            root,
            selection,
            "artifactPath",
            "artifactSha256",
            "evidence.selection.artifact",
        )
        results.extend(selection_results)
        if selection_path is not None:
            try:
                selection_artifact = json.loads(read_text(selection_path))
            except json.JSONDecodeError:
                selection_artifact = None
            if not isinstance(selection_artifact, dict) or any(
                selection_artifact.get(key) != selection.get(key)
                for key in ("candidateOfferIds", "baseline", "counterfactual")
            ):
                results.append(result("FAIL", "evidence.selection.artifact_binding", "Selection artifact does not bind both decisions"))
        if candidates_valid and decisions_valid and not any(
            entry.level == "FAIL" and entry.code.startswith("evidence.selection.artifact") for entry in results
        ):
            results.append(result("PASS", "evidence.selection.materiality", "Counterfactual telemetry changes the verified offer selection"))

    if not isinstance(payments, list):
        return results
    for index, payment in enumerate(payments):
        prefix = f"evidence.payment[{index}].receipt"
        if not isinstance(payment, dict):
            continue
        offer = offer_map.get(str(payment.get("offerId")))
        baseline_selection = selection.get("baseline") if isinstance(selection, dict) else None
        if isinstance(baseline_selection, dict) and baseline_selection.get("selectedOfferId") != payment.get("offerId"):
            results.append(result("FAIL", f"{prefix}.selection", "Payment does not use the selected offer"))
        if offer is None:
            results.append(result("FAIL", f"{prefix}.offer", "Payment does not reference a verified offer"))
        else:
            expected_offer_fields = {
                "network": payment.get("network"),
                "asset": payment.get("asset"),
                "assetMint": payment.get("assetMint"),
                "amountBaseUnits": str(payment.get("amountBaseUnits")),
                "payee": payment.get("payee"),
            }
            if any(offer.get(key) != value for key, value in expected_offer_fields.items()):
                results.append(result("FAIL", f"{prefix}.offer_binding", "Payment differs from signed offer"))
            incident_at = parse_timestamp(payment.get("incidentAt"))
            paid_at = None
            x402 = payment.get("x402")
            if isinstance(x402, dict) and isinstance(x402.get("payment"), dict):
                paid_at = parse_timestamp(x402["payment"].get("capturedAt"))
            expires_at = parse_timestamp(offer.get("expiresAt"))
            if expires_at is None or any(
                timestamp is not None and timestamp > expires_at
                for timestamp in (incident_at, paid_at, parse_timestamp(payment.get("confirmedAt")))
            ):
                results.append(result("FAIL", f"{prefix}.offer_expired", "Offer was expired during the paid execution"))
        signed_receipt = payment.get("fulfillmentReceipt")
        receipt = signed_receipt.get("payload") if isinstance(signed_receipt, dict) else None
        signer = signed_receipt.get("signer") if isinstance(signed_receipt, dict) else None
        key_id = signed_receipt.get("keyId") if isinstance(signed_receipt, dict) else None
        signature = signed_receipt.get("signature") if isinstance(signed_receipt, dict) else None
        expected_receipt = {
            "version": "1",
            "paymentId": payment.get("paymentId"),
            "offerId": payment.get("offerId"),
            "incidentId": payment.get("incidentId"),
            "requestFingerprint": payment.get("requestFingerprint"),
            "challengeHash": payment.get("challengeHash"),
            "executionPolicyHash": payment.get("executionPolicyHash"),
            "txSignature": payment.get("txSignature"),
            "resourceResponseHash": payment.get("resourceResponseHash"),
            "resourceUrl": payment.get("x402", {}).get("request", {}).get("resourceUrl")
            if isinstance(payment.get("x402"), dict)
            else None,
            "payer": payment.get("payer"),
            "payee": payment.get("payee"),
            "assetMint": payment.get("assetMint"),
            "amountBaseUnits": str(payment.get("amountBaseUnits")),
        }
        if not isinstance(receipt, dict) or any(receipt.get(key) != value for key, value in expected_receipt.items()):
            results.append(result("FAIL", f"{prefix}.binding", "FulfillmentReceipt does not bind payment/response/outcome"))
        elif (
            signer != pinned_key
            or signer == payment.get("payee")
            or key_id != pinned_key_id
            or not verify_ed25519(signer, signature, canonical_json(receipt))
        ):
            results.append(result("FAIL", f"{prefix}.signature", "Receipt signature is not pinned to the separate Agent Card key"))
        elif not isinstance(receipt.get("issuerAgentId"), str) or not receipt.get("issuerAgentId"):
            results.append(result("FAIL", f"{prefix}.issuer", "FulfillmentReceipt issuerAgentId is required"))
        elif parse_timestamp(receipt.get("fulfilledAt")) is None:
            results.append(result("FAIL", f"{prefix}.time", "FulfillmentReceipt fulfilledAt is invalid"))
        elif (
            parse_timestamp(payment.get("confirmedAt")) is None
            or parse_timestamp(payment.get("confirmedAt")) > parse_timestamp(receipt.get("fulfilledAt"))
        ):
            results.append(result("FAIL", f"{prefix}.timeline", "Receipt must be fulfilled after on-chain confirmation"))
        elif sha256_value(canonical_json(signed_receipt)) != payment.get("fulfillmentReceiptHash"):
            results.append(result("FAIL", f"{prefix}.hash", "fulfillmentReceiptHash mismatch"))
        else:
            results.append(result("PASS", prefix, "Signed FulfillmentReceipt verified and bound through paid response"))
    return results


def check_hashed_artifact(
    root: Path,
    obj: dict[str, Any],
    path_key: str,
    hash_key: str,
    code: str,
) -> tuple[Path | None, list[Result]]:
    path = resolve_repo_file(root, obj.get(path_key))
    if path is None:
        return None, [result("FAIL", code, f"Missing/unsafe artifact path in {path_key}")]
    claimed = str(obj.get(hash_key, ""))
    actual = file_digest(path)
    if claimed.lower() != actual.lower():
        return path, [result("FAIL", code, f"Artifact hash mismatch for {path.relative_to(root.resolve())}")]
    return path, [result("PASS", code, f"Artifact hash verified: {path.relative_to(root.resolve())}")]


def check_outcome(
    root: Path,
    payment: dict[str, Any],
    index: int,
    attestations: dict[str, Any] | None,
) -> list[Result]:
    prefix = f"evidence.payment[{index}].outcome"
    signed_outcome = payment.get("outcome")
    if not isinstance(signed_outcome, dict):
        return [result("FAIL", prefix, "Outcome must be an object")]
    outcome = signed_outcome.get("payload")
    if not isinstance(outcome, dict):
        return [result("FAIL", prefix, "RecoveryOutcomeEvent payload is required")]
    path, results = check_hashed_artifact(root, signed_outcome, "artifactPath", "artifactSha256", prefix)
    expected = {
        "incidentId": payment.get("incidentId"),
        "paymentId": payment.get("paymentId"),
        "fulfillmentReceiptHash": payment.get("fulfillmentReceiptHash"),
        "resourceResponseHash": payment.get("resourceResponseHash"),
    }
    for key, value in expected.items():
        if outcome.get(key) != value:
            results.append(result("FAIL", f"{prefix}.{key}", f"Outcome does not bind payment {key}"))
    before = outcome.get("statusBefore")
    after = outcome.get("statusAfter")
    if (
        before not in {"degraded", "down"}
        or after != "healthy"
        or not HASH_RE.fullmatch(str(outcome.get("healthProbeHash", "")))
        or parse_timestamp(outcome.get("recoveredAt")) is None
    ):
        results.append(result("FAIL", f"{prefix}.state", "Outcome must show a timestamped, probe-bound state transition"))
    receipt = payment.get("fulfillmentReceipt")
    receipt_payload = receipt.get("payload") if isinstance(receipt, dict) else None
    fulfilled_at = parse_timestamp(receipt_payload.get("fulfilledAt")) if isinstance(receipt_payload, dict) else None
    recovered_at = parse_timestamp(outcome.get("recoveredAt"))
    confirmed_at = parse_timestamp(payment.get("confirmedAt"))
    if not all((confirmed_at, fulfilled_at, recovered_at)) or not (confirmed_at <= fulfilled_at <= recovered_at):
        results.append(
            result(
                "FAIL",
                f"{prefix}.timeline",
                "Chronology must be chain confirmation -> vendor fulfillment receipt -> buyer recovery outcome",
            )
        )
    autonomy = attestations.get("autonomy") if isinstance(attestations, dict) else None
    signer = signed_outcome.get("signer")
    key_id = signed_outcome.get("keyId")
    control_key = autonomy.get("verificationPublicKey") if isinstance(autonomy, dict) else None
    control_key_id = autonomy.get("verificationKeyId") if isinstance(autonomy, dict) else None
    if (
        signer != control_key
        or key_id != control_key_id
        or signer == payment.get("payer")
        or not verify_ed25519(signer, signed_outcome.get("signature"), canonical_json(outcome))
    ):
        results.append(result("FAIL", f"{prefix}.signature", "RecoveryOutcomeEvent control-plane signature is invalid"))
    if path is not None:
        try:
            artifact = json.loads(read_text(path))
        except json.JSONDecodeError:
            artifact = None
        if not isinstance(artifact, dict):
            results.append(result("FAIL", f"{prefix}.artifact", "Outcome artifact must be JSON"))
        else:
            for key, value in {
                **expected,
                "statusBefore": before,
                "statusAfter": after,
                "healthProbeHash": outcome.get("healthProbeHash"),
                "recoveredAt": outcome.get("recoveredAt"),
            }.items():
                if artifact.get(key) != value:
                    results.append(result("FAIL", f"{prefix}.artifact_binding", f"Outcome artifact mismatches {key}"))
    if not any(item.level == "FAIL" for item in results):
        results.append(result("PASS", f"{prefix}.binding", "Buyer-signed RecoveryOutcomeEvent binds receipt, response, and health transition"))
    return results


def check_denials(root: Path, payload: dict[str, Any]) -> list[Result]:
    denials = payload.get("denials")
    if not isinstance(denials, list) or not denials:
        return [result("FAIL", "evidence.denial", "At least one denial is required")]
    results: list[Result] = []
    for index, denial in enumerate(denials):
        prefix = f"evidence.denial[{index}]"
        if not isinstance(denial, dict):
            results.append(result("FAIL", prefix, "Denial must be an object"))
            continue
        required = {
            "incidentId",
            "mandateId",
            "reasonCode",
            "attemptedAt",
            "attemptedAmountBaseUnits",
            "perTransactionLimitBaseUnits",
            "executionPolicyHash",
            "transactionCreated",
            "txSignature",
            "artifactPath",
            "artifactSha256",
        }
        missing = sorted(required - set(denial))
        if missing:
            results.append(result("FAIL", f"{prefix}.fields", f"Missing denial fields: {missing}"))
            continue
        attempted = parse_positive_int(denial.get("attemptedAmountBaseUnits"))
        limit = parse_positive_int(denial.get("perTransactionLimitBaseUnits"))
        if attempted is None or limit is None or attempted <= limit:
            results.append(result("FAIL", f"{prefix}.limit", "Denied amount must exceed the recorded limit"))
        if denial.get("transactionCreated") is not False or denial.get("txSignature") is not None:
            results.append(result("FAIL", f"{prefix}.transaction", "Denial must have no transaction/signature"))
        if parse_timestamp(denial.get("attemptedAt")) is None or not HASH_RE.fullmatch(
            str(denial.get("executionPolicyHash", ""))
        ):
            results.append(result("FAIL", f"{prefix}.policy", "Denial needs attemptedAt and executionPolicyHash"))
        path, artifact_results = check_hashed_artifact(
            root, denial, "artifactPath", "artifactSha256", f"{prefix}.artifact_hash"
        )
        results.extend(artifact_results)
        if path is not None:
            try:
                artifact = json.loads(read_text(path))
            except json.JSONDecodeError:
                artifact = None
            if not isinstance(artifact, dict):
                results.append(result("FAIL", f"{prefix}.artifact", "Denial artifact must be JSON"))
            else:
                for key in ("incidentId", "reasonCode", "transactionCreated", "executionPolicyHash"):
                    if artifact.get(key) != denial.get(key):
                        results.append(result("FAIL", f"{prefix}.binding", f"Denial artifact mismatches {key}"))
    if not any(item.level == "FAIL" for item in results):
        results.append(result("PASS", "evidence.denial", "Policy denial is hash-bound and has no transaction"))
    return results


def check_attestations(root: Path, payload: dict[str, Any]) -> list[Result]:
    attestations = payload.get("attestations")
    if not isinstance(attestations, dict):
        return [result("FAIL", "evidence.attestations", "Attestations object is required")]
    required_claims = ("gemini", "a2a", "autonomy", "policy")
    results: list[Result] = []
    for claim in required_claims:
        prefix = f"evidence.attestation.{claim}"
        item = attestations.get(claim)
        if not isinstance(item, dict) or item.get("implemented") is not True:
            results.append(result("FAIL", prefix, f"{claim} implemented attestation is required"))
            continue
        source_paths = item.get("sourcePaths")
        if not isinstance(source_paths, list) or not source_paths:
            results.append(result("FAIL", f"{prefix}.sources", "At least one source path is required"))
        else:
            missing = [value for value in source_paths if resolve_repo_file(root, value) is None]
            if missing:
                results.append(result("FAIL", f"{prefix}.sources", f"Missing/unsafe source paths: {missing}"))
        runtime: dict[str, Any] | None = None
        path, artifact_results = check_hashed_artifact(
            root, item, "runtimeArtifact", "runtimeArtifactSha256", f"{prefix}.runtime"
        )
        results.extend(artifact_results)
        if path is not None:
            try:
                runtime = json.loads(read_text(path))
            except json.JSONDecodeError:
                runtime = None
            if not isinstance(runtime, dict):
                results.append(result("FAIL", f"{prefix}.runtime_shape", "Runtime artifact must be JSON"))
        if claim == "gemini" and (
            not isinstance(item.get("model"), str) or "gemini" not in item["model"].lower()
        ):
            results.append(result("FAIL", f"{prefix}.model", "Gemini model identifier is required"))
        if claim == "a2a":
            key_id = item.get("verificationKeyId")
            public_key = item.get("verificationPublicKey")
            verification_methods = runtime.get("verificationMethods") if isinstance(runtime, dict) else None
            agent_card_hash = item.get("agentCardHash")
            pinned = isinstance(verification_methods, list) and any(
                isinstance(method, dict)
                and method.get("id") == key_id
                and method.get("publicKeyBase58") == public_key
                for method in verification_methods
            )
            if (
                item.get("separateService") is not True
                or not is_web_url(item.get("agentCardUrl"))
                or not BASE58_PUBKEY_RE.fullmatch(str(public_key or ""))
                or not HASH_RE.fullmatch(str(agent_card_hash or ""))
                or not isinstance(runtime, dict)
                or sha256_value(canonical_json(runtime)) != agent_card_hash
                or not pinned
            ):
                results.append(result("FAIL", f"{prefix}.service", "A2A Agent Card hash/key must be canonically pinned"))
        if claim == "autonomy" and (
            item.get("humanApprovalPerPayment") is not False or item.get("automaticSigning") is not True
        ):
            results.append(result("FAIL", f"{prefix}.approval", "Autonomy must attest no per-payment approval and automatic signing"))
        if claim == "autonomy":
            key_id = item.get("verificationKeyId")
            public_key = item.get("verificationPublicKey")
            verification_methods = runtime.get("verificationMethods") if isinstance(runtime, dict) else None
            pinned = isinstance(verification_methods, list) and any(
                isinstance(method, dict)
                and method.get("id") == key_id
                and method.get("publicKeyBase58") == public_key
                for method in verification_methods
            )
            if not BASE58_PUBKEY_RE.fullmatch(str(public_key or "")) or not pinned:
                results.append(result("FAIL", f"{prefix}.key", "Autonomy artifact must pin the recovery signing key"))
        if claim == "policy" and (
            item.get("deterministic") is not True
            or not item.get("enforcedLimits")
            or not HASH_RE.fullmatch(str(item.get("executionPolicyHash", "")))
            or not isinstance(runtime, dict)
            or sha256_value(canonical_json(runtime)) != item.get("executionPolicyHash")
        ):
            results.append(result("FAIL", f"{prefix}.limits", "Policy must attest canonical deterministic limits"))
        if claim == "policy":
            payments = payload.get("payments")
            if not isinstance(payments, list) or any(
                not isinstance(payment, dict)
                or payment.get("executionPolicyHash") != item.get("executionPolicyHash")
                for payment in payments
            ):
                results.append(result("FAIL", f"{prefix}.binding", "Payments must bind the hashed policy runtime artifact"))
        if not any(entry.level == "FAIL" and entry.code.startswith(prefix) for entry in results):
            results.append(result("PASS", prefix, f"{claim} source and runtime attestation is complete"))
    a2a = attestations.get("a2a")
    autonomy = attestations.get("autonomy")
    vendor_key = a2a.get("verificationPublicKey") if isinstance(a2a, dict) else None
    vendor_key_id = a2a.get("verificationKeyId") if isinstance(a2a, dict) else None
    recovery_key = autonomy.get("verificationPublicKey") if isinstance(autonomy, dict) else None
    recovery_key_id = autonomy.get("verificationKeyId") if isinstance(autonomy, dict) else None
    if (
        not isinstance(vendor_key, str)
        or not isinstance(recovery_key, str)
        or vendor_key == recovery_key
        or not isinstance(vendor_key_id, str)
        or not isinstance(recovery_key_id, str)
        or vendor_key_id == recovery_key_id
    ):
        results.append(
            result(
                "FAIL",
                "evidence.attestation.key_separation",
                "Vendor offer/receipt key and control-plane recovery key must be distinct",
            )
        )
    else:
        results.append(
            result(
                "PASS",
                "evidence.attestation.key_separation",
                "Vendor receipt and control-plane recovery signing authorities are distinct",
            )
        )
    return results


def rpc_call(url: str, method: str, params: list[Any], timeout: int) -> Any:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "uptime402-readiness/2"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict) or payload.get("error"):
        raise ValueError(f"RPC {method} returned error: {payload!r}")
    return payload.get("result")


def token_totals(balances: object, mint: str, decimals: int) -> dict[str, int]:
    totals: dict[str, int] = {}
    if not isinstance(balances, list):
        return totals
    for item in balances:
        if not isinstance(item, dict) or item.get("mint") != mint:
            continue
        owner = item.get("owner")
        token_amount = item.get("uiTokenAmount")
        if not isinstance(owner, str) or not isinstance(token_amount, dict):
            continue
        if token_amount.get("decimals") != decimals:
            continue
        try:
            amount = int(str(token_amount.get("amount")))
        except (TypeError, ValueError):
            continue
        totals[owner] = totals.get(owner, 0) + amount
    return totals


def check_rpc_payments(
    payload: dict[str, Any],
    rpc_url: str | None,
    timeout: int,
    expected_usdc_mint: str | None,
    *,
    label: str = "primary",
) -> list[Result]:
    code_root = f"rpc.{label}"
    if not rpc_url:
        return [result("FAIL", f"{code_root}.url", "RPC URL is missing")]
    if expected_usdc_mint != OFFICIAL_DEVNET_USDC_MINT:
        return [result("FAIL", f"{code_root}.usdc_mint", "--usdc-mint must equal the official Devnet USDC mint")]
    results: list[Result] = []
    try:
        genesis = rpc_call(rpc_url, "getGenesisHash", [], timeout)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return [result("FAIL", f"{code_root}.connection", f"RPC request failed ({type(exc).__name__}); URL redacted")]
    if genesis != DEVNET_GENESIS_HASH:
        return [result("FAIL", f"{code_root}.genesis", "RPC genesis is not the pinned Solana Devnet genesis")]
    caip_network = f"solana:{genesis[:32]}"

    payments = payload.get("payments")
    if not isinstance(payments, list):
        return [result("FAIL", f"{code_root}.payments", "No payments to verify")]
    for index, payment in enumerate(payments):
        prefix = f"{code_root}.payment[{index}]"
        if not isinstance(payment, dict):
            results.append(result("FAIL", prefix, "Payment must be an object"))
            continue
        network = str(payment.get("network", ""))
        if network != caip_network:
            results.append(result("FAIL", f"{prefix}.genesis", "Full RPC genesis does not derive the recorded CAIP-2 network"))
            continue
        mint = str(payment.get("assetMint", ""))
        if mint != expected_usdc_mint:
            results.append(result("FAIL", f"{prefix}.mint", "Payment mint differs from explicitly supplied USDC mint"))
            continue
        signature = str(payment.get("txSignature", ""))
        try:
            status_result = rpc_call(
                rpc_url,
                "getSignatureStatuses",
                [[signature], {"searchTransactionHistory": True}],
                timeout,
            )
            transaction = rpc_call(
                rpc_url,
                "getTransaction",
                [signature, {"encoding": "jsonParsed", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}],
                timeout,
            )
            raw_transaction = rpc_call(
                rpc_url,
                "getTransaction",
                [signature, {"encoding": "base64", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}],
                timeout,
            )
            supply = rpc_call(rpc_url, "getTokenSupply", [mint, {"commitment": "confirmed"}], timeout)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            results.append(result("FAIL", f"{prefix}.request", f"RPC verification failed ({type(exc).__name__}); URL redacted"))
            continue

        statuses = status_result.get("value") if isinstance(status_result, dict) else None
        status = statuses[0] if isinstance(statuses, list) and statuses else None
        if not isinstance(status, dict) or status.get("err") is not None or status.get("confirmationStatus") not in {
            "confirmed",
            "finalized",
        }:
            results.append(result("FAIL", f"{prefix}.status", "Signature is not live confirmed/finalized"))
        if not isinstance(transaction, dict):
            results.append(result("FAIL", f"{prefix}.transaction", "RPC returned no transaction"))
            continue
        raw_tx_field = raw_transaction.get("transaction") if isinstance(raw_transaction, dict) else None
        raw_tx_b64 = raw_tx_field[0] if isinstance(raw_tx_field, list) and raw_tx_field else None
        try:
            live_tx_bytes = base64.b64decode(str(raw_tx_b64), validate=True)
        except (ValueError, base64.binascii.Error):
            live_tx_bytes = b""
        payment_stage = payment.get("x402", {}).get("payment", {}) if isinstance(payment.get("x402"), dict) else {}
        if not live_tx_bytes or sha256_value(live_tx_bytes) != payment_stage.get("signedTransactionSha256"):
            results.append(result("FAIL", f"{prefix}.wire_transaction", "x402 signed transaction differs from live RPC bytes"))
        meta = transaction.get("meta")
        tx = transaction.get("transaction")
        if not isinstance(meta, dict) or meta.get("err") is not None or not isinstance(tx, dict):
            results.append(result("FAIL", f"{prefix}.execution", "Transaction execution failed or is malformed"))
            continue
        signatures = tx.get("signatures")
        if not isinstance(signatures, list) or signature not in signatures:
            results.append(result("FAIL", f"{prefix}.signature", "RPC transaction does not contain claimed signature"))
        message = tx.get("message")
        account_keys = message.get("accountKeys") if isinstance(message, dict) else None
        payer = str(payment.get("payer", ""))
        payer_is_signer = False
        if isinstance(account_keys, list):
            for position, key in enumerate(account_keys):
                if isinstance(key, dict) and key.get("pubkey") == payer and key.get("signer") is True:
                    payer_is_signer = True
                elif position == 0 and key == payer:
                    payer_is_signer = True
        if not payer_is_signer:
            results.append(result("FAIL", f"{prefix}.payer_signer", "Claimed payer is not a transaction signer"))

        supply_value = supply.get("value") if isinstance(supply, dict) else None
        decimals = supply_value.get("decimals") if isinstance(supply_value, dict) else None
        if decimals != 6 or payment.get("decimals") != decimals:
            results.append(result("FAIL", f"{prefix}.decimals", "Live mint decimals do not match USDC evidence"))
            continue
        status_slot = status.get("slot") if isinstance(status, dict) else None
        tx_slot = transaction.get("slot")
        block_time = transaction.get("blockTime")
        if not isinstance(tx_slot, int) or status_slot != tx_slot or not isinstance(block_time, int):
            results.append(result("FAIL", f"{prefix}.slot_time", "Signature status slot/blockTime is inconsistent"))
        else:
            block_at = datetime.fromtimestamp(block_time, timezone.utc)
            incident_at = parse_timestamp(payment.get("incidentAt"))
            confirmed_at = parse_timestamp(payment.get("confirmedAt"))
            x402 = payment.get("x402")
            payment_at = parse_timestamp(x402.get("payment", {}).get("capturedAt")) if isinstance(x402, dict) else None
            settlement_at = parse_timestamp(x402.get("settlement", {}).get("capturedAt")) if isinstance(x402, dict) else None
            tolerance = 10
            if not all((incident_at, confirmed_at, payment_at, settlement_at)) or not (
                incident_at <= payment_at
                and (block_at - payment_at).total_seconds() >= -tolerance
                and (settlement_at - block_at).total_seconds() >= -tolerance
                and (confirmed_at - settlement_at).total_seconds() >= -tolerance
                and abs((confirmed_at - block_at).total_seconds()) <= 600
            ) or not (0 <= (confirmed_at - incident_at).total_seconds() <= 3600):
                results.append(result("FAIL", f"{prefix}.timeline", "RPC blockTime does not fit incident/x402/confirmation timeline"))
        live_confirmation = status.get("confirmationStatus") if isinstance(status, dict) else None
        if payment.get("confirmationStatus") == "finalized" and live_confirmation != "finalized":
            results.append(result("FAIL", f"{prefix}.confirmation", "Recorded finalized status is not live finalized"))
        base_units = parse_positive_int(payment.get("amountBaseUnits"))
        amount = parse_decimal(payment.get("amount"))
        if base_units is None or amount is None or amount * (Decimal(10) ** decimals) != base_units:
            results.append(result("FAIL", f"{prefix}.amount", "Human amount and base units do not match live decimals"))
            continue
        pre = token_totals(meta.get("preTokenBalances"), mint, decimals)
        post = token_totals(meta.get("postTokenBalances"), mint, decimals)
        payee = str(payment.get("payee", ""))
        payer_delta = post.get(payer, 0) - pre.get(payer, 0)
        payee_delta = post.get(payee, 0) - pre.get(payee, 0)
        if payer_delta != -base_units or payee_delta != base_units:
            results.append(
                result(
                    "FAIL",
                    f"{prefix}.transfer",
                    f"USDC deltas mismatch: payer {payer_delta}, payee {payee_delta}, expected {base_units}",
                )
            )
        if not any(entry.level == "FAIL" and entry.code.startswith(prefix) for entry in results):
            results.append(
                result(
                    "PASS",
                    prefix,
                    f"Live RPC verified CAIP chain, signed bytes, and USDC transfer at slot {transaction.get('slot')}",
                )
            )
    return results


def verify_reachable_url(url: str, timeout: int, code: str) -> list[Result]:
    if not is_web_url(url):
        return [result("FAIL", code, "URL must be public HTTPS")]
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "uptime402-readiness/2", "Range": "bytes=0-1023"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            response.read(1024)
    except urllib.error.HTTPError as exc:
        status = exc.code
    except OSError as exc:
        return [result("FAIL", code, f"URL is unreachable ({type(exc).__name__})")]
    if 200 <= status < 400:
        return [result("PASS", code, f"Verified reachable URL ({status}): {url}")]
    return [result("FAIL", code, f"URL returned HTTP {status}: {url}")]


def verify_private_url(url: str, timeout: int, code: str) -> list[Result]:
    """Verify that an unauthenticated request is denied, without credentials."""
    if not is_web_url(url):
        return [result("FAIL", code, "Private service URL must use HTTPS")]
    request = urllib.request.Request(url, headers={"User-Agent": "uptime402-readiness/2"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            response.read(256)
    except urllib.error.HTTPError as exc:
        status = exc.code
    except OSError as exc:
        return [result("FAIL", code, f"Private URL check failed ({type(exc).__name__})")]
    if status in {401, 403}:
        return [result("PASS", code, f"Unauthenticated invocation is denied ({status})")]
    return [result("FAIL", code, f"Private executor did not return 401/403 (got {status})")]


def load_hashed_json(
    root: Path,
    obj: dict[str, Any],
    path_key: str,
    hash_key: str,
    code: str,
) -> tuple[dict[str, Any] | None, list[Result]]:
    path, results = check_hashed_artifact(root, obj, path_key, hash_key, code)
    if path is None:
        return None, results
    try:
        payload = json.loads(read_text(path))
    except json.JSONDecodeError:
        payload = None
    if not isinstance(payload, dict):
        results.append(result("FAIL", f"{code}.json", "IAM evidence artifact must be a JSON object"))
        return None, results
    return payload, results


def role_members(policy: dict[str, Any] | None, role: str) -> set[str]:
    bindings = policy.get("bindings") if isinstance(policy, dict) else None
    members: set[str] = set()
    if isinstance(bindings, list):
        for binding in bindings:
            if (
                isinstance(binding, dict)
                and binding.get("role") == role
                and "condition" not in binding
                and isinstance(binding.get("members"), list)
            ):
                members.update(str(member) for member in binding["members"])
    return members


def check_submission_assets(root: Path, payload: dict[str, Any], timeout: int) -> list[Result]:
    project = payload.get("project")
    if not isinstance(project, dict):
        return [result("FAIL", "submission.project", "Project object is required")]
    results: list[Result] = []
    live_url = project.get("liveUrl")
    if isinstance(live_url, str):
        results.extend(verify_reachable_url(live_url, timeout, "submission.live_url"))
    else:
        results.append(result("FAIL", "submission.live_url", "project.liveUrl is required"))

    deployment = resolve_repo_file(root, project.get("deploymentArtifact"))
    allowed_deploy_names = {"Dockerfile", "cloudbuild.yaml", "cloudbuild.yml", "service.yaml", "app.yaml"}
    deployment_text = read_text(deployment) if deployment is not None else ""
    meaningful_deployment = False
    if deployment is not None and "dockerfile" in deployment.name.lower():
        meaningful_deployment = bool(
            re.search(r"(?im)^\s*FROM\s+\S+", deployment_text)
            and re.search(r"(?im)^\s*(?:COPY|ADD)\s+", deployment_text)
            and re.search(r"(?im)^\s*(?:CMD|ENTRYPOINT)\s+", deployment_text)
        )
    elif deployment is not None:
        meaningful_deployment = len(deployment_text) >= 80 and bool(
            re.search(r"(?i)(?:cloud\s*run|run\s+deploy|gcloud|service)", deployment_text)
        )
    if deployment is None or deployment.name not in allowed_deploy_names or not meaningful_deployment:
        results.append(result("FAIL", "submission.deployment", "Declared deployment artifact is missing/empty"))
    else:
        results.append(result("PASS", "submission.deployment", f"Deployment artifact: {deployment.relative_to(root)}"))

    services = project.get("services")
    required_roles = {"control-plane", "payment-executor", "vendor-agent"}
    service_roles: set[str] = set()
    service_hosts: set[str] = set()
    service_artifacts: set[str] = set()
    describe_artifacts: set[str] = set()
    iam_artifacts: set[str] = set()
    service_by_role: dict[str, dict[str, Any]] = {}
    iam_by_role: dict[str, dict[str, Any]] = {}
    service_accounts: dict[str, str] = {}
    secret_policy: dict[str, Any] | None = None
    if not isinstance(services, list):
        results.append(result("FAIL", "submission.services", "Three-service deployment manifest is required"))
    else:
        for index, service in enumerate(services):
            prefix = f"submission.service[{index}]"
            if not isinstance(service, dict):
                results.append(result("FAIL", prefix, "Service entry must be an object"))
                continue
            role = service.get("role")
            url = service.get("url")
            health_url = service.get("healthUrl")
            service_account = service.get("serviceAccount")
            artifact_value = service.get("deploymentArtifact")
            artifact = resolve_repo_file(root, artifact_value)
            if role in required_roles:
                if role in service_roles:
                    results.append(result("FAIL", f"{prefix}.role", f"Duplicate service role: {role}"))
                service_roles.add(str(role))
                service_by_role[str(role)] = service
            else:
                results.append(result("FAIL", f"{prefix}.role", f"Unexpected service role: {role}"))
            if not isinstance(service_account, str) or not SERVICE_ACCOUNT_RE.fullmatch(service_account):
                results.append(result("FAIL", f"{prefix}.identity", "A concrete Cloud Run serviceAccount email is required"))
            elif isinstance(role, str):
                service_accounts[role] = service_account
            if is_web_url(url):
                service_hosts.add(str(urllib.parse.urlparse(str(url)).netloc))
            else:
                results.append(result("FAIL", f"{prefix}.url", "Cloud Run service URL must use HTTPS"))
            if role == "payment-executor":
                if service.get("public") is not False or service.get("iamProtected") is not True:
                    results.append(result("FAIL", f"{prefix}.iam", "payment-executor must be private and IAM-protected"))
                if not isinstance(url, str) or service.get("audience") != url:
                    results.append(result("FAIL", f"{prefix}.audience", "payment-executor audience must equal its service URL"))
                if isinstance(health_url, str) and health_url:
                    results.append(result("FAIL", f"{prefix}.health", "Do not publish a public executor health endpoint"))
                if isinstance(url, str):
                    results.extend(verify_private_url(url, timeout, f"{prefix}.private"))
                secret_resource = service.get("signerSecretResource")
                if not isinstance(secret_resource, str) or not re.fullmatch(
                    r"projects/[a-z][a-z0-9-]{4,62}/secrets/[A-Za-z0-9_-]+/versions/[0-9]+",
                    secret_resource,
                ):
                    results.append(result("FAIL", f"{prefix}.secret_resource", "Executor must pin a Secret Manager version"))
                secret_policy, secret_results = load_hashed_json(
                    root,
                    service,
                    "secretIamPolicyArtifact",
                    "secretIamPolicyArtifactSha256",
                    f"{prefix}.secret_iam",
                )
                results.extend(secret_results)
            elif service.get("public") is not True:
                results.append(result("FAIL", f"{prefix}.public", f"{role} must declare public: true for judging"))
            elif isinstance(health_url, str):
                results.extend(verify_reachable_url(health_url, timeout, f"{prefix}.health"))
            else:
                results.append(result("FAIL", f"{prefix}.health", "Service healthUrl is required"))
            if artifact is None or artifact.stat().st_size < 40:
                results.append(result("FAIL", f"{prefix}.deploy", "Service deployment artifact is missing/tiny"))
            else:
                service_artifacts.add(str(artifact.resolve()))
                if isinstance(service_account, str) and service_account not in read_text(artifact):
                    results.append(result("FAIL", f"{prefix}.deploy_identity", "Deployment config does not name its service account"))
            description, description_results = load_hashed_json(
                root,
                service,
                "serviceDescribeArtifact",
                "serviceDescribeArtifactSha256",
                f"{prefix}.describe",
            )
            results.extend(description_results)
            description_path = resolve_repo_file(root, service.get("serviceDescribeArtifact"))
            if description_path is not None:
                describe_artifacts.add(str(description_path.resolve()))
            described_account = None
            described_url = None
            raw_description_valid = False
            if isinstance(description, dict):
                metadata = description.get("metadata")
                spec = description.get("spec")
                spec_template = spec.get("template") if isinstance(spec, dict) else None
                spec_template_spec = spec_template.get("spec") if isinstance(spec_template, dict) else None
                if isinstance(spec_template_spec, dict):
                    described_account = spec_template_spec.get("serviceAccountName")
                status = description.get("status")
                if isinstance(status, dict):
                    described_url = status.get("url")
                generation = metadata.get("generation") if isinstance(metadata, dict) else None
                observed_generation = status.get("observedGeneration") if isinstance(status, dict) else None
                conditions = status.get("conditions") if isinstance(status, dict) else None
                ready = isinstance(conditions, list) and any(
                    isinstance(condition, dict)
                    and condition.get("type") == "Ready"
                    and str(condition.get("status")).lower() == "true"
                    and parse_timestamp(condition.get("lastTransitionTime")) is not None
                    for condition in conditions
                )
                raw_description_valid = (
                    description.get("apiVersion") == "serving.knative.dev/v1"
                    and description.get("kind") == "Service"
                    and isinstance(metadata, dict)
                    and isinstance(metadata.get("name"), str)
                    and isinstance(metadata.get("namespace"), str)
                    and isinstance(metadata.get("uid"), str)
                    and len(metadata["uid"]) >= 16
                    and isinstance(generation, int)
                    and generation > 0
                    and parse_timestamp(metadata.get("creationTimestamp")) is not None
                    and observed_generation == generation
                    and ready
                    and isinstance(status.get("latestReadyRevisionName"), str)
                    and bool(status["latestReadyRevisionName"])
                )
            if not raw_description_valid or described_account != service_account or described_url != url:
                results.append(
                    result(
                        "FAIL",
                        f"{prefix}.describe_binding",
                        "Raw ready Cloud Run v1 description does not bind the declared URL/service account",
                    )
                )
            iam_policy, iam_results = load_hashed_json(
                root,
                service,
                "iamPolicyArtifact",
                "iamPolicyArtifactSha256",
                f"{prefix}.iam_policy",
            )
            results.extend(iam_results)
            iam_path = resolve_repo_file(root, service.get("iamPolicyArtifact"))
            if iam_path is not None:
                iam_artifacts.add(str(iam_path.resolve()))
            if isinstance(role, str) and iam_policy is not None:
                iam_by_role[role] = iam_policy

        distinct_identities = len(set(service_accounts.values())) == 3
        control_account = service_accounts.get("control-plane")
        executor_account = service_accounts.get("payment-executor")
        vendor_account = service_accounts.get("vendor-agent")
        for public_role in ("control-plane", "vendor-agent"):
            if "allUsers" not in role_members(iam_by_role.get(public_role), "roles/run.invoker"):
                results.append(result("FAIL", f"submission.{public_role}.iam", "Judge-facing service IAM lacks allUsers run.invoker"))
        executor_invokers = role_members(iam_by_role.get("payment-executor"), "roles/run.invoker")
        if (
            control_account is None
            or executor_invokers != {f"serviceAccount:{control_account}"}
        ):
            results.append(
                result(
                    "FAIL",
                    "submission.payment-executor.invoker",
                    "Executor IAM must allow the control-plane identity and deny public principals",
                )
            )
        secret_members = role_members(secret_policy, "roles/secretmanager.secretAccessor")
        if (
            executor_account is None
            or f"serviceAccount:{executor_account}" not in secret_members
            or any(
                account is not None and f"serviceAccount:{account}" in secret_members
                for account in (control_account, vendor_account)
            )
        ):
            results.append(
                result(
                    "FAIL",
                    "submission.payment-executor.secret_iam",
                    "Signer secret IAM must allow only the executor among the three service identities",
                )
            )
        if isinstance(live_url, str) and isinstance(service_by_role.get("control-plane"), dict):
            control_url = service_by_role["control-plane"].get("url")
            if urllib.parse.urlparse(live_url).netloc != urllib.parse.urlparse(str(control_url)).netloc:
                results.append(result("FAIL", "submission.live_identity", "project.liveUrl must use the control-plane origin"))

        if (
            service_roles != required_roles
            or len(service_hosts) < 3
            or len(service_artifacts) < 3
            or len(describe_artifacts) < 3
            or len(iam_artifacts) < 3
            or not distinct_identities
        ):
            results.append(
                result(
                    "FAIL",
                    "submission.services",
                    "Three roles need distinct URLs, service accounts, configs, live descriptions, and IAM exports",
                )
            )
        else:
            results.append(
                result(
                    "PASS",
                    "submission.services",
                    "Three distinct deployments/identities and hash-bound IAM evidence are declared",
                )
            )

    deck = resolve_repo_file(root, project.get("deckPdf"))
    if deck is None:
        results.append(result("FAIL", "submission.pdf", "project.deckPdf must name the final PDF"))
    else:
        try:
            header = deck.read_bytes()[:5]
            size = deck.stat().st_size
        except OSError:
            header, size = b"", 0
        if deck.suffix.lower() == ".pdf" and header == b"%PDF-" and size >= 1024:
            results.append(result("PASS", "submission.pdf", f"Final PDF looks valid ({size} bytes)"))
        else:
            results.append(result("FAIL", "submission.pdf", "Final PDF is missing, tiny, or has no PDF header"))

    video = resolve_repo_file(root, project.get("demoVideo"))
    video_url = project.get("demoVideoUrl")
    duration = parse_decimal(project.get("demoVideoDurationSeconds"))
    if duration is None or duration <= 0 or duration > 180:
        results.append(result("FAIL", "submission.video_duration", "Declared demo duration must be 1-180 seconds"))
    if video is not None:
        try:
            header = video.read_bytes()[:32]
            size = video.stat().st_size
        except OSError:
            header, size = b"", 0
        valid_header = b"ftyp" in header or header.startswith(b"\x1aE\xdf\xa3")
        if video.suffix.lower() in {".mp4", ".mov", ".webm"} and valid_header and size >= 1024:
            results.append(result("PASS", "submission.video", f"Final video looks valid ({size} bytes)"))
        else:
            results.append(result("FAIL", "submission.video", "Demo video is tiny or has an invalid container header"))
    elif isinstance(video_url, str):
        results.extend(verify_reachable_url(video_url, timeout, "submission.video_url"))
    else:
        results.append(result("FAIL", "submission.video", "Provide project.demoVideo or verified project.demoVideoUrl"))
    results.append(
        result(
            "INFO",
            "manual.video_duration",
            "Automated checks validate the declared <=180s duration; a reviewer must confirm playback duration/content",
        )
    )
    return results


def check_rpc_topology(
    primary: str | None,
    *,
    primary_from_env: bool,
    secondary: str | None,
) -> list[Result]:
    primary_meta, error = rpc_url_metadata(primary, from_env=primary_from_env)
    if error or primary_meta is None:
        return [result("FAIL", "rpc.primary.url", error or "Invalid primary RPC")]
    primary_host = str(primary_meta.hostname).lower()
    if primary_host in APPROVED_PUBLIC_RPC_HOSTS:
        if secondary is None:
            return [result("PASS", "rpc.topology", "Primary RPC is an approved public Solana origin")]
    elif secondary is None:
        return [
            result(
                "FAIL",
                "rpc.secondary.required",
                "A private/nonstandard primary RPC requires an independent approved public secondary RPC",
            )
        ]
    if secondary is None:
        return []
    secondary_meta, secondary_error = rpc_url_metadata(secondary, from_env=False)
    if secondary_error or secondary_meta is None:
        return [result("FAIL", "rpc.secondary.url", secondary_error or "Invalid secondary RPC")]
    secondary_host = str(secondary_meta.hostname).lower()
    if secondary_host not in APPROVED_PUBLIC_RPC_HOSTS or secondary_host == primary_host:
        return [result("FAIL", "rpc.secondary.independence", "Secondary RPC must be an independent approved public origin")]
    return [result("PASS", "rpc.topology", "Independent public secondary RPC is configured")]


def check_submission_evidence(
    root: Path,
    payload: dict[str, Any],
    rpc_url: str | None,
    secondary_rpc_url: str | None,
    expected_usdc_mint: str | None,
    timeout: int,
) -> list[Result]:
    results: list[Result] = []
    payments = payload.get("payments")
    if isinstance(payments, list):
        for index, payment in enumerate(payments):
            if isinstance(payment, dict):
                results.extend(check_x402(payment, index))
                results.extend(
                    check_outcome(
                        root,
                        payment,
                        index,
                        payload.get("attestations") if isinstance(payload.get("attestations"), dict) else None,
                    )
                )
    results.extend(check_signed_commerce_evidence(root, payload))
    results.extend(check_denials(root, payload))
    results.extend(check_attestations(root, payload))
    results.extend(check_rpc_payments(payload, rpc_url, timeout, expected_usdc_mint, label="primary"))
    if secondary_rpc_url:
        results.extend(
            check_rpc_payments(payload, secondary_rpc_url, timeout, expected_usdc_mint, label="secondary")
        )
    results.extend(check_submission_assets(root, payload, timeout))
    results.extend(
        [
            result("INFO", "manual.gemini", "Review Gemini traces/model reasoning quality; nonce report only proves the integration test ran"),
            result("INFO", "manual.a2a", "Review that buyer/vendor are operationally separate services and the A2A exchange is meaningful"),
            result("INFO", "manual.autonomy", "Review the demo for absence of hidden per-payment human approval and for real recovery"),
            result("INFO", "manual.presentation", "Review PDF legibility and the full <=3-minute video narrative before submission"),
        ]
    )
    return results


def run_checks(
    root: Path,
    *,
    submission: bool = False,
    rpc_url: str | None = None,
    rpc_url_from_env: bool = False,
    secondary_rpc_url: str | None = None,
    expected_usdc_mint: str | None = None,
    run_repo_scripts: bool = False,
    command_timeout: int = 300,
    network_timeout: int = 15,
) -> list[Result]:
    root = root.resolve()
    if not root.is_dir():
        return [result("FAIL", "root", f"Not a directory: {root}")]
    mode = "submission" if submission else "structural"
    results = [
        result(
            "INFO",
            f"mode.{mode}",
            "Live submission verification enabled"
            if submission
            else "Structural checks only; no live, transaction, deployment, or outcome claim is verified",
        )
    ]
    command_run: CommandRun | None = None
    if submission:
        if not run_repo_scripts:
            results.append(
                result(
                    "FAIL",
                    "commands.opt_in",
                    "Submission mode requires --run-repo-scripts so verification results are executed, not trusted",
                )
            )
        else:
            command_run = run_repository_scripts(root, command_timeout)
            results.extend(command_run.results)

    # Scan after build/evidence generation so generated client bundles are covered.
    results.extend(check_secret_filenames(root, submission=submission))
    results.extend(check_secret_contents(root, submission=submission))

    results.extend(check_required_files(root))
    results.extend(check_package_scripts(root))
    results.extend(check_readme(root))
    payload, load_results = load_evidence(root)
    results.extend(load_results)
    if command_run is not None:
        results.extend(check_verification_report(root, command_run))
    if payload is not None:
        results.extend(check_payment_shape(payload))
        if submission:
            results.extend(
                check_rpc_topology(
                    rpc_url,
                    primary_from_env=rpc_url_from_env,
                    secondary=secondary_rpc_url,
                )
            )
            results.extend(
                check_submission_evidence(
                    root,
                    payload,
                    rpc_url,
                    secondary_rpc_url,
                    expected_usdc_mint,
                    network_timeout,
                )
            )
    if not submission:
        results.append(
            result(
                "INFO",
                "submission.not_run",
                "Run --submission --run-repo-scripts --usdc-mint MINT (RPC defaults to SOLANA_RPC_URL)",
            )
        )
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="Target repository root")
    parser.add_argument("--submission", action="store_true", help="Run commands and live final-submission checks")
    parser.add_argument(
        "--rpc-url",
        help="Public credential-free Solana RPC URL; otherwise use --rpc-url-env",
    )
    parser.add_argument(
        "--rpc-url-env",
        default="SOLANA_RPC_URL",
        help="Environment variable holding a private RPC URL (default: SOLANA_RPC_URL)",
    )
    parser.add_argument(
        "--secondary-rpc-url",
        help="Independent approved public Solana RPC required for a nonstandard/private primary",
    )
    parser.add_argument("--usdc-mint", help="Explicit current USDC mint expected on the selected chain")
    parser.add_argument(
        "--run-repo-scripts",
        action="store_true",
        help="Execute build, test, lint, typecheck, and evidence:verify package scripts",
    )
    parser.add_argument("--command-timeout", type=int, default=300, help="Seconds allowed per package script")
    parser.add_argument("--network-timeout", type=int, default=15, help="Seconds allowed per RPC/URL request")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Emit JSON")
    parser.add_argument("--strict", action="store_true", help="Treat warnings as failures")
    args = parser.parse_args()

    rpc_url = args.rpc_url
    rpc_url_from_env = False
    if rpc_url is None and args.submission:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", args.rpc_url_env):
            rpc_url = None
        else:
            rpc_url = os.environ.get(args.rpc_url_env)
            rpc_url_from_env = True

    results = run_checks(
        Path(args.root),
        submission=args.submission,
        rpc_url=rpc_url,
        rpc_url_from_env=rpc_url_from_env,
        secondary_rpc_url=args.secondary_rpc_url,
        expected_usdc_mint=args.usdc_mint,
        run_repo_scripts=args.run_repo_scripts,
        command_timeout=max(1, args.command_timeout),
        network_timeout=max(1, args.network_timeout),
    )
    levels = ("PASS", "INFO", "WARN", "FAIL")
    counts = {level: sum(item.level == level for item in results) for level in levels}
    if args.as_json:
        print(
            json.dumps(
                {
                    "mode": "submission" if args.submission else "structural",
                    "scope": "automated checks only; manual review remains" if args.submission else "structure only",
                    "root": str(Path(args.root).resolve()),
                    "counts": counts,
                    "results": [item.__dict__ for item in results],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        for item in results:
            print(f"[{item.level}] {item.code}: {item.message}")
        print(
            f"\nSummary: {counts['PASS']} passed, {counts['INFO']} info, "
            f"{counts['WARN']} warned, {counts['FAIL']} failed"
        )
        if args.submission:
            print("Submission result covers automated gates only; INFO manual.* items still require human review.")

    if counts["FAIL"] or (args.strict and counts["WARN"]):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
