/**
 * The F-O11 oracle (arch-v2 D5, shared with D6): prepare an op, prove it
 * wrote nothing, apply the plan and compare its effect summary with what
 * changed — observed test-side from the document before and after, never
 * from the op's result or its plan.
 */
// @ts-nocheck -- tests drive the vendored engine JS directly (excluded lane).
import { expect } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { readData } from '../../../lib/crdt/data.js';

export const svEqual = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((x, i) => x === b[i]);

/** Run `fn`; report whether anything left the document. */
export const observe = (doc: Y.Doc, fn: () => unknown) => {
	const sv0 = Y.encodeStateVector(doc);
	const bytes0 = Y.encodeStateAsUpdate(doc);
	let updates = 0;
	const count = () => updates++;
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
		untouched: svEqual(sv0, Y.encodeStateVector(doc)) && svEqual(bytes0, Y.encodeStateAsUpdate(doc))
	};
};

export const isPlan = (x: unknown) =>
	x !== null && typeof x === 'object' && 'writes' in (x as object);

/** Per-block facts read from the document (test-side; independent of the op). */
export const facts = (ed, doc) => {
	const v = ed.model.view(doc);
	const out = new Map();
	for (const [id, rec] of v.blocks) {
		const live = ed.isVisibleBlock(id);
		const len = live ? ed.displayLength(id) : 0;
		const atoms = [];
		for (let k = 0; k < len; k++) {
			const a = ed.anchorAt(id, k, 'right');
			atoms.push(a ? [a.b, a.a.i?.c, a.a.i?.k] : null);
		}
		out.set(id, {
			live,
			owner: v.own.ownerOf(id),
			meta: JSON.stringify([rec.node.getAttr('type'), readData(rec.node) ?? null]),
			at: JSON.stringify(ed.model.candidatesOf(rec.node).map((c) => c.key)),
			text: live ? JSON.stringify([ed.contentItems(id), atoms]) : null
		});
	}
	return out;
};

/** What changed between two fact snapshots, in the effect summary's vocabulary. */
export const touched = (before: Map, after: Map) => {
	const t = { creates: [], removes: [], merges: [], moves: [], meta: [], text: [] };
	for (const [id, a] of after) {
		const b = before.get(id);
		if (b === undefined) {
			t.creates.push(id);
			continue;
		}
		const mergedInto =
			b.live && b.owner === id && typeof a.owner === 'string' && a.owner !== id ? a.owner : null;
		if (mergedInto !== null) t.merges.push(`${id}>${mergedInto}`);
		else if (b.live && !a.live) t.removes.push(id);
		if (b.at !== a.at) t.moves.push(id);
		if (b.meta !== a.meta) t.meta.push(id);
		if (b.live && a.live && b.text !== a.text) t.text.push(id);
	}
	return t;
};

export const set = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** The effect summary in the same vocabulary. */
export const predicted = (effect) => ({
	creates: set(effect.creates),
	removes: set(effect.removes),
	merges: set(effect.merges.map(([from, into]) => `${from}>${into}`)),
	moves: set(effect.moves),
	meta: set(effect.meta),
	text: set(effect.textRanges.map((r) => r.block))
});

/** Prepare (must write nothing), apply, and compare the effect with what changed. */
export const prepareApply = (ed, doc, name: string, prepare: () => unknown, label = name) => {
	const prepared = observe(doc, prepare);
	expect(prepared.updates, `${label}: prepare writes nothing`).toBe(0);
	expect(prepared.untouched, `${label}: prepare leaves zero bytes, no state-vector advance`).toBe(
		true
	);
	const plan = prepared.result as { status?: string };
	if (!isPlan(plan)) {
		expect(plan.status, `${label}: not a plan ⇒ refused`).toBe('refused');
		const refusedApply = observe(doc, () => ed.apply(plan));
		expect(refusedApply.result.status).toBe('refused');
		expect(refusedApply.untouched, `${label}: a refusal writes nothing`).toBe(true);
		return { status: 'refused' };
	}
	for (const w of plan.writes) expect(typeof w.op, `${label}: named step`).toBe('string');
	const before = facts(ed, doc);
	const applied = observe(doc, () => ed.apply(plan));
	const after = facts(ed, doc);
	const r = applied.result as { status: string; ids: string[] };
	const want = predicted(plan.effect);
	const got = touched(before, after);
	expect(
		{ creates: set(got.creates), removes: set(got.removes), merges: set(got.merges) },
		`${label}: structure`
	).toEqual({ creates: want.creates, removes: want.removes, merges: want.merges });
	expect({ moves: set(got.moves), meta: set(got.meta) }, `${label}: placements and meta`).toEqual({
		moves: want.moves,
		meta: want.meta
	});
	expect(set(got.text), `${label}: text`).toEqual(want.text);
	const empty = Object.values(want).every((xs) => xs.length === 0);
	expect(r.status, `${label}: effect empty ⇔ noop`).toBe(empty ? 'noop' : 'applied');
	if (r.status === 'applied') expect(r.ids, `${label}: ids`).toEqual(plan.ids);
	return r;
};

/** Deterministic PRNG (mulberry32). */
export const rng = (seed: number) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
