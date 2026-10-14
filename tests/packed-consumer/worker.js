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
import { fromHTML, toMarkdown } from 'edytor/export';
import { DOMParser } from 'linkedom';

export { DocumentRoom };

const authorize = (request) => {
	const userId = new URL(request.url).searchParams.get('user') ?? 'anon';
	return userId === 'denied' ? null : { userId, replica: requestedReplica(request) };
};

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/health') return new Response('ready');
		// `edytor/export` in a Worker: posted HTML as markdown, sanitized on the way.
		if (url.pathname === '/export')
			return new Response(toMarkdown(fromHTML(await request.text(), { DOMParser })));
		const match = /^\/rooms\/([^/]+)\/?$/.exec(url.pathname);
		if (!match) return new Response('not found', { status: 404 });
		return routeDocumentSocket(request, env.ROOM, decodeURIComponent(match[1]), authorize);
	}
};
