import http from "node:http";

export async function startHealthServer(
  preferredPort: number,
): Promise<{ server: http.Server; port: number }> {
  for (let port = preferredPort; port < preferredPort + 20; port += 1) {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/healthz") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => resolve());
      });
      return { server, port };
    } catch {
      server.close();
    }
  }
  throw new Error(`Unable to bind health server starting at port ${preferredPort}`);
}
