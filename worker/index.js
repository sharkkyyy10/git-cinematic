// Edge entry point: serves the static viewer and a health check.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    }
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404 && (request.headers.get("accept") || "").includes("text/html")) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }
    return res;
  },
};
