/**
 * Vendored-engine patch P11 (`src/lib/crdt/vendor/yjs/UPSTREAM.md`): two
 * UndoManager options that let the document decide how deleted text comes
 * back (per-writer text delete marks, `src/lib/crdt/text/deletes.ts`).
 *
 * - `restoreFilter(item, stackItem)`: whether popping the stack item may
 *   re-create the deleted item. A withheld item still counts as a change:
 *   the step is consumed instead of skipped for the next one (it reaches the
 *   other stack when the pop changed anything else, as a document's delete
 *   step does by removing its mark).
 * - `onApply(transaction, stackItem)`: called inside the undo/redo
 *   transaction once the stack item is applied, so its writes are part of
 *   the same update and of the step the other stack captures.
 *
 * With neither option the engine is upstream's: the differential below
 * replays random programs over every text write path with undo/redo on the
 * patched tree and on the tree with the P11 hunks stripped, and requires
 * byte-identical stores and identical renders after every operation. The
 * hook rows also run on the stripped tree, which ignores the options (the
 * rows discriminate).
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';
import { mulberry32 } from './harness/rng.js';

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(here, '../../lib/crdt/vendor/yjs/src');

/** The vendored tree with the P11 hunks of `utils/UndoManager.js` stripped. */
const baseline = async () => {
	const root = join(here, '../../../node_modules/.cache/edytor-p11-baseline');
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	cpSync(VENDOR, join(root, 'src'), { recursive: true });
	const file = 'utils/UndoManager.js';
	const src = readFileSync(join(VENDOR, file), 'utf8');
	const stripped = src
		.replace(/[ \t]*\/\/ P11 begin[\s\S]*?\/\/ P11 end\n/g, '')
		.replace(/^.*\/\/ P11\n/gm, '');
	expect(src).toContain('// P11');
	expect(stripped).not.toContain('P11');
	expect(stripped).not.toContain('restoreFilter');
	writeFileSync(join(root, 'src', file), stripped);
	return import(/* @vite-ignore */ join(root, 'src/index.js'));
};

/** `abc`, `b` deleted in one tracked step; the options on the manager. */
const deleted = (E, opts) => {
	const doc = new E.Doc();
	doc.clientID = 7;
	const t = doc.get('t');
	t.insert(0, 'abc');
	const um = new E.UndoManager(t, { captureTimeout: 0, ...opts });
	t.delete(1, 1);
	const updates = [];
	doc.on('update', (u) => updates.push(u));
	return { doc, t, um, updates };
};

describe('P11 — restoreFilter and onApply', () => {
	for (const [name, patched] of [
		['patched', true],
		['stripped', false]
	]) {
		it(`${name}: a withheld item stays deleted and the undo is still consumed`, async () => {
			const E = patched ? Y : await baseline();
			const seen = [];
			const { t, um } = deleted(E, {
				restoreFilter: (item) => (seen.push(item.content.str), false)
			});
			expect(um.undo()).not.toBeNull();
			expect(t.toString()).toBe(patched ? 'ac' : 'abc');
			expect(seen).toEqual(patched ? ['b'] : []);
			// consumed; a step that changed nothing leaves nothing to redo
			expect([um.undoStack.length, um.redoStack.length]).toEqual([0, patched ? 0 : 1]);
		});

		it(`${name}: onApply writes join the undo's update and its redo step`, async () => {
			const E = patched ? Y : await baseline();
			const calls = [];
			const { doc, t, um, updates } = deleted(E, {
				onApply: (tr, stackItem) => {
					calls.push([tr === doc._transaction, stackItem.deletes.isEmpty()]);
					if (um.undoing) t.insert(0, '!');
				}
			});
			um.undo();
			expect(t.toString()).toBe(patched ? '!abc' : 'abc');
			expect(updates.length).toBe(1);
			expect(calls).toEqual(patched ? [[true, false]] : []);
			um.redo();
			expect(t.toString()).toBe('ac');
		});
	}

	it('a stack item whose only effect was withheld is consumed, not skipped for the next one', () => {
		const doc = new Y.Doc();
		const t = doc.get('t');
		t.insert(0, 'abc');
		const um = new Y.UndoManager(t, { captureTimeout: 0, restoreFilter: () => false });
		t.insert(3, 'X');
		t.delete(1, 1);
		um.undo();
		// the delete's undo withheld `b` and is consumed; `X` is still there
		expect(t.toString()).toBe('acX');
		um.undo();
		expect(t.toString()).toBe('ac');
	});
});

/** One random program over the text write paths with undo/redo, replayed on engine `E`. */
const program = (E, seed, steps) => {
	const r = mulberry32(seed);
	const mk = (client) => {
		const doc = new E.Doc({ gc: r() < 0.5 });
		doc.clientID = client;
		return doc;
	};
	const a = mk(4242);
	const b = mk(4343);
	const um = new E.UndoManager(a.get('t'), { captureTimeout: 0 });
	const snaps = [];
	const marks = [{ b: true }, { b: null }, { i: true }, {}];
	const sync = () => {
		E.applyUpdate(b, E.encodeStateAsUpdate(a, E.encodeStateVector(b)));
		E.applyUpdate(a, E.encodeStateAsUpdate(b, E.encodeStateVector(a)));
	};
	for (let s = 0; s < steps; s++) {
		const doc = r() < 0.7 ? a : b;
		const t = doc.get('t');
		const len = t.length;
		const k = Math.floor(r() * 8);
		const at = Math.floor(r() * (len + 1));
		const n = Math.min(len - at, 1 + Math.floor(r() * 4));
		if (k === 0 || len === 0) t.insert(at, 'xyzw'.slice(0, 1 + Math.floor(r() * 4)));
		else if (k === 1) t.insert(at, 'ab', marks[Math.floor(r() * marks.length)]);
		else if (k === 2 && n > 0) t.delete(at, n);
		else if (k === 3 && n > 0) t.format(at, n, marks[Math.floor(r() * marks.length)]);
		else if (k === 4) t.insert(at, [new E.Node('inline')]);
		else if (k === 5 && doc === a) um.undo();
		else if (k === 6 && doc === a) um.redo();
		else sync();
		snaps.push([
			Buffer.from(E.encodeStateAsUpdate(a)).toString('base64'),
			Buffer.from(E.encodeStateAsUpdate(b)).toString('base64'),
			JSON.stringify(a.get('t').toDelta().toJSON())
		]);
	}
	return snaps;
};

describe('P11 differential — without the options no byte changes', () => {
	it('identical stores and renders after EVERY operation, 40 programs × 120 ops', async () => {
		const YB = await baseline();
		for (let seed = 1; seed <= 40; seed++) {
			const patched = program(Y, seed, 120);
			const base = program(YB, seed, 120);
			expect(patched.length).toBe(base.length);
			for (let i = 0; i < patched.length; i++)
				expect(patched[i], `seed ${seed} diverged at op ${i}`).toEqual(base[i]);
		}
	});
});
