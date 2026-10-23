import http from "node:http";

const relayPort = Number(process.env.RELAY_PORT ?? 3210);
const target = new URL(process.env.RELAY_TARGET ?? "http://127.0.0.1:3000");
const allowedMethods = new Set(["GET", "POST"]);

const server = http.createServer((request, response) => {
  const incoming = new URL(request.url ?? "/", "http://relay.invalid");
  if (incoming.pathname !== "/webhooks/meta" || !allowedMethods.has(request.method ?? "")) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("Not found");
    return;
  }

  const headers = { ...request.headers, host: target.host, "x-forwarded-proto": "https" };
  delete headers.connection;
  delete headers["proxy-connection"];
  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: `${incoming.pathname}${incoming.search}`,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, {
      "content-type": upstreamResponse.headers["content-type"] ?? "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("Webhook target unavailable");
  });
  request.pipe(upstream);
});

server.requestTimeout = 15_000;
server.headersTimeout = 20_000;
server.listen(relayPort, "127.0.0.1", () => {
  process.stdout.write(`Webhook-only relay listening on http://127.0.0.1:${relayPort}\n`);
});
