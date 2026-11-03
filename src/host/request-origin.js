// The origin a browser addressed, and the same-origin check every route that changes something or opens a socket makes
// against it. Behind front proxies the Host header names the proxied site, X-Forwarded-Host the name in the address
// bar: Caddy sets it to the requested host, or passes on the one Cloudflare gave — a Worker serving the site under
// another name (orthros.chalco.workers.dev). Not an authority: a client outside a browser sets it as it likes — as it
// sets Origin —; a page cannot, on another site's request, without a CORS preflight this server never grants, nor on a
// WebSocket's handshake at all.

const HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?)(:\d{1,5})?$/;
const first = (value) => String(value ?? '').split(',')[0].trim().toLowerCase();

/** The host the browser addressed (`name[:port]`, lowercase): the front proxy's X-Forwarded-Host, else Host; '' if neither. */
export function requestHost(req) {
  const forwarded = first(req.headers['x-forwarded-host']);
  if (HOST.test(forwarded)) return forwarded;
  const host = first(req.headers.host);
  return HOST.test(host) ? host : '';
}

/** The origin a front proxy says the browser addressed (`https://name`), or `fallback` without one. */
export function forwardedOrigin(req, fallback) {
  const host = first(req.headers['x-forwarded-host']);
  if (!HOST.test(host)) return fallback;
  return `${first(req.headers['x-forwarded-proto']) === 'http' ? 'http' : 'https'}://${host}`;
}

/** The request comes from a page of the origin it was addressed to (its Origin header's host is the addressed one). */
export function sameOrigin(req) {
  let origin; try { origin = new URL(req.headers.origin); } catch { return false; }
  return (origin.protocol === 'https:' || origin.protocol === 'http:') && origin.host === requestHost(req);
}
