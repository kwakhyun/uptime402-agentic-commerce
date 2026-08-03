import "server-only";

import { randomUUID } from "node:crypto";

import {
  AgentCard,
  Role,
  type Message,
  type Part,
  type SendMessageRequest,
  type SendMessageResult,
  type Task,
} from "@a2a-js/sdk";
import {
  ClientFactory,
  JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import {
  Base58Schema,
  IdentifierSchema,
  VendorOfferEvaluationSchema,
  VendorOfferSchema,
  canonicalHash,
  normalizePinnedHttpsUrl,
  normalizePinnedOrigin,
  parseBoundedStrictJsonBytes,
  type VendorOffer,
  type VendorOfferEvaluation,
} from "@uptime402/domain";
import { z } from "zod";

import { parseStrictJson } from "./strict-json.js";

const SignedOffersPayloadSchema = z
  .object({
    kind: z.literal("signed_offers"),
    incidentId: IdentifierSchema,
    untrustedVendorDescriptions: z.literal(true),
    offers: z.tuple([VendorOfferSchema, VendorOfferSchema]),
    offerEvaluations: z.tuple([VendorOfferEvaluationSchema, VendorOfferEvaluationSchema]),
    processId: z.number().int().positive().optional(),
  })
  .strict();

const VendorVerificationMethodSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("Ed25519VerificationKey2020"),
    controller: z.string().min(1).max(256),
    publicKeyBase58: Base58Schema,
    purposes: z.tuple([
      z.literal("offer-signing"),
      z.literal("fulfillment-receipt-signing"),
    ]),
  })
  .strict();

const EmptyObjectSchema = z.object({}).strict();
const EmptyArraySchema = z.tuple([]);
const PublishedAgentInterfaceSchema = z
  .object({
    url: z.string().url(),
    protocolBinding: z.literal("JSONRPC"),
    protocolVersion: z.literal("1.0"),
    tenant: z.string().min(1).max(256),
  })
  .strict();
const PublishedAgentSkillSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(512),
    description: z.string().min(1).max(2_000),
    tags: z.array(z.string().min(1).max(128)).max(32),
    examples: z.array(z.string().max(1_000)).max(32),
    inputModes: z.array(z.string().min(1).max(256)).max(16),
    outputModes: z.array(z.string().min(1).max(256)).max(16),
    securityRequirements: EmptyArraySchema,
  })
  .strict();

const PublishedAgentCardSchema = z
  .object({
    name: z.string().min(1).max(512),
    description: z.string().min(1).max(2_000),
    supportedInterfaces: z.tuple([PublishedAgentInterfaceSchema]),
    provider: z
      .object({
        organization: z.string().min(1).max(512),
        url: z.string().url(),
      })
      .strict(),
    version: z.string().min(1).max(128),
    documentationUrl: z.string().max(2_000).optional(),
    capabilities: z
      .object({
        streaming: z.literal(false).optional(),
        pushNotifications: z.literal(false).optional(),
        extensions: EmptyArraySchema,
        extendedAgentCard: z.literal(false).optional(),
      })
      .strict(),
    securitySchemes: EmptyObjectSchema,
    securityRequirements: EmptyArraySchema,
    defaultInputModes: z.tuple([z.literal("application/json")]),
    defaultOutputModes: z.tuple([z.literal("application/json")]),
    skills: z.tuple([PublishedAgentSkillSchema]),
    signatures: EmptyArraySchema,
    iconUrl: z.string().url().optional(),
    verificationMethods: z.tuple([VendorVerificationMethodSchema]),
  })
  .strict();

const RawA2aDataPartSchema = z
  .object({
    data: z.unknown(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    filename: z.string().max(1_024).optional(),
    mediaType: z.string().max(256).optional(),
  })
  .strict();
const RawA2aMessageSchema = z
  .object({
    messageId: z.string().min(1).max(256),
    contextId: z.string().min(1).max(256),
    taskId: z.string().max(256).optional(),
    role: z.literal("ROLE_AGENT"),
    parts: z.tuple([RawA2aDataPartSchema]),
    metadata: z.record(z.string(), z.unknown()).optional(),
    extensions: z.array(z.string().max(512)).max(32).optional(),
    referenceTaskIds: z.array(z.string().max(256)).max(32).optional(),
  })
  .strict();
const RawA2aJsonRpcSuccessSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number().int(), z.null()]),
    result: z.object({ message: RawA2aMessageSchema }).strict(),
  })
  .strict();
const RawA2aJsonRpcErrorSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number().int(), z.null()]),
    error: z
      .object({
        code: z.number().int(),
        message: z.string().min(1).max(2_000),
        data: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
const RawA2aJsonRpcResponseSchema = z.union([
  RawA2aJsonRpcSuccessSchema,
  RawA2aJsonRpcErrorSchema,
]);

export type A2aOfferDiscoveryEvidence = {
  evidenceLevel: "local-process-smoke" | "remote";
  agentCardUrl: string;
  agentCardHash: `sha256:${string}`;
  protocolBinding: "JSONRPC";
  protocolVersion: string;
  requestMessageId: string;
  responseKind: "message" | "task";
  responseId: string;
  contextId: string;
  verificationKeyId: string;
  verificationPublicKey: string;
  remoteProcessId?: number;
};

export type A2aOfferDiscoveryResult = {
  offers: readonly [VendorOffer, VendorOffer];
  offerEvaluations: readonly [VendorOfferEvaluation, VendorOfferEvaluation];
  evidence: A2aOfferDiscoveryEvidence;
};

export type A2aOfferDiscoveryOptions = {
  agentOrigin: string;
  incidentId: string;
  capability: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Explicitly test-only. Production must use a pinned public HTTPS origin. */
  allowHttpLocalTest?: boolean;
  fetchImpl?: typeof fetch;
};

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function readLimitedJsonResponse(
  response: Response,
  maxResponseBytes: number,
  expectJsonRpc: boolean,
): Promise<Response> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new TypeError(`A2A response content type is not JSON: ${contentType || "missing"}`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > maxResponseBytes) {
    throw new RangeError("A2A response exceeds the configured byte limit");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw new RangeError("A2A response exceeds the configured byte limit");
      }
      chunks.push(chunk.value);
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = parseBoundedStrictJsonBytes(body, maxResponseBytes, "A2A response");
  if (expectJsonRpc) RawA2aJsonRpcResponseSchema.parse(decoded);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function createPinnedJsonFetch(input: {
  origin: string;
  allowHttpLocalTest: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl: typeof fetch;
}): typeof fetch {
  return async (resource, init) => {
    const options = input.allowHttpLocalTest ? { allowHttpLocalTest: true } : {};
    const normalizedUrl = normalizePinnedHttpsUrl(inputUrl(resource), input.origin, options);
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await input.fetchImpl(normalizedUrl, {
      ...init,
      redirect: "error",
      signal,
    });
    const method = (init?.method ?? (resource instanceof Request ? resource.method : "GET"))
      .toUpperCase();
    return readLimitedJsonResponse(response, input.maxResponseBytes, method === "POST");
  };
}

function outputParts(result: SendMessageResult): {
  kind: "message" | "task";
  responseId: string;
  contextId: string;
  parts: Part[];
} {
  if ("messageId" in result) {
    const message = result as Message;
    return {
      kind: "message",
      responseId: message.messageId,
      contextId: message.contextId,
      parts: message.parts,
    };
  }
  const task = result as Task;
  return {
    kind: "task",
    responseId: task.id,
    contextId: task.contextId,
    parts: task.artifacts.flatMap((artifact) => artifact.parts),
  };
}

export async function discoverA2aVendorOffers(
  options: A2aOfferDiscoveryOptions,
): Promise<A2aOfferDiscoveryResult> {
  const allowHttpLocalTest = options.allowHttpLocalTest === true;
  const urlOptions = allowHttpLocalTest ? { allowHttpLocalTest: true } : {};
  const agentOrigin = normalizePinnedOrigin(options.agentOrigin, urlOptions);
  const incidentId = IdentifierSchema.parse(options.incidentId);
  const capability = IdentifierSchema.parse(options.capability);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError("A2A timeout must be an integer from 1 to 60000 milliseconds");
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 4_194_304) {
    throw new RangeError("A2A byte limit must be an integer from 1 to 4194304");
  }

  const fetchImpl = createPinnedJsonFetch({
    origin: agentOrigin,
    allowHttpLocalTest,
    timeoutMs,
    maxResponseBytes,
    fetchImpl: options.fetchImpl ?? fetch,
  });
  const agentCardUrl = new URL("/.well-known/agent-card.json", agentOrigin).toString();
  const rawAgentCardResponse = await fetchImpl(agentCardUrl, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!rawAgentCardResponse.ok) {
    throw new Error(`A2A Agent Card returned HTTP ${rawAgentCardResponse.status}`);
  }
  const publishedAgentCard = PublishedAgentCardSchema.parse(
    parseStrictJson(await rawAgentCardResponse.text()),
  );
  const verificationMethod = publishedAgentCard.verificationMethods[0];
  const agentCardHash = canonicalHash(publishedAgentCard);
  // Select the A2A transport from the same raw card that was hashed above.
  // A second discovery fetch would allow a card-rotation TOCTOU between the
  // immutable offer binding and the endpoint selected by the SDK.
  const agentCard = AgentCard.fromJSON(publishedAgentCard);
  const client = await new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
  }).createFromAgentCard(agentCard);
  const jsonRpcInterface = agentCard.supportedInterfaces.find(
    (candidate) => candidate.protocolBinding === "JSONRPC",
  );
  if (!jsonRpcInterface) throw new TypeError("Agent Card does not advertise JSONRPC");
  normalizePinnedHttpsUrl(
    jsonRpcInterface.url,
    agentOrigin,
    urlOptions,
  );
  const requestMessageId = randomUUID();
  const request: SendMessageRequest = {
    tenant: "",
    message: {
      messageId: requestMessageId,
      role: Role.ROLE_USER,
      parts: [
        {
          content: {
            $case: "data",
            value: { kind: "discover_offers", incidentId, capability },
          },
          metadata: { trust: "sanitized-buyer-input" },
          filename: "",
          mediaType: "application/json",
        },
      ],
      taskId: "",
      contextId: "",
      extensions: [],
      metadata: {},
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: {},
  };
  const result = await client.sendMessage(request, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const output = outputParts(result);
  const dataParts = output.parts.filter((part) => part.content?.$case === "data");
  if (dataParts.length !== 1) {
    throw new TypeError("A2A response must contain exactly one structured data part");
  }
  const payload = SignedOffersPayloadSchema.parse(dataParts[0]!.content!.value);
  if (payload.incidentId !== incidentId) throw new TypeError("A2A incident binding mismatch");
  if (payload.offers[0].payload.offerId === payload.offers[1].payload.offerId) {
    throw new TypeError("A2A vendor must return two distinct immutable offers");
  }
  for (const offer of payload.offers) {
    if (offer.payload.capability !== capability) throw new TypeError("A2A offer capability mismatch");
    if (offer.payload.providerAgentId !== verificationMethod.controller) {
      throw new TypeError("A2A offer provider identity mismatch");
    }
    if (!allowHttpLocalTest && offer.payload.providerAgentCardUrl !== agentCardUrl) {
      throw new TypeError("A2A offer Agent Card URL mismatch");
    }
    if (offer.payload.providerAgentCardHash !== agentCardHash) {
      throw new TypeError("A2A offer Agent Card hash mismatch");
    }
    if (
      offer.keyId !== verificationMethod.id ||
      offer.signer !== verificationMethod.publicKeyBase58
    ) {
      throw new TypeError("A2A offer does not use the Agent Card verification method");
    }
    if (!allowHttpLocalTest && new URL(offer.payload.resourceUrl).origin !== agentOrigin) {
      throw new TypeError("A2A paid resource origin is not pinned to the discovered card");
    }
  }
  const offerIds = payload.offers.map((offer) => offer.payload.offerId);
  if (
    new Set(payload.offerEvaluations.map((entry) => entry.offerId)).size !== 2 ||
    payload.offerEvaluations.some((entry) => !offerIds.includes(entry.offerId))
  ) {
    throw new TypeError("A2A offer evaluation metadata must map one-to-one to signed offers");
  }

  return {
    offers: payload.offers,
    offerEvaluations: payload.offerEvaluations,
    evidence: {
      evidenceLevel: allowHttpLocalTest ? "local-process-smoke" : "remote",
      agentCardUrl,
      agentCardHash,
      protocolBinding: "JSONRPC",
      protocolVersion: client.protocolVersion,
      requestMessageId,
      responseKind: output.kind,
      responseId: output.responseId,
      contextId: output.contextId,
      verificationKeyId: verificationMethod.id,
      verificationPublicKey: verificationMethod.publicKeyBase58,
      ...(payload.processId === undefined ? {} : { remoteProcessId: payload.processId }),
    },
  };
}
