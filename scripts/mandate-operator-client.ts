import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  canonicalize,
  normalizePinnedOrigin,
} from "@uptime402/domain";
import { z } from "zod";

import { parseMandateJson } from "./mandate-json.js";

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

function inside(candidate: string, root: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

export async function readOwnerOnlyOperatorFile(
  configuredPath: string,
  configuredRoot: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<Uint8Array> {
  if (!isAbsolute(configuredPath) || !isAbsolute(configuredRoot)) {
    throw new TypeError("Operator input and root paths must be absolute");
  }
  const [resolvedPath, resolvedRoot] = await Promise.all([
    realpath(resolve(configuredPath)),
    realpath(resolve(configuredRoot)),
  ]);
  if (!inside(resolvedPath, resolvedRoot)) {
    throw new Error("Operator input resolves outside its configured root");
  }
  if ((await lstat(resolve(configuredPath))).isSymbolicLink()) {
    throw new Error("Operator input path must not be a symbolic link");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(resolvedPath, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > maxBytes ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("Operator input must be a bounded owner-only regular file");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Operator input must be owned by the current user");
    }
    const bytes = new Uint8Array(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, stat.size, 0);
    if (bytesRead !== stat.size) throw new Error("Operator input read was incomplete");
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readOperatorOidcToken(
  tokenPath: string,
  tokenRoot: string,
): Promise<string> {
  const bytes = await readOwnerOnlyOperatorFile(tokenPath, tokenRoot, 16 * 1024);
  try {
    const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    if (!JWT_PATTERN.test(token)) {
      throw new TypeError("Operator token file does not contain one OIDC JWT");
    }
    return token;
  } finally {
    bytes.fill(0);
  }
}

export async function postProtectedOperatorJson(input: {
  controlPlaneOrigin: string;
  path: string;
  token: string;
  body: unknown;
  maxResponseBytes?: number;
}): Promise<{ status: number; body: unknown }> {
  const origin = normalizePinnedOrigin(input.controlPlaneOrigin);
  if (!input.path.startsWith("/api/operator/") || input.path.includes("?") || input.path.includes("#")) {
    throw new TypeError("Operator client path is not a protected operator route");
  }
  if (!JWT_PATTERN.test(input.token)) throw new TypeError("Operator OIDC token is invalid");
  const response = await fetch(`${origin}${input.path}`, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: canonicalize(input.body),
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("Protected operator route returned a non-JSON response");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const maximum = input.maxResponseBytes ?? 4 * 1024 * 1024;
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) {
    throw new Error("Protected operator route response is outside the size limit");
  }
  const body = parseMandateJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (response.status < 200 || response.status > 299) {
    const error = z.object({ error: z.string().min(1).max(128) }).passthrough().safeParse(body);
    throw new Error(
      error.success
        ? `Protected operator route rejected request: ${error.data.error}`
        : `Protected operator route returned HTTP ${response.status}`,
    );
  }
  return { status: response.status, body };
}

export async function writeNewOwnerOnlyOperatorCapture(
  configuredPath: string,
  configuredRoot: string,
  value: unknown,
): Promise<void> {
  if (!isAbsolute(configuredPath) || !isAbsolute(configuredRoot)) {
    throw new TypeError("Operator capture and root paths must be absolute");
  }
  const [resolvedParent, resolvedRoot] = await Promise.all([
    realpath(dirname(resolve(configuredPath))),
    realpath(resolve(configuredRoot)),
  ]);
  if (!inside(resolvedParent, resolvedRoot)) {
    throw new Error("Operator capture resolves outside its configured root");
  }
  await writeFile(resolve(configuredPath), `${canonicalize(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}
