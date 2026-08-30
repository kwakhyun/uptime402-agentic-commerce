import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as runDemoIncident } from "../apps/control-plane/app/api/operator/incidents/demo-run/route.js";
import { POST as runIncident } from "../apps/control-plane/app/api/operator/incidents/run/route.js";
import { POST as armMandate } from "../apps/control-plane/app/api/operator/mandates/arm/route.js";
import { POST as revokeMandate } from "../apps/control-plane/app/api/operator/mandates/[mandateId]/revoke/route.js";

const request = () => new Request("https://control.uptime402.example/api/operator", {
  method: "POST",
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("portfolio replay mutation routes", () => {
  it("returns a fail-closed 404 before auth, Firestore, executor, or signer setup", async () => {
    vi.stubEnv("CONTROL_PLANE_MUTATIONS_ENABLED", "false");

    const responses = await Promise.all([
      armMandate(request()),
      runIncident(request()),
      runDemoIncident(request()),
      revokeMandate(request(), { params: Promise.resolve({ mandateId: "mandate-demo" }) }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "operator_mutations_disabled",
      });
    }
  });
});
