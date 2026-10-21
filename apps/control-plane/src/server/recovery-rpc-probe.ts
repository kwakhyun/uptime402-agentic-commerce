import "server-only";

import {
  DEVNET_GENESIS_HASH,
  IdentifierSchema,
  canonicalHash,
  canonicalize,
  normalizePinnedHttpsUrl,
  normalizePinnedOrigin,
} from "@uptime402/domain";
import { z } from "zod";
import { GoogleAuth } from "google-auth-library";
import type { FirestoreRecoveryRoute } from "./live-flow-contracts.js";
import { readBoundedJson } from "./live-flow-verification.js";
import { createProductionOriginBoundFetchFactory, type OriginBoundFetchFactory } from "./pinned-fetch.js";
import { parseStrictJson } from "./strict-json.js";

const RouteSchema = z.object({
  offerId: IdentifierSchema,
  resourceUrl: z.string().url(),
  rpcUrl: z.string().url(),
  authentication: z.literal("google-iam").optional(),
}).strict();

export interface RecoveryRpcProbe {
  probe(route: FirestoreRecoveryRoute): Promise<{
    endpointHash: string; responseHash: string; genesisHash: string; latencyMs: number;
    rpcEndpoint?: string; rpcResponsesJson?: string; authentication?: string;
  }>;
}

/** The operator pins the RPC actually supplied for each paid offer. Vendor text cannot choose it. */
export class PinnedRecoveryRpcProbe implements RecoveryRpcProbe {
  private readonly routes: z.infer<typeof RouteSchema>[];
  constructor(rawRoutes: unknown, private readonly fetchFactory: OriginBoundFetchFactory,
    private readonly getIdToken?: (audience: string) => Promise<string>) {
    this.routes = z.array(RouteSchema).min(1).max(64).parse(rawRoutes);
    if (new Set(this.routes.map((route) => route.offerId)).size !== this.routes.length) throw new Error("Duplicate recovery RPC offer binding");
    for (const route of this.routes) {
      for (const url of [route.rpcUrl, route.resourceUrl]) normalizePinnedHttpsUrl(url, normalizePinnedOrigin(new URL(url).origin));
    }
  }

  async probe(route: FirestoreRecoveryRoute) {
    const configured = this.routes.find((candidate) => candidate.offerId === route.offerId && candidate.resourceUrl === route.resourceUrl);
    if (!configured) throw new Error("Paid route has no configured RPC binding");
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (configured.authentication === "google-iam") {
      if (route.rpcEndpoint !== configured.rpcUrl || !this.getIdToken) throw new Error("Paid RPC endpoint or IAM configuration mismatch");
      const token = await this.getIdToken(new URL(configured.rpcUrl).origin);
      if (!token || token.length > 8_192 || !/^[A-Za-z0-9._~-]+$/.test(token)) throw new Error("Invalid RPC identity token");
      headers.authorization = `Bearer ${token}`;
      headers["x-uptime402-route-activation"] = route.activationId;
    } else if (route.rpcEndpoint && route.rpcEndpoint !== configured.rpcUrl) {
      throw new Error("Paid RPC endpoint mismatch");
    }
    const fetchRpc = this.fetchFactory.forOrigin(new URL(configured.rpcUrl).origin);
    const started = performance.now();
    const responses = await Promise.all(["getHealth", "getGenesisHash"].map(async (method, id) => {
      const response = await fetchRpc(configured.rpcUrl, {
        method: "POST", redirect: "error", cache: "no-store",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method }),
      });
      if (response.status !== 200) throw new Error("Recovery RPC HTTP failure");
      const body = await readBoundedJson(response, 16_384);
      return z.object({ jsonrpc: z.literal("2.0"), id: z.literal(id), result: z.string() }).strict().parse(body.value);
    }));
    if (responses[0]?.result !== "ok" || responses[1]?.result !== DEVNET_GENESIS_HASH) throw new Error("Recovery RPC health or network mismatch");
    return {
      endpointHash: canonicalHash(configured), responseHash: canonicalHash(responses),
      genesisHash: DEVNET_GENESIS_HASH, latencyMs: Math.max(0, performance.now() - started),
      rpcEndpoint: configured.rpcUrl, rpcResponsesJson: canonicalize(responses),
      authentication: configured.authentication ?? "none",
    };
  }
}

export function buildRecoveryRpcProbe(environment: Readonly<NodeJS.ProcessEnv> = process.env): RecoveryRpcProbe {
  const routes = environment.RECOVERY_RPC_ROUTES_JSON?.trim();
  if (!routes || Buffer.byteLength(routes) > 32_768) throw new Error("RECOVERY_RPC_ROUTES_JSON is required for real recovery verification");
  const auth = new GoogleAuth();
  return new PinnedRecoveryRpcProbe(parseStrictJson(routes), createProductionOriginBoundFetchFactory({
    timeoutMs: 5_000, maxRequestBytes: 16_384, maxResponseBytes: 16_384,
  }), async audience => {
    const client = await auth.getIdTokenClient(audience);
    return client.idTokenProvider.fetchIdToken(audience);
  });
}
