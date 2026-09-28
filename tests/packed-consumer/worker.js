/**
 * Packed-consumer Worker entry: the deployment README "Server coordinator"
 * documents, built ONLY on the packed package — `edytor/cloudflare`'s
 * `DocumentRoom` (re-exported as the Durable Object class) behind
 * `routeDocumentSocket`. Bundled and run in Miniflare by `smoke-worker.mjs`.
 *
 * `authorize` trusts `?user=` (`denied` is refused) — a smoke stand-in for
 * a real session check.
 */
import { DocumentRoom, requestedReplica, routeDocumentSocket } from 'edytor/cloudflare';

export { DocumentRoom };

const authorize = (request) => {
	const userId = new URL(request.url).searchParams.get('user') ?? 'anon';
	return userId === 'denied' ? null : { userId, replica: requestedReplica(request) };
};

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/health') return new Response('ready');
		const match = /^\/rooms\/([^/]+)\/?$/.exec(url.pathname);
		if (!match) return new Response('not found', { status: 404 });
		return routeDocumentSocket(request, env.ROOM, decodeURIComponent(match[1]), authorize);
	}
};
