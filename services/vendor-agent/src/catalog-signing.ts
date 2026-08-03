import type { KeyPairSigner } from "@solana/kit";
import {
  Base58Schema,
  HttpsUrlSchema,
  IdentifierSchema,
  VendorOfferCatalogSchema,
  VendorOfferEvaluationSchema,
  VendorOfferPayloadSchema,
  canonicalHash,
  normalizePinnedOrigin,
  type VendorOfferCatalog,
} from "@uptime402/domain";
import { signEnvelope } from "@uptime402/payments";
import { z } from "zod";

import { buildVendorAgentCard } from "./index.js";

const VendorOfferDraftSchema = VendorOfferPayloadSchema.omit({
  providerAgentCardHash: true,
});

export const VendorOfferCatalogSigningInputSchema = z
  .object({
    schemaVersion: z.literal("1"),
    agent: z
      .object({
        agentId: IdentifierSchema,
        agentName: z.string().min(1).max(256),
        agentDescription: z.string().min(1).max(2_000),
        agentOrigin: HttpsUrlSchema,
        vendorTenant: IdentifierSchema,
      })
      .strict(),
    offers: z.tuple([VendorOfferDraftSchema, VendorOfferDraftSchema]),
    offerEvaluations: z.tuple([
      VendorOfferEvaluationSchema,
      VendorOfferEvaluationSchema,
    ]),
  })
  .strict();

export type VendorOfferCatalogSigningInput = z.infer<
  typeof VendorOfferCatalogSigningInputSchema
>;

export type SignVendorOfferCatalogOptions = Readonly<{
  input: VendorOfferCatalogSigningInput;
  signer: KeyPairSigner;
  expectedSignerPublicKey: string;
  keyId: string;
}>;

/**
 * Signs the exact payment-evidence-v2 offer payload. The Agent Card hash is
 * computed from the same raw object published by the vendor runtime. This
 * helper accepts an existing signer only and never creates or replaces keys.
 */
export async function signVendorOfferCatalog(
  options: SignVendorOfferCatalogOptions,
): Promise<VendorOfferCatalog> {
  const input = VendorOfferCatalogSigningInputSchema.parse(options.input);
  const expectedSigner = Base58Schema.parse(options.expectedSignerPublicKey);
  if (options.signer.address !== expectedSigner) {
    throw new Error("Existing vendor keypair does not match the pinned public key");
  }
  if (!options.keyId || options.keyId.length > 256) {
    throw new TypeError("Vendor Agent Card key ID must be non-empty and at most 256 characters");
  }
  const agentOrigin = normalizePinnedOrigin(input.agent.agentOrigin);
  const agentCardUrl = new URL("/.well-known/agent-card.json", agentOrigin).toString();
  const agentCard = buildVendorAgentCard(
    {
      ...input.agent,
      agentOrigin,
      a2aPath: "/a2a",
    },
    { signerPublicKey: expectedSigner, keyId: options.keyId },
  );
  const providerAgentCardHash = canonicalHash(agentCard);
  const seenOfferIds = new Set<string>();
  const signedOffers = await Promise.all(
    input.offers.map(async (draft) => {
      if (seenOfferIds.has(draft.offerId)) {
        throw new TypeError("Offer draft IDs must be distinct");
      }
      seenOfferIds.add(draft.offerId);
      if (
        draft.providerAgentId !== input.agent.agentId ||
        draft.providerAgentCardUrl !== agentCardUrl ||
        new URL(draft.resourceUrl).origin !== agentOrigin ||
        !draft.capability ||
        !draft.method
      ) {
        throw new TypeError("Offer draft does not bind the generated Agent Card and P0 routes");
      }
      if (draft.payee === expectedSigner) {
        throw new TypeError("Vendor offer authority must differ from the USDC payee");
      }
      const payload = VendorOfferPayloadSchema.parse({
        ...draft,
        providerAgentCardHash,
      });
      return signEnvelope(payload, VendorOfferPayloadSchema, {
        signer: options.signer,
        keyId: options.keyId,
      });
    }),
  );
  return VendorOfferCatalogSchema.parse({
    schemaVersion: "2",
    offers: [signedOffers[0], signedOffers[1]],
    offerEvaluations: input.offerEvaluations,
  });
}
