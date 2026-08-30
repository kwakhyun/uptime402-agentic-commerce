import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { discoverA2aVendorOffers } from "../apps/control-plane/src/server/a2a-client.js";

type ReadyMessage = {
  ready: true;
  origin: string;
  processId: number;
};

let child: ChildProcessWithoutNullStreams | undefined;

async function waitForReady(processHandle: ChildProcessWithoutNullStreams): Promise<ReadyMessage> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`A2A child readiness timed out. stderr=${stderr}`));
    }, 8_000);

    const cleanup = (): void => {
      clearTimeout(timeout);
      processHandle.stdout.off("data", onStdout);
      processHandle.stderr.off("data", onStderr);
      processHandle.off("error", onError);
      processHandle.off("exit", onExit);
    };
    const onStderr = (chunk: Buffer): void => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_384);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`A2A child exited before ready: code=${String(code)} stderr=${stderr}`));
    };
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      const line = stdout.slice(0, newline);
      try {
        const parsed = JSON.parse(line) as ReadyMessage;
        if (parsed.ready !== true || typeof parsed.origin !== "string") {
          throw new TypeError("Malformed A2A child readiness message");
        }
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    processHandle.stdout.on("data", onStdout);
    processHandle.stderr.on("data", onStderr);
    processHandle.once("error", onError);
    processHandle.once("exit", onExit);
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      onExit(processHandle.exitCode);
    }
  });
}

async function stopChild(): Promise<void> {
  if (!child || child.exitCode !== null) {
    child = undefined;
    return;
  }
  const processHandle = child;
  child = undefined;
  await new Promise<void>((resolve) => {
    const forceKill = setTimeout(() => {
      processHandle.kill("SIGKILL");
    }, 2_000);
    processHandle.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    processHandle.kill("SIGTERM");
  });
}

afterEach(stopChild);

describe("A2A process-boundary smoke", () => {
  it("discovers an Agent Card and sends a v1 message to a separate Node process", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/a2a-vendor-child.ts", import.meta.url));
    const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
    child = spawn(process.execPath, ["--import", "tsx", fixture], {
      cwd: repositoryRoot,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ready = await waitForReady(child);

    expect(ready.processId).not.toBe(process.pid);
    let agentCardFetches = 0;
    const countedFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
      if (url.pathname === "/.well-known/agent-card.json") agentCardFetches += 1;
      return fetch(input, init);
    };
    const discovered = await discoverA2aVendorOffers({
      agentOrigin: ready.origin,
      incidentId: "incident-a2a-smoke",
      capability: "solana-rpc-health",
      allowHttpLocalTest: true,
      timeoutMs: 5_000,
      maxResponseBytes: 256_000,
      fetchImpl: countedFetch,
    });

    expect(discovered.offers.map((offer) => offer.payload.offerId)).toEqual([
      "rpc-fast",
      "rpc-economy",
    ]);
    expect(discovered.offerEvaluations.map((entry) => entry.offerId)).toEqual([
      "rpc-fast",
      "rpc-economy",
    ]);
    expect(discovered.evidence).toMatchObject({
      evidenceLevel: "local-process-smoke",
      agentCardUrl: `${ready.origin}/.well-known/agent-card.json`,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
      responseKind: "message",
      remoteProcessId: ready.processId,
      verificationKeyId: "local-smoke-vendor-key",
      verificationPublicKey: "11111111111111111111111111111111",
    });
    expect(discovered.evidence.agentCardHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(discovered.evidence.requestMessageId).toBeTruthy();
    expect(discovered.evidence.responseId).toBe("offers-incident-a2a-smoke");
    expect(agentCardFetches).toBe(1);
  }, 12_000);
});
