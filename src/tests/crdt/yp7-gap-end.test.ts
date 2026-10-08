/**
 * Fork feature YP7 — `YNode#insertAtGapEnd(index, content)` (arch-v2 D11, plan
 * §2.1 Split, R2, UPSTREAM.md YP7).
 *
 * Contract (plan §4.1 "fork YP7"): the insert walk passes every deleted item and
 * every format item before the next live content item, then inserts with the
 * formats in effect there, adding no format item.
 *
 * Differential oracle (the YP4 method, `marker-seed.test.ts` / `r1-p4-format`):
 * the pre-P7 engine is materialized from the vendored tree with the YP7 hunks
 * stripped; identical op programs over every existing public write path
 * (insert with and without formats, delete, format, multi-op deltas, inline
 * nodes, undo/redo, remote apply) must produce byte-identical stores and
 * identical renders after EVERY operation. YP7 adds a path; it must change none.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';

/** Red on the reference (no YP7): `it.fails` in the tests-first commit. */
const row = it;

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(here, '../../lib/crdt/vendor/yjs/src');

/** Live/deleted item walk: `[state, kind, payload]` per struct. */
const items = (t) => {
	const out = [];
	for (let it = t._start; it !== null; it = it.right) {
		const c = it.content;
		const kind = c.constructor.name;
		const payload =
			kind === 'ContentFormat'
				? `${c.key}=${JSON.stringify(c.value)}`
				: (c.str ?? JSON.stringify(c.arr ?? null));
		out.push({ live: !it.deleted, kind, payload, item: it });
	}
	return out;
};
const formatCount = (t) => items(t).filter((i) => i.kind === 'ContentFormat').length;
const B = { s: 'u', n: 1 };

const mkDoc = (client) => {
	const doc = new Y.Doc();
	doc.clientID = client;
	return doc;
};
const sync = (a, b) => {
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
	Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
};

describe('YP7 insertAtGapEnd — semantics', () => {
	row(
		'passes every tombstone and format item in the gap, stops before the next live content',
		() => {
			const doc = mkDoc(1);
			const t = doc.get('t');
			t.insert(0, 'hello world tail');
			t.format(6, 5, { b: true }); // [b:true]world[b:null]
			t.delete(6, 5); // tombstones between ' ' and ' tail'
			const before = items(t);
			const clock = doc.store.getClock(1);
			t.insertAtGapEnd(6, [B]);
			const after = items(t);
			const k = after.findIndex((i) => i.kind === 'ContentAny');
			// everything between the last live content left of the gap and the
			// boundary is a tombstone or a format item; the right neighbour is live content
			for (let j = k - 1; j >= 0 && after[j].payload !== 'hello '; j--) {
				expect(!after[j].live || after[j].kind === 'ContentFormat').toBe(true);
			}
			expect(after[k + 1].live && after[k + 1].kind !== 'ContentFormat').toBe(true);
			expect(after[k + 1].payload).toBe(' tail');
			// exactly one new struct of one unit, no format item added
			expect(after.length).toBe(before.length + 1);
			expect(doc.store.getClock(1)).toBe(clock + 1);
		}
	);

	row(
		'passes two live same-key format items with different values (the F1 gap) and takes the fold',
		() => {
			// Two formatters leave `[b:true] … [b:null][b:'x'] …` style items in one
			// gap once the text between them is deleted.
			// (the delete must not see the formats, or its cleanup removes them).
			const a = mkDoc(10);
			const b = mkDoc(20);
			const c = mkDoc(30);
			a.get('t').insert(0, 'hello world tail');
			sync(a, b);
			sync(a, c);
			a.get('t').delete(6, 5);
			b.get('t').format(6, 2, { b: true }); // 'wo'
			c.get('t').format(8, 3, { b: 'x' }); // 'rld'
			sync(a, b);
			sync(a, c);
			sync(a, b);
			const t = a.get('t');
			const liveFormats = items(t).filter((i) => i.live && i.kind === 'ContentFormat');
			expect(liveFormats.length).toBeGreaterThanOrEqual(2);
			const nFormats = formatCount(t);
			// The public insert with {} stops before the first live format item whose
			// value differs — inside the gap (the F1 counterexample).
			const probe = mkDoc(40);
			Y.applyUpdate(probe, Y.encodeStateAsUpdate(a));
			probe.get('t').insert(6, [B], {});
			const pub = items(probe.get('t'));
			const pk = pub.findIndex((i) => i.kind === 'ContentAny');
			expect(pub.slice(pk + 1).some((i) => i.live && i.kind === 'ContentFormat')).toBe(true);
			// YP7 lands after all of them, with the formats the fold gives there.
			t.insertAtGapEnd(6, [B]);
			const after = items(t);
			const k = after.findIndex((i) => i.kind === 'ContentAny');
			expect(after[k + 1].live && after[k + 1].payload).toBe(' tail');
			expect(formatCount(t)).toBe(nFormats);
			let fold = {};
			for (const i of after.slice(0, k)) {
				if (!i.live || i.kind !== 'ContentFormat') continue;
				const c = i.item.content;
				fold = { ...fold };
				if (c.value == null) delete fold[c.key];
				else fold[c.key] = c.value;
			}
			const ops = t.toDelta().toJSON().children;
			const op = ops.find((o) => Array.isArray(o.insert));
			expect(op.format ?? {}).toEqual(fold);
		}
	);

	row(
		'splits a live item mid-way when the gap is empty; index 0 and the end work; past the end throws',
		() => {
			const doc = mkDoc(1);
			const t = doc.get('t');
			t.insert(0, 'abcdef', { i: true });
			t.insertAtGapEnd(3, [B]);
			expect(t.toDelta().toJSON().children).toEqual([
				{ type: 'insert', insert: 'abc', format: { i: true } },
				{ type: 'insert', insert: [B], format: { i: true } },
				{ type: 'insert', insert: 'def', format: { i: true } }
			]);
			t.insertAtGapEnd(0, [{ s: 'v', n: 2 }]);
			// index 0 sits after the opening format item (the end of the gap)
			expect(t.toDelta().toJSON().children[0]).toEqual({
				type: 'insert',
				insert: [{ s: 'v', n: 2 }],
				format: { i: true }
			});
			t.insertAtGapEnd(t.length, [{ s: 'w', n: 3 }]);
			// the closing format item precedes the end of the gap → unformatted
			expect(t.toDelta().toJSON().children.at(-1)).toEqual({
				type: 'insert',
				insert: [{ s: 'w', n: 3 }]
			});
			expect(() => t.insertAtGapEnd(t.length + 1, [B])).toThrow();
		}
	);

	row(
		'replicates like any insert: concurrent gap-end inserts converge on every client order',
		() => {
			for (const [ca, cb] of [
				[7, 3],
				[3, 7],
				[100, 50]
			]) {
				const a = mkDoc(ca);
				const b = mkDoc(cb);
				a.get('t').insert(0, 'hello world');
				a.get('t').delete(3, 3);
				sync(a, b);
				a.get('t').insertAtGapEnd(3, [{ s: 'x', n: 1 }]);
				b.get('t').insertAtGapEnd(3, [{ s: 'y', n: 1 }]);
				sync(a, b);
				expect(a.get('t').toDelta().toJSON()).toEqual(b.get('t').toDelta().toJSON());
				expect(Y.encodeStateVector(a)).toEqual(Y.encodeStateVector(b));
				// both boundaries sit after the tombstones, before 'lo… '→' world' content
				expect(
					items(a.get('t'))
						.filter((i) => i.live)
						.map((i) => i.payload)
				).toEqual(
					items(b.get('t'))
						.filter((i) => i.live)
						.map((i) => i.payload)
				);
			}
		}
	);
});

// ── the differential oracle ────────────────────────────────────────────

/** The vendored tree with the YP7 hunks stripped = the pre-P7 engine. */
const materializeBaseline = () => {
	const root = join(here, '../../../node_modules/.cache/edytor-p7-baseline');
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	cpSync(VENDOR, join(root, 'src'), { recursive: true });
	const src = readFileSync(join(VENDOR, 'ynode.js'), 'utf8');
	const stripped = src.replace(/[ \t]*\/\/ YP7 begin[\s\S]*?\/\/ YP7 end\n\n?/g, '');
	writeFileSync(join(root, 'src/ynode.js'), stripped);
	return { index: join(root, 'src/index.js'), stripped, src };
};

/** Deterministic PRNG (mulberry32). */
const rng = (seed) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** One random program over every public write path, replayed on engine `E`. */
const program = (E, seed, steps) => {
	const r = rng(seed);
	const mk = (client) => {
		const doc = new E.Doc({ gc: r() < 0.5 });
		doc.clientID = client;
		return doc;
	};
	const a = mk(4242);
	const b = mk(4343);
	const um = new E.UndoManager(a.get('t'), { captureTimeout: 0 });
	const snaps = [];
	const marks = [{ b: true }, { b: 'x' }, { b: null }, { i: true }, {}];
	for (let s = 0; s < steps; s++) {
		const doc = r() < 0.7 ? a : b;
		const t = doc.get('t');
		const len = t.length;
		const k = Math.floor(r() * 9);
		const at = Math.floor(r() * (len + 1));
		const n = Math.min(len - at, 1 + Math.floor(r() * 4));
		if (k === 0 || len === 0) t.insert(at, 'xyzw'.slice(0, 1 + Math.floor(r() * 4)));
		else if (k === 1) t.insert(at, 'ab', marks[Math.floor(r() * marks.length)]);
		else if (k === 2 && n > 0) t.delete(at, n);
		else if (k === 3 && n > 0) t.format(at, n, marks[Math.floor(r() * marks.length)]);
		else if (k === 4) t.insert(at, [new E.Node('inline')]);
		else if (k === 5) t.insert(at, [{ any: s }]);
		else if (k === 6 && doc === a) um.undo();
		else if (k === 7 && doc === a) um.redo();
		else sync2(E, a, b);
		snaps.push([
			Buffer.from(E.encodeStateAsUpdate(a)).toString('base64'),
			Buffer.from(E.encodeStateAsUpdate(b)).toString('base64'),
			JSON.stringify(a.get('t').toDelta().toJSON())
		]);
	}
	return snaps;
};
const sync2 = (E, a, b) => {
	E.applyUpdate(b, E.encodeStateAsUpdate(a, E.encodeStateVector(b)));
	E.applyUpdate(a, E.encodeStateAsUpdate(b, E.encodeStateVector(a)));
};

describe('YP7 differential — no existing public path changes a byte', () => {
	row(
		'the stripped tree is the pre-P7 engine: no insertAtGapEnd, every other line identical',
		async () => {
			const { index, stripped, src } = materializeBaseline();
			expect(src).toContain('insertAtGapEnd');
			expect(stripped).not.toContain('insertAtGapEnd');
			expect(stripped).not.toContain('YP7');
			const YB = await import(/* @vite-ignore */ index);
			expect(typeof new YB.Doc().get('t').insertAtGapEnd).toBe('undefined');
			expect(typeof new Y.Doc().get('t').insertAtGapEnd).toBe('function');
		}
	);

	it('identical stores and renders after EVERY operation, 40 programs × 120 ops', async () => {
		const { index } = materializeBaseline();
		const YB = await import(/* @vite-ignore */ index);
		for (let seed = 1; seed <= 40; seed++) {
			const patched = program(Y, seed, 120);
			const base = program(YB, seed, 120);
			expect(patched.length).toBe(base.length);
			for (let i = 0; i < patched.length; i++) {
				expect(patched[i], `seed ${seed} diverged at op ${i}`).toEqual(base[i]);
			}
		}
	});
});
