import { describe, expect, it } from "vitest";

import { isCloudRunOriginBound } from "../scripts/cloud-run-evidence.js";

const stableOrigin = "https://uptime402-control-plane-1065649463621.asia-northeast3.run.app";
const generatedOrigin = "https://uptime402-control-plane-iexsqmjhha-du.a.run.app";

function description(statusUrl: string, aliases?: unknown): Record<string, unknown> {
  return {
    metadata: {
      annotations: aliases === undefined
        ? {}
        : { "run.googleapis.com/urls": JSON.stringify(aliases) },
    },
    status: { url: statusUrl },
  };
}

describe("Cloud Run raw service URL evidence", () => {
  it("accepts the exact status URL without an alias annotation", () => {
    expect(isCloudRunOriginBound(description(stableOrigin), stableOrigin)).toBe(true);
  });

  it("accepts a project-number origin only when the raw export binds both official aliases", () => {
    expect(isCloudRunOriginBound(
      description(generatedOrigin, [stableOrigin, generatedOrigin]),
      stableOrigin,
    )).toBe(true);
  });

  it("rejects missing, malformed, external, duplicate, and non-origin aliases", () => {
    expect(isCloudRunOriginBound(description(generatedOrigin), stableOrigin)).toBe(false);
    expect(isCloudRunOriginBound(
      { metadata: { annotations: { "run.googleapis.com/urls": "not-json" } }, status: { url: generatedOrigin } },
      stableOrigin,
    )).toBe(false);
    expect(isCloudRunOriginBound(
      description(generatedOrigin, [stableOrigin, "https://attacker.example"]),
      stableOrigin,
    )).toBe(false);
    expect(isCloudRunOriginBound(
      description(generatedOrigin, [stableOrigin, generatedOrigin, generatedOrigin]),
      stableOrigin,
    )).toBe(false);
    expect(isCloudRunOriginBound(
      description(generatedOrigin, [`${stableOrigin}/path`, generatedOrigin]),
      stableOrigin,
    )).toBe(false);
  });
});
