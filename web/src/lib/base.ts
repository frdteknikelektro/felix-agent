// Base-path support. The SPA normally serves at "/" — index.html pins
// <base href="/"> so document.baseURI stays stable on deep routes. A fronting
// proxy (e.g. an orchestrator mounting this console under /agents/<id>/console/)
// may rewrite that tag; router paths and API/SSE URLs all resolve through here.
export const basePath = new URL(document.baseURI).pathname.replace(/\/$/, "");

export function withBase(path: string): string {
  return `${basePath}${path}`;
}
