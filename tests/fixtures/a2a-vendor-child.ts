import { createServer } from "node:http";

import {
  Role,
  type Message,
  type AgentCard as AgentCardType,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type RequestContext,
} from "@a2a-js/sdk/server";
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
} from "@a2a-js/sdk/server/express";
import {
  DEVNET_USDC_MINT,
  DEVNET_X402_NETWORK_ID,
  canonicalHash,
  type VendorOffer,
} from "@uptime402/domain";
import express from "express";
import { z } from "zod";

const PAYEE = "C".repeat(44);
const VENDOR_VERIFICATION_KEY = "11111111111111111111111111111111";
const DiscoverySchema = z
  .object({
    kind: z.literal("discover_offers"),
    incidentId: z.string().min(1).max(128),
    capability: z.literal("solana-rpc-health"),
  })
  .strict();

function offer(
  input: {
    offerId: string;
    priceBaseUnits: string;
    latencyMs: number;
    description: string;
    agentCardHash: `sha256:${string}`;
  },
): VendorOffer {
  const unsigned = {
    offerId: input.offerId,
    providerAgentId: "vendor-agent-local-smoke",
    providerAgentCardUrl: "https://vendor.uptime402.example/.well-known/agent-card.json",
    providerAgentCardHash: input.agentCardHash,
    resourceUrl: "https://vendor.uptime402.example/v1/recovery",
    network: DEVNET_X402_NETWORK_ID,
    asset: "USDC" as const,
    assetMint: DEVNET_USDC_MINT,
    amountBaseUnits: input.priceBaseUnits,
    payee: PAYEE,
    expiresAt: "2099-01-01T00:00:00.000Z",
    capability: "solana-rpc-health",
    method: "POST" as const,
  };
  return {
    payload: unsigned,
    signer: VENDOR_VERIFICATION_KEY,
    keyId: "local-smoke-vendor-key",
    signature: "S".repeat(88),
  };
}

function discoveryInput(context: RequestContext): z.infer<typeof DiscoverySchema> {
  const parts = context.userMessage.parts.filter((part) => part.content?.$case === "data");
  if (parts.length !== 1) throw new TypeError("Expected one structured discovery part");
  return DiscoverySchema.parse(parts[0]!.content!.value);
}

function createExecutor(
  offers: readonly [VendorOffer, VendorOffer],
  offerEvaluations: readonly [
    { offerId: string; latencyMs: number; health: string; description: string },
    { offerId: string; latencyMs: number; health: string; description: string },
  ],
): AgentExecutor {
  return {
    async execute(context, eventBus) {
      const input = discoveryInput(context);
      const response: Message = {
        messageId: `offers-${input.incidentId}`,
        contextId: context.contextId,
        taskId: "",
        role: Role.ROLE_AGENT,
        parts: [
          {
            content: {
              $case: "data",
              value: {
                kind: "signed_offers",
                incidentId: input.incidentId,
                untrustedVendorDescriptions: true,
                offers,
                offerEvaluations,
                processId: process.pid,
              },
            },
            metadata: { evidenceLevel: "local-process-smoke" },
            filename: "",
            mediaType: "application/json",
          },
        ],
        metadata: { processId: process.pid },
        extensions: [],
        referenceTaskIds: [],
      };
      eventBus.publish(AgentEvent.message(response));
      eventBus.finished();
    },
    async cancelTask() {
      throw new Error("Local smoke discovery is immediate");
    },
  };
}

const app = express();
app.disable("x-powered-by");
const server = createServer(app);

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    process.stderr.write("A2A smoke child did not receive a TCP address\n");
    process.exitCode = 1;
    server.close();
    return;
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const card: AgentCardType & {
    verificationMethods: readonly [{
      id: string;
      type: "Ed25519VerificationKey2020";
      controller: string;
      publicKeyBase58: string;
      purposes: readonly ["offer-signing", "fulfillment-receipt-signing"];
    }];
  } = {
    name: "Uptime402 local process smoke vendor",
    description: "Local-only A2A protocol fixture; not payment or deployment evidence.",
    supportedInterfaces: [
      {
        url: `${origin}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        tenant: "local-smoke",
      },
    ],
    provider: { organization: "Uptime402 test fixture", url: origin },
    version: "1.0.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "discover-recovery-offers",
        name: "Discover two local smoke offers",
        description: "Returns two immutable fixture offers for protocol verification.",
        tags: ["a2a", "local-smoke"],
        examples: ["Discover solana-rpc-health offers"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
        securityRequirements: [],
      },
    ],
    documentationUrl: "",
    signatures: [],
    verificationMethods: [
      {
        id: "local-smoke-vendor-key",
        type: "Ed25519VerificationKey2020",
        controller: "vendor-agent-local-smoke",
        publicKeyBase58: VENDOR_VERIFICATION_KEY,
        purposes: ["offer-signing", "fulfillment-receipt-signing"],
      },
    ],
  };
  const agentCardHash = canonicalHash(card);
  const offers = [
    offer({
      offerId: "rpc-fast",
      priceBaseUnits: "18000",
      latencyMs: 80,
      description: "Fast failover route.",
      agentCardHash,
    }),
    offer({
      offerId: "rpc-economy",
      priceBaseUnits: "9000",
      latencyMs: 350,
      description: "Economical recovery route.",
      agentCardHash,
    }),
  ] as const;
  const offerEvaluations = [
    { offerId: "rpc-fast", latencyMs: 80, health: "available", description: "Fast failover route." },
    { offerId: "rpc-economy", latencyMs: 350, health: "available", description: "Economical recovery route." },
  ] as const;
  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    createExecutor(offers, offerEvaluations),
  );
  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: requestHandler, cache: { maxAge: 0 } }),
  );
  app.use(
    "/a2a",
    jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
  );
  process.stdout.write(
    `${JSON.stringify({ ready: true, origin, processId: process.pid })}\n`,
  );
});

function stop(): void {
  server.close(() => process.exit(0));
}

process.once("SIGTERM", stop);
process.once("SIGINT", stop);
