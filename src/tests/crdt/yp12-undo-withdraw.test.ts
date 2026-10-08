/**
 * Vendored-engine patch YP12 (`src/lib/crdt/vendor/yjs/UPSTREAM.md`): the
 * UndoManager option `withdraw(item, stackItem, transaction)` lets the
 * document keep an item a popped stack item would delete — and write in its
 * place, in the same transaction — while the step still counts as applied.
 * Edytor uses it so an undone block creation withdraws the block instead of
 * deleting its node (`hist.undo.withdraw`, `placement/model.ts`
 * `withdrawOnUndo`).
 *
 * Without the option the engine is unchanged: the differential replays random
 * programs over map and sequence writes with undo/redo on the patched tree and
 * on the tree with the YP12 hunks stripped and requires byte-identical stores
 * after every operation. The hook rows also run on the stripped tree, which
 * ignores the option (the rows discriminate).
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

/** The vendored tree with the YP12 hunks of `utils/UndoManager.js` stripped. */
const baseline = async () => {
	const root = join(here, '../../../node_modules/.cache/edytor-p12-baseline');
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	cpSync(VENDOR, join(root, 'src'), { recursive: true });
	const file = 'utils/UndoManager.js';
	const src = readFileSync(join(VENDOR, file), 'utf8');
	const stripped = src
		.replace(/[ \t]*\/\/ YP12 begin[\s\S]*?\/\/ YP12 end\n/g, '')
		.replace(/^.*\/\/ YP12\n/gm, '');
	expect(src).toContain('// YP12');
	expect(stripped).not.toContain('YP12');
	expect(stripped).not.toContain('withdraw');
	writeFileSync(join(root, 'src', file), stripped);
	return import(/* @vite-ignore */ join(root, 'src/index.js'));
};

/** One tracked step creating `m.k = node('x')` with a text inside it; the option on the manager. */
const created = (E, opts) => {
	const doc = new E.Doc();
	doc.clientID = 7;
	const m = doc.get('m');
	const um = new E.UndoManager(m, { captureTimeout: 0, ...opts });
	doc.transact(() => {
		const node = new E.Node('x');
		m.setAttr('k', node);
		node.insert(0, 'hi');
	});
	return { doc, m, um };
};

/** Keep the entry `k` and write `w` on it; delete what is inside it. */
const keepEntry = (seen) => (item, stackItem, tr) => {
	seen?.push([
		item.parentSub,
		stackItem.inserts.hasId(item.id),
		tr === item.parent.doc._transaction
	]);
	if (item.parentSub !== 'k') return false;
	item.content.type.setAttr('w', true);
	return true;
};

describe('YP12 — withdraw', () => {
	for (const [name, patched] of [
		['patched', true],
		['stripped', false]
	]) {
		it(`${name}: a kept item stays, the hook's write joins the step, the undo is consumed`, async () => {
			const E = patched ? Y : await baseline();
			const seen = [];
			const { m, um } = created(E, { withdraw: keepEntry(seen) });
			expect(um.undo()).not.toBeNull();
			const node = m.getAttr('k');
			if (patched) {
				// The text inside was deleted as usual; the entry stays, marked.
				expect(node?.getAttr('w')).toBe(true);
				expect(node?.length).toBe(0);
				expect(seen).toContainEqual(['k', true, true]);
				expect([um.undoStack.length, um.redoStack.length]).toEqual([0, 1]);
				// Redo removes the mark and brings the text back.
				expect(um.redo()).not.toBeNull();
				expect(m.getAttr('k')?.getAttr('w')).toBeUndefined();
				expect(m.getAttr('k')?.length).toBe(2);
			} else {
				expect(node).toBeUndefined();
				expect(seen).toEqual([]);
			}
		});
	}

	it('a step whose only effect was kept is consumed, not skipped for the next one', () => {
		const doc = new Y.Doc();
		const m = doc.get('m');
		const um = new Y.UndoManager(m, { captureTimeout: 0, withdraw: () => true });
		m.setAttr('a', 1);
		m.setAttr('b', 2);
		um.undo();
		// the second step's item was kept and the step consumed; `a` is still there
		expect([m.getAttr('a'), m.getAttr('b')]).toEqual([1, 2]);
		expect(um.undoStack.length).toBe(1);
		um.undo();
		expect(um.undoStack.length).toBe(0);
	});
});

/** One random program over map entries and a nested text with undo/redo, replayed on engine `E`. */
const program = (E, seed, steps) => {
	const r = mulberry32(seed);
	const mk = (client) => {
		const doc = new E.Doc({ gc: r() < 0.5 });
		doc.clientID = client;
		return doc;
	};
	const a = mk(4242);
	const b = mk(4343);
	const um = new E.UndoManager(a.get('m'), { captureTimeout: 0 });
	const snaps = [];
	const sync = () => {
		E.applyUpdate(b, E.encodeStateAsUpdate(a, E.encodeStateVector(b)));
		E.applyUpdate(a, E.encodeStateAsUpdate(b, E.encodeStateVector(a)));
	};
	for (let s = 0; s < steps; s++) {
		const doc = r() < 0.7 ? a : b;
		const m = doc.get('m');
		const key = `k${Math.floor(r() * 4)}`;
		const k = Math.floor(r() * 7);
		const node = m.getAttr(key);
		if (k === 0) {
			const n = new E.Node('x');
			m.setAttr(key, n);
			n.insert(0, 'ab');
		} else if (k === 1 && node) node.insert(Math.floor(r() * (node.length + 1)), 'z');
		else if (k === 2 && node && node.length > 0) node.delete(0, 1);
		else if (k === 3) m.deleteAttr(key);
		else if (k === 4 && doc === a) um.undo();
		else if (k === 5 && doc === a) um.redo();
		else sync();
		snaps.push([
			Buffer.from(E.encodeStateAsUpdate(a)).toString('base64'),
			Buffer.from(E.encodeStateAsUpdate(b)).toString('base64')
		]);
	}
	return snaps;
};

describe('YP12 differential — without the option no byte changes', () => {
	it('identical stores after EVERY operation, 30 programs × 100 ops', async () => {
		const YB = await baseline();
		for (let seed = 1; seed <= 30; seed++) {
			const patched = program(Y, seed, 100);
			const base = program(YB, seed, 100);
			expect(patched.length).toBe(base.length);
			for (let i = 0; i < patched.length; i++)
				expect(patched[i], `seed ${seed} diverged at op ${i}`).toEqual(base[i]);
		}
	});
});
