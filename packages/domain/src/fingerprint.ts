import { canonicalHash } from "./canonical.js";
import {
  IncidentRunBindingInputSchema,
  RequestFingerprintInputSchema,
  type IncidentRunBindingInput,
  type RequestFingerprintInput,
} from "./schemas.js";
import { normalizeHttpsUrl, normalizePinnedHttpsUrl } from "./url.js";

export type CreateRequestFingerprintOptions = {
  pinnedOrigin?: string;
  allowHttpLocalTest?: boolean;
};

export function canonicalRequestFingerprintObject(
  input: RequestFingerprintInput,
  options: CreateRequestFingerprintOptions = {},
): RequestFingerprintInput {
  const parsed = RequestFingerprintInputSchema.parse(input);
  const urlOptions = options.allowHttpLocalTest === undefined
    ? {}
    : { allowHttpLocalTest: options.allowHttpLocalTest };
  const resourceUrl = options.pinnedOrigin
    ? normalizePinnedHttpsUrl(parsed.resourceUrl, options.pinnedOrigin, urlOptions)
    : normalizeHttpsUrl(parsed.resourceUrl, urlOptions);
  return RequestFingerprintInputSchema.parse({ ...parsed, resourceUrl });
}

export function createRequestFingerprint(
  input: RequestFingerprintInput,
  options: CreateRequestFingerprintOptions = {},
): `sha256:${string}` {
  return canonicalHash(canonicalRequestFingerprintObject(input, options));
}

export function createIncidentRunBindingHash(
  input: IncidentRunBindingInput,
): `sha256:${string}` {
  return canonicalHash(IncidentRunBindingInputSchema.parse(input));
}
