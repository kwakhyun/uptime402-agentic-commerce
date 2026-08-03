import "server-only";

import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { z } from "zod";

const MAX_BEARER_TOKEN_BYTES = 16 * 1024;
const GoogleEmailSchema = z.string().email().max(320);

export type OperatorOidcIdentity = Readonly<{
  audience: string;
  principal: string;
  subject: string;
  issuer: "accounts.google.com" | "https://accounts.google.com";
}>;

export type OperatorOidcAuthConfig = Readonly<{
  audience: string;
  allowedPrincipals: readonly string[];
}>;

export interface OperatorOidcTokenVerifier {
  verifyBearerToken(token: string, exactAudience: string): Promise<OperatorOidcIdentity>;
}

type GoogleIdTokenVerifier = Pick<OAuth2Client, "verifyIdToken">;

/**
 * Verifies Google-signed OIDC ID tokens. The google-auth library checks the
 * signature, expiry, issuer, and requested audience; the claims are then
 * checked again here before an application role is granted.
 */
export class GoogleOperatorOidcTokenVerifier implements OperatorOidcTokenVerifier {
  constructor(private readonly client: GoogleIdTokenVerifier = new OAuth2Client()) {}

  async verifyBearerToken(
    token: string,
    exactAudience: string,
  ): Promise<OperatorOidcIdentity> {
    const ticket = await this.client.verifyIdToken({
      idToken: token,
      audience: exactAudience,
    });
    const payload = ticket.getPayload() as TokenPayload | undefined;
    if (!payload) throw new Error("Google OIDC token has no payload");
    if (typeof payload.aud !== "string" || payload.aud !== exactAudience) {
      throw new Error("Google OIDC token audience mismatch");
    }
    if (
      payload.iss !== "accounts.google.com" &&
      payload.iss !== "https://accounts.google.com"
    ) {
      throw new Error("Google OIDC token issuer mismatch");
    }
    if (typeof payload.sub !== "string" || payload.sub.length < 1 || payload.sub.length > 256) {
      throw new Error("Google OIDC token subject is missing");
    }
    if (payload.email_verified !== true) {
      throw new Error("Google OIDC email claim is not verified");
    }
    const principal = GoogleEmailSchema.parse(payload.email);
    return Object.freeze({
      audience: payload.aud,
      principal,
      subject: payload.sub,
      issuer: payload.iss,
    });
  }
}

export class OperatorAuthenticationError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code:
      | "operator_token_required"
      | "operator_token_invalid"
      | "operator_audience_mismatch"
      | "operator_principal_forbidden",
  ) {
    super(code);
    this.name = "OperatorAuthenticationError";
  }
}

function parseBearerToken(header: string | null): string {
  if (!header) {
    throw new OperatorAuthenticationError(401, "operator_token_required");
  }
  if (Buffer.byteLength(header, "utf8") > MAX_BEARER_TOKEN_BYTES) {
    throw new OperatorAuthenticationError(401, "operator_token_invalid");
  }
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(header);
  if (!match?.[1]) {
    throw new OperatorAuthenticationError(401, "operator_token_invalid");
  }
  return match[1];
}

/** Authenticates before request-body parsing so mutation schemas are not public oracles. */
export async function authenticateOperator(
  authorizationHeader: string | null,
  config: OperatorOidcAuthConfig,
  verifier: OperatorOidcTokenVerifier,
): Promise<OperatorOidcIdentity> {
  const token = parseBearerToken(authorizationHeader);
  let identity: OperatorOidcIdentity;
  try {
    identity = await verifier.verifyBearerToken(token, config.audience);
  } catch {
    throw new OperatorAuthenticationError(401, "operator_token_invalid");
  }
  if (identity.audience !== config.audience) {
    throw new OperatorAuthenticationError(403, "operator_audience_mismatch");
  }
  if (!config.allowedPrincipals.includes(identity.principal)) {
    throw new OperatorAuthenticationError(403, "operator_principal_forbidden");
  }
  return identity;
}

export function parseOperatorOidcAuthConfig(
  environment: Readonly<NodeJS.ProcessEnv>,
): OperatorOidcAuthConfig {
  const audience = environment.CONTROL_PLANE_OPERATOR_AUDIENCE?.trim();
  if (!audience || audience.length > 512 || /\s/u.test(audience)) {
    throw new TypeError(
      "CONTROL_PLANE_OPERATOR_AUDIENCE must be an exact non-empty OIDC audience",
    );
  }
  const rawPrincipals = environment.CONTROL_PLANE_OPERATOR_PRINCIPALS?.split(",") ?? [];
  const allowedPrincipals = rawPrincipals
    .map((principal) => principal.trim())
    .filter(Boolean)
    .map((principal) => GoogleEmailSchema.parse(principal));
  if (
    allowedPrincipals.length === 0 ||
    new Set(allowedPrincipals).size !== allowedPrincipals.length
  ) {
    throw new TypeError(
      "CONTROL_PLANE_OPERATOR_PRINCIPALS must contain distinct Google principals",
    );
  }
  return Object.freeze({
    audience,
    allowedPrincipals: Object.freeze(allowedPrincipals),
  });
}
