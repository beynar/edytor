/**
 * arch-v2 — checkpoint D4 rows: operation results `refused | noop | applied`
 * read from the transaction's effects, one result shape for every op,
 * all-or-nothing `setBlock`, one ingress normalization for writes and
 * lookups, `moveBlocks` returns the moved ids (rule R6, §2.4 "Op result",
 * O1, O10; decision D-12).
 *
 * Rows (doc lane):
 * - F-D5 — `moveBlocks([], dest)`, `insertBlocks(dest, [])`, `insertText('')`,
 *   an empty delete and an empty format: all `noop`, one result shape; no
 *   stamp, no undo step, no state-vector advance. Red on the reference
 *   (crdt C8: `moveBlocks([])` → `false`, `insertBlocks([])` → `true`).
 * - F-D6 — `b > [c1]`; `setBlock(b, {children: [{id:'c1'}, {id:'c2'}]})`
 *   is refused (`id-collision`) with zero bytes and `c1` intact; the retry
 *   with fresh ids is applied (D-12: refuse, all-or-nothing). Red on the
 *   reference (C4: returns `true`, `c1` gone).
 * - F-D7 — `insertBlock({id: 'x\uD800'})`, then `insertText` by the same
 *   string and by the returned id: both resolve to the stored block. Red on
 *   the reference (C11: every later reference by the raw string is refused).
 * - F-O4 — every op over a randomized corpus: the result is one of
 *   `refused | noop | applied`; `applied` ⇒ a non-empty touched set (the
 *   transaction wrote something: an update left the document); `noop` and
 *   `refused` ⇒ no state-vector advance and no update. The touched set is
 *   observed test-side from the engine's own update event, never from the
 *   op's result.
 *
 * Expected values come from the plan rows and the contracts they cite, never
 * from running the code.
 */
// @ts-nocheck -- tests drive the vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);

const STATUSES = ['refused', 'noop', 'applied'];

const p = (id: string, text: string, children?: unknown[]) => ({
	id,
	type: 'paragraph',
	content: [{ kind: 'text', text }],
	...(children ? { children } : {})
});

/** A facade with an actor and a lineage ring (so a stamp would be visible) plus its undo manager. */
const make = (content: unknown[], clientID = 7) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	const ed = E.create(doc, { actor: () => ({ id: 'alice' }), lineageDepth: 3 });
	ed.init({ content });
	const um = ed.createUndoManager({ captureTimeout: 0 });
	return { doc, ed, um };
};

const svEqual = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((x, i) => x === b[i]);

/** Run `fn` and report what left the document: update count and state-vector advance. */
const observe = (doc: Y.Doc, fn: () => unknown) => {
	const sv0 = Y.encodeStateVector(doc);
	const bytes0 = Y.encodeStateAsUpdate(doc);
	let updates = 0;
	const count = () => {
		updates++;
	};
	doc.on('update', count);
	let result: unknown;
	try {
		result = fn();
	} finally {
		doc.off('update', count);
	}
	return {
		result,
		updates,
		advanced: !svEqual(sv0, Y.encodeStateVector(doc)),
		sameBytes: svEqual(bytes0, Y.encodeStateAsUpdate(doc))
	};
};

/** The result shape every op returns. */
const expectShape = (r: unknown) => {
	expect(r).toBeTypeOf('object');
	expect(STATUSES).toContain((r as { status: string }).status);
	expect(Array.isArray((r as { ids: unknown }).ids)).toBe(true);
};

// ── F-D5 — empty collections ──────────────────────────────────────────────

describe('F-D5 — empty inputs are noop, one result shape, nothing leaves the document', () => {
	const EMPTY: [string, (ed) => unknown][] = [
		['moveBlocks([], dest)', (ed) => ed.moveBlocks([], { parent: null, index: 0 })],
		['insertBlocks(dest, [])', (ed) => ed.insertBlocks({ parent: null, index: 0 }, [])],
		["insertText('')", (ed) => ed.insertText('a', 1, '')],
		['empty delete', (ed) => ed.deleteText('a', 1, 0)],
		['empty format', (ed) => ed.formatRange('a', 1, 0, { bold: true })],
		['empty setMark', (ed) => ed.setMark('a', 1, 0, 'bold', true)],
		['handle: empty delete', (ed) => ed.block('a').deleteText(1, 0)],
		["handle: insertText('')", (ed) => ed.block('a').insertText(0, '')]
	];

	for (const [name, run] of EMPTY) {
		test(`${name} → noop; no stamp, no undo step, no state-vector advance`, () => {
			const { doc, ed, um } = make([p('a', 'aa'), p('b', 'bb')]);
			// A prior applied edit gives a reference result shape and an
			// attribution record to compare against.
			const applied = ed.insertText('a', 2, 'x');
			expectShape(applied);
			expect(applied.status).toBe('applied');
			um.stopCapturing();
			const undoDepth = um.undoStack.length;
			const attribution = ed.blockAttribution('a');
			const l = ed.model.blockNodeOf(doc, 'a').getAttr('l');

			const seen = observe(doc, () => run(ed));
			expectShape(seen.result);
			expect(seen.result.status).toBe('noop');
			expect(Object.keys(seen.result).sort()).toEqual(Object.keys(applied).sort());
			expect(seen.updates, 'no update').toBe(0);
			expect(seen.advanced, 'no state-vector advance').toBe(false);
			expect(seen.sameBytes, 'zero bytes').toBe(true);
			expect(um.undoStack.length, 'no undo step').toBe(undoDepth);
			expect(ed.blockAttribution('a'), 'no stamp').toEqual(attribution);
			expect(ed.model.blockNodeOf(doc, 'a').getAttr('l')).toBe(l);
			expect(ed.toJSON().children.map((b) => b.id)).toEqual(['a', 'b']);
		});
	}

	test('empty inputs agree with each other: moveBlocks([]) and insertBlocks([]) give the same status', () => {
		const { ed } = make([p('a', 'aa')]);
		const move = ed.moveBlocks([], { parent: null, index: 0 });
		const insert = ed.insertBlocks({ parent: null, index: 0 }, []);
		expect(move.status).toBe(insert.status);
		expect(move).toEqual(insert);
	});
});

// ── F-D6 — failure midway, retry (D-12) ───────────────────────────────────

describe('F-D6 — setBlock with a reused child id refuses before any write; the retry applies', () => {
	const seed = () => make([p('b', 'bb', [p('c1', 'one')]), p('z', 'zz')]);

	for (const via of ['facade', 'handle'] as const) {
		const set = (ed, value) =>
			via === 'facade' ? ed.setBlock('b', value) : ed.block('b').set(value);

		test(`reused child id → refused (id-collision), zero bytes, c1 intact; fresh ids → applied (${via})`, () => {
			const { doc, ed, um } = seed();
			um.stopCapturing();
			const undoDepth = um.undoStack.length;
			const first = observe(doc, () =>
				set(ed, {
					children: [
						{ id: 'c1', type: 'paragraph' },
						{ id: 'c2', type: 'paragraph' }
					]
				})
			);
			expectShape(first.result);
			expect(first.result.status).toBe('refused');
			expect(first.result.reason).toBe('id-collision');
			expect(first.updates).toBe(0);
			expect(first.sameBytes, 'zero bytes').toBe(true);
			expect(um.undoStack.length).toBe(undoDepth);
			expect(ed.childrenIds('b')).toEqual(['c1']);
			expect(ed.blockText('c1')).toBe('one');
			expect(ed.isVisibleBlock('c1')).toBe(true);
			expect(ed.hasBlock('c2')).toBe(false);

			const retry = set(ed, {
				children: [
					{ id: 'c3', type: 'paragraph' },
					{ id: 'c4', type: 'paragraph' }
				]
			});
			expect(retry.status).toBe('applied');
			expect(ed.childrenIds('b')).toEqual(['c3', 'c4']);
			expect(ed.isVisibleBlock('c1')).toBe(false);
		});

		test(`the refusal is all-or-nothing: type, data and content are not written either (${via})`, () => {
			const { doc, ed } = seed();
			const seen = observe(doc, () =>
				set(ed, {
					type: 'heading',
					data: { level: 1 },
					content: [{ kind: 'text', text: 'new' }],
					children: [{ id: 'c1', type: 'paragraph' }]
				})
			);
			expect(seen.result.status).toBe('refused');
			expect(seen.result.reason).toBe('id-collision');
			expect(seen.sameBytes).toBe(true);
			expect(ed.blockTypeOf('b')).toBe('paragraph');
			expect(ed.blockDataOf('b') ?? {}).toEqual({});
			expect(ed.blockText('b')).toBe('bb');
			expect(ed.childrenIds('b')).toEqual(['c1']);
		});

		test(`duplicate ids inside the replacement and the block's own id also collide (${via})`, () => {
			const { doc, ed } = seed();
			for (const children of [
				[
					{ id: 'n1', type: 'paragraph' },
					{ id: 'n1', type: 'paragraph' }
				],
				[{ id: 'b', type: 'paragraph' }],
				[{ id: 'n2', type: 'paragraph', children: [{ id: 'z', type: 'paragraph' }] }]
			]) {
				const seen = observe(doc, () => set(ed, { children }));
				expect(seen.result.status).toBe('refused');
				expect(seen.result.reason).toBe('id-collision');
				expect(seen.sameBytes).toBe(true);
			}
			expect(ed.childrenIds('b')).toEqual(['c1']);
		});
	}
});

// ── F-D7 — a generated value after a boundary ─────────────────────────────

describe('F-D7 — one ingress normalization for writes and lookups', () => {
	test("insertBlock({id: 'x\\uD800'}); insertText by the same string and by the returned id both resolve", () => {
		const { ed } = make([p('a', 'aa')]);
		const inserted = ed.insertBlock(
			{ parent: null, index: 1 },
			{ id: 'x\uD800', type: 'paragraph' }
		);
		expect(inserted.status).toBe('applied');
		expect(inserted.ids).toEqual(['x�']);
		const stored = inserted.ids[0];

		expect(ed.insertText('x\uD800', 0, 'a').status, 'by the same string').toBe('applied');
		expect(ed.insertText(stored, 1, 'b').status, 'by the returned id').toBe('applied');
		expect(ed.blockText('x\uD800')).toBe('ab');
		expect(ed.blockText(stored)).toBe('ab');
		expect(ed.hasBlock('x\uD800')).toBe(true);
		expect(ed.isVisibleBlock('x\uD800')).toBe(true);
		expect(ed.listBlockIds()).toEqual(['a', stored]);
	});

	test('the typed handle resolves the same string to the stored block', () => {
		const { ed } = make([p('a', 'aa')]);
		const stored = ed.insertBlock({ parent: null, index: 1 }, { id: 'x\uD800', type: 'paragraph' })
			.ids[0];
		const handle = ed.block('x\uD800');
		expect(handle.id).toBe(stored);
		expect(handle.insertText(0, 'ab').status).toBe('applied');
		expect(ed.block(stored).length).toBe(2);
	});

	test('a split-born id and a move target are normalized the same way', () => {
		const { ed } = make([p('a', 'abcd'), p('b', 'bb')]);
		const split = ed.splitBlock('a', 2, 's\uDC00');
		expect(split.status).toBe('applied');
		expect(split.ids).toEqual(['s�']);
		expect(ed.blockText('s\uDC00')).toBe('cd');
		expect(ed.moveBlock('s\uDC00', { parent: null, index: 0 }).status).toBe('applied');
		expect(ed.nestBlock('b', 's\uDC00').status).toBe('applied');
		expect(ed.childrenIds('s\uDC00')).toEqual(['b']);
		expect(ed.deleteBlock('s\uDC00').status).toBe('applied');
		expect(ed.listBlockIds()).toEqual(['a']);
	});
});

// ── moveBlocks returns the moved ids ──────────────────────────────────────

describe('moveBlocks returns the moved ids', () => {
	test('the result lists the moved blocks in request order', () => {
		const { ed } = make([p('a', 'a'), p('b', 'b'), p('c', 'c'), p('d', 'd')]);
		const r = ed.moveBlocks(['c', 'a'], { parent: null, index: 2 });
		expect(r.status).toBe('applied');
		expect(r.ids).toEqual(['c', 'a']);
		expect(ed.listBlockIds()).toEqual(['b', 'd', 'c', 'a']);
	});

	test('a refused move lists nothing', () => {
		const { ed } = make([p('a', 'a', [p('a1', 'a1')])]);
		const r = ed.moveBlocks(['a'], { parent: 'a1', index: 0 });
		expect(r.status).toBe('refused');
		expect(r.ids).toEqual([]);
	});
});

// ── F-O4 — every op over a randomized corpus ──────────────────────────────

/** Deterministic PRNG (mulberry32). */
const rng = (seed: number) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('F-O4 — every op over a randomized corpus has one of three results, observed from its effects', () => {
	for (const seed of [1, 2, 3]) {
		test(`seed ${seed}: applied ⇒ something was written; noop and refused ⇒ nothing left the document`, () => {
			const rand = rng(seed);
			const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
			const { doc, ed } = make(
				[p('a', 'alpha', [p('a1', 'one')]), p('b', 'beta'), p('c', ''), p('d', 'delta')],
				seed + 40
			);
			let fresh = 0;
			const freshId = () => `n${seed}-${fresh++}`;
			const ids = () => [
				...ed.listBlockIds(),
				'ghost',
				'x\uD800',
				pick(ed.listBlockIds().concat(['a']))
			];
			const id = () => pick(ids());
			const off = () => Math.floor(rand() * 8) - 1;
			const len = () => Math.floor(rand() * 4);
			const dest = () => ({ parent: rand() < 0.5 ? null : id(), index: Math.floor(rand() * 4) });
			const inlineIn = (b: string) =>
				(ed.hasBlock(b) ? ed.contentItems(b) : []).find((i) => i.kind === 'inline')?.id ??
				'no-atom';

			const OPS: [string, () => unknown][] = [
				[
					'insertBlock',
					() => ed.insertBlock(dest(), { id: rand() < 0.2 ? id() : freshId(), type: 'paragraph' })
				],
				['insertBlocks', () => ed.insertBlocks(dest(), rand() < 0.3 ? [] : [p(freshId(), 'x')])],
				['moveBlock', () => ed.moveBlock(id(), dest())],
				['moveBlocks', () => ed.moveBlocks(rand() < 0.2 ? [] : [id(), id()], dest())],
				['nestBlock', () => ed.nestBlock(id(), id())],
				['unNestBlock', () => ed.unNestBlock(id())],
				['splitBlock', () => ed.splitBlock(id(), off(), rand() < 0.2 ? id() : freshId())],
				['mergeBlocks', () => ed.mergeBlocks(id(), id())],
				['mergeBackward', () => ed.mergeBackward(id())],
				['mergeForward', () => ed.mergeForward(id())],
				['deleteBlock', () => ed.deleteBlock(id(), { keepChildren: rand() < 0.3 })],
				['setBlockType', () => ed.setBlockType(id(), pick(['paragraph', 'heading']))],
				['setBlockData', () => ed.setBlockData(id(), pick([{}, { level: 1 }]))],
				[
					'setBlock',
					() =>
						ed.setBlock(id(), {
							type: pick([undefined, 'paragraph', 'heading']),
							content: rand() < 0.5 ? undefined : [{ kind: 'text', text: pick(['', 'set']) }],
							children:
								rand() < 0.7
									? undefined
									: [{ id: rand() < 0.3 ? id() : freshId(), type: 'paragraph' }]
						})
				],
				['duplicateBlock', () => ed.duplicateBlock(id(), () => freshId())],
				['insertText', () => ed.insertText(id(), off(), pick(['', 'q', 'zz']))],
				['deleteText', () => ed.deleteText(id(), off(), len())],
				['setMark', () => ed.setMark(id(), off(), len(), 'bold', true)],
				['unsetMark', () => ed.unsetMark(id(), off(), len(), 'bold')],
				['formatRange', () => ed.formatRange(id(), off(), len(), { italic: pick([true, null]) })],
				['clearMarks', () => ed.clearMarks(id(), off(), len())],
				['insertInline', () => ed.insertInline(id(), off(), { id: freshId(), type: 'mention' })],
				[
					'removeInline',
					() => {
						const b = id();
						return ed.removeInline(b, inlineIn(b));
					}
				],
				[
					'setInlineData',
					() => {
						const b = id();
						return ed.setInlineData(b, inlineIn(b), pick([{}, { v: 1 }]));
					}
				],
				['handle.insertText', () => ed.block(id()).insertText(off(), pick(['', 'h']))],
				['handle.deleteText', () => ed.block(id()).deleteText(off(), len())],
				['handle.split', () => ed.block(id()).split(off(), freshId())],
				['handle.moveTo', () => ed.block(id()).moveTo(dest())],
				['handle.delete', () => ed.block(id()).delete()],
				['handle.setType', () => ed.block(id()).setType(pick(['paragraph', 'heading']))]
			];

			const seen = { refused: 0, noop: 0, applied: 0 };
			for (let step = 0; step < 300; step++) {
				const [name, run] = pick(OPS);
				const o = observe(doc, run);
				const r = o.result as { status: string; ids: string[] };
				expectShape(r);
				seen[r.status]++;
				if (r.status === 'applied') {
					expect(o.updates, `${step} ${name}: applied ⇒ written`).toBeGreaterThan(0);
					expect(r.ids.length, `${step} ${name}: applied ⇒ ids`).toBeGreaterThan(0);
					for (const touched of r.ids)
						expect(ed.hasBlock(touched), `${step} ${name}: ${touched}`).toBe(true);
				} else {
					expect(o.updates, `${step} ${name}: ${r.status} ⇒ no update`).toBe(0);
					expect(o.advanced, `${step} ${name}: ${r.status} ⇒ no state-vector advance`).toBe(false);
					expect(r.ids, `${step} ${name}: ${r.status} ⇒ no ids`).toEqual([]);
				}
				if (ed.listBlockIds().length < 2)
					ed.insertBlocks({ parent: null, index: 0 }, [p(freshId(), 'refill')]);
			}
			// The corpus exercises all three outcomes.
			expect(seen.refused).toBeGreaterThan(0);
			expect(seen.noop).toBeGreaterThan(0);
			expect(seen.applied).toBeGreaterThan(0);
		});
	}
});
