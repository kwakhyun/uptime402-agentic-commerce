function isExactHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Cloud Run exposes both a stable project-number hostname and a generated
 * `a.run.app` hostname. Evidence may use an alias only when the raw service
 * export binds both that alias and `status.url` in its official URL annotation.
 */
export function isCloudRunOriginBound(
  description: Record<string, unknown>,
  expectedOrigin: string,
): boolean {
  if (!isExactHttpsOrigin(expectedOrigin)) return false;
  const metadata = record(description.metadata);
  const status = record(description.status);
  const statusUrl = status?.url;
  if (!isExactHttpsOrigin(statusUrl)) return false;
  if (statusUrl === expectedOrigin) return true;

  const annotations = record(metadata?.annotations);
  const rawAliases = annotations?.["run.googleapis.com/urls"];
  if (typeof rawAliases !== "string" || rawAliases.length === 0 || rawAliases.length > 16_384) {
    return false;
  }
  let aliases: unknown;
  try {
    aliases = JSON.parse(rawAliases);
  } catch {
    return false;
  }
  if (!Array.isArray(aliases) || aliases.length < 2 || aliases.length > 16) return false;
  if (!aliases.every(isExactHttpsOrigin)) return false;
  const uniqueAliases = new Set(aliases);
  return (
    uniqueAliases.size === aliases.length &&
    uniqueAliases.has(statusUrl) &&
    uniqueAliases.has(expectedOrigin)
  );
}
