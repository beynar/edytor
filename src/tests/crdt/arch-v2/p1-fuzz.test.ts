/**
 * arch-v2 phase 2 P1.1 — the native review's multi-replica fuzz campaign
 * (`review-probes/fuzz-lib.ts`, `fuzz.test.ts`) re-targeted at arch-v2.
 *
 * 3–5 replicas, each a real document driven through the facade: insert,
 * delete, replace, range delete, format, split, merge (backward and
 * forward), move, nest, unnest, block delete (subtree and keep-children),
 * block create, multi-line paste, retype (incl. an island and a void kind),
 * inline atoms, undo and redo. Delivery is random: batches from one replica
 * to another, shuffled, with duplicates; replicas go offline (neither send
 * nor receive) and come back; occasional full syncs.
 *
 * Asserted per program (the native probe's failure kinds, arch-v2 terms):
 * - `throw`: no facade op, undo or redo throws (a local refusal is a
 *   result, not a failure);
 * - `refused`: no inbound update is refused by the admission gate or left
 *   unapplied;
 * - `stuck-pending`: nothing is held back after full delivery;
 * - `diverge`: every replica agrees; an observer fed every update in
 *   reverse order (each twice) agrees; a binary reload of every replica
 *   agrees (the native `fastpath` check: the maintained index equals a
 *   document rebuilt from bytes);
 * - `tree` / `dup-atom`: every block reachable once with a consistent
 *   parent, every visible character identity once.
 *
 * A failing seed is shrunk to a minimal replayable program (the recorded
 * steps carry concrete arguments) and printed in the assertion message.
 *
 * Knobs: `P1_FUZZ_SEEDS` (default 200), `P1_FUZZ_START` (1), `P1_FUZZ_LEN`
 * (40), `P1_FUZZ_WIDE` (seeds of the 5-replica pass, default 40).
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import {
	quiesce,
	reloadCanonical,
	replica,
	seedUpdate,
	syncAll,
	wellFormed,
	type Replica
} from './p1-harness.js';
import { ACTIONS, apply, genAction, rngOf } from './p1-ops.js';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../oracles/model-ops.js';

const M = bindModel(Y);

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
const SEMANTICS = { roles: { callout: { island: true }, divider: { void: true } } };

/** A campaign's document: its seed, its roles, the kinds a retype picks, its actions. */
type Lane = { seed: Uint8Array; semantics: unknown; kinds?: string[]; actions?: string[] };
const PLAIN: Lane = { seed: seedUpdate(SEEDS, SEMANTICS), semantics: SEMANTICS };

/**
 * ZW-11: the container lane — lists of items (one with a paragraph child,
 * one nested), columns of columns (a column holds any block), a table
 * island of rows of cells and a code island of lines; retypes pick list,
 * line and container kinds too, and the view's Turn into (`turnInto`: the
 * lift and the retype in one plan) races the outdents (DR-crdt-1). Held to
 * `wellFormed` with its roles (`island-kind`: never a line kind outside its
 * island) and to `listChildren`.
 *
 * Columns, C0 (`docs/columns-plan.md`): `columns` is a layout (its role says
 * `layout`), so `layout-shape` holds after every step, and `placeBeside`
 * (the beside drop) joins the actions.
 */
const item = (id: string, text: string, children = []) => ({
	id,
	type: 'list-item',
	text,
	children
});
const CONTAINERS: Lane = (() => {
	const semantics = {
		roles: {
			callout: { island: true },
			divider: { void: true },
			code: { island: true, lines: true },
			table: { island: true },
			columns: { layout: true }
		},
		rendersContent: {
			divider: false,
			code: false,
			table: false,
			row: false,
			'unordered-list': false,
			'ordered-list': false,
			columns: false,
			column: false
		},
		defaultChild: {
			code: 'codeLine',
			table: 'row',
			row: 'cell',
			'unordered-list': 'list-item',
			'ordered-list': 'list-item',
			columns: 'column'
		}
	};
	const seeds = [
		{ id: 'A', text: 'alpha' },
		{
			id: 'U',
			type: 'unordered-list',
			children: [
				item('U1', 'one', [{ id: 'U1p', text: 'under' }]),
				item('U2', 'two', [
					{ id: 'O', type: 'ordered-list', children: [item('O1', 'first'), item('O2', 'second')] }
				]),
				// DR-crdt-1: a void and an island under an item keep their kinds when shed.
				item('U3', 'three', [
					{ id: 'U3d', type: 'divider' },
					{ id: 'U3c', type: 'code', children: [{ id: 'U3cl', type: 'codeLine', text: 'let y' }] }
				]),
				// AW-04, DR-crdt-3: stored as a paragraph, shown as the list's item (what a race leaves).
				{ id: 'U4', type: 'paragraph', text: 'four' }
			]
		},
		{
			id: 'K',
			type: 'columns',
			children: [
				{ id: 'K1', type: 'column', children: [{ id: 'K1a', text: 'left' }] },
				{
					id: 'K2',
					type: 'column',
					children: [
						{ id: 'K2a', text: 'right' },
						{ id: 'K2b', text: 'more' }
					]
				}
			]
		},
		{
			id: 'T',
			type: 'table',
			children: [
				{
					id: 'T1',
					type: 'row',
					children: [
						{ id: 'T1a', type: 'cell', text: 'c1' },
						{ id: 'T1b', type: 'cell', text: 'c2' }
					]
				}
			]
		},
		{ id: 'C', type: 'code', children: [{ id: 'C1', type: 'codeLine', text: 'let x' }] },
		{ id: 'D', text: 'delta' }
	];
	return {
		seed: seedUpdate(seeds, semantics),
		semantics,
		actions: [...ACTIONS, 'turnInto', 'turnInto', 'placeBeside', 'placeBeside'],
		kinds: [
			'paragraph',
			'heading',
			'list-item',
			'unordered-list',
			'ordered-list',
			'codeLine',
			'divider',
			'column'
		]
	};
})();

/**
 * Columns C1: the layout lane — the concurrent campaigns of the plan (§4.7):
 * two beside drops on one target, moves racing a dissolve, a column deleted
 * while a peer adds into it, a layout deleted while a peer adds a column,
 * undo after a peer's edit in a new column (P12 withdraw). Two layouts and
 * plain blocks; the actions lean on beside drops, deletes, moves, merges and
 * history. Held to `wellFormed` with its roles (`layout-shape` after every
 * step).
 */
const LAYOUTS: Lane = (() => {
	const semantics = {
		roles: { columns: { layout: true }, divider: { void: true } },
		rendersContent: {
			columns: false,
			column: false,
			divider: false,
			'unordered-list': false
		},
		defaultChild: { columns: 'column', 'unordered-list': 'list-item' }
	};
	const col = (id: string, ...children) => ({ id, type: 'column', children });
	const seeds = [
		{ id: 'P', text: 'para' },
		{
			id: 'C',
			type: 'columns',
			children: [
				col('C1', { id: 'C1a', text: 'left' }, { id: 'C1b', text: 'below' }),
				col('C2', { id: 'C2a', text: 'right' })
			]
		},
		{ id: 'Q', text: 'quiet' },
		{
			id: 'E',
			type: 'columns',
			children: [
				col('E1', { id: 'E1a', text: 'one' }),
				col('E2', { id: 'U', type: 'unordered-list', children: [item('U1', 'item')] }),
				col('E3', { id: 'E3a', text: 'three' })
			]
		},
		{ id: 'Z', text: 'zulu' }
	];
	return {
		seed: seedUpdate(seeds, semantics),
		semantics,
		actions: [
			'placeBeside',
			'placeBeside',
			'placeBeside',
			'placeBeside',
			'deleteBlocks',
			'deleteKeep',
			'move',
			'nest',
			'unnest',
			'mergeBackward',
			'mergeForward',
			'deleteRange',
			'split',
			'insert',
			'create',
			'paste',
			'undo',
			'undo',
			'redo'
		],
		kinds: ['paragraph', 'column', 'columns', 'divider']
	};
})();

/**
 * AW-04, DR-crdt-1: what a list shows directly — its item, or a block
 * showing its own stored kind other than the document's default (a nested
 * list; an image, a heading a merge or a race leaves there, DR-crdt-1).
 * Never a paragraph: a plain block stored there shows as the item
 * (`typeOf`), and nothing else shows a kind it is not stored as.
 */
const LISTS = new Set(['unordered-list', 'ordered-list']);
const listChildren = (ed, doc): string[] => {
	const out: string[] = [];
	const visit = (b) => {
		if (LISTS.has(b.type))
			for (const c of b.children ?? []) {
				const stored = M.blockNodeOf(doc, c.id)?.getAttr('type');
				if (c.type !== 'list-item' && (c.type !== stored || stored === 'paragraph'))
					out.push(`${c.id}:${c.type} (stored ${stored}) in ${b.id}`);
			}
		(b.children ?? []).forEach(visit);
	};
	ed.toJSON().children.forEach(visit);
	return out;
};

type Step =
	| { t: 'op'; r: number; action: string; args: unknown[] }
	| { t: 'deliver'; to: number; from: number; n: number; shuffle: number; dup: boolean }
	| { t: 'offline'; r: number; on: boolean }
	| { t: 'sync' };
type Failure = { kind: string; detail: string };

/** Outcome counts per action (`insert:applied`, `undo:item`, …) — the campaign's coverage. */
const STATS = new Map<string, number>();

type World = { reps: Replica[]; sentTo: number[][]; online: boolean[]; lane: Lane };

/**
 * Replica `i`'s client id: one of `n` bands, the bands shuffled per seed
 * (CW-01) — with the bands in replica order, `R0` always lost every
 * concurrent move and a race whose outcome follows the ids was only ever
 * run one way round.
 */
const clientIds = (n: number, seed: number): number[] => {
	const next = rngOf(seed * 7919 + 17);
	const bands = Array.from({ length: n }, (_, i) => i);
	for (let i = n - 1; i > 0; i--) {
		const j = next(i + 1);
		[bands[i], bands[j]] = [bands[j], bands[i]];
	}
	return bands.map((band, i) => 1 + ((seed * 31 + i * 7) % 5000) + band * 5000);
};

const world = (n: number, seed: number, lane: Lane): World => ({
	lane,
	reps: clientIds(n, seed).map((id, i) =>
		replica(`R${i}`, lane.seed, id, { semantics: lane.semantics, salt: seed })
	),
	sentTo: Array.from({ length: n }, () => Array(n).fill(0)),
	online: Array(n).fill(true)
});

const deliver = (w: World, to: number, from: number, n = Infinity, shuffle = 0, dup = false) => {
	if (to === from || !w.online[to] || !w.online[from]) return;
	const src = w.reps[from];
	const start = w.sentTo[from][to];
	const batch = src.log.slice(start, start + n);
	w.sentTo[from][to] = start + batch.length;
	const order = [...batch];
	if (shuffle) {
		const r = rngOf(shuffle);
		for (let i = order.length - 1; i > 0; i--) {
			const j = r(i + 1);
			[order[i], order[j]] = [order[j], order[i]];
		}
		if (dup && batch.length) order.push(batch[r(batch.length)]);
	}
	w.reps[to].receiveAll(order);
};

const execute = (w: World, step: Step, failures: Failure[]) => {
	if (step.t === 'op') {
		const r = w.reps[step.r];
		try {
			const res = apply(r, step.action, structuredClone(step.args));
			const k = `${step.action}:${res === null ? 'null' : (res?.status ?? (res ? 'item' : String(res)))}`;
			STATS.set(k, (STATS.get(k) ?? 0) + 1);
		} catch (e) {
			failures.push({
				kind: 'throw',
				detail: `${r.name} ${step.action}(${JSON.stringify(step.args)}): ${e?.stack ?? e}`
			});
		}
	} else if (step.t === 'deliver') deliver(w, step.to, step.from, step.n, step.shuffle, step.dup);
	else if (step.t === 'offline') w.online[step.r] = !step.on;
	else for (const to of w.reps.keys()) for (const from of w.reps.keys()) deliver(w, to, from);
};

/** Finish: everyone online, full sync, then every check. */
const verdict = (w: World, failures: Failure[]) => {
	w.online.fill(true);
	for (let k = 0; k < 2; k++)
		for (const to of w.reps.keys()) for (const from of w.reps.keys()) deliver(w, to, from);
	syncAll(w.reps); // belt and braces: re-deliver everything (duplicates)
	for (const r of w.reps) {
		for (const p of r.problems) failures.push({ kind: 'refused', detail: p });
		if (r.pending()) failures.push({ kind: 'stuck-pending', detail: r.name });
	}
	// An observer fed every update in reverse order, each twice: nothing may
	// stay pending once it holds every update.
	const all = w.reps.flatMap((r) => r.log).reverse();
	const { seed, semantics } = w.lane;
	const obs = replica('obs', seed, 7777, { semantics });
	for (const u of all) {
		obs.receive(u);
		obs.receive(u);
	}
	if (obs.pending()) failures.push({ kind: 'observer-pending', detail: '' });
	// Then its own writes (the engine's formatting cleanup) propagate like
	// anyone's, and everybody must agree (`quiesce`).
	try {
		quiesce([...w.reps, obs]);
	} catch (e) {
		failures.push({ kind: 'no-quiescence', detail: String(e) });
	}
	for (const p of obs.problems) failures.push({ kind: 'observer-refused', detail: p });
	const canon = w.reps.map((r) => r.canonical());
	if (new Set(canon).size !== 1) failures.push({ kind: 'diverge', detail: canon.join('\n') });
	if (obs.canonical() !== canon[0])
		failures.push({ kind: 'observer-diverge', detail: obs.canonical() });
	for (const r of w.reps) {
		// The same roles as the replica: a void's children display by them (UW-21b).
		const reloaded = reloadCanonical(r, undefined, { semantics });
		if (reloaded !== canon[0]) failures.push({ kind: 'reload', detail: `${r.name}: ${reloaded}` });
	}
	obs.destroy();
	for (const p of wellFormed(w.reps[0].ed, w.lane === PLAIN ? {} : { semantics }))
		failures.push({ kind: p.startsWith('duplicate atom') ? 'dup-atom' : 'tree', detail: p });
	if (w.lane === CONTAINERS)
		for (const p of listChildren(w.reps[0].ed, w.reps[0].doc))
			failures.push({ kind: 'container', detail: p });
	for (const r of w.reps) r.destroy();
};

/** Generate and run one program; returns the recorded (replayable) steps and failures. */
const generate = (seed: number, n: number, length: number, lane: Lane) => {
	const next = rngOf(seed);
	const w = world(n, seed, lane);
	const counter = { n: 0 };
	const steps: Step[] = [];
	const failures: Failure[] = [];
	for (let i = 0; i < length; i++) {
		const roll = next(20);
		let step: Step | null = null;
		if (roll < 13) {
			const r = next(n);
			const a = genAction(w.reps[r], next, counter, lane.actions, lane.kinds);
			if (a) step = { t: 'op', r, ...a };
		} else if (roll < 17) {
			const to = next(n);
			const from = next(n);
			if (to !== from)
				step = {
					t: 'deliver',
					to,
					from,
					n: 1 + next(4),
					shuffle: 1 + next(1e9),
					dup: next(3) === 0
				};
		} else if (roll < 19) {
			const r = next(n);
			step = { t: 'offline', r, on: w.online[r] };
		} else step = { t: 'sync' };
		if (!step) continue;
		steps.push(step);
		execute(w, step, failures);
	}
	verdict(w, failures);
	return { steps, failures };
};

const replay = (seed: number, n: number, steps: Step[], lane: Lane) => {
	const w = world(n, seed, lane);
	const failures: Failure[] = [];
	for (const s of steps) execute(w, s, failures);
	verdict(w, failures);
	return failures;
};

/** Delta-debug `steps` down to a minimal program that still fails with `kind`. */
const shrink = (seed: number, n: number, steps: Step[], kind: string, lane: Lane) => {
	let cur = steps;
	const fails = (s: Step[]) => replay(seed, n, s, lane).some((f) => f.kind === kind);
	for (let chunk = Math.max(1, cur.length >> 1); chunk >= 1; chunk >>= 1) {
		for (let i = 0; i + chunk <= cur.length; ) {
			const cand = [...cur.slice(0, i), ...cur.slice(i + chunk)];
			if (fails(cand)) cur = cand;
			else i += chunk;
		}
	}
	return cur;
};

const campaign = (n: number, seeds: number, start: number, length: number, lane = PLAIN) => {
	const byKind = new Map<string, { seed: number; detail: string }[]>();
	for (let seed = start; seed < start + seeds; seed++) {
		const failures = generate(seed, n, length, lane).failures;
		for (const k of new Set(failures.map((f) => f.kind))) {
			const list = byKind.get(k) ?? [];
			list.push({ seed, detail: failures.find((f) => f.kind === k)!.detail });
			byKind.set(k, list);
		}
	}
	const report: Record<string, unknown> = {};
	for (const [kind, list] of byKind) {
		const first = list[0];
		const { steps } = generate(first.seed, n, length, lane);
		report[kind] = {
			seeds: list.map((x) => x.seed).slice(0, 15),
			count: list.length,
			detail: first.detail.slice(0, 2000),
			minimal: shrink(first.seed, n, steps, kind, lane)
		};
	}
	return report;
};

const env = (k: string, d: number) => Number(process.env[k] ?? d);
const START = env('P1_FUZZ_START', 1);
const LEN = env('P1_FUZZ_LEN', 40);

describe('P1 fuzz — multi-replica campaign through the facade (review-probes/fuzz)', () => {
	it(`3 replicas × ${env('P1_FUZZ_SEEDS', 200)} seeds × ${LEN} steps: converge, no refusal, nothing pending, well-formed`, () => {
		STATS.clear();
		const report = campaign(3, env('P1_FUZZ_SEEDS', 200), START, LEN);
		expect(report, JSON.stringify(report, null, 1)).toEqual({});
		// Not vacuous: every action wrote at least once (undo/redo popped a step).
		const wrote = new Set(
			[...STATS.keys()].filter((k) => /:(applied|item)$/.test(k)).map((k) => k.split(':')[0])
		);
		expect([...new Set(ACTIONS)].filter((a) => !wrote.has(a))).toEqual([]);
	});

	it(`5 replicas × ${env('P1_FUZZ_WIDE', 40)} seeds × ${LEN + 20} steps, offline churn`, () => {
		const report = campaign(5, env('P1_FUZZ_WIDE', 40), START + 5000, LEN + 20);
		expect(report, JSON.stringify(report, null, 1)).toEqual({});
	});

	/**
	 * ZW-01/ZW-11: one replica, structural ops only (no explicit retype or
	 * insert, which place what they are told): after every op, every list
	 * holds no plain block (a paragraph) and at least one child — the
	 * container rule (`fits`) on every placement path — and every void and
	 * island keeps its kind (DR-crdt-1: a shed one is never refitted).
	 */
	it(`containers: structural ops never leave a paragraph or no item in a list, nor retype a void or island (${env('P1_FUZZ_SEEDS', 200)} seeds)`, () => {
		const lists = LISTS;
		const sealed = new Set(['divider', 'code', 'table', 'callout']);
		const kinds = new Map<string, string>();
		const broken = (ed, doc) => {
			const out: string[] = [];
			const visit = (b) => {
				// The write side too (`fitted`): a structural op stores a shed paragraph as the item
				// (the seed's U4 is stored so on purpose: what a race leaves).
				if (lists.has(b.type))
					for (const c of b.children ?? [])
						if (c.id !== 'U4' && M.blockNodeOf(doc, c.id)?.getAttr('type') === 'paragraph')
							out.push(`${c.id} stored as a paragraph in ${b.id}`);
				if (sealed.has(kinds.get(b.id) ?? '') && b.type !== kinds.get(b.id))
					out.push(`${b.id}:${kinds.get(b.id)} became ${b.type}`);
				if (lists.has(b.type) && !b.children?.length && !b.content?.length)
					out.push(`${b.id} has no item`);
				(b.children ?? []).forEach(visit);
			};
			ed.toJSON().children.forEach(visit);
			// Only a plain block is refitted: any other kind keeps its kind (DR-crdt-1).
			return [...out, ...listChildren(ed, doc)];
		};
		const actions = ACTIONS.filter((a) => !['create', 'retype'].includes(a));
		const TEXT = new Set(['insert', 'deleteText', 'replaceText', 'format', 'inline']);
		const CONTAINER = new Set([...lists, 'columns', 'column', 'row']);
		const failures: string[] = [];
		for (let seed = START + 12000; seed < START + 12000 + env('P1_FUZZ_SEEDS', 200); seed++) {
			const r = replica('R', CONTAINERS.seed, 1000 + seed, {
				semantics: CONTAINERS.semantics,
				salt: seed
			});
			const next = rngOf(seed);
			const counter = { n: 0 };
			const trail: string[] = [];
			kinds.clear();
			for (const id of r.ed.order()) kinds.set(id, r.ed.blockTypeOf(id));
			for (let i = 0; i < LEN && failures.length === 0; i++) {
				const a = genAction(r, next, counter, actions);
				// Text written into a list's own (hidden) slot is an explicit write too.
				if (!a || (TEXT.has(a.action) && CONTAINER.has(r.ed.blockTypeOf(a.args[0])))) continue;
				const inList = (id) => r.ed.ancestorsOf(id).some((p) => lists.has(r.ed.blockTypeOf(p)));
				const was = a.action === 'unnest' && inList(a.args[0]);
				const res = apply(r, a.action, structuredClone(a.args));
				trail.push(`${a.action}(${JSON.stringify(a.args)})`);
				const bad = broken(r.ed, r.doc);
				// DR-crdt-3: an outdent out of every list leaves no item behind.
				const [id] = a.args;
				if (was && res?.status === 'applied' && !inList(id) && r.ed.blockTypeOf(id) === 'list-item')
					bad.push(`${id} left its list as a list-item`);
				if (bad.length) failures.push(`seed ${seed}: ${bad.join('; ')} after ${trail.join(' ')}`);
			}
			r.destroy();
		}
		expect(failures).toEqual([]);
	});

	// ZW-11: pinned seeds over lists, columns of columns, a table and a code island.
	it(`containers: 3 replicas × ${env('P1_FUZZ_SEEDS', 200)} seeds × ${LEN} steps`, () => {
		STATS.clear();
		const report = campaign(3, env('P1_FUZZ_SEEDS', 200), START + 9000, LEN, CONTAINERS);
		expect(report, JSON.stringify(report, null, 1)).toEqual({});
		// Not vacuous: a Turn into applied (DR-crdt-1), and a beside drop.
		expect(STATS.get('turnInto:applied') ?? 0).toBeGreaterThan(0);
		expect(STATS.get('placeBeside:applied') ?? 0).toBeGreaterThan(0);
	});

	it(`layouts: 3 replicas × ${env('P1_FUZZ_SEEDS', 200)} seeds × ${LEN} steps`, () => {
		STATS.clear();
		const report = campaign(3, env('P1_FUZZ_SEEDS', 200), START + 21000, LEN, LAYOUTS);
		expect(report, JSON.stringify(report, null, 1)).toEqual({});
		// Not vacuous: beside drops applied, and undos popped them.
		expect(STATS.get('placeBeside:applied') ?? 0).toBeGreaterThan(50);
		expect(STATS.get('undo:item') ?? 0).toBeGreaterThan(50);
	});

	it(`layouts: 5 replicas × ${env('P1_FUZZ_WIDE', 40)} seeds × ${LEN + 20} steps, offline churn`, () => {
		const report = campaign(5, env('P1_FUZZ_WIDE', 40), START + 24000, LEN + 20, LAYOUTS);
		expect(report, JSON.stringify(report, null, 1)).toEqual({});
	});

	it(`containers: 5 replicas × ${env('P1_FUZZ_WIDE', 40)} seeds × ${LEN + 20} steps, offline churn`, () => {
		const report = campaign(5, env('P1_FUZZ_WIDE', 40), START + 15000, LEN + 20, CONTAINERS);
		expect(report, JSON.stringify(report, null, 1)).toEqual({});
	});
});
