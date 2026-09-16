// Cloudflare Worker: Profound Dynamic Bot Rendering
// Zone:  bryanjohnson.com
// Route: www.bryanjohnson.com/about*   (Worker Route, NOT a Custom Domain)
// Secret required: PROFOUND_CONCIERGE_KEY
//
// Based on Profound's reference Worker:
// https://docs.tryprofound.com/dynamic-bot-rendering/cloudflare
// Only PUBLIC_PATHS has been changed from the reference implementation.

const CONCIERGE_ENDPOINT = 'https://concierge.tryprofound.com/v1/concierge';

// Keep this list in sync with the supported assistants in the Profound docs.
// Drift means bot-kind: unknown — a wasted round trip that serves nothing.
// https://docs.tryprofound.com/dynamic-bot-rendering/overview
const BOT_RE = /duckassistbot|chatgpt-user|gemini-deep-research|perplexity-user|amzn-user|mistralai-user|claude-user|claude-code|codex/i;

// Explicit public pages only. Review each path before extending this list.
// Exact match, including query string — '/about' does NOT cover '/about?utm_source=x'.
// bryanjohnson.com is a 4-link hub; /about is the only substantive page on the
// Webflow site. Everything else lives on blueprint.bryanjohnson.com or dontdie.com.
const PUBLIC_PATHS = new Set(['/about']);

const UPSTREAM_TIMEOUT_MS = 2000; // Header deadline; leaves time for origin fallback.
const FORWARDED_HEADERS = ['user-agent', 'accept', 'accept-encoding', 'accept-language'];

// Statuses that mean "Profound could not serve this" rather than "the origin
// said so". 404 is deliberately absent: Profound fails open internally and
// returns your origin's own status, so a 404 is your real 404.
const FAILOVER_STATUSES = new Set([400, 401, 403, 500, 502, 503, 504]);

async function failOpen(request) {
  // A subrequest to the same zone goes to the origin without re-running this Worker.
  // On this zone that path is Cloudflare -> Fastly (Webflow's CDN) -> Webflow.
  const originResponse = await fetch(request);
  const response = new Response(originResponse.body, originResponse);
  response.headers.set('x-concierge-cdn-failover', '1');
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const userAgent = request.headers.get('user-agent') || '';

    // Loop protection: Profound stamps this on its own origin fetches.
    // Passing it through means those fetches reach the origin directly.
    // This marker is spoofable — never use it to bypass WAF or access control.
    if (request.headers.has('x-concierge-request')) return fetch(request);

    if (request.method !== 'GET') return fetch(request);
    if (request.headers.has('cookie') || request.headers.has('authorization')) return fetch(request);

    const isAssistant = BOT_RE.test(userAgent);
    if (!isAssistant || !PUBLIC_PATHS.has(url.pathname)) return fetch(request);

    // Copy only required negotiation headers, never viewer credentials or identity.
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }

    headers.set('x-concierge-api-key', env.PROFOUND_CONCIERGE_KEY);
    headers.set('x-concierge-host', url.hostname);
    headers.set('x-concierge-url', url.pathname + url.search);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetch(CONCIERGE_ENDPOINT, {
        method: 'GET',
        headers,
        redirect: 'manual', // pass redirects through instead of following them
        cache: 'no-store',  // the upstream call must NEVER be cached
        signal: controller.signal,
      });

      if (FAILOVER_STATUSES.has(response.status)) {
        if (response.body) void response.body.cancel().catch(() => {});
        controller.abort();
        return failOpen(request);
      }
      const result = new Response(response.body, response);
      result.headers.set('cache-control', 'no-store');
      return result;
    } catch {
      return failOpen(request);
    } finally {
      clearTimeout(timeout);
    }
  },
};
