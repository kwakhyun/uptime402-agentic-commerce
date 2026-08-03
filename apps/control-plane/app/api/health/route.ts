export function GET() {
  return Response.json({
    service: "uptime402-control-plane",
    status: "healthy",
  });
}
