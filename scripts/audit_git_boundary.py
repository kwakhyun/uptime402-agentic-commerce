#!/usr/bin/env python3
"""Fail closed when Git candidates contain secrets or generated build output.

This audits both tracked files and untracked, non-ignored files: exactly the set a
broad `git add -A` could place in the repository. It prints paths and rule names,
never matching content.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAX_SCAN_BYTES = 4 * 1024 * 1024

FORBIDDEN_COMPONENTS = {
    ".firebase",
    ".next",
    ".pnpm-store",
    "__pycache__",
    "coverage",
    "credentials",
    "dist",
    "node_modules",
    "private",
    "secrets",
}
FORBIDDEN_SUFFIXES = {
    ".key",
    ".log",
    ".p12",
    ".pem",
    ".pfx",
    ".pyc",
    ".tsbuildinfo",
}
SENSITIVE_NAME = re.compile(r"(?:keypair|wallet).*[.]json$", re.IGNORECASE)
PRIVATE_KEY_MARKER = re.compile(
    rb"-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----"
)
SERVICE_ACCOUNT_MARKER = re.compile(
    rb'"(?:private_key|private_key_id)"\s*:\s*"[^"\r\n]+"'
)
SECRET_ASSIGNMENT = re.compile(
    rb"(?m)^[ \t]*(?:export[ \t]+)?"
    rb"(?:[A-Z0-9_]*(?:PRIVATE_KEY|SECRET_KEY|CLIENT_SECRET|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|"
    rb"MNEMONIC|SEED_PHRASE)[A-Z0-9_]*)"
    rb"[ \t]*=[ \t]*([^#\r\n]+)"
)
CODE_SECRET_LITERAL = re.compile(
    rb"(?m)^[ \t]*(?:const|let|var)?[ \t]*"
    rb"(?:[A-Z0-9_]*(?:PRIVATE_KEY|SECRET_KEY|CLIENT_SECRET|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|"
    rb"MNEMONIC|SEED_PHRASE)[A-Z0-9_]*)"
    rb"[ \t]*=[ \t]*[\"']([^\"'\r\n]+)[\"']"
)
PLACEHOLDER_VALUES = {
    b"",
    b'""',
    b"''",
    b"changeme",
    b"placeholder",
    b"replace-me",
    b"set-in-secret-manager",
}


def git_candidates() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    return [Path(raw.decode("utf-8")) for raw in result.stdout.split(b"\0") if raw]


def path_rule(path: Path) -> str | None:
    if (ROOT / path).is_symlink():
        return "symlink candidate"
    if path.name == ".env" or (path.name.startswith(".env.") and path.name != ".env.example"):
        return "environment file"
    if any(component in FORBIDDEN_COMPONENTS for component in path.parts):
        return "generated/private directory"
    if path.suffix.lower() in FORBIDDEN_SUFFIXES:
        return "generated/private extension"
    if SENSITIVE_NAME.search(path.name):
        return "wallet/keypair filename"
    return None


def is_flat_solana_secret_key(data: bytes) -> bool:
    try:
        parsed = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return (
        isinstance(parsed, list)
        and len(parsed) in {32, 64}
        and all(isinstance(value, int) and 0 <= value <= 255 for value in parsed)
    )


def content_rule(path: Path) -> str | None:
    absolute = ROOT / path
    if not absolute.is_file() or absolute.stat().st_size > MAX_SCAN_BYTES:
        return None
    data = absolute.read_bytes()
    if b"\0" in data[:8192]:
        return None
    if PRIVATE_KEY_MARKER.search(data):
        return "PEM private-key material"
    if SERVICE_ACCOUNT_MARKER.search(data):
        return "Google service-account private material"
    if is_flat_solana_secret_key(data):
        return "Solana secret-key byte array"
    assignment_pattern = SECRET_ASSIGNMENT if path.name.startswith(".env") else CODE_SECRET_LITERAL
    for match in assignment_pattern.finditer(data):
        value = match.group(1).strip().strip(b"\r")
        lowered = value.lower()
        if (
            lowered not in PLACEHOLDER_VALUES
            and not value.startswith(b"${")
            and not lowered.startswith((b"test-", b"fake-", b"example-"))
        ):
            return "non-empty secret environment assignment"
    return None


def main() -> int:
    findings: list[tuple[Path, str]] = []
    candidates = git_candidates()
    for path in candidates:
        rule = path_rule(path)
        if rule is None:
            rule = content_rule(path)
        if rule is not None:
            findings.append((path, rule))

    if findings:
        print("Git boundary audit failed:", file=sys.stderr)
        for path, rule in findings:
            print(f"- {path.as_posix()}: {rule}", file=sys.stderr)
        return 1

    print(f"Git boundary audit passed: {len(candidates)} candidate files; no forbidden material detected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
