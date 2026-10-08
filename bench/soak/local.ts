/**
 * The soak's Worker as Miniflare runs it (`server.mjs`): {@link routeSoak}
 * plus `POST /rooms/<name>/evict[?sockets=close]`, the eviction workerd
 * offers locally (`workerd:unsafe`, as the hosted lane's worker): the
 * instance's memory is dropped while its hibernatable sockets stay
 * connected (a hibernation), or with them closed (`sockets=close`, an
 * eviction). Needs the `unsafe_module` compatibility flag; never deployed.
 */
// @ts-ignore -- workerd-internal module, available under the `unsafe_module` flag
import workerdUnsafe from 'workerd:unsafe';
import { SoakRoom, routeSoak, type Env } from './worker';

export { SoakRoom };

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const routed = await routeSoak(request, env);
		if (routed) return routed;
		if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
		const url = new URL(request.url);
		const name = decodeURIComponent(url.pathname.split('/')[2]);
		const webSockets = url.searchParams.get('sockets') === 'close' ? 'close' : 'hibernate';
		try {
			await workerdUnsafe.evict(env.ROOM.getByName(name), { webSockets });
		} catch (error) {
			return Response.json({ evicted: false, error: String(error) });
		}
		return Response.json({ evicted: true, webSockets });
	}
} satisfies ExportedHandler<Env>;
