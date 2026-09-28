/**
 * arch-v2 phase 2 P1.1 — the native review's room simulation
 * (`review-probes/sim-room.ts`, `room-offline.test.ts`,
 * `room-refusal.test.ts`) re-targeted at arch-v2.
 *
 * The native probes drove their `RoomClient` against a Node copy of their
 * Durable Object's admission logic and found clients that block forever
 * and lose offline edits. arch-v2's room is a relay of engine updates: the
 * room document admits every inbound update through the sync protocol's
 * inbound refusal (`crdt.sync.applyRemote`, the coordinator's path in
 * `do-coordinator.test.ts`), relays what it integrated to every other
 * connection, and a (re)connecting client runs the Step1/Step2 exchange —
 * both sides send what the other's state vector lacks. Clients are real
 * documents edited through the facade (`p1-ops.ts`), online edits go out
 * as they are authored, offline edits wait for the reconnect exchange. The
 * network is a FIFO queue flushed explicitly, like the native `SimRoom`.
 *
 * Expected (native probe → arch-v2 terms): no client is ever blocked
 * (nothing pending once the network is flushed, no inbound refusal), every
 * client equals the room, and in the text-only campaign no character is
 * lost or duplicated (seed text + every inserted word, as a multiset).
 *
 * Knobs: `P1_ROOM_SEEDS` (default 60), `P1_ROOM_OFFLINE` (50).
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { REMOTE, crdt, replica, seedUpdate, tree, type Replica } from './p1-harness.js';
import { ACTIONS, apply, genAction, rngOf } from './p1-ops.js';

const SEEDS = [
	{
		id: 'A',
		text: 'alpha',
		children: [
			{ id: 'A1', text: 'one' },
			{ id: 'A2', text: 'two' }
		]
	},
	{ id: 'B', text: 'bravo' },
	{ id: 'C', text: 'charlie', children: [{ id: 'C1', text: 'x' }] },
	{ id: 'D', text: 'delta' }
];
const SEED_TEXT = 'alphaonetwobravocharliexdelta';

/** A FIFO network: every send is a queued delivery, `flush` drains it. */
const network = () => {
	const queue: (() => void)[] = [];
	return {
		push: (f: () => void) => queue.push(f),
		flush: () => {
			for (let guard = 0; queue.length; guard++) {
				if (guard > 1e6) throw new Error('network loop');
				queue.shift()!();
			}
		}
	};
};

type Socket = { client: Replica; open: boolean };

/** The room: one document, the connected sockets, relay of what it integrates. */
const simRoom = (seed: Uint8Array) => {
	const net = network();
	const room = replica('room', seed, 1);
	const sockets = new Set<Socket>();
	const problems: string[] = [];
	room.doc.on('update', (update: Uint8Array, origin: unknown) => {
		for (const s of sockets) {
			if (s === origin) continue;
			const bytes = update.slice();
			net.push(() => s.open && s.client.receive(bytes));
		}
	});
	/** Inbound frame from a socket: admission, then integration (relay follows from the update event). */
	const inbound = (s: Socket, update: Uint8Array) => {
		if (!s.open) return;
		const { applied, problem } = crdt.sync.applyRemote(room.doc, update, s);
		if (problem !== null || !applied)
			problems.push(`room refused ${s.client.name}: ${JSON.stringify(problem)}`);
	};
	const connect = (client: Replica): Socket => {
		const s: Socket = { client, open: true };
		sockets.add(s);
		// Step1/Step2 both ways: each side sends what the other's state vector lacks.
		const clientSv = Y.encodeStateVector(client.doc);
		net.push(() => inbound(s, Y.encodeStateAsUpdate(client.doc, Y.encodeStateVector(room.doc))));
		net.push(() => s.open && client.receive(Y.encodeStateAsUpdate(room.doc, clientSv)));
		return s;
	};
	const disconnect = (s: Socket) => {
		s.open = false;
		sockets.delete(s);
	};
	return { net, room, connect, disconnect, inbound, problems };
};

/** A client whose local writes go to the room while it is connected. */
const client = (name: string, seed: Uint8Array, cid: number, r: ReturnType<typeof simRoom>) => {
	const c = replica(name, seed, cid);
	const state = { socket: null as Socket | null };
	c.doc.on('update', (update: Uint8Array, origin: unknown) => {
		const s = state.socket;
		if (origin === REMOTE || s === null) return;
		const bytes = update.slice();
		r.net.push(() => r.inbound(s, bytes));
	});
	return {
		c,
		online: () => state.socket !== null,
		connect: () => (state.socket = r.connect(c)),
		disconnect: () => {
			if (state.socket) r.disconnect(state.socket);
			state.socket = null;
		}
	};
};

const env = (k: string, d: number) => Number(process.env[k] ?? d);

/** One seeded campaign: `mode` 'one' (one client offline for the burst) or 'churn'. */
const campaign = (seed: number, mode: 'one' | 'churn', textOnly: boolean, offline: number) => {
	const next = rngOf(seed * 7919);
	const bytes = seedUpdate(SEEDS);
	const r = simRoom(bytes);
	const clients = ['A', 'B', 'C'].map((n, i) => client(n, bytes, 100 * (i + 1) + (seed % 97), r));
	for (const k of clients) k.connect();
	r.net.flush();
	const inserted: string[] = [];
	const counter = { n: 0 };
	const actions = textOnly ? ['insert', 'insert', 'insert', 'split'] : ACTIONS;
	const act = (k: (typeof clients)[number]) => {
		const a = genAction(k.c, next, counter, actions);
		if (!a) return;
		const res = apply(k.c, a.action, a.args);
		if (a.action === 'insert' && res?.status === 'applied') inserted.push(a.args[2] as string);
	};
	if (mode === 'one') {
		for (let i = 0; i < 5; i++) {
			act(clients[next(3)]);
			r.net.flush();
		}
		clients[2].disconnect();
		for (let i = 0; i < offline; i++) {
			act(clients[2]);
			if (next(2)) {
				act(clients[next(2)]);
				r.net.flush();
			}
		}
		clients[2].connect();
		r.net.flush();
	} else {
		for (let i = 0; i < offline * 2; i++) {
			const k = clients[next(3)];
			if (next(8) === 0) (k.online() ? k.disconnect : k.connect)();
			act(clients[next(3)]);
			if (next(2)) r.net.flush();
		}
		for (const k of clients) if (!k.online()) k.connect();
		r.net.flush();
	}
	for (let i = 0; i < 5; i++) {
		act(clients[next(3)]);
		r.net.flush();
	}
	const failures: string[] = [...r.problems];
	const room = r.room.canonical();
	for (const k of clients) {
		failures.push(...k.c.problems);
		if (k.c.pending()) failures.push(`${k.c.name}: blocked (pending)`);
		if (k.c.canonical() !== room)
			failures.push(`${k.c.name}: diverged from the room\n${k.c.tree()}\n${tree(r.room.ed)}`);
	}
	if (r.room.pending()) failures.push('room: pending');
	if (textOnly) {
		const text = r.room.ed
			.order()
			.map((id) => r.room.ed.blockText(id))
			.join('');
		const sorted = (s: string) => [...s].sort().join('');
		if (sorted(text) !== sorted(SEED_TEXT + inserted.join('')))
			failures.push(`lost or duplicated text: ${text}`);
	}
	for (const k of clients) k.c.destroy();
	r.room.destroy();
	return failures;
};

describe('P1 room simulation — offline replay through a relay room (review-probes/room-offline)', () => {
	const N = env('P1_ROOM_SEEDS', 60);
	const OFFLINE = env('P1_ROOM_OFFLINE', 50);
	for (const [mode, textOnly] of [
		['one', true],
		['one', false],
		['churn', true],
		['churn', false]
	] as const) {
		it(`${mode === 'one' ? 'one client offline' : 'every client churns'} (${textOnly ? 'text only' : 'all ops'}), ${N} seeds × ${OFFLINE} offline edits: never blocked, equal to the room${textOnly ? ', no text lost or duplicated' : ''}`, () => {
			const bad: Record<number, string[]> = {};
			for (let seed = 1; seed <= N; seed++) {
				const f = campaign(seed, mode, textOnly, OFFLINE);
				if (f.length) bad[seed] = f.slice(0, 3);
			}
			expect(bad).toEqual({});
		});
	}
});

describe('P1 room — the native refusal program (review-probes/room-refusal)', () => {
	it('offline insert + split on two clients, reconnects in turn → no client blocked, all equal to the room', () => {
		for (const ids of [
			[20, 30],
			[30, 20],
			[7, 100]
		]) {
			const bytes = seedUpdate([{ id: 'P', text: 'abc' }]);
			const r = simRoom(bytes);
			const x = client('X', bytes, ids[0], r);
			const y = client('Y', bytes, ids[1], r);
			x.connect();
			r.net.flush();
			// Y is offline from the start and types three times.
			y.c.ed.insertText('P', 3, '1');
			y.c.ed.insertText('P', 4, '2');
			y.c.ed.insertText('P', 0, 'Q');
			x.c.ed.insertText('P', 0, 'zzz'); // online: stored by the room
			r.net.flush();
			x.disconnect();
			x.c.ed.splitBlock('P', 1, 'S'); // offline split
			y.connect(); // Y reconnects: receives zzz, uploads 1, 2, Q
			r.net.flush();
			y.c.ed.insertText('P', 3, 'x'); // Y types between zzz and Q
			r.net.flush();
			x.connect(); // X reconnects
			r.net.flush();
			// A fresh client with no local state.
			const z = client('Z', bytes, 999, r);
			z.connect();
			r.net.flush();
			for (const k of [x, y, z]) {
				expect(k.c.pending(), k.c.name).toBe(false);
				expect(k.c.problems).toEqual([]);
				expect(k.c.canonical(), k.c.name).toBe(r.room.canonical());
			}
			expect(r.problems).toEqual([]);
			// Every character once, in the two blocks of X's split.
			const text = r.room.ed
				.order()
				.map((id) => r.room.ed.blockText(id))
				.join('');
			expect([...text].sort().join('')).toBe([...'zzzQabc12x'].sort().join(''));
			expect(r.room.ed.order()).toEqual(['P', 'S']);
		}
	});
});
