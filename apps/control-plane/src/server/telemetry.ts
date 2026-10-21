import "server-only";

import { isIP } from "node:net";

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
  | "query_secret"
  | "unapproved_field";

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
    name: "credential",
    pattern: /\b(?:proxy-)?authorization(["']?\s*[:=]\s*)[^\r\n]+/giu,
    replacement: "authorization$1[REDACTED_CREDENTIAL]",
  },
  {
    name: "query_secret",
    pattern: /([?&](?:api[_-]?key|access[_-]?token|token|secret|password|session)=)[^&#\s]+/giu,
    replacement: "$1[REDACTED_CREDENTIAL]",
  },
  {
    name: "credential",
    pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu,
    replacement: "[REDACTED_CREDENTIAL]",
  },
  {
    name: "credential",
    pattern: /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret)(["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&]+)/giu,
    replacement: "$1$2[REDACTED_CREDENTIAL]",
  },
  {
    name: "cookie",
    pattern: /\b(cookie|set-cookie)(["']?\s*[:=]\s*)[^\r\n]+/giu,
    replacement: "$1$2[REDACTED_COOKIE]",
  },
  {
    name: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    name: "customer_identifier",
    pattern: /\b(customer[_ -]?id|account[_ -]?id|tenant[_ -]?id)(["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9._:-]+)/giu,
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
    unapproved_field: 0,
  };
}

const DIAGNOSTIC_FIELDS = new Set(["error", "errorclass", "message", "details", "errors", "cause", "code", "status", "statuscode", "latencyms", "failurerate", "reason", "type", "health", "description"]);

function sensitiveField(key: string): RedactionRule | null {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (/cookie/u.test(normalized)) return "cookie";
  if (/(?:key|token|secret|password|authorization|credential|session)/u.test(normalized)) return "credential";
  if (/email/u.test(normalized)) return "email";
  if (/^(?:ip|ipv4|ipv6|ipaddress|address|remoteaddress|clientip)$/u.test(normalized)) return "ip_address";
  if (/(?:customer|account|tenant|user|person|name)/u.test(normalized)) return "customer_identifier";
  return null;
}

function redactText(message: string, depth = 0): {
  value: string;
  replacements: Record<RedactionRule, number>;
} {
  const replacements = emptyCounts();
  if (depth > 8) {
    replacements.unapproved_field++;
    return { value: "[REDACTED_DEPTH]", replacements };
  }
  let value = message;
  try {
    const parsed: unknown = JSON.parse(message);
    const clean = (item: unknown, level: number): unknown => {
      if (level > 8) { replacements.unapproved_field++; return "[REDACTED_DEPTH]"; }
      if (typeof item === "string") {
        const result = redactText(item, level + 1);
        addCounts(replacements, result.replacements);
        return result.value;
      }
      if (Array.isArray(item)) return item.map((child) => clean(child, level + 1));
      if (item && typeof item === "object") {
        const output: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(item)) {
          const rule = sensitiveField(key);
          if (rule) { replacements[rule]++; continue; }
          const diagnosticName = key.toLowerCase().replace(/[_ -]/gu, "");
          if (!DIAGNOSTIC_FIELDS.has(diagnosticName)) {
            replacements.unapproved_field++; continue;
          }
          output[diagnosticName] = clean(child, level + 1);
        }
        return output;
      }
      return item;
    };
    if (parsed !== null && (typeof parsed === "object" || typeof parsed === "string")) {
      return { value: JSON.stringify(clean(parsed, depth)), replacements };
    }
  } catch { /* Non-JSON diagnostics use the bounded text filters below. */ }
  value = value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, (raw) => {
    try {
      const url = new URL(raw);
      if (url.username || url.password) {
        replacements.credential++;
        url.username = ""; url.password = "";
      }
      for (const key of [...url.searchParams.keys()]) {
        replacements.query_secret++;
        url.searchParams.set(key, "[REDACTED_CREDENTIAL]");
      }
      return url.toString();
    } catch { return "[REDACTED_URL]"; }
  });
  value = value.replace(/(?<![a-z0-9])(?:[a-f0-9]{0,4}:){2,}[a-f0-9:.]*(?:%[a-z0-9]+)?/giu, (candidate) => {
    if (isIP(candidate.replace(/\.+$/u, "").split("%", 1)[0]!) !== 6) return candidate;
    replacements.ip_address++;
    return "[REDACTED_IP]";
  });
  for (const rule of RULES) {
    replacements[rule.name] += [...value.matchAll(rule.pattern)].length;
    value = value.replace(rule.pattern, rule.replacement);
  }
  return { value, replacements };
}

export function redactUntrustedText(value: string): string {
  return redactText(value.slice(0, 20_000)).value;
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
