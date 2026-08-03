import "server-only";

import { canonicalHash, SanitizedTelemetrySchema } from "@uptime402/domain";
import { z } from "zod";

export const RawTelemetrySchema = z
  .object({
    errorClass: z.string().min(1).max(128),
    statusCode: z.number().int().min(100).max(599).optional(),
    latencyMs: z.number().finite().nonnegative().max(3_600_000).optional(),
    failureRate: z.number().finite().min(0).max(1).optional(),
    message: z.string().max(20_000).optional(),
  })
  .strict();

export type RawTelemetry = z.infer<typeof RawTelemetrySchema>;

export type RedactionRule =
  | "credential"
  | "cookie"
  | "email"
  | "customer_identifier"
  | "ip_address"
  | "query_secret";

export type TelemetryRedactionReport = {
  schemaVersion: "1";
  allowlistedFields: readonly [
    "service",
    "signal",
    "errorClass",
    "statusCode",
    "latencyMs",
    "failureRate",
    "message",
  ];
  replacements: Record<RedactionRule, number>;
  totalReplacements: number;
};

const RULES: ReadonlyArray<{
  name: RedactionRule;
  pattern: RegExp;
  replacement: string;
}> = [
  {
    name: "query_secret",
    pattern: /([?&](?:api[_-]?key|access[_-]?token|token|secret|password|session)=)[^&#\s]+/giu,
    replacement: "$1[REDACTED_CREDENTIAL]",
  },
  {
    name: "credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
    replacement: "Bearer [REDACTED_CREDENTIAL]",
  },
  {
    name: "credential",
    pattern: /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret)(\s*[:=]\s*)([^\s,;&]+)/giu,
    replacement: "$1$2[REDACTED_CREDENTIAL]",
  },
  {
    name: "cookie",
    pattern: /\b(cookie|set-cookie)(\s*[:=]\s*)[^\r\n]+/giu,
    replacement: "$1$2[REDACTED_COOKIE]",
  },
  {
    name: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    name: "customer_identifier",
    pattern: /\b(customer[_ -]?id|account[_ -]?id|tenant[_ -]?id)(\s*[:=]\s*)[A-Za-z0-9._:-]+/giu,
    replacement: "$1$2[REDACTED_CUSTOMER_ID]",
  },
  {
    name: "ip_address",
    pattern: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/gu,
    replacement: "[REDACTED_IP]",
  },
];

const ALLOWLISTED_FIELDS = [
  "service",
  "signal",
  "errorClass",
  "statusCode",
  "latencyMs",
  "failureRate",
  "message",
] as const;

function emptyCounts(): Record<RedactionRule, number> {
  return {
    credential: 0,
    cookie: 0,
    email: 0,
    customer_identifier: 0,
    ip_address: 0,
    query_secret: 0,
  };
}

function redactText(message: string): {
  value: string;
  replacements: Record<RedactionRule, number>;
} {
  const replacements = emptyCounts();
  let value = message;
  for (const rule of RULES) {
    replacements[rule.name] += [...value.matchAll(rule.pattern)].length;
    value = value.replace(rule.pattern, rule.replacement);
  }
  return { value, replacements };
}

function addCounts(
  target: Record<RedactionRule, number>,
  source: Record<RedactionRule, number>,
): void {
  for (const name of Object.keys(target) as RedactionRule[]) {
    target[name] += source[name];
  }
}

export function sanitizeTelemetry(
  input: unknown,
  context: Readonly<{ service: string; signal: string }> = { service: "", signal: "" },
): {
  sanitizedTelemetry: z.infer<typeof SanitizedTelemetrySchema>;
  sanitizedContext: Readonly<{ service: string; signal: string }>;
  redactionReport: TelemetryRedactionReport;
  redactionReportHash: `sha256:${string}`;
} {
  const parsed = RawTelemetrySchema.parse(input);
  const redactedService = redactText(context.service);
  const redactedSignal = redactText(context.signal);
  const redactedErrorClass = redactText(parsed.errorClass);
  const redactedMessage = redactText(parsed.message ?? "");
  const replacements = emptyCounts();
  for (const candidate of [
    redactedService,
    redactedSignal,
    redactedErrorClass,
    redactedMessage,
  ]) {
    addCounts(replacements, candidate.replacements);
  }
  const sanitizedTelemetry = SanitizedTelemetrySchema.parse({
    errorClass: redactedErrorClass.value.slice(0, 128),
    ...(parsed.statusCode === undefined ? {} : { statusCode: parsed.statusCode }),
    ...(parsed.latencyMs === undefined ? {} : { latencyMs: parsed.latencyMs }),
    ...(parsed.failureRate === undefined ? {} : { failureRate: parsed.failureRate }),
    ...(parsed.message === undefined
      ? {}
      : { redactedMessage: redactedMessage.value.slice(0, 1_000) }),
  });
  const totalReplacements = Object.values(replacements).reduce(
    (total, count) => total + count,
    0,
  );
  const redactionReport: TelemetryRedactionReport = {
    schemaVersion: "1",
    allowlistedFields: ALLOWLISTED_FIELDS,
    replacements,
    totalReplacements,
  };
  return {
    sanitizedTelemetry,
    sanitizedContext: {
      service: redactedService.value.slice(0, 256),
      signal: redactedSignal.value.slice(0, 256),
    },
    redactionReport,
    redactionReportHash: canonicalHash(redactionReport),
  };
}

export function escapeRenderedText(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
