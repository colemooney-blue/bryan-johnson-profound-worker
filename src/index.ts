/**
 * Cloudflare Worker for Log Collection
 *
 * Forwards request metadata to Profound's log collection API. The origin
 * response body is never read or modified, and every error in the logging
 * path is swallowed, so logging cannot alter the response. Failures are
 * logged with enough detail to tell a rejected request apart from a
 * timeout or a connection error.
 *
 * Deployed on: www.bryanjohnson.com/*  (Webflow site)
 * DO NOT point this at blueprint.bryanjohnson.com or immortals.com —
 * Profound's docs are explicit that a Worker should not sit in front of a
 * Shopify storefront. Use a log drain for those.
 *
 * Source: https://docs.tryprofound.com/ -> Cloudflare integration (Worker)
 * Use as-is. In particular: never clone the response or read its body, and
 * keep the logging call inside ctx.waitUntil() with a .catch().
 */

export interface Env {
    PROFOUND_API_URL: string;
    PROFOUND_LOG_INGESTION_TOKEN: string;
}

// Paths that are not logged. Matched on full path segments, so '/cart' does
// not match '/cartography'. Note: this only skips LOGGING — the request still
// passes through the Worker. To take a path out of the Worker entirely,
// narrow the route pattern instead.
const EXCLUDED_PATHS = ['/checkout', '/cart', '/admin', '/api'];

// Characters kept from a rejected response body when logging the failure.
const DETAIL_LIMIT = 512;

// Percent-decoded and lowercased so encoded variants such as '/%63heckout'
// and '/checkout%2Fpayment' match the same way the origin routes them.
function normalizePath(pathname: string): string {
    try {
        return decodeURIComponent(pathname).toLowerCase();
    } catch {
        return pathname.toLowerCase();
    }
}

function isExcluded(pathname: string): boolean {
    const path = normalizePath(pathname);
    return EXCLUDED_PATHS.some(
        (excluded) => path === excluded || path.startsWith(`${excluded}/`),
    );
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const response = await fetch(request);

        const skip = response.status === 101 || isExcluded(new URL(request.url).pathname);

        if (!skip) {
            ctx.waitUntil(
                sendLog(request, response, env).catch((error: unknown) =>
                    console.error(
                        'Failed to send logs:',
                        error instanceof Error ? `${error.name}: ${error.message}` : error,
                    ),
                ),
            );
        }

        return response;
    },
} satisfies ExportedHandler<Env>;

async function sendLog(request: Request, response: Response, env: Env) {
    const requestUrl = new URL(request.url);

    // +2 for ': ' and +2 for '\r\n' per header
    const headerSize = Array.from(response.headers.entries()).reduce(
        (total, [key, value]) => total + key.length + value.length + 4,
        0,
    );

    // Derived from content-length so the body is never buffered. Streamed or
    // chunked responses have no content-length and are reported as headers only.
    // HEAD and bodyless statuses advertise a content-length that is never sent,
    // so their body size is counted as zero.
    const contentLength = Number(response.headers.get('content-length'));
    const transmitsBody =
        request.method !== 'HEAD' && response.status !== 204 && response.status !== 304;
    const bodySize = transmitsBody && Number.isFinite(contentLength) ? contentLength : 0;
    const bytes = headerSize + bodySize;

    const logData = {
        timestamp: Date.now(),
        host: requestUrl.hostname,
        method: request.method,
        pathname: requestUrl.pathname,
        query_params: Object.fromEntries(requestUrl.searchParams),
        ip: request.headers.get('cf-connecting-ip'),
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
        bytes,
        status: response.status,
    };

    const logResponse = await fetch(env.PROFOUND_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': env.PROFOUND_LOG_INGESTION_TOKEN,
        },
        body: JSON.stringify([logData]),
        signal: AbortSignal.timeout(5000),
    });

    // Only the first chunk of a rejected response is read, and only up to
    // DETAIL_LIMIT characters of it are kept, so a misconfigured URL that
    // returns a large body can never fill the isolate. The origin response
    // is still never read.
    if (!logResponse.ok) {
        const reader = logResponse.body?.getReader();
        const chunk = await reader?.read();
        await reader?.cancel();

        const detail = chunk?.value
            ? new TextDecoder().decode(chunk.value).slice(0, DETAIL_LIMIT)
            : '';

        console.error(`Log ingestion rejected the request: ${logResponse.status} ${detail}`);
        return;
    }

    await logResponse.body?.cancel();
}