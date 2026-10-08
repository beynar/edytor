/**
 * arch-v2 — checkpoint D9 rows: one derived index per document, folded once
 * per transaction behind a watermark; the change report comes from the fold
 * (rule R6, §2.4 "Per-doc index" and "Change report", L10, K7).
 *
 * Rows (doc lane):
 * - F-O7 — the change report vs the `diffSnaps` oracle (`src/tests/oracles`)
 *   over a random corpus: every facade op, nested `transact` batches,
 *   change-then-revert batches, undo/redo, remote delivery from a peer in
 *   both directions (in order, duplicated, as one merged update) and a
 *   binary reload, under three client-id assignments. Snapshots are built
 *   test-side from the public projection (`project()`: the blocks reachable
 *   from the root) and the maintained runs, before and after every commit;
 *   the oracle's diff must equal the published report on every commit, and
 *   a commit whose oracle diff is empty publishes nothing.
 * - F-O9 — inside one transaction: insert → read → insert into the same text
 *   → read, and delete → read → delete → read; the second read sees the
 *   second edit (attack F11: `transaction.changed` does not grow on a second
 *   edit to an already-changed type). Also through a raw engine write, which
 *   no facade funnel sees.
 * - F-O5 (linearity half) — 1,000 inserts inside one transaction fold about
 *   what 1,000 separate transactions fold, and ten times the inserts fold
 *   about ten times the work (probe C10: every read re-folded the whole
 *   accumulated transaction, so batching was quadratic). Counted by the
 *   index's fold counters, never a wall clock (CC-05).
 * - Publication rules of §2.4: nested transactions publish once;
 *   change-then-revert publishes nothing; every facade on the doc receives
 *   the one report of a commit.
 *
 * Expected values come from the plan rows and the oracle, never from the
 * code under test.
 */
// @ts-nocheck -- tests drive the vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { diffSnaps, type DocSnap } from '../../oracles/doc-change.js';

const E = bindEdytorDoc(Y);

/** Red on the reference (`arch-v2/ref-d9`); green since the fold landed. */
const red = test;

const p = (id: string, text: string, children?: unknown[], type = 'paragraph') => ({
	id,
	type,
	content: [{ kind: 'text', text }],
	...(children ? { children } : {})
});

const roles = (t: string) =>
	t === 'box' ? { island: true } : t === 'img' ? { void: true } : undefined;

/** Deterministic PRNG (mulberry32). */
const rng = (seed: number) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Oracle snapshot from the public projection (reachable blocks) and the maintained runs. */
const snapOf = (ed): DocSnap => {
	const nodes: DocSnap['nodes'] = new Map();
	const order: DocSnap['order'] = new Map();
	const byId = new Map();
	const walk = (parent, bs) => {
		if (bs.length > 0 || parent === null)
			order.set(
				parent,
				bs.map((b) => b.id)
			);
		bs.forEach((b, index) => {
			byId.set(b.id, b);
			nodes.set(b.id, { parent, index, type: b.type, data: b.data, contentRef: ed.runs(b.id) });
			walk(b.id, b.children);
		});
	};
	walk(null, ed.project().children);
	return { nodes, order, nodeFor: (id) => byId.get(id) };
};

/** Key-sorted object of `[key, value]` pairs (JSON comparison ignores map insertion order). */
const sorted = (entries: [string, unknown][]) =>
	Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Comparable form — ids and payloads, not identities or versions. */
const norm = (c) =>
	c === null
		? null
		: {
				local: c.local,
				added: sorted([...c.added].map(([id, b]) => [id, JSON.stringify(b)])),
				removed: [...c.removed].sort(),
				moved: [...c.moved].sort(),
				meta: sorted([...c.meta].map(([id, m]) => [id, JSON.stringify(m)])),
				content: sorted([...c.content].map(([id, r]) => [id, JSON.stringify(r)])),
				order: sorted(
					[...c.order]
						.filter(([, ids]) => ids.length > 0)
						.map(([parent, ids]) => [String(parent), [...ids]])
				)
			};

/**
 * Watch every commit on `doc`: the report `ed` publishes for it must equal
 * the oracle's diff of the snapshots around it. The watcher's `update`
 * listener registers after the facade's subscription, so it runs after the
 * report of the same commit was published.
 */
const watch = (ed, doc) => {
	let before = snapOf(ed);
	let got = [];
	const mismatches = [];
	let commits = 0;
	let reported = 0;
	const off = ed.onChange((c) => got.push(c));
	const onUpdate = (_u, origin, _d, tr) => {
		commits++;
		const after = snapOf(ed);
		const want = diffSnaps(before, after, origin, tr.local, 0);
		const published = got;
		got = [];
		reported += published.length;
		const a = norm(want);
		const b =
			published.length === 0
				? null
				: published.length === 1
					? norm(published[0])
					: published.map(norm);
		if (published.length > 1 || JSON.stringify(a) !== JSON.stringify(b)) {
			// Keep only the differing fields so a failure names what disagrees.
			const diff =
				a === null || b === null || Array.isArray(b)
					? { want: a, got: b }
					: Object.fromEntries(
							Object.keys(a)
								.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
								.map((k) => [k, { want: a[k], got: b[k] }])
						);
			mismatches.push({ commit: commits, ...diff });
		}
		before = after;
	};
	doc.on('update', onUpdate);
	return {
		mismatches,
		stats: () => ({ commits, reported }),
		stop: () => {
			off();
			doc.off('update', onUpdate);
		}
	};
};

// ── F-O7 — the change report equals the oracle on every commit ──────────────

describe('F-O7 — change report vs the diffSnaps oracle over the random corpus', () => {
	const assignments = [
		[7, 3],
		[3, 7],
		[100, 50]
	];
	for (const [seed, [mine, theirs]] of assignments.map((a, i) => [i + 1, a])) {
		// Red on the reference: its snapshot lists every children-index bucket,
		// including blocks under a hidden subtree, so a subtree that becomes
		// reachable again is not reported as added, and a block that arrives
		// under a hidden subtree makes the diff throw (no projection for it).
		red(`seed ${seed}, clients ${mine}/${theirs}`, () => {
			const rand = rng(seed * 97);
			const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
			const content = [
				p('a', 'alpha', [p('a1', 'one', [p('a2', 'two')])]),
				p('b', 'beta'),
				p('c', ''),
				p('box', 'isle', [p('in', 'side', undefined, 'line')], 'box'),
				p('d', 'delta', [p('d1', 'deep')])
			];
			const open = (clientID: number, bytes?: Uint8Array) => {
				const doc = new Y.Doc();
				doc.clientID = clientID;
				if (bytes) Y.applyUpdate(doc, bytes);
				const ed = E.create(doc, { actor: () => ({ id: `u${clientID}` }), roleOf: roles });
				if (!bytes) ed.init({ content });
				return { doc, ed };
			};
			let A = open(mine);
			const B = open(theirs, Y.encodeStateAsUpdate(A.doc));
			// Updates each side has not delivered to the other yet.
			let toB: Uint8Array[] = [];
			let toA: Uint8Array[] = [];
			const tapA = (u, origin) => origin !== 'remote' && toB.push(u);
			const tapB = (u, origin) => origin !== 'remote' && toA.push(u);
			A.doc.on('update', tapA);
			B.doc.on('update', tapB);
			let umA = A.ed.createUndoManager({ captureTimeout: 0 });
			let w = watch(A.ed, A.doc);

			let fresh = 0;
			const freshId = () => `n${seed}-${fresh++}`;
			const idsOf = (ed) => [...ed.listBlockIds(), 'ghost'];
			const opsFor = (ed) => {
				const id = () => pick(idsOf(ed));
				const off = () => Math.floor(rand() * 8) - 1;
				const len = () => Math.floor(rand() * 4);
				const dest = () => ({
					parent: rand() < 0.5 ? null : id(),
					index: Math.floor(rand() * 4)
				});
				const inlineIn = (b: string) =>
					(ed.hasBlock(b) ? ed.contentItems(b) : []).find((i) => i.kind === 'inline')?.id ??
					'no-atom';
				return [
					() => ed.insertBlock(dest(), { id: freshId(), type: 'paragraph' }),
					() => ed.insertBlocks(dest(), [p(freshId(), 'x', [p(freshId(), 'y')])]),
					() => ed.moveBlock(id(), dest()),
					() => ed.moveBlocks([id(), id()], dest()),
					() => ed.nestBlock(id(), id()),
					() => ed.unNestBlock(id()),
					() => ed.splitBlock(id(), off(), freshId()),
					() => ed.mergeBlocks(id(), id()),
					() => ed.mergeBackward(id()),
					() => ed.mergeForward(id()),
					() => ed.deleteBlock(id(), { keepChildren: rand() < 0.4 }),
					() => ed.setBlockType(id(), pick(['paragraph', 'heading', 'box'])),
					() => ed.setBlockData(id(), pick([{}, { level: 1 }])),
					() =>
						ed.setBlock(id(), {
							type: pick([undefined, 'heading']),
							content: rand() < 0.5 ? undefined : [{ kind: 'text', text: 'set' }],
							children: rand() < 0.7 ? undefined : [{ id: freshId(), type: 'paragraph' }]
						}),
					() => ed.duplicateBlock(id(), () => freshId()),
					() => ed.insertText(id(), off(), pick(['q', 'zz']), pick([undefined, { bold: true }])),
					() => ed.deleteText(id(), off(), len()),
					() => ed.setMark(id(), off(), len(), 'bold', true),
					() => ed.formatRange(id(), off(), len(), { italic: pick([true, null]) }),
					() => ed.insertInline(id(), off(), { id: freshId(), type: 'mention' }),
					() => {
						const b = id();
						return ed.removeInline(b, inlineIn(b));
					},
					() => {
						const b = id();
						return ed.setInlineData(b, inlineIn(b), pick([{}, { v: 1 }]));
					}
				];
			};
			const deliver = (queue: Uint8Array[], doc) => {
				if (queue.length === 0) return;
				const mode = pick(['each', 'dup', 'merged']);
				if (mode === 'merged') Y.applyUpdate(doc, Y.mergeUpdates(queue), 'remote');
				else
					for (const u of queue) {
						Y.applyUpdate(doc, u, 'remote');
						if (mode === 'dup') Y.applyUpdate(doc, u, 'remote');
					}
			};

			for (let step = 0; step < 400; step++) {
				const r = rand();
				if (r < 0.5) pick(opsFor(A.ed))();
				else if (r < 0.62) {
					// A batch: nested transactions, sometimes changed and reverted.
					A.ed.transact(() => {
						pick(opsFor(A.ed))();
						A.ed.transact(() => pick(opsFor(A.ed))());
						if (rand() < 0.5) pick(opsFor(A.ed))();
					});
				} else if (r < 0.68) {
					const b = pick(A.ed.listBlockIds());
					A.ed.transact(() => {
						A.ed.insertText(b, 0, 'tmp');
						A.ed.deleteText(b, 0, 3);
						const t = A.ed.blockTypeOf(b);
						A.ed.setBlockType(b, 'heading');
						A.ed.setBlockType(b, t);
					});
				} else if (r < 0.74) umA.undo();
				else if (r < 0.78) umA.redo();
				else if (r < 0.9) {
					for (let k = 0; k < 3; k++) pick(opsFor(B.ed))();
				} else if (r < 0.97) {
					// Deliver in a random direction first — both delivery orders.
					const [q1, q2] = [toA, toB];
					toA = [];
					toB = [];
					if (rand() < 0.5) {
						deliver(q1, A.doc);
						deliver(q2, B.doc);
					} else {
						deliver(q2, B.doc);
						deliver(q1, A.doc);
					}
				} else if (step > 100 && step < 110) {
					// Binary reload of A: a fresh document and facade, same watcher rules.
					expect(w.mismatches).toEqual([]);
					w.stop();
					A.doc.off('update', tapA);
					A = open(mine, Y.encodeStateAsUpdate(A.doc));
					A.doc.on('update', tapA);
					umA = A.ed.createUndoManager({ captureTimeout: 0 });
					w = watch(A.ed, A.doc);
				}
				if (A.ed.listBlockIds().length < 3)
					A.ed.insertBlocks({ parent: null, index: 0 }, [p(freshId(), 'refill')]);
			}
			// Converge and check the final delivery too.
			deliver(toA, A.doc);
			deliver(toB, B.doc);
			expect(w.mismatches).toEqual([]);
			expect(w.stats().commits).toBeGreaterThan(50);
			w.stop();
			expect(A.ed.toJSON()).toEqual(B.ed.toJSON());
		});
	}
});

// ── publication rules (§2.4 "Change report") ──────────────────────────────

describe('D9 — publication: nested once, change-then-revert nothing, every facade once', () => {
	const make = () => {
		const doc = new Y.Doc();
		doc.clientID = 11;
		const ed = E.create(doc);
		ed.init({ content: [p('a', 'alpha'), p('b', 'beta', [p('b1', 'kid')]), p('c', 'gamma')] });
		return { doc, ed };
	};

	test('nested transactions publish one report for the outer commit', () => {
		const { ed } = make();
		const seen = [];
		ed.onChange((c) => seen.push(c));
		ed.transact(() => {
			ed.insertText('a', 0, 'x');
			ed.transact(() => {
				ed.insertText('c', 0, 'y');
				ed.transact(() => ed.setBlockType('b', 'heading'));
			});
			ed.moveBlock('c', { parent: null, index: 0 });
		});
		expect(seen).toHaveLength(1);
		expect([...seen[0].content.keys()].sort()).toEqual(['a', 'c']);
		expect([...seen[0].meta.keys()]).toEqual(['b']);
		expect(seen[0].order.get(null)).toEqual(['c', 'a', 'b']);
	});

	test('change-then-revert inside one transaction publishes nothing', () => {
		const { ed } = make();
		const seen = [];
		ed.onChange((c) => seen.push(c));
		ed.transact(() => {
			ed.insertText('a', 2, 'zz');
			ed.deleteText('a', 2, 2);
			ed.setBlockType('b', 'heading');
			ed.setBlockType('b', 'paragraph');
			ed.moveBlock('a', { parent: null, index: 3 });
			ed.moveBlock('a', { parent: null, index: 0 });
		});
		expect(seen).toEqual([]);
	});

	test('every facade on one doc receives the commit once', () => {
		const { doc, ed } = make();
		const other = E.create(doc);
		const one = [];
		const two = [];
		ed.onChange((c) => one.push(c));
		other.onChange((c) => two.push(c));
		ed.insertText('a', 0, 'x');
		other.deleteBlock('b');
		expect(one.map(norm)).toEqual(two.map(norm));
		expect(one).toHaveLength(2);
		expect([...one[1].removed]).toEqual(['b']);
	});

	red(
		'a block that arrives under a deleted subtree takes its slot and is reported (visible = reachable, UW-08)',
		() => {
			const { doc, ed } = make();
			const peerDoc = new Y.Doc();
			peerDoc.clientID = 12;
			Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(doc));
			const peer = E.create(peerDoc);
			// Concurrently: A deletes `b` and its subtree; the peer adds a grandchild under `b1`.
			ed.deleteBlock('b', { keepChildren: false });
			peer.insertBlocks({ parent: 'b1', index: 0 }, [p('b2', 'grandkid')]);
			const w = watch(ed, doc);
			Y.applyUpdate(doc, Y.encodeStateAsUpdate(peerDoc), 'remote');
			expect(ed.project().children.map((b) => b.id)).toEqual(['a', 'b2', 'c']);
			// And an edit inside the promoted block publishes like any other.
			peer.insertText('b2', 0, 'x');
			Y.applyUpdate(doc, Y.encodeStateAsUpdate(peerDoc), 'remote');
			expect(ed.blockText('b2')).toBe('xgrandkid');
			expect(w.mismatches).toEqual([]);
			expect(w.stats().reported).toBe(2);
			w.stop();
		}
	);
});

// ── F-O9 — mid-transaction reads see every edit (the watermark) ────────────

describe('F-O9 — a read inside a transaction sees the edits before it', () => {
	const make = () => {
		const doc = new Y.Doc();
		doc.clientID = 21;
		const ed = E.create(doc);
		ed.init({ content: [p('a', 'abc'), p('b', 'xyz')] });
		return { doc, ed };
	};
	const reads = (ed, id) => ({
		text: ed.blockText(id),
		runs: ed
			.runs(id)
			.map((r) => r.text ?? `@${r.id}`)
			.join(''),
		items: ed
			.contentItems(id)
			.map((i) => i.text ?? `@${i.id}`)
			.join(''),
		length: ed.displayLength(id),
		projected: JSON.stringify(ed.project().children.find((b) => b.id === id)?.content)
	});

	test('insert → read → insert into the same text → read', () => {
		const { ed } = make();
		ed.transact(() => {
			ed.insertText('a', 3, 'd');
			expect(reads(ed, 'a').text).toBe('abcd');
			ed.insertText('a', 4, 'e');
			const r = reads(ed, 'a');
			expect(r.text).toBe('abcde');
			expect(r.runs).toBe('abcde');
			expect(r.items).toBe('abcde');
			expect(r.length).toBe(5);
			expect(r.projected).toContain('abcde');
		});
		expect(ed.blockText('a')).toBe('abcde');
	});

	test('delete → read → delete → read', () => {
		const { ed } = make();
		ed.transact(() => {
			ed.deleteText('b', 0, 1);
			expect(reads(ed, 'b').text).toBe('yz');
			ed.deleteText('b', 0, 1);
			const r = reads(ed, 'b');
			expect(r).toEqual({
				text: 'z',
				runs: 'z',
				items: 'z',
				length: 1,
				projected: r.projected
			});
			expect(r.projected).toContain('"z"');
		});
	});

	test('a raw engine write inside the transaction is seen by the next read', () => {
		const { doc, ed } = make();
		ed.transact(() => {
			ed.insertText('a', 0, '1');
			expect(ed.blockText('a')).toBe('1abc');
			// The same backing text, written below every facade funnel.
			const content = ed.model.blockNodeOf(doc, 'a').getAttr('content');
			content.insert(content.length, '2');
			expect(ed.blockText('a')).toBe('1abc2');
			expect(
				ed
					.runs('a')
					.map((r) => r.text)
					.join('')
			).toBe('1abc2');
		});
	});

	test('structure: insert a block → read order → insert under it → read order', () => {
		const { ed } = make();
		ed.transact(() => {
			ed.insertBlock({ parent: null, index: 1 }, p('m', 'mid'));
			expect(ed.listBlockIds()).toEqual(['a', 'm', 'b']);
			ed.insertBlock({ parent: 'm', index: 0 }, p('m1', 'kid'));
			expect(ed.listBlockIds()).toEqual(['a', 'm', 'm1', 'b']);
			ed.deleteBlock('m', { keepChildren: false });
			expect(ed.listBlockIds()).toEqual(['a', 'b']);
		});
	});
});

// ── F-O5 (linearity half) — batching into one transaction stays linear ─────

describe('F-O5 — one transaction of N inserts folds about what N separate transactions fold', () => {
	/**
	 * The index's fold work for `n` block inserts (CC-05: an operation count,
	 * not a wall clock; the timings are `bench:crdt`'s `scale` workload): the
	 * changed pairs every fold located, and the structs the reads inside a
	 * transaction folded.
	 */
	const run = (n: number, oneTx: boolean) => {
		const doc = new Y.Doc();
		doc.clientID = 31;
		const ed = E.create(doc);
		ed.init({ content: [p('r0', 'x')] });
		const { debug } = ed.runsView;
		debug.reset();
		const body = () => {
			for (let i = 0; i < n; i++)
				ed.insertBlock({ parent: null, index: i + 1 }, p(`b${i}`, 'hello'));
		};
		if (oneTx) ed.transact(body);
		else body();
		expect(ed.listBlockIds()).toHaveLength(n + 1);
		return { pairs: debug.foldedPairs, structs: debug.foldedStructs };
	};

	red('1,000 inserts: one transaction folds ≤ 2.5 × what separate transactions fold', () => {
		const separate = run(1000, false);
		const batched = run(1000, true);
		expect(separate.pairs).toBeGreaterThan(0);
		expect(batched.pairs).toBeLessThanOrEqual(2.5 * separate.pairs);
	});

	red('one transaction: ten times the inserts, at most eleven times the fold work', () => {
		// Probe C10: every read re-folded the whole accumulated transaction, so
		// ten times the inserts cost a hundred times the work.
		const small = run(100, true);
		const large = run(1000, true);
		expect(small.structs).toBeGreaterThan(0);
		expect(large.pairs).toBeLessThanOrEqual(11 * small.pairs);
		expect(large.structs).toBeLessThanOrEqual(11 * small.structs);
	});
});
