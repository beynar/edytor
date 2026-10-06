/**
 * Phase 2, H6 — a large offline backlog reaches the room
 * (`net.chunk.outbound` in `docs/editor-delete-contract.md`):
 *
 * - the provider sends a frame larger than its `maxFrameBytes` (32 MiB by
 *   default, Cloudflare's message limit) as a chunk sequence, which the
 *   room reassembles, applies, stores and acknowledges;
 * - a 40 MB backlog written offline is delivered on reconnect, and a
 *   fresh client receives it;
 * - a chunk with no sequence started (the room woke between two) faults
 *   the socket (`1011`), so its provider redials and resends.
 */
import { describe, expect, it, vi } from 'vitest';
import { E, ORIGIN, RawClient, SelfWebSocket, crdt, para } from './client';

const isChunk = (bytes: Uint8Array) => {
	const decoder = E.createDecoder(bytes);
	return E.readProtocolVersion(decoder) && E.readVarUint(decoder) === E.messageChunk;
};

/** Incompressible text, so 4 MB of it is 4 MB on the wire. */
const noise = (length: number, seed: number) => {
	const out = new Array<string>(length);
	for (let i = 0; i < length; i++) {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		out[i] = String.fromCharCode(48 + ((seed >>> 16) % 64));
	}
	return out.join('');
};

describe('H6 · outbound chunking', () => {
	it('a 40 MB offline backlog is sent as chunks on reconnect; the room stores it and serves it', async () => {
		const room = 'h6-backlog';
		const sent: number[] = [];
		let chunks = 0;
		class Recording extends SelfWebSocket {
			send(data: string | ArrayBuffer | Uint8Array) {
				if (typeof data !== 'string') {
					const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
					sent.push(bytes.length);
					if (isChunk(bytes)) chunks++;
				}
				super.send(data);
			}
		}
		const a = E.createDocument({ value: { children: [para('p', 'start')] }, actor: { id: 'ada' } });
		const provider = new crdt.providers.WebsocketProvider(
			`${ORIGIN.replace('https', 'wss')}/rooms`,
			room,
			a.doc,
			{
				WebSocketPolyfill: Recording as unknown as typeof WebSocket,
				params: { user: 'ada' },
				disableBc: true
			}
		);
		await vi.waitFor(() => expect(provider.synced && provider.saved).toBe(true));
		provider.disconnect();

		// Offline: ten blocks of 4 MB each.
		for (let i = 0; i < 10; i++) {
			a.transact(() =>
				a.facade.insertBlock(
					{ parent: null, index: i + 1 },
					E.toBlockSpec(para(`b${i}`, noise(4_000_000, i + 1)))
				)
			);
		}
		expect(provider.saved).toBe(false);
		sent.length = 0;
		provider.connect();
		await vi.waitFor(() => expect(provider.saved).toBe(true), { timeout: 120_000, interval: 200 });
		expect(chunks).toBeGreaterThan(2);
		expect(Math.max(...sent)).toBeLessThanOrEqual(E.MAX_FRAME_BYTES);
		expect(sent.reduce((n, size) => n + size, 0)).toBeGreaterThan(40_000_000);

		// A fresh client receives the whole document (the room chunks its catch-up).
		const b = await RawClient.connect(room);
		await vi.waitFor(() => expect(b.synced).toBe(true), { timeout: 60_000 });
		expect(b.json()).toEqual(a.facade.toJSON());
		b.close();
		provider.destroy();
		a.destroy();
	}, 240_000);

	it('a chunk with no sequence started faults the socket (1011): its provider redials', async () => {
		const room = 'h6-lost';
		const client = await RawClient.bare(room, { user: 'ada' });
		const whole = E.frame(E.messageSync, (e) => crdt.sync.writeUpdate(e, new Uint8Array(4000)));
		const [, part] = E.chunkFrame(whole, 1024);
		client.send(part);
		await vi.waitFor(() =>
			expect(client.closed).toEqual({ code: 1011, reason: 'chunk sequence lost' })
		);
	});
});
