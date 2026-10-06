/**
 * H7 (contract rows `room.purge.what`, `room.purge.stale`): the purge under
 * random concurrent histories. A relay room (as in `p1-room.test.ts`: every
 * inbound update admitted through `crdt.sync.applyRemote` and relayed, a
 * (re)connecting client runs the Step1/Step2 exchange) records an epoch
 * (its state vector) now and then, and purges at an epoch at least two
 * epochs old, as its own transaction, relayed like any edit. Three clients
 * edit through the facade (every action of `p1-ops.ts`, undo and redo
 * included) and churn offline, so some miss purges and come back with
 * edits made against content purged meanwhile.
 *
 * After the network is flushed: nothing is pending or refused anywhere,
 * every client equals the room, a document rebuilt from the room's bytes
 * equals it, and every replica holds the named `wellFormed` invariants.
 *
 * Knobs: `H7_FUZZ_SEEDS` (default 80), `H7_FUZZ_LEN` (60).
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { defaultSemantics } from '../../../lib/crdt/index.js';
import {
	REMOTE,
	crdt,
	reloadCanonical,
	replica,
	seedUpdate,
	tree,
	wellFormed,
	type Replica
} from './p1-harness.js';
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
	{ id: 'D', text: 'delta' },
	{ id: 'E', text: 'echo' }
];
const PLAIN = {
	name: 'plain',
	seeds: SEEDS,
	semantics: { roles: { callout: { island: true }, divider: { void: true } } },
	kinds: ['paragraph', 'heading', 'quote', 'callout', 'divider']
};
/** Lists, a code island of lines and a columns layout, with the bundled roles. */
const RICH = {
	name: 'rich',
	seeds: [
		{ id: 'P', text: 'para' },
		{
			id: 'U',
			type: 'unordered-list',
			children: [
				{ id: 'U1', type: 'list-item', text: 'one', children: [{ id: 'U1p', text: 'under' }] },
				{ id: 'U2', type: 'list-item', text: 'two' }
			]
		},
		{ id: 'K', type: 'code', children: [{ id: 'K1', type: 'codeLine', text: 'let x' }] },
		{
			id: 'L',
			type: 'columns',
			children: [
				{ id: 'L1', type: 'column', children: [{ id: 'L1a', text: 'left' }] },
				{ id: 'L2', type: 'column', children: [{ id: 'L2a', text: 'right' }] }
			]
		},
		{ id: 'Z', text: 'zulu' }
	],
	semantics: defaultSemantics,
	kinds: ['paragraph', 'heading', 'list-item', 'unordered-list', 'codeLine', 'divider', 'column']
};
type Lane = typeof PLAIN;
const PURGE = Symbol('purge');

type Socket = { client: Replica; open: boolean };

const simRoom = (seed: Uint8Array, lane: Lane) => {
	const queue: (() => void)[] = [];
	const flush = () => {
		for (let guard = 0; queue.length; guard++) {
			if (guard > 1e6) throw new Error('network loop');
			queue.shift()!();
		}
	};
	const room = replica('room', seed, 1, { semantics: lane.semantics });
	const sockets = new Set<Socket>();
	const problems: string[] = [];
	room.doc.on('update', (update: Uint8Array, origin: unknown) => {
		for (const s of sockets) {
			if (s === origin) continue;
			const bytes = update.slice();
			queue.push(() => s.open && s.client.receive(bytes));
		}
	});
	const inbound = (s: Socket, update: Uint8Array) => {
		if (!s.open) return;
		const { applied, problem } = crdt.sync.applyRemote(room.doc, update, s);
		if (problem !== null || !applied)
			problems.push(`room refused ${s.client.name}: ${JSON.stringify(problem)}`);
	};
	const connect = (client: Replica): Socket => {
		const s: Socket = { client, open: true };
		sockets.add(s);
		const clientSv = Y.encodeStateVector(client.doc);
		queue.push(() => inbound(s, Y.encodeStateAsUpdate(client.doc, Y.encodeStateVector(room.doc))));
		queue.push(() => s.open && client.receive(Y.encodeStateAsUpdate(room.doc, clientSv)));
		return s;
	};
	const epochs: Uint8Array[] = [];
	return {
		queue,
		flush,
		room,
		problems,
		connect,
		inbound,
		disconnect: (s: Socket) => {
			s.open = false;
			sockets.delete(s);
		},
		tick: () => epochs.push(Y.encodeStateVector(room.doc)),
		/** Purge at the epoch two before the newest; `null` when there is none yet. */
		purge: () => {
			const sv = epochs.at(-3);
			if (sv === undefined) return null;
			return room.doc.transact(
				() => crdt.doc.purge(room.doc, room.ed, { at: epochs.length, sv }),
				PURGE
			);
		}
	};
};

const client = (
	name: string,
	seed: Uint8Array,
	cid: number,
	r: ReturnType<typeof simRoom>,
	lane: Lane
) => {
	const c = replica(name, seed, cid, { semantics: lane.semantics });
	const state = { socket: null as Socket | null };
	c.doc.on('update', (update: Uint8Array, origin: unknown) => {
		const s = state.socket;
		if (origin === REMOTE || s === null) return;
		const bytes = update.slice();
		r.queue.push(() => r.inbound(s, bytes));
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

const campaign = (
	seed: number,
	length: number,
	lane: Lane,
	purge = !process.env.H7_FUZZ_NOPURGE
) => {
	// The index checks (`indexChecks`) throw inside the engine's update
	// emit, which logs and swallows: a logged index error is a failure.
	const logged: string[] = [];
	const error = console.error;
	console.error = (...args: unknown[]) => {
		const text = args.map((a) => String(a?.stack ?? a)).join(' ');
		if (text.includes('[edytor index]')) logged.push(text.slice(0, 600));
		else error(...args);
	};
	try {
		return run(seed, length, lane, logged, purge);
	} finally {
		console.error = error;
	}
};

const run = (seed: number, length: number, lane: Lane, logged: string[], purge: boolean) => {
	const next = rngOf(seed * 104729);
	const bytes = seedUpdate(lane.seeds, lane.semantics);
	const r = simRoom(bytes, lane);
	const clients = ['A', 'B', 'C'].map((n, i) =>
		client(n, bytes, 100 * (i + 1) + (seed % 97), r, lane)
	);
	for (const k of clients) k.connect();
	r.flush();
	const counter = { n: 0 };
	const failures: string[] = [];
	const stats = { purges: 0, removed: 0, emptied: 0, marks: 0 };
	const trail: string[] = [];
	for (let i = 0; i < length; i++) {
		const roll = next(20);
		if (roll < 12) {
			const k = clients[next(3)];
			const a = genAction(k.c, next, counter, ACTIONS, lane.kinds);
			if (!a) continue;
			trail.push(`${k.c.name}.${a.action}(${JSON.stringify(a.args)})`);
			try {
				apply(k.c, a.action, structuredClone(a.args));
			} catch (e) {
				failures.push(`${k.c.name} ${a.action} threw: ${e?.stack ?? e}`);
			}
		} else if (roll < 15) {
			r.flush();
		} else if (roll < 17) {
			const k = clients[next(3)];
			trail.push(`${k.c.name}.${k.online() ? 'offline' : 'online'}`);
			(k.online() ? k.disconnect : k.connect)();
		} else if (roll < 19) {
			r.tick();
			trail.push('tick');
		} else {
			const report = purge ? r.purge() : null;
			trail.push(`purge ${JSON.stringify(report)}`);
			if (report) {
				stats.purges++;
				stats.removed += report.removed;
				stats.emptied += report.emptied;
				stats.marks += report.marks;
			}
		}
	}
	for (const k of clients) if (!k.online()) k.connect();
	r.flush();
	failures.push(...r.problems, ...logged);
	const room = r.room.canonical();
	for (const k of clients) {
		failures.push(...k.c.problems);
		if (k.c.pending()) failures.push(`${k.c.name}: blocked (pending)`);
		if (k.c.canonical() !== room)
			failures.push(`${k.c.name}: diverged\n${k.c.tree()}\n${tree(r.room.ed)}`);
	}
	if (r.room.pending()) failures.push('room: pending');
	for (const rep of [r.room, ...clients.map((k) => k.c)])
		for (const p of wellFormed(rep.ed, { doc: rep.doc, semantics: lane.semantics }))
			failures.push(`${rep.name}: ${p}`);
	const problems: string[] = [];
	if (reloadCanonical(r.room, problems, { semantics: lane.semantics }) !== room)
		failures.push('room: a reload differs');
	failures.push(...problems);
	for (const k of clients) k.c.destroy();
	r.room.destroy();
	return { failures, stats, trail };
};

describe('H7 purge fuzz — a relay room purging under random concurrent histories', () => {
	for (const lane of [PLAIN, RICH]) {
		it(`${lane.name}: 3 clients × ${env('H7_FUZZ_SEEDS', 80)} seeds × ${env('H7_FUZZ_LEN', 60)} steps: never blocked, equal to the room, well-formed`, () => {
			const bad: Record<number, unknown> = {};
			const total = { purges: 0, removed: 0, emptied: 0, marks: 0 };
			const start = env('H7_FUZZ_START', 1);
			for (let seed = start; seed < start + env('H7_FUZZ_SEEDS', 80); seed++) {
				const { failures, stats, trail } = campaign(seed, env('H7_FUZZ_LEN', 60), lane);
				for (const key of Object.keys(total)) total[key] += stats[key];
				if (failures.length) bad[seed] = { failures: failures.slice(0, 3), trail };
			}
			expect(bad, JSON.stringify(bad, null, 1).slice(0, 6000)).toEqual({});
			// Not vacuous: purges ran and removed, emptied and dropped marks.
			expect(total.purges).toBeGreaterThan(50);
			expect(total.removed).toBeGreaterThan(0);
			expect(total.emptied).toBeGreaterThan(0);
			expect(total.marks).toBeGreaterThan(0);
		});
	}
});

/**
 * Pinned (Phase 4, item 0): the rich lane's seeds 651 and 1271 of the
 * 2,000-seed campaign at 120 steps, with and without the purge. A remote
 * commit's cleanup starts a follow-up transaction (the delete marks'
 * repair, P11) whose writes are in the document before the commit's
 * report; the report read the child lists, then its first content read
 * folded the follow-up (read-your-writes) and moved them, so the published
 * tree differed from its rebuild. The report folds every queued
 * transaction first.
 */
describe('H7 purge fuzz — pinned seeds', () => {
	for (const seed of [651, 1271])
		for (const purge of [true, false])
			it(`rich seed ${seed}, 120 steps, purge ${purge ? 'on' : 'off'}: no index divergence`, () => {
				const { failures } = campaign(seed, 120, RICH, purge);
				expect(failures).toEqual([]);
			});
});
