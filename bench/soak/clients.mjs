/**
 * One soak worker thread (WU-16): a share of the soak's clients, each a
 * headless document (`createDocument`) on the shipped `WebsocketProvider`,
 * driven by `run.mjs` over `parentPort`.
 *
 * A client edits as a writer does — typing at its caret, Backspace, Enter
 * (a split), merges, moves, marks, data — publishes presence after each
 * edit (its caret moved) and at `presenceHz` while it drags a selection
 * (`dragShare` of its time; 1: always), drops its socket for a moment now and then (churn),
 * reloads (a new replica, synced from nothing), and goes offline for tens
 * of seconds while it keeps editing, then replays.
 *
 * Measured per client, with no help from the provider: the ack latency of
 * every edit made online — from the edit to the first `messageSaved` frame
 * whose state vector covers it (the room stored it) — read off the socket
 * (`Instrumented`); the replay time of an offline session (reconnect to
 * the ack covering its last edit); closes by code; provider events.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { loadEngine } from './engine.mjs';

// A full GC before a heap reading (a worker thread takes no `--expose-gc`).
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc');
// Each provider listens for the process exit.
process.setMaxListeners(0);

const { E, P, Y, crdt } = await loadEngine();
const {
	first,
	count,
	server,
	room,
	token,
	presenceHz,
	dragShare,
	opsPerSecond,
	churnPerMinute,
	offlinePerHour,
	reloadShare,
	maxBlocks,
	maxChars,
	seed
} = workerData;

/** A seeded PRNG (mulberry32): a run's choices replay from its seed. */
const prng = (s) => () => {
	s |= 0;
	s = (s + 0x6d2b79f5) | 0;
	let t = Math.imul(s ^ (s >>> 15), 1 | s);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const stats = {
	ops: {},
	acks: [],
	replays: [],
	closes: {},
	events: {},
	reloads: 0,
	churns: 0,
	offline: 0,
	errors: []
};
const bump = (bucket, key) => (bucket[key] = (bucket[key] ?? 0) + 1);
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

const WORDS = 'the quick brown fox jumps over a lazy dog while every replica keeps typing'.split(
	' '
);

class Client {
	constructor(index) {
		this.index = index;
		this.user = `u${index}`;
		this.random = prng(seed * 1000 + index);
		this.seq = 0;
		this.caret = null;
		this.blocks = [];
		this.listedAt = -Infinity;
		this.pending = [];
		this.offlineUntil = 0;
		this.replay = null;
		this.active = false;
		this.timers = new Set();
		this.open();
	}

	/** A fresh replica: a new document and provider (a page load). */
	open() {
		this.document = E.createDocument({ actor: { id: this.user }, semantics: E.defaultSemantics });
		const received = (data) => this.received(data);
		const doc = this.document.doc;
		class Instrumented extends WebSocket {
			constructor(url) {
				super(url);
				this.addEventListener('message', (event) => received(event.data));
				// An edit not acknowledged before a close stays pending: its
				// provider resends it after the redial, and its latency counts
				// the fault (what a writer sees as unsaved).
				this.addEventListener('close', (event) => bump(stats.closes, String(event.code)));
			}
		}
		this.provider = new crdt.providers.WebsocketProvider(server, room, doc, {
			WebSocketPolyfill: Instrumented,
			params: { user: this.user, ...(token ? { token } : {}) },
			disableBc: true
		});
		for (const name of [
			'refused',
			'unreachable',
			'message-error',
			'schema-mismatch',
			'permission-denied',
			'failed'
		]) {
			this.provider.on(name, (detail) => {
				bump(stats.events, name);
				if (name === 'refused' || name === 'failed' || name === 'message-error') {
					if (stats.errors.length < 50)
						stats.errors.push({
							user: this.user,
							event: name,
							detail: String(detail?.message ?? detail?.code ?? detail)
						});
				}
			});
		}
		this.provider.on('synced', (state) => {
			if (state && this.replay) this.replay.synced = performance.now();
		});
	}

	/** This replica's next clock: what a `messageSaved` must cover for its last edit. */
	clock() {
		return (
			Y.decodeStateVector(Y.encodeStateVector(this.document.doc)).get(this.document.doc.clientID) ??
			0
		);
	}

	received(data) {
		if (!(data instanceof ArrayBuffer)) return;
		try {
			const decoder = P.createDecoder(new Uint8Array(data));
			P.readVarUint(decoder); // the generation
			if (P.readVarUint(decoder) !== P.messageSaved) return;
			const sv = Y.decodeStateVector(P.readVarUint8Array(decoder));
			const acked = sv.get(this.document.doc.clientID) ?? 0;
			const at = performance.now();
			while (this.pending.length && this.pending[0].clock <= acked) {
				stats.acks.push(at - this.pending.shift().at);
			}
			if (this.replay && this.replay.reconnected && acked >= this.replay.clock) {
				stats.replays.push({
					ms: at - this.replay.reconnected,
					offlineMs: this.replay.offlineMs,
					edits: this.replay.edits
				});
				this.replay = null;
			}
		} catch (error) {
			bump(stats.events, 'tap-error');
		}
	}

	start() {
		this.active = true;
		this.schedule(
			'op',
			() => this.op(),
			() => -Math.log(1 - this.random()) * (1000 / opsPerSecond)
		);
		if (presenceHz > 0) {
			this.schedule(
				'presence',
				() => this.dragging() && this.presence(),
				() => 1000 / presenceHz
			);
		}
		this.schedule(
			'churn',
			() => this.disturb(),
			() => 1000
		);
	}

	stop() {
		this.active = false;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}

	schedule(name, fn, delay) {
		const tick = () => {
			this.timers.delete(timer);
			if (!this.active) return;
			try {
				fn();
			} catch (error) {
				bump(stats.events, `${name}-throw`);
				if (stats.errors.length < 50)
					stats.errors.push({
						user: this.user,
						event: `${name}-throw`,
						detail: String(error?.stack ?? error)
					});
			}
			timer = setTimeout(tick, delay());
			this.timers.add(timer);
		};
		let timer = setTimeout(tick, delay() * this.random());
		this.timers.add(timer);
	}

	/** The top-level blocks and their text lengths, re-read at most every 2 s. */
	list() {
		const now = performance.now();
		if (now - this.listedAt < 2000 && this.blocks.length) return this.blocks;
		this.listedAt = now;
		const length = (block) =>
			(block.content ?? []).reduce((n, piece) => n + ('text' in piece ? piece.text.length : 1), 0);
		const json = this.document.facade.toJSON();
		this.blocks = json.children.map((block) => ({
			id: block.id,
			type: block.type,
			length: length(block)
		}));
		this.chars = this.blocks.reduce((n, b) => n + b.length, 0);
		return this.blocks;
	}

	pick() {
		const blocks = this.list().filter((b) => b.type === 'paragraph' || b.type === 'heading');
		return blocks.length ? blocks[Math.floor(this.random() * blocks.length)] : null;
	}

	/** The caret's block and offset, valid in the document now (else a new one). */
	at() {
		const facade = this.document.facade;
		if (this.caret) {
			const text = facade.blockText(this.caret.id);
			if (typeof text === 'string' && this.caret.offset <= text.length)
				return { ...this.caret, length: text.length };
		}
		const block = this.pick();
		if (!block) return null;
		const text = facade.blockText(block.id) ?? '';
		this.caret = { id: block.id, offset: Math.floor(this.random() * (text.length + 1)) };
		return { ...this.caret, length: text.length };
	}

	op() {
		const blocks = this.list();
		const crowded = blocks.length > maxBlocks;
		const long = this.chars > maxChars;
		const r = this.random();
		const weights = [
			['type', long ? 30 : 62],
			['backspace', long ? 30 : 10],
			['split', crowded ? 0 : 7],
			['merge', crowded ? 12 : 4],
			['move', 4],
			['mark', 4],
			['data', 3],
			['cut', long ? 15 : 3],
			['jump', 3]
		];
		const total = weights.reduce((n, [, w]) => n + w, 0);
		let roll = r * total;
		const [kind] = weights.find(([, w]) => (roll -= w) < 0) ?? weights[0];
		const status = this.perform(kind);
		bump(stats.ops, `${kind}:${status}`);
		if (status === 'applied') this.edited();
		if (status === 'applied' || status === 'applied-local') this.presence();
	}

	perform(kind) {
		const { document } = this;
		const f = document.facade;
		const run = (fn) => {
			let result;
			document.transact(() => (result = fn()));
			return result?.status ?? 'applied';
		};
		if (kind === 'jump') {
			this.caret = null;
			return this.at() ? 'applied-local' : 'noop';
		}
		const caret = this.at();
		if (!caret) return 'noop';
		switch (kind) {
			case 'type': {
				const word = WORDS[Math.floor(this.random() * WORDS.length)];
				const text =
					this.random() < 0.8 ? word[Math.floor(this.random() * word.length)] : ` ${word}`;
				const status = run(() => f.insertText(caret.id, caret.offset, text));
				if (status === 'applied') this.caret.offset += text.length;
				return status;
			}
			case 'backspace': {
				if (caret.offset === 0) return 'noop';
				const status = run(() => f.deleteText(caret.id, caret.offset - 1, 1));
				if (status === 'applied') this.caret.offset -= 1;
				return status;
			}
			case 'split': {
				const id = `${this.user}-${this.document.doc.clientID}-${++this.seq}`;
				const status = run(() => f.splitBlock(caret.id, caret.offset, id));
				if (status === 'applied') {
					this.caret = { id, offset: 0 };
					this.listedAt = -Infinity;
				}
				return status;
			}
			case 'merge': {
				const status = run(() => f.mergeBackward(caret.id));
				this.caret = null;
				this.listedAt = -Infinity;
				return status;
			}
			case 'move': {
				const block = this.pick();
				if (!block) return 'noop';
				const index = Math.floor(this.random() * this.list().length);
				const status = run(() => f.moveBlock(block.id, { parent: null, index }));
				this.listedAt = -Infinity;
				return status;
			}
			case 'mark': {
				if (caret.length < 2) return 'noop';
				const from = Math.floor(this.random() * (caret.length - 1));
				const length = 1 + Math.floor(this.random() * Math.min(12, caret.length - from));
				const mark = ['bold', 'italic', 'code'][Math.floor(this.random() * 3)];
				return run(() =>
					f.formatRange(caret.id, from, length, { [mark]: this.random() < 0.7 ? true : null })
				);
			}
			case 'data':
				return run(() => f.patchData(caret.id, [{ path: ['soak', this.user], value: this.seq++ }]));
			case 'cut': {
				if (caret.length < 4) return 'noop';
				const from = Math.floor(this.random() * (caret.length - 3));
				const length = Math.min(caret.length - from, 3 + Math.floor(this.random() * 40));
				const status = run(() => f.deleteText(caret.id, from, length));
				if (status === 'applied') this.caret.offset = from;
				return status;
			}
		}
		return 'noop';
	}

	/** After an applied edit: track its ack (online), or count it into the offline replay. */
	edited() {
		const clock = this.clock();
		if (this.offlineUntil) {
			this.replay.edits++;
			this.replay.clock = clock;
			return;
		}
		if (this.provider.wsconnected && this.provider.synced)
			this.pending.push({ clock, at: performance.now() });
	}

	/**
	 * Whether a selection drag runs now: drags of 2 to 5 s start at random
	 * so that they cover `dragShare` of the client's time.
	 */
	dragging() {
		if (dragShare >= 1) return true;
		const now = performance.now();
		if (now < (this.dragUntil ?? 0)) return true;
		const mean = 3500;
		// A drag starts in this tick with the probability that keeps the share.
		const tick = 1000 / presenceHz;
		if (this.random() < (dragShare / (1 - dragShare)) * (tick / mean)) {
			this.dragUntil = now + 2000 + this.random() * 3000;
			return true;
		}
		return false;
	}

	presence() {
		if (!this.caret) return;
		this.provider.awareness.setLocalStateField('selections', {
			soak: {
				start: { b: this.caret.id, a: { o: this.caret.offset } },
				end: { b: this.caret.id, a: { o: this.caret.offset } },
				collapsed: true,
				reversed: false,
				t: ++this.seq
			}
		});
	}

	/** Once a second: maybe churn (a dropped socket), a reload, or an offline session. */
	disturb() {
		const now = performance.now();
		if (this.offlineUntil) {
			if (now < this.offlineUntil) return;
			this.offlineUntil = 0;
			this.replay.offlineMs = now - this.replay.left;
			this.replay.reconnected = now;
			this.provider.connect();
			return;
		}
		if (this.random() < offlinePerHour / 3600) {
			bump(stats, 'offline');
			this.offlineUntil = now + 10_000 + this.random() * 50_000;
			this.replay = { left: now, edits: 0, clock: this.clock(), reconnected: 0, offlineMs: 0 };
			this.provider.disconnect();
			return;
		}
		if (this.random() < churnPerMinute / 60) {
			if (this.random() < reloadShare && this.provider.saved) return this.reload();
			stats.churns++;
			this.provider.disconnect();
			const timer = setTimeout(
				() => {
					this.timers.delete(timer);
					if (!this.offlineUntil) this.provider.connect();
				},
				200 + this.random() * 2800
			);
			this.timers.add(timer);
		}
	}

	reload() {
		stats.reloads++;
		this.provider.destroy();
		this.document.destroy();
		this.pending.length = 0;
		this.caret = null;
		this.listedAt = -Infinity;
		this.open();
	}

	/** Back online for the end: no more edits; resolves once synced and saved. */
	async settle(deadline) {
		this.stop();
		if (this.offlineUntil) {
			this.offlineUntil = 0;
			this.replay = null;
		}
		this.provider.connect();
		while (performance.now() < deadline) {
			const p = this.provider;
			if (p.wsconnected && p.synced && p.saved) return true;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	}

	snapshot() {
		const doc = this.document.doc;
		return {
			user: this.user,
			clientID: doc.clientID,
			sv: Array.from(Y.decodeStateVector(Y.encodeStateVector(doc)).entries()).sort(
				(a, b) => a[0] - b[0]
			),
			json: JSON.stringify(this.document.facade.toJSON()),
			synced: this.provider.synced,
			saved: this.provider.saved,
			unsaved: this.provider.unsaved
		};
	}
}

const clients = Array.from({ length: count }, (_, i) => new Client(first + i));

/** The samples gathered since the last call (latencies are moved out). */
const drain = (gc) => {
	if (gc) collect();
	const out = {
		...stats,
		acks: stats.acks.splice(0),
		replays: stats.replays.splice(0),
		errors: stats.errors.splice(0),
		loopP99: loop.percentile(99) / 1e6,
		loopMax: loop.max / 1e6,
		online: clients.filter((c) => c.provider.wsconnected && c.provider.synced).length,
		heapUsed: process.memoryUsage().heapUsed
	};
	stats.ops = {};
	stats.closes = {};
	stats.events = {};
	stats.reloads = stats.churns = stats.offline = 0;
	loop.reset();
	return out;
};

parentPort.on('message', async (message) => {
	switch (message.type) {
		case 'ready': {
			const deadline = performance.now() + 60_000;
			const ok = await Promise.all(clients.map((c) => c.settle(deadline)));
			parentPort.postMessage({ type: 'ready', ok: ok.every(Boolean) });
			break;
		}
		case 'start':
			for (const client of clients) client.start();
			break;
		case 'stats':
			parentPort.postMessage({ type: 'stats', stats: drain(message.gc) });
			break;
		case 'settle': {
			const deadline = performance.now() + message.timeoutMs;
			const ok = await Promise.all(clients.map((c) => c.settle(deadline)));
			parentPort.postMessage({
				type: 'settled',
				ok: ok.map((v, i) => (v ? null : clients[i].user)).filter(Boolean)
			});
			break;
		}
		case 'snapshot':
			parentPort.postMessage({ type: 'snapshot', clients: clients.map((c) => c.snapshot()) });
			break;
		case 'close':
			for (const client of clients) {
				client.stop();
				client.provider.destroy();
				client.document.destroy();
			}
			parentPort.postMessage({ type: 'closed' });
			break;
	}
});
parentPort.postMessage({ type: 'loaded' });
