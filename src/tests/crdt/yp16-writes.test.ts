/**
 * YP16 (UPSTREAM.md) — the fork's writes without the delta layer store exactly
 * what upstream's delta-driven writes stored.
 *
 * Differential: seeded programs over every public write of a node — `insert`
 * (text with formats, arrays mixing JSON values and nodes), `delete`, `format`
 * (set, `null` clear, `{}` and `null` updates), `setAttr`/`deleteAttr`/
 * `clearAttrs`, `push`/`unshift`, writes to DETACHED nodes (the pre-integration
 * list replayed on integration, nested detached nodes included), undo/redo,
 * remote exchange between two replicas, gc on and off — replayed on this fork
 * and on an engine that still writes through `applyDelta`. After EVERY
 * operation both replicas' `encodeStateAsUpdate` bytes must be identical across
 * the engines, and so must their deep content (the baseline's own `toDelta`,
 * the fork's through the test port). Two baselines:
 *
 * - the pristine upstream engine (`@y/y@14.0.0-rc.26`, the `@y/protocols`
 *   peer): local writes and undo/redo, the fork running without its search
 *   markers (the cursor walks from the start, as upstream does). Remote
 *   integration already stored differently from upstream before YP16 (the fork's
 *   patches), so exchange is left out; and the YP4 seeded cursor can place an item
 *   differently from upstream's walk (bytes differ, content equal: seed 18 of
 *   this program, an array insert with formats) — a pre-YP16 behaviour the
 *   second baseline keeps pinned;
 * - the fork as it stood before YP16 (`git archive` of {@link BEFORE}, when the
 *   commit is in the clone): every operation, exchange included.
 */
// @ts-nocheck -- drives two engines' plain JS directly.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as F from '../../lib/crdt/vendor/yjs/src/index.js';
import { toDelta } from './harness/delta.js';
import { bool, int, mulberry32, pick } from './harness/rng.js';

const upstream = async () => {
	const require = createRequire(import.meta.url);
	const r = createRequire(require.resolve('@y/protocols/sync'));
	return import(/* @vite-ignore */ pathToFileURL(r.resolve('@y/y')).href);
};

/** The last commit before YP16 (the engine still wrote through `applyDelta`). */
const BEFORE = '30f50824';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: ROOT });
const hasBefore = (() => {
	try {
		git('cat-file', '-e', `${BEFORE}^{commit}`);
		return true;
	} catch {
		return false;
	}
})();
const beforeYP16 = async () => {
	const dir = join(ROOT, 'node_modules/.cache/edytor-yp16-baseline');
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	execFileSync('tar', ['-x', '-C', dir], {
		input: git('archive', BEFORE, 'src/lib/crdt/vendor/yjs/src')
	});
	return import(
		/* @vite-ignore */ pathToFileURL(join(dir, 'src/lib/crdt/vendor/yjs/src/index.js')).href
	);
};

const FORMATS = [
	undefined,
	{},
	{ bold: true },
	{ italic: true, bold: true },
	{ bold: null },
	{ href: { url: 'x' } },
	{ bold: true, italic: null }
];
const UPDATES = [
	{ bold: true },
	{ bold: null },
	{ italic: true },
	{},
	null,
	{ href: { url: 'y' } },
	{ a: undefined }
];
const WORDS = ['a', 'bc', 'def', '😀x', 'ghij'];

/**
 * One program, written once and run on any engine: `E` is the engine namespace.
 * Returns a step function; the caller compares after each step.
 */
const program = (E, seed, gc, exchange, markers) => {
	const rng = mulberry32(seed);
	const docs = [new E.Doc({ gc }), new E.Doc({ gc })];
	docs[0].clientID = 11;
	docs[1].clientID = 22;
	// the fork without its search-marker pool: the cursor walks from the start, as upstream does
	if (!markers) for (const d of docs) d.get('t')._searchMarker = null;
	const ums = docs.map((d) => new E.UndoManager([d.get('t'), d.get('m')], { captureTimeout: 0 }));
	/** A detached node with a few writes of its own (lengths tracked here: a detached node has none). */
	const detached = (depth) => {
		const n = new E.Node(pick(rng, [null, 'p', 'q']));
		let len = 0;
		const writes = int(rng, 0, 4);
		for (let i = 0; i < writes; i++) {
			const k = int(rng, 0, 5);
			if (k <= 1) {
				const s = pick(rng, WORDS);
				n.insert(int(rng, 0, len), s, pick(rng, FORMATS));
				len += s.length;
			} else if (k === 2) {
				const arr = [
					{ j: int(rng, 0, 9) },
					...(depth < 1 && bool(rng) ? [detached(depth + 1)] : []),
					7
				];
				n.insert(int(rng, 0, len), arr, pick(rng, FORMATS));
				len += arr.length;
			} else if (k === 3 && len > 0) {
				const at = int(rng, 0, len - 1);
				const l = int(rng, 1, len - at);
				n.delete(at, l);
				len -= l;
			} else if (k === 4 && len > 0) {
				const at = int(rng, 0, len - 1);
				n.format(at, int(rng, 1, len - at), pick(rng, UPDATES));
			} else {
				const key = pick(rng, ['x', 'y', 'z']);
				if (bool(rng, 0.7))
					n.setAttr(key, depth < 1 && bool(rng, 0.3) ? detached(depth + 1) : int(rng, 0, 99));
				else n.deleteAttr(key);
			}
		}
		return n;
	};
	return () => {
		const di = int(rng, 0, 1);
		const doc = docs[di];
		const t = doc.get('t');
		const m = doc.get('m');
		const len = t.length;
		const k = int(rng, 0, 13);
		if (k <= 2) t.insert(int(rng, 0, len), pick(rng, WORDS), pick(rng, FORMATS));
		else if (k === 3)
			t.insert(int(rng, 0, len), [int(rng, 0, 9), detached(0), { o: 1 }], pick(rng, FORMATS));
		else if (k === 4) t.delete(int(rng, 0, len), len === 0 ? 0 : int(rng, 0, 3));
		else if (k === 5 && len > 0) {
			const at = int(rng, 0, len - 1);
			t.format(at, int(rng, 0, len - at), pick(rng, UPDATES));
		} else if (k === 6)
			m.setAttr(
				pick(rng, ['a', 'b', 'c']),
				bool(rng) ? detached(0) : pick(rng, [1, 'two', null, [3]])
			);
		else if (k === 7) m.deleteAttr(pick(rng, ['a', 'b', 'c', 'zz']));
		else if (k === 8 && bool(rng, 0.2)) m.clearAttrs();
		else if (k === 9) bool(rng) ? t.push(pick(rng, WORDS)) : t.unshift([int(rng, 0, 9)]);
		else if (k === 10) ums[di].undo();
		else if (k === 11) ums[di].redo();
		else if (k === 12) {
			const node = m.getAttr('a');
			if (node instanceof E.Node)
				node.insert(int(rng, 0, node.length), pick(rng, WORDS), pick(rng, FORMATS));
		} else if (exchange) {
			// exchange: both replicas catch up
			const u0 = E.encodeStateAsUpdate(docs[0], E.encodeStateVector(docs[1]));
			const u1 = E.encodeStateAsUpdate(docs[1], E.encodeStateVector(docs[0]));
			E.applyUpdate(docs[1], u0);
			E.applyUpdate(docs[0], u1);
		}
		return docs;
	};
};

const snapshot = (E, docs) =>
	docs.map((d) => ({
		bytes: Buffer.from(E.encodeStateAsUpdate(d)).toString('hex'),
		t: JSON.stringify(toDelta(d.get('t'), { deep: true }).toJSON()),
		m: JSON.stringify(toDelta(d.get('m'), { deep: true }).toJSON())
	}));

/** Run 40 seeded programs × 120 operations on the fork and `B`, comparing after every one. */
const differential = (B, gc, exchange, markers) => {
	for (let seed = 1; seed <= 40; seed++) {
		const f = program(F, seed, gc, exchange, markers);
		const b = program(B, seed, gc, exchange, true);
		for (let step = 0; step < 120; step++) {
			const fs = snapshot(F, f());
			const bs = snapshot(B, b());
			if (JSON.stringify(fs) !== JSON.stringify(bs))
				expect(fs, `seed ${seed} step ${step}`).toEqual(bs);
		}
	}
};

describe('YP16 — writes without the delta layer store what the delta layer stored', () => {
	for (const gc of [true, false]) {
		it(`vs pristine upstream: 40 programs × 120 local operations, gc ${gc ? 'on' : 'off'}`, async () => {
			const U = await upstream();
			expect(typeof U.Node.prototype.applyDelta).toBe('function'); // the baseline writes through deltas
			expect(F.Node.prototype.applyDelta).toBeUndefined();
			differential(U, gc, false, false);
		});

		it.runIf(hasBefore)(
			`vs the fork before YP16: 40 programs × 120 operations with exchange, gc ${gc ? 'on' : 'off'}`,
			async () => {
				const B = await beforeYP16();
				expect(typeof B.Node.prototype.applyDelta).toBe('function');
				differential(B, gc, true, true);
			}
		);
	}

	it('a detached node keeps its writes in order: content first, then attrs in first-write order', async () => {
		const U = await upstream();
		const run = (E) => {
			const doc = new E.Doc();
			doc.clientID = 5;
			const n = new E.Node('p');
			n.setAttr('b', 1);
			n.insert(0, 'xy', { bold: true });
			n.setAttr('a', 2);
			n.deleteAttr('b');
			n.insert(1, 'Z');
			n.setAttr('b', 3); // keeps its first-write slot
			n.format(0, 2, { italic: true });
			n.delete(2, 1);
			doc.get('r').insert(0, [n]);
			return Buffer.from(E.encodeStateAsUpdate(doc)).toString('hex');
		};
		expect(run(F)).toBe(run(U));
	});
});
