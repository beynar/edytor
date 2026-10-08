/**
 * Phase 5, H13 — a concurrent creation of one caller-chosen id keeps the
 * losing incarnation's text (`docs/archive/research/crdt-fix-plan-2026-10.md`,
 * contract row `id.same.concurrent` in `docs/editor-delete-contract.md`).
 *
 * Two live writers (client ids above the seed band, 2^26) insert block `N`
 * concurrently, each with its own text. The registry's last-writer-wins
 * keeps the larger client's node (its type, data, place); the engine keeps
 * the other node's subtree (fork P14), and the index shows its stream after
 * the winner's own, before the winner's merge claims — an implicit merge
 * claim. Expected results come from the contract row, never from running
 * code:
 *
 * - every replica, both delivery orders, duplicate delivery and a reload
 *   show `N` = the winner's text, then the loser's;
 * - a block split off the loser's text keeps its piece;
 * - typing into the loser's part edits it, on every replica; the loser's
 *   author typing late (before it heard of the winner) is kept;
 * - deleting `N` hides both texts; its undo shows both again;
 * - three writers: the two losers follow the winner in client order;
 * - a seed's losing incarnation (a writer below 2^26) shows nothing:
 *   seeds keep one version per id (F-T17).
 * - a fuzz: three replicas creating, typing into and splitting blocks with
 *   colliding ids, synced in random orders, converge and lose no character.
 */
// @ts-nocheck -- tests reach raw engine internals (excluded lane).
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';

const E = bindEdytorDoc(Y);
/**
 * An edytor document (each carries the P14 rule; `H13_OFF=1` turns it off to
 * show the rows discriminate). A replica that reloads integrates before its
 * facade exists, so it is one from the start.
 */
const edytorDoc = () => {
	const doc = E.newDoc();
	if (process.env.H13_OFF === '1') doc.keepReplaced = () => false;
	return doc;
};
const REMOTE = { remote: true };
const LIVE = 2 ** 26;

/** Client-id pairs above the seed band: both orders, near and far. */
const PAIRS: [number, number][] = [
	[LIVE + 7, LIVE + 3],
	[LIVE + 3, LIVE + 7],
	[LIVE + 100, LIVE + 50],
	[LIVE + 50, LIVE + 100],
	[2 ** 40 + 1, LIVE + 9],
	[LIVE + 9, 2 ** 40 + 1]
];

const para = (id: string, text?: string) => ({
	id,
	type: 'paragraph',
	...(text === undefined ? {} : { content: [{ text }] })
});
const seeded = (blocks) => {
	const doc = new Y.Doc();
	E.seed(doc, blocks);
	return Y.encodeStateAsUpdate(doc);
};
const replica = (base: Uint8Array, clientID: number) => {
	const doc = edytorDoc();
	doc.clientID = clientID;
	Y.applyUpdate(doc, base, REMOTE);
	return { doc, ed: E.create(doc) };
};
const deliver = (to, update: Uint8Array) => {
	Y.applyUpdate(to.doc, update, REMOTE);
	Y.applyUpdate(to.doc, update, REMOTE);
};
const diff = (from, to) => Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc));
const sync = (x, y, order: 'xy' | 'yx' = 'xy') => {
	const ux = diff(x, y);
	const uy = diff(y, x);
	if (order === 'xy') {
		deliver(y, ux);
		deliver(x, uy);
	} else {
		deliver(x, uy);
		deliver(y, ux);
	}
};
const reload = (r, clientID: number) => {
	const doc = edytorDoc();
	doc.clientID = clientID;
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(r.doc), REMOTE);
	return E.create(doc);
};
const shape = (ed) => ed.listBlockIds().map((id) => [id, ed.blockText(id)]);
const insertN = (r, text: string, id = 'N') =>
	r.ed.insertBlock(
		{ parent: null, index: 1 },
		{ id, type: 'paragraph', content: [{ kind: 'text', text }] }
	);
const every = (rs, check: (ed) => void) => {
	for (const [i, r] of rs.entries()) check(r.ed);
	for (const [i, r] of rs.entries()) check(reload(r, 900 + i));
};

describe('id.same.concurrent — the losing incarnation shows after the winner', () => {
	for (const [a, b] of PAIRS) {
		for (const order of ['xy', 'yx'] as const) {
			it(`A=${a} B=${b} · ${order}`, () => {
				const base = seeded([para('x', 'x')]);
				const A = replica(base, a);
				const B = replica(base, b);
				expect(insertN(A, 'from A').status).toBe('applied');
				expect(insertN(B, 'from B').status).toBe('applied');
				sync(A, B, order);
				const [win, lose] = a > b ? ['from A', 'from B'] : ['from B', 'from A'];
				every([A, B], (ed) => {
					expect(shape(ed)).toEqual([
						['x', 'x'],
						['N', win + lose]
					]);
				});
				expect(A.ed.toJSON()).toEqual(B.ed.toJSON());
			});
		}
	}

	it('the winner keeps its type and data; the loser only lends its text', () => {
		for (const [a, b] of PAIRS) {
			const base = seeded([para('x', 'x')]);
			const A = replica(base, a);
			const B = replica(base, b);
			A.ed.insertBlock(
				{ parent: null, index: 1 },
				{ id: 'N', type: 'heading', data: { level: 1 }, content: [{ kind: 'text', text: 'A' }] }
			);
			B.ed.insertBlock(
				{ parent: null, index: 0 },
				{ id: 'N', type: 'paragraph', data: { tone: 'b' }, content: [{ kind: 'text', text: 'B' }] }
			);
			sync(A, B);
			const json = A.ed.toJSON();
			expect(json).toEqual(B.ed.toJSON());
			const n = json.children.find((block) => block.id === 'N');
			expect(n.type).toBe(a > b ? 'heading' : 'paragraph');
			expect(n.content.map((c) => c.text).join('')).toBe(a > b ? 'AB' : 'BA');
			expect(json.children).toHaveLength(2);
		}
	});

	it("a block split off the loser's text keeps its piece; the loser's head shows in N", () => {
		for (const [a, b] of PAIRS) {
			for (const order of ['xy', 'yx'] as const) {
				const base = seeded([para('x', 'x')]);
				const A = replica(base, a);
				const B = replica(base, b);
				insertN(A, 'from A');
				insertN(B, 'from B');
				expect(B.ed.splitBlock('N', 4, 'NB2').status).toBe('applied');
				sync(A, B, order);
				expect(shape(A.ed)).toEqual(shape(B.ed));
				const n = a > b ? 'from Afrom' : 'fromfrom A';
				every([A, B], (ed) => {
					expect(ed.blockText('N')).toBe(n);
					expect(ed.blockText('NB2')).toBe(' B');
					// NB2 stands at its own rank, beside where the losing node stood.
					expect([...ed.listBlockIds()].sort()).toEqual(['N', 'NB2', 'x']);
				});
			}
		}
	});

	it("typing into the loser's part edits it on every replica", () => {
		for (const [a, b] of PAIRS) {
			const base = seeded([para('x', 'x')]);
			const A = replica(base, a);
			const B = replica(base, b);
			insertN(A, 'aa');
			insertN(B, 'bb');
			sync(A, B);
			const winner = a > b ? A : B;
			// Typing into the shown text, at the loser's part (after the winner's two chars).
			expect(winner.ed.insertText('N', 3, '!').status).toBe('applied');
			sync(A, B);
			const shown = (a > b ? 'aa' : 'bb') + (a > b ? 'b!b' : 'a!a');
			every([A, B], (ed) => expect(ed.blockText('N')).toBe(shown));
		}
	});

	it("the loser's author typing after the race, before it synced, is kept", () => {
		for (const [a, b] of PAIRS) {
			const base = seeded([para('x', 'x')]);
			const A = replica(base, a);
			const B = replica(base, b);
			insertN(A, 'aa');
			insertN(B, 'bb');
			// Both type more before any exchange: each into its own node.
			A.ed.insertText('N', 2, 'A');
			B.ed.insertText('N', 2, 'B');
			sync(A, B);
			const shown = a > b ? 'aaAbbB' : 'bbBaaA';
			every([A, B], (ed) => expect(ed.blockText('N')).toBe(shown));
			// And typing that reaches one replica late, in pieces.
			const before = Y.encodeStateVector(B.doc);
			B.ed.insertText('N', 0, '<');
			deliver(A, Y.encodeStateAsUpdate(B.doc, before));
			every([A, B], (ed) => expect(ed.blockText('N')).toBe(`<${shown}`));
		}
	});

	it('deleting N hides both texts; the undo shows both again', () => {
		for (const [a, b] of PAIRS) {
			const base = seeded([para('x', 'x')]);
			const A = replica(base, a);
			const B = replica(base, b);
			insertN(A, 'aa');
			insertN(B, 'bb');
			sync(A, B);
			const um = B.ed.createUndoManager({ captureTimeout: 0 });
			expect(B.ed.deleteBlock('N').status).toBe('applied');
			sync(A, B);
			every([A, B], (ed) => expect(shape(ed)).toEqual([['x', 'x']]));
			expect(um.undo()).not.toBe(null);
			sync(A, B);
			const shown = a > b ? 'aabb' : 'bbaa';
			every([A, B], (ed) =>
				expect(shape(ed)).toEqual([
					['x', 'x'],
					['N', shown]
				])
			);
		}
	});

	it('merging N into the block before it carries both texts; N’s own claims follow the loser', () => {
		for (const [a, b] of PAIRS) {
			const base = seeded([para('x', 'x'), para('y', 'y')]);
			const A = replica(base, a);
			const B = replica(base, b);
			A.ed.insertBlock(
				{ parent: null, index: 2 },
				{ id: 'N', type: 'paragraph', content: [{ kind: 'text', text: 'aa' }] }
			);
			B.ed.insertBlock(
				{ parent: null, index: 2 },
				{ id: 'N', type: 'paragraph', content: [{ kind: 'text', text: 'bb' }] }
			);
			sync(A, B);
			// The winner merges a block into N: its claim follows the loser's text.
			const winner = a > b ? A : B;
			expect(winner.ed.moveBlock('y', { parent: null, index: 2 }).status).toBe('applied');
			expect(winner.ed.mergeBlocks('y', 'N').status).toBe('applied');
			sync(A, B);
			const shown = (a > b ? 'aabb' : 'bbaa') + 'y';
			every([A, B], (ed) => expect(ed.blockText('N')).toBe(shown));
			// N merged backward into x: x shows everything.
			expect(A.ed.mergeBackward('N').status).toBe('applied');
			sync(A, B);
			every([A, B], (ed) => expect(shape(ed)).toEqual([['x', `x${shown}`]]));
		}
	});

	it('three writers: the losers follow the winner in client order', () => {
		const ids = [LIVE + 5, LIVE + 9, LIVE + 2];
		for (const order of [
			[0, 1, 2],
			[2, 1, 0],
			[1, 0, 2]
		]) {
			const base = seeded([para('x', 'x')]);
			const rs = ids.map((id) => replica(base, id));
			rs.forEach((r, i) => insertN(r, `${i}${i}`));
			for (const i of order) for (const j of order) if (i !== j) sync(rs[i], rs[j]);
			// Winner: client LIVE+9 (writer 1); then the losers by client id, larger first.
			every(rs, (ed) => expect(ed.blockText('N')).toBe('110022'));
		}
	});
});

describe('id.same.concurrent — seeds keep one version per id (F-T17)', () => {
	it("a seed's losing incarnation shows nothing", () => {
		const one = seeded([para('N', 'one')]);
		const two = seeded([para('N', 'two')]);
		for (const order of ['xy', 'yx'] as const) {
			const A = replica(one, LIVE + 1);
			const B = replica(two, LIVE + 2);
			sync(A, B, order);
			every([A, B], (ed) => expect(['one', 'two']).toContain(ed.blockText('N')));
			expect(A.ed.blockText('N')).toBe(B.ed.blockText('N'));
		}
	});

	it('a live writer racing a seed: the live block wins and the seed shows nothing', () => {
		const tmpl = seeded([para('N', 'template')]);
		const A = replica(seeded([para('x', 'x')]), LIVE + 1);
		insertN(A, 'live');
		const B = replica(tmpl, LIVE + 2);
		sync(A, B);
		every([A, B], (ed) => expect(ed.blockText('N')).toBe('live'));
	});
});

// ── fuzz ─────────────────────────────────────────────────────────────────

/** A small deterministic PRNG (mulberry32). */
const prng = (seed: number) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SEEDS = Number(process.env.H13_FUZZ_SEEDS ?? 120);
const STEPS = Number(process.env.H13_FUZZ_STEPS ?? 40);

describe('id.same.concurrent — fuzz: colliding ids converge and lose no character', () => {
	it(`${SEEDS} seeds × ${STEPS} steps, 3 replicas`, () => {
		for (let seed = Number(process.env.H13_FROM ?? 1); seed <= SEEDS; seed++) {
			const rand = prng(seed);
			const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
			const base = seeded([para('root', '')]);
			const rs = [0, 1, 2].map((i) => replica(base, LIVE + 1 + i * 1000 + seed));
			// Every character written is unique: a lost or doubled one shows in the multiset.
			let next = 0x4e00;
			const written: string[] = [];
			const ids = ['A', 'B', 'C', 'D'];
			let fresh = 0;
			try {
				for (let step = 0; step < STEPS; step++) {
					const r = pick(rs);
					const ed = r.ed;
					const visible = ed.listBlockIds();
					const roll = rand();
					if (roll < 0.3) {
						const id = rand() < 0.7 ? pick(ids) : `f${seed}.${fresh++}`;
						const ch = String.fromCodePoint(next++);
						const res = ed.insertBlock(
							{ parent: null, index: Math.floor(rand() * (visible.length + 1)) },
							{ id, type: 'paragraph', content: [{ kind: 'text', text: ch }] }
						);
						if (res.status === 'applied') written.push(ch);
					} else if (roll < 0.75) {
						const id = pick(visible);
						const ch = String.fromCodePoint(next++);
						const at = Math.floor(rand() * (ed.blockText(id).length + 1));
						if (ed.insertText(id, at, ch).status === 'applied') written.push(ch);
					} else if (roll < 0.8) {
						const id = pick(visible);
						const at = Math.floor(rand() * (ed.blockText(id).length + 1));
						ed.splitBlock(id, at, rand() < 0.3 ? pick(ids) : `s${seed}.${fresh++}`);
					} else if (roll < 0.85) {
						ed.mergeBackward(pick(visible));
					} else {
						const x = pick(rs);
						const y = pick(rs);
						if (x !== y) sync(x, y, rand() < 0.5 ? 'xy' : 'yx');
					}
				}
				for (const x of rs) for (const y of rs) if (x !== y) sync(x, y);
				const texts = rs.map((r) => JSON.stringify(r.ed.toJSON()));
				expect(new Set(texts).size, `seed ${seed}: replicas converge`).toBe(1);
				const reloaded = JSON.stringify(reload(rs[0], 999).toJSON());
				expect(reloaded, `seed ${seed}: a reload reads the same`).toBe(texts[0]);
				const ed = rs[0].ed;
				const all = ed
					.listBlockIds()
					.map((id) => ed.blockText(id))
					.join('');
				expect([...all].sort().join(''), `seed ${seed}: every character, once`).toBe(
					[...written].sort().join('')
				);
			} catch (error) {
				(error as Error).message = `seed ${seed}: ${(error as Error).message}`;
				throw error;
			}
		}
	});
});

describe('id.same.concurrent — fuzz with deletes and undo: colliding ids converge', () => {
	it(`${SEEDS} seeds × ${STEPS} steps, 3 replicas`, () => {
		for (let seed = 1; seed <= SEEDS; seed++) {
			const rand = prng(seed * 7919);
			const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
			const base = seeded([para('root', 'r')]);
			const rs = [0, 1, 2].map((i) => replica(base, LIVE + 7 + i * 1000 + seed));
			const ums = rs.map((r) => r.ed.createUndoManager({ captureTimeout: 0 }));
			const ids = ['A', 'B', 'C'];
			let fresh = 0;
			try {
				for (let step = 0; step < STEPS; step++) {
					const i = Math.floor(rand() * rs.length);
					const ed = rs[i].ed;
					const visible = ed.listBlockIds();
					const roll = rand();
					const id = pick(visible);
					const len = id === undefined ? 0 : ed.blockText(id).length;
					if (roll < 0.25) {
						ed.insertBlock(
							{ parent: null, index: Math.floor(rand() * (visible.length + 1)) },
							{
								id: rand() < 0.7 ? pick(ids) : `f${seed}.${fresh++}`,
								type: 'paragraph',
								content: [{ kind: 'text', text: 'ab'.slice(0, 1 + Math.floor(rand() * 2)) }]
							}
						);
					} else if (roll < 0.45 && id !== undefined) {
						ed.insertText(id, Math.floor(rand() * (len + 1)), 'xy'[Math.floor(rand() * 2)]);
					} else if (roll < 0.55 && id !== undefined && len > 0) {
						ed.deleteText(id, Math.floor(rand() * len), 1);
					} else if (roll < 0.62 && id !== undefined && visible.length > 1) {
						ed.deleteBlock(id);
					} else if (roll < 0.7 && id !== undefined) {
						ed.splitBlock(
							id,
							Math.floor(rand() * (len + 1)),
							rand() < 0.3 ? pick(ids) : `s${seed}.${fresh++}`
						);
					} else if (roll < 0.75 && id !== undefined) {
						ed.mergeBackward(id);
					} else if (roll < 0.82) {
						ums[i].undo();
					} else {
						const x = pick(rs);
						const y = pick(rs);
						if (x !== y) sync(x, y, rand() < 0.5 ? 'xy' : 'yx');
					}
				}
				for (const x of rs) for (const y of rs) if (x !== y) sync(x, y);
				const texts = rs.map((r) => JSON.stringify(r.ed.toJSON()));
				expect(new Set(texts).size, `seed ${seed}: replicas converge`).toBe(1);
				expect(
					JSON.stringify(reload(rs[1], 998).toJSON()),
					`seed ${seed}: a reload reads the same`
				).toBe(texts[0]);
			} catch (error) {
				(error as Error).message = `seed ${seed}: ${(error as Error).message}`;
				throw error;
			}
		}
	});
});

// ── the purge (H7) of a block shown with a losing incarnation ─────────────

describe('id.same.concurrent — the purge removes both incarnations together', () => {
	it("a deleted N past the horizon takes the loser's text with it; a live one keeps it", async () => {
		const { Y: engine } = await import('$lib/crdt/engine.js');
		const { bindCrdt, defaultSemantics } = await import('$lib/crdt/index.js');
		const {
			replica: open,
			seedUpdate,
			syncAll,
			wellFormed
		} = await import('../arch-v2/p1-harness.js');
		const crdt = bindCrdt(engine);
		const seed = seedUpdate([{ id: 'p1', text: 'live' }], defaultSemantics);
		const room = open('room', seed, LIVE + 1, { semantics: defaultSemantics });
		const ada = open('ada', seed, LIVE + 30, { semantics: defaultSemantics });
		const bob = open('bob', seed, LIVE + 20, { semantics: defaultSemantics });
		const insert = (r, text: string, id: string) =>
			r.ed.insertBlock(
				{ parent: null, index: 1 },
				{ id, type: 'paragraph', content: [{ kind: 'text', text }] }
			);
		insert(ada, 'ADA-ONE', 'N');
		insert(bob, 'BOB-ONE', 'N');
		insert(ada, 'ADA-TWO', 'M');
		insert(bob, 'BOB-TWO', 'M');
		syncAll([room, ada, bob]);
		expect(room.ed.blockText('N')).toBe('ADA-ONEBOB-ONE');
		expect(room.ed.blockText('M')).toBe('ADA-TWOBOB-TWO');
		ada.ed.deleteBlock('N');
		syncAll([room, ada, bob]);
		const holds = (r, text: string) =>
			new TextDecoder('utf-8', { fatal: false })
				.decode(engine.encodeStateAsUpdate(r.doc))
				.includes(text);
		expect(holds(room, 'BOB-ONE')).toBe(true);
		const horizon = { at: 1, sv: engine.encodeStateVector(room.doc) };
		const report = room.doc.transact(
			() => crdt.doc.purge(room.doc, room.ed, horizon),
			Symbol('purge')
		);
		expect(report).toMatchObject({ removed: 2 });
		syncAll([room, ada, bob]);
		for (const r of [room, ada, bob]) {
			expect(holds(r, 'BOB-ONE')).toBe(false);
			expect(holds(r, 'ADA-ONE')).toBe(false);
			expect(r.ed.blockText('M')).toBe('ADA-TWOBOB-TWO');
			expect(r.ed.listBlockIds()).toEqual(['p1', 'M']);
			expect(wellFormed(r.ed, { doc: r.doc, semantics: defaultSemantics })).toEqual([]);
		}
	});
});
