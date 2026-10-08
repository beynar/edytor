/**
 * Vendored-engine patches YP9 and YP10 (`src/lib/crdt/vendor/yjs/UPSTREAM.md`),
 * found by the arch-v2 phase 2 P1 fuzz campaign
 * (`src/tests/crdt/arch-v2/replica-fuzz.test.ts`); both reproduce on the
 * unmodified upstream `@y/y@14.0.0-rc.26`.
 *
 * YP9 — pending updates stay pending forever. `integrateStructs` records in
 * the pending missing-set only the dependency of the struct at the top of
 * its dependency stack. When a struct waits for client X and the jump into
 * X's refs lands on a struct that waits on the first one's client (a
 * cycle across two pending updates), the first struct's own dependency is
 * dropped: the update that later supplies it does not trigger a retry, and
 * the document never integrates what it already holds. Rows: the raw-engine
 * program below delivered in every order, and the facade-level program the
 * fuzz found (a two-line paste into a block, then a second paste into the
 * pasted line, with a concurrent replace), in every order.
 *
 * YP10 — the formatting cleanup that follows a remote transaction ran as a
 * local transaction with the `null` origin, which every default undo
 * manager tracks: receiving a peer's delete over text this user formatted
 * pushed an invisible step onto this user's undo stack, and the next undo
 * reverted that cleanup instead of the user's last edit
 * (`conc.undo.actor-local`, `hist.capture-group`). The cleanup now runs
 * under an origin nobody tracks; it is still an ordinary local write that
 * providers broadcast.
 *
 * Each row is also run against the tree with the patch's hunks stripped
 * (the YP7 method): the stripped engine must show the failure, so the row
 * discriminates.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as Y from '../../lib/crdt/vendor/yjs/src/index.js';
import { permutations, replica, seedUpdate } from './arch-v2/replica-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(here, '../../lib/crdt/vendor/yjs/src');

/** The vendored tree with patch `tag`'s hunks stripped from `file`. */
const baseline = async (tag: string, file: string) => {
	const root = join(here, `../../../node_modules/.cache/edytor-${tag.toLowerCase()}-baseline`);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	cpSync(VENDOR, join(root, 'src'), { recursive: true });
	const src = readFileSync(join(VENDOR, file), 'utf8');
	const stripped = src
		.replace(new RegExp(`[ \\t]*// ${tag} begin[\\s\\S]*?// ${tag} end\\n`, 'g'), '')
		.replace(new RegExp(`, [A-Za-z]+\\) // ${tag}\\n`, 'g'), ')\n')
		.replace(new RegExp(`^.*// ${tag}\\n`, 'gm'), '');
	expect(src).toContain(`// ${tag}`);
	expect(stripped).not.toContain(tag);
	writeFileSync(join(root, 'src', file), stripped);
	return import(/* @vite-ignore */ join(root, 'src/index.js'));
};

const mkDoc = (E, client: number) => {
	const doc = new E.Doc();
	doc.clientID = client;
	return doc;
};
const capture = (E, doc, fn) => {
	const sv = E.encodeStateVector(doc);
	fn();
	return E.encodeStateAsUpdate(doc, sv);
};
const pending = (doc) => doc.store.pendingStructs !== null || doc.store.pendingDs !== null;

/**
 * A1 (A: `Q` at 0) ← B1 (B: an independent write, then `yy` after `Q`)
 * ← A3 (A: `W` after `yy`); A2 is an independent A write between A1 and A3.
 */
const program = (E) => {
	const seed = mkDoc(E, 1);
	seed.get('t').insert(0, 'abc');
	const s = E.encodeStateAsUpdate(seed);
	const a = mkDoc(E, 100);
	const b = mkDoc(E, 200);
	E.applyUpdate(a, s);
	E.applyUpdate(b, s);
	const A1 = capture(E, a, () => a.get('t').insert(0, 'Q'));
	E.applyUpdate(b, A1);
	const B1 = capture(E, b, () =>
		b.transact(() => {
			b.get('v').insert(0, 'k');
			b.get('t').insert(1, 'yy');
		})
	);
	const A2 = capture(E, a, () => a.get('u').insert(0, 'zzz'));
	E.applyUpdate(a, B1);
	const A3 = capture(E, a, () => a.get('t').insert(3, 'W'));
	return { s, ups: { A1, B1, A2, A3 }, expected: a.get('t').toString() };
};

const deliver = (E, s, ups, order) => {
	const d = mkDoc(E, 999);
	E.applyUpdate(d, s);
	for (const k of order) E.applyUpdate(d, ups[k]);
	return d;
};

describe('YP9 — a pending struct whose dependency arrives later is retried', () => {
	it('raw engine: every delivery order integrates everything (`QyyWabc`)', () => {
		const { s, ups, expected } = program(Y);
		expect(expected).toBe('QyyWabc');
		for (const order of permutations(Object.keys(ups))) {
			const d = deliver(Y, s, ups, order);
			expect(pending(d), order.join(',')).toBe(false);
			expect(d.get('t').toString(), order.join(',')).toBe(expected);
			expect(d.get('u').toString()).toBe('zzz');
		}
	});

	it('the stripped engine stays pending on A3,B1,A1,A2 (the row discriminates)', async () => {
		const YB = await baseline('YP9', 'utils/encoding.js');
		const { s, ups } = program(YB);
		const d = deliver(YB, s, ups, ['A3', 'B1', 'A1', 'A2']);
		expect(pending(d)).toBe(true);
	});

	it('facade: paste, replace, paste into the pasted line — an observer integrates every order', () => {
		const seed = seedUpdate([
			{
				id: 'A',
				text: 'alpha',
				children: [
					{ id: 'A1', text: 'one' },
					{ id: 'A2', text: 'two' }
				]
			},
			{ id: 'B', text: 'bravo' }
		]);
		const a = replica('A', seed, 100);
		const b = replica('B', seed, 200);
		const sync = () => {
			b.receiveAll(a.log);
			a.receiveAll(b.log);
		};
		const line = (id: string, text: string) => ({ id, content: [{ kind: 'text', text }] });
		a.ed.insertText('A2', 0, 'Q');
		sync();
		b.ed.transact(() => {
			b.ed.deleteText('A2', 3, 1);
			b.ed.insertText('A2', 3, 'yy');
		});
		a.ed.insertFlow({ block: 'A2', offset: 3 }, { lines: [line('p9a', 'zzz'), line('p9b', 'W')] });
		sync();
		a.ed.insertFlow(
			{ block: 'p9b', offset: 3 },
			{ lines: [line('p10a', 'yy'), line('p10b', 'x')] }
		);
		sync();
		const expected = a.tree();
		expect(expected).toBe('A:"alpha"[A1:"one",A2:"Qtwzzz",p9b:"Wyyyy",p10b:"x"] B:"bravo"');
		const ups = { A1: a.log[0], B1: b.log[0], A2: a.log[1], A3: a.log[2] };
		for (const order of permutations(Object.keys(ups))) {
			const o = replica('O', seed, 999);
			for (const k of order) o.receive(ups[k]);
			expect(o.pending(), order.join(',')).toBe(false);
			expect(o.tree(), order.join(',')).toBe(expected);
			o.destroy();
		}
	});
});

describe('YP10 — the formatting cleanup after a remote change is not an undo step', () => {
	/** A bolds D[0..2] and types `!` in E; B deletes inside the bold run; A receives. */
	const run = (variant: string) => {
		const seed = seedUpdate([
			{ id: 'D', text: 'delta' },
			{ id: 'E', text: 'echo' }
		]);
		const a = replica('A', seed, 100);
		const b = replica('B', seed, 200);
		a.ed.setMark('D', 0, 2, 'bold', true);
		a.ed.insertText('E', 4, '!');
		const steps = a.document.history.undoStack.length;
		if (variant === 'replace')
			b.ed.transact(() => {
				b.ed.deleteText('D', 0, 5);
				b.ed.insertText('D', 0, 'W');
			});
		if (variant === 'delete-inside') b.ed.deleteText('D', 0, 2);
		if (variant === 'delete-all') b.ed.deleteText('D', 0, 5);
		const authored = a.log.length;
		a.receiveAll(b.log);
		return { a, b, steps, authoredOnReceive: a.log.length - authored };
	};

	for (const [variant, d] of [
		['replace', 'W'],
		['delete-inside', 'lta'],
		['delete-all', '']
	] as const) {
		it(`peer ${variant} over A’s bold run: A’s stack is unchanged and one undo removes A’s last edit`, () => {
			const { a, b, steps, authoredOnReceive } = run(variant);
			// Paired marks (H5, YP13) are never cleaned up: receiving writes
			// nothing (before H5 the cleanup was a write A made and broadcast) …
			expect(authoredOnReceive).toBe(0);
			// … and nothing lands on A's stack.
			expect(a.document.history.undoStack.length).toBe(steps);
			a.undo();
			expect(a.tree()).toBe(`D:${JSON.stringify(d)} E:"echo"`);
			b.receiveAll(a.log);
			expect(b.tree()).toBe(a.tree());
		});
	}

	it('the stripped engine’s cleanup lands on the undo stack (the row discriminates)', async () => {
		/** Raw engine, edytor's capture rule: remote applies are non-local. */
		const stack = (E) => {
			const a = mkDoc(E, 100);
			const b = mkDoc(E, 200);
			a.get('t').insert(0, 'delta');
			E.applyUpdate(b, E.encodeStateAsUpdate(a), 'remote');
			const um = new E.UndoManager(a.get('t'), {
				captureTimeout: 0,
				captureTransaction: (tr) => tr.local !== false
			});
			a.get('t').format(0, 2, { bold: true });
			const before = um.undoStack.length;
			b.get('t').delete(0, 5); // concurrent: B has not seen the format
			E.applyUpdate(a, E.encodeStateAsUpdate(b), 'remote');
			return um.undoStack.length - before;
		};
		expect(stack(await baseline('YP10', 'utils/Transaction.js'))).toBe(1);
		expect(stack(Y)).toBe(0);
	});
});
