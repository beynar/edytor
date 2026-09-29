/**
 * The websocket provider's close handling (UW-12, client) and keepalive
 * replies (UW-11, client).
 *
 * - A close with `1008` or an application code (`4xxx`) is terminal: one
 *   dial, a `refused` event carrying a `SyncRefusedError` (code, reason),
 *   `failed` once, and no redial.
 * - Any other close (`1006`: server down, or an HTTP 403 as a browser sees
 *   it) keeps dialing, reading `params` at every dial. Dials that never
 *   synced count in a row — an opened-then-closed socket too — and each
 *   emits `unreachable({ attempts, nextRetryMs })`: `100 ms × 2ⁿ` capped at
 *   `maxBackoffTime`, the cap doubling past 8 such dials, up to 30 s. A
 *   dial that synced starts the count over.
 * - Keepalive: a socket silent for 15 s is sent one text `ping`; a text
 *   `pong` (a server's keepalive auto-response) proves liveness and is not
 *   an error. A lone provider whose server echoes its presence, or answers
 *   the ping, stays connected past the 30 s liveness window; one whose
 *   server does neither is torn down.
 *
 * The expected delays are computed by hand from the rule above.
 */
// @ts-nocheck -- tests reach raw provider internals (excluded lane).
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as decoding from 'lib0-v14/decoding';
import { Y } from '../../../lib/crdt/engine.js';
import { bindWebsocketProvider } from '../../../lib/crdt/providers/websocket.js';
import { SyncRefusedError } from '../../../lib/crdt/providers/room.js';
import { bindSync } from '../../../lib/crdt/protocols/sync.js';
import { frame, readProtocolVersion } from '../../../lib/crdt/protocols/envelope.js';

// lib0 captures `Date.now` at import: read it per call so fake timers move the clock.
vi.mock('lib0-v14/time', async (original) => ({
	...(await original()),
	getUnixTime: () => Date.now()
}));

const ws = bindWebsocketProvider(Y);
const sync = bindSync(Y);

/**
 * A scripted server. `server.accept` decides each dial: `'open'`, or a
 * `{ code, reason }` to close with before opening; `server.onFrame(socket,
 * type, payload)` sees every binary frame of an open socket, `server.onText(socket,
 * text)` every text frame (recorded in `server.texts`).
 */
const createServer = () => {
	const server = {
		sockets: [],
		texts: [],
		accept: () => 'open',
		onFrame: () => {},
		onText: () => {}
	};
	class Socket {
		static OPEN = 1;
		OPEN = 1;
		binaryType = '';
		readyState = 0;
		onopen = null;
		onclose = null;
		onerror = null;
		onmessage = null;

		constructor(url) {
			this.url = url;
			server.sockets.push(this);
			setTimeout(() => {
				if (this.readyState !== 0) return;
				const verdict = server.accept(this);
				if (verdict !== 'open') return this.close(verdict.code, verdict.reason);
				this.readyState = 1;
				this.onopen?.({});
			});
		}

		send(data) {
			if (typeof data === 'string') {
				server.texts.push(data);
				setTimeout(() => this.readyState === 1 && server.onText(this, data));
				return;
			}
			const bytes = new Uint8Array(data).slice();
			setTimeout(() => {
				if (this.readyState !== 1) return;
				const decoder = decoding.createDecoder(bytes);
				readProtocolVersion(decoder);
				const type = decoding.readVarUint(decoder);
				server.onFrame(this, type, bytes, decoder);
			});
		}

		deliver(data) {
			if (this.readyState === 1) this.onmessage?.({ data });
		}

		close(code = 1005, reason = '') {
			if (this.readyState === 3) return;
			this.readyState = 3;
			this.onclose?.({ code, reason });
		}
	}
	server.Socket = Socket;
	return server;
};

/** Answer a Step1 with an (empty) Step2: the provider syncs. */
const answerStep1 = (socket, type, _bytes, decoder) => {
	if (type !== 0 || decoding.readVarUint(decoder) !== sync.messageYjsSyncStep1) return;
	const sv = decoding.readVarUint8Array(decoder);
	socket.deliver(frame(0, (e) => sync.writeSyncStep2(e, new Y.Doc(), sv)).buffer);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, timeout = 3000) => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeout) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 5));
	}
};

const record = (p) => {
	const events = { refused: [], failed: [], unreachable: [], closes: [], errors: [] };
	p.on('refused', (refusal) => events.refused.push(refusal));
	p.on('failed', (error) => events.failed.push(error));
	p.on('unreachable', (state) => events.unreachable.push(state));
	p.on('connection-close', (event) => events.closes.push(event));
	p.on('message-error', (error) => events.errors.push(error));
	return events;
};

const provider = (server, options = {}) =>
	new ws.WebsocketProvider('ws://refusal', 'room', new Y.Doc(), {
		WebSocketPolyfill: server.Socket,
		disableBc: true,
		...options
	});

afterEach(() => {
	vi.useRealTimers();
});

describe('refusal closes are terminal', () => {
	it('1008 after the open: one dial, refused + failed once, no redial', async () => {
		const server = createServer();
		server.onFrame = (socket) => socket.close(1008, 'refused: generation');
		const p = provider(server);
		const events = record(p);
		await until(() => events.refused.length === 1);
		await wait(500);
		expect(server.sockets).toHaveLength(1);
		expect(events.refused[0]).toBeInstanceOf(SyncRefusedError);
		expect([events.refused[0].code, events.refused[0].reason]).toEqual([
			1008,
			'refused: generation'
		]);
		expect(events.failed).toEqual([events.refused[0]]);
		expect(events.unreachable).toEqual([]);
		expect(p.shouldConnect).toBe(false);
		p.destroy();
		expect(events.failed).toHaveLength(1);
	});

	it('an application code (4403) before the open is terminal too', async () => {
		const server = createServer();
		server.accept = () => ({ code: 4403, reason: 'denied' });
		const p = provider(server);
		const events = record(p);
		await until(() => events.refused.length === 1);
		await wait(300);
		expect(server.sockets).toHaveLength(1);
		expect(events.refused[0].code).toBe(4403);
		p.destroy();
	});

	it('refused after a sync: refused fires, failed does not (the provider synced)', async () => {
		const server = createServer();
		server.onFrame = answerStep1;
		const p = provider(server);
		const events = record(p);
		await until(() => p.synced);
		server.sockets[0].close(1008, 'refused: replica');
		await wait(300);
		expect(events.refused.map((r) => r.code)).toEqual([1008]);
		expect(events.failed).toEqual([]);
		expect(server.sockets).toHaveLength(1);
		p.destroy();
	});
});

describe('other closes redial with a backoff that grows while the room is unreachable', () => {
	it('1006 before every open (a 403 upgrade): attempts count up, the cap doubles past 8', async () => {
		const server = createServer();
		server.accept = () => ({ code: 1006, reason: '' });
		const p = provider(server, { maxBackoffTime: 10, params: { token: 't0' } });
		const events = record(p);
		await until(() => events.unreachable.length >= 12);
		p.params = { token: 't1' };
		await until(() => server.sockets.at(-1).url.endsWith('token=t1'));
		p.destroy();
		expect(events.unreachable.slice(0, 12)).toEqual([
			{ attempts: 1, nextRetryMs: 10 },
			{ attempts: 2, nextRetryMs: 10 },
			{ attempts: 3, nextRetryMs: 10 },
			{ attempts: 4, nextRetryMs: 10 },
			{ attempts: 5, nextRetryMs: 10 },
			{ attempts: 6, nextRetryMs: 10 },
			{ attempts: 7, nextRetryMs: 10 },
			{ attempts: 8, nextRetryMs: 10 },
			{ attempts: 9, nextRetryMs: 20 },
			{ attempts: 10, nextRetryMs: 40 },
			{ attempts: 11, nextRetryMs: 80 },
			{ attempts: 12, nextRetryMs: 160 }
		]);
		expect(events.refused).toEqual([]);
		expect(events.failed.map((e) => e.message)).toEqual([
			'WebsocketProvider "room" was destroyed before it synced'
		]);
	});

	it('with the default cap: 2500 ms through 8 failures, then doubling to 30 s', async () => {
		const server = createServer();
		server.accept = () => ({ code: 1006, reason: '' });
		const delayAt = async (attempts) => {
			const p = provider(server, { connect: false });
			const events = record(p);
			p.wsUnsuccessfulReconnects = attempts - 1;
			p.connect();
			await until(() => events.unreachable.length === 1);
			p.destroy();
			return events.unreachable[0];
		};
		const delays = [];
		for (const attempts of [4, 8, 9, 10, 11, 12, 30]) delays.push(await delayAt(attempts));
		expect(delays).toEqual([
			{ attempts: 4, nextRetryMs: 1600 },
			{ attempts: 8, nextRetryMs: 2500 },
			{ attempts: 9, nextRetryMs: 5000 },
			{ attempts: 10, nextRetryMs: 10000 },
			{ attempts: 11, nextRetryMs: 20000 },
			{ attempts: 12, nextRetryMs: 30000 },
			{ attempts: 30, nextRetryMs: 30000 }
		]);
	});

	it('a socket that opens and closes without syncing is not a fresh start', async () => {
		const server = createServer();
		server.onFrame = (socket) => socket.close(1006, '');
		const p = provider(server, { maxBackoffTime: 10 });
		const events = record(p);
		await until(() => events.unreachable.length >= 3);
		p.destroy();
		expect(events.unreachable.slice(0, 3).map((s) => s.attempts)).toEqual([1, 2, 3]);
	});

	it('a dial that synced starts the count over: its drop redials in 100 ms, silently', async () => {
		const server = createServer();
		server.onFrame = answerStep1;
		const p = provider(server);
		const events = record(p);
		p.wsUnsuccessfulReconnects = 5;
		await until(() => p.synced);
		expect(p.wsUnsuccessfulReconnects).toBe(0);
		const dropped = Date.now();
		server.sockets[0].close(1006, '');
		await until(() => server.sockets.length === 2);
		expect(Date.now() - dropped).toBeLessThan(400);
		expect(events.unreachable).toEqual([]);
		p.destroy();
	});
});

describe('keepalive', () => {
	it('a text pong refreshes liveness and is not a message error', async () => {
		const server = createServer();
		const p = provider(server);
		const events = record(p);
		await until(() => p.wsconnected);
		p.wsLastMessageReceived = 0;
		server.sockets[0].deliver('pong');
		expect(p.wsLastMessageReceived).toBeGreaterThan(0);
		expect(events.errors).toEqual([]);
		p.destroy();
	});

	/**
	 * A lone provider for 37 s of fake time; `echo` sends its presence frames
	 * back, `pong` answers its pings.
	 */
	const lone = async ({ echo = false, pong = false } = {}) => {
		vi.useFakeTimers();
		const server = createServer();
		if (echo) server.onFrame = (socket, type, bytes) => type === 1 && socket.deliver(bytes.buffer);
		if (pong) server.onText = (socket, text) => text === 'ping' && socket.deliver('pong');
		const p = provider(server);
		const events = record(p);
		await vi.advanceTimersByTimeAsync(37_000);
		const result = {
			closes: events.closes.length,
			dials: server.sockets.length,
			pings: server.texts.filter((t) => t === 'ping').length
		};
		p.destroy();
		return result;
	};

	it('a lone provider whose server echoes its presence stays connected past 36 s', async () => {
		expect(await lone({ echo: true })).toMatchObject({ closes: 0, dials: 1 });
	});

	it('a silent socket is pinged after 15 s; a pong keeps it connected past 36 s', async () => {
		// Pinged at 15 s, answered; silent again, pinged at 30 s, answered.
		expect(await lone({ pong: true })).toEqual({ closes: 0, dials: 1, pings: 2 });
	});

	it('one ping per silence: an unanswered ping is not repeated before the teardown', async () => {
		vi.useFakeTimers();
		const server = createServer();
		const p = provider(server);
		const events = record(p);
		await vi.advanceTimersByTimeAsync(14_000);
		expect(server.texts).toEqual([]);
		await vi.advanceTimersByTimeAsync(19_000);
		expect(server.texts).toEqual(['ping']);
		expect(events.closes).toHaveLength(1);
		p.destroy();
	});

	it('without an echo or a pong the provider is torn down by the liveness check (control)', async () => {
		const { closes, pings } = await lone();
		expect(closes).toBeGreaterThanOrEqual(1);
		expect(pings).toBeGreaterThanOrEqual(1);
	});
});
