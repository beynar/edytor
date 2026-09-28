/**
 * TEST FIXTURE — the hosted lane's Worker: the shipped room
 * (`edytor/cloudflare`) behind the `tests/do` route (`routeDocumentSocket`
 * with its query-string test `authorize`), plus
 * ONE test-only hook, `POST /rooms/<name>/evict`, which evicts the room's
 * Durable Object through `workerd:unsafe` (the same primitive
 * `@cloudflare/vitest-plugin`'s `evictDurableObject` uses). By default the
 * instance is torn down — memory gone — while its hibernatable WebSockets
 * stay connected (`?sockets=close` closes them instead). Requires the
 * `unsafe_module` compatibility flag (set by `start.mjs`); never ship it.
 */
// @ts-ignore -- workerd-internal module, available under the `unsafe_module` flag
import workerdUnsafe from 'workerd:unsafe';
import { DocumentRoom, routeRoom, type Env } from '../do/worker';

export { DocumentRoom };

const EVICT_ROUTE = /^\/rooms\/([^/]+)\/evict\/?$/;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const evict = EVICT_ROUTE.exec(url.pathname);
		if (!evict) return routeRoom(request, env);
		if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
		const stub = env.ROOM.getByName(decodeURIComponent(evict[1]));
		const webSockets = url.searchParams.get('sockets') === 'close' ? 'close' : 'hibernate';
		try {
			await workerdUnsafe.evict(stub, { webSockets });
		} catch (error) {
			// Not running (already evicted/hibernated) is fine for a test hook.
			return Response.json({ evicted: false, error: String(error) });
		}
		return Response.json({ evicted: true, webSockets });
	}
} satisfies ExportedHandler<Env>;
