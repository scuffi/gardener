export default {
  fetch(request: Request): Response {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({ ok: true, service: "gardener-actions-runtime" });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler;
