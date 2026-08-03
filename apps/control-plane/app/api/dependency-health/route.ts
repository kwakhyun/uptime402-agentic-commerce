import {
  buildFirestoreAppliedRouteReader,
  inspectAppliedDependencyRoute,
  type AppliedRouteReader,
} from "../../../src/server/dependency-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let routeReader: AppliedRouteReader | undefined;

function reader(): AppliedRouteReader {
  routeReader ??= buildFirestoreAppliedRouteReader();
  return routeReader;
}

export async function GET(request: Request): Promise<Response> {
  const incidentId = request.headers.get("x-uptime402-incident-id");
  const activationId = request.headers.get("x-uptime402-route-activation");
  if (!incidentId || !activationId) {
    return Response.json(
      { status: "unhealthy", reason: "route_binding_required" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const result = await inspectAppliedDependencyRoute(
      { incidentId, activationId },
      reader(),
    );
    if (!result.healthy) {
      return Response.json(
        { status: "unhealthy", reason: result.reason },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(result.body, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json(
      { status: "unhealthy", reason: "route_verification_failed" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
