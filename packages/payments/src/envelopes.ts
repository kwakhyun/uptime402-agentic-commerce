import {
  canonicalBytes,
  canonicalHash,
} from "@uptime402/domain";
import {
  signBytes,
  signatureBytes,
  verifySignature,
  type KeyPairSigner,
} from "@solana/kit";
import bs58 from "bs58";
import { z } from "zod";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const envelopeShape = z
  .object({
    payload: z.unknown(),
    signer: z.string().min(32).max(44).regex(BASE58),
    keyId: z.string().min(1).max(256),
    signature: z.string().min(64).max(96).regex(BASE58),
  })
  .strict();

export type SignedEnvelope<T> = Readonly<{
  payload: T;
  signer: string;
  keyId: string;
  signature: string;
}>;

export type PayloadSchema<T> = Readonly<{
  parse(value: unknown): T;
}>;

export type EnvelopeSigningIdentity = Readonly<{
  keyId: string;
  signer: KeyPairSigner;
}>;

export type EnvelopeVerificationPolicy<T> = Readonly<{
  payloadSchema: PayloadSchema<T>;
  expectedSigner: string;
  expectedKeyId: string;
  forbiddenSigner?: string;
}>;

export type CanonicalSignatureVerificationOptions<T> = Readonly<{
  payload: unknown;
  payloadSchema: PayloadSchema<T>;
  signerPublicKey: string;
  signature: string;
}>;

function decodeBase58Length(value: string, expectedLength: number, label: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new TypeError(`${label} must be valid Base58`);
  }
  if (decoded.byteLength !== expectedLength) {
    throw new TypeError(`${label} has an invalid Ed25519 byte length`);
  }
  return decoded;
}

/** Verifies a detached Ed25519 signature over RFC 8785 canonical payload bytes. */
export async function verifyCanonicalEd25519Signature<T>(
  options: CanonicalSignatureVerificationOptions<T>,
): Promise<boolean> {
  const payload = options.payloadSchema.parse(options.payload);
  const publicKeyBytes = decodeBase58Length(options.signerPublicKey, 32, "Signer public key");
  const rawSignature = signatureBytes(
    decodeBase58Length(options.signature, 64, "Detached signature"),
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(publicKeyBytes),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return verifySignature(publicKey, rawSignature, canonicalBytes(payload));
}

export async function signEnvelope<T>(
  payload: T,
  payloadSchema: PayloadSchema<T>,
  identity: EnvelopeSigningIdentity,
): Promise<SignedEnvelope<T>> {
  if (!identity.keyId || identity.keyId.length > 256) {
    throw new TypeError("Envelope keyId must be a non-empty pinned identifier");
  }
  const validatedPayload = payloadSchema.parse(payload);
  const signature = await signBytes(identity.signer.keyPair.privateKey, canonicalBytes(validatedPayload));
  return Object.freeze({
    payload: validatedPayload,
    signer: identity.signer.address,
    keyId: identity.keyId,
    signature: bs58.encode(signature),
  });
}

export async function verifyEnvelope<T>(
  candidate: unknown,
  policy: EnvelopeVerificationPolicy<T>,
): Promise<SignedEnvelope<T>> {
  const outer = envelopeShape.parse(candidate);
  if (outer.signer !== policy.expectedSigner || outer.keyId !== policy.expectedKeyId) {
    throw new Error("Signed envelope identity does not match the pinned verification method");
  }
  if (policy.forbiddenSigner && outer.signer === policy.forbiddenSigner) {
    throw new Error("Signed envelope authority must be separate from the forbidden identity");
  }
  const payload = policy.payloadSchema.parse(outer.payload);
  const publicKeyBytes = decodeBase58Length(outer.signer, 32, "Envelope signer");
  const rawSignature = signatureBytes(
    decodeBase58Length(outer.signature, 64, "Envelope signature"),
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(publicKeyBytes),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (!(await verifySignature(publicKey, rawSignature, canonicalBytes(payload)))) {
    throw new Error("Signed envelope verification failed");
  }
  return {
    payload,
    signer: outer.signer,
    keyId: outer.keyId,
    signature: outer.signature,
  };
}

export function hashSignedEnvelope(envelope: SignedEnvelope<unknown>): `sha256:${string}` {
  return canonicalHash(envelope);
}

export function assertSeparateSigningAuthorities(
  vendor: Pick<SignedEnvelope<unknown>, "signer" | "keyId">,
  outcome: Pick<SignedEnvelope<unknown>, "signer" | "keyId">,
  payee?: string,
): void {
  if (vendor.signer === outcome.signer || vendor.keyId === outcome.keyId) {
    throw new Error("Vendor receipt and recovery outcome must use separate signing authorities");
  }
  if (payee && (vendor.signer === payee || outcome.signer === payee)) {
    throw new Error("Application signing authorities must be separate from the USDC payee");
  }
}
