/**
 * arch-v2 — checkpoint R2 row (doc lane): the change report names the
 * previously visible descendants of an added subtree (K7; the orchestrator's
 * answer (b) to R1's contract question).
 *
 * A block that was visible and ends up inside a subtree added in the same
 * commit is reported like any other visible block: in `moved` (its display
 * parent changed), and in `meta` / `content` only when its type, data or text
 * changed. So the cells rebuild only the blocks that are new; every block that
 * was visible and did not change keeps its cell object (keyed components keep
 * their elements).
 *
 * Expected values come from the plan rows and a projection-built oracle, never
 * from the code under test.
 */
// @ts-nocheck -- tests drive the vendored engine JS directly (excluded lane).
import { describe, expect, test } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';
import { setDocRand } from '../../../lib/crdt/rand.js';

const lib = import.meta.glob('../../../lib/surface/cells.ts', { eager: true });
const { createCells } = Object.values(lib)[0] ?? {};

/** Red on the reference (`arch-v2/ref-r2`); green since R2. */
const red = test.fails;

const E = bindEdytorDoc(Y);

const p = (id: string, text: string, children?: unknown[], type = 'paragraph') => ({
	id,
	type,
	content: [{ kind: 'text', text }],
	...(children ? { children } : {})
});

const open = (clientID: number, content?: unknown[], bytes?: Uint8Array) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	let seed = clientID * 7919;
	setDocRand(doc, () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
	if (bytes) Y.applyUpdate(doc, bytes);
	const ed = E.create(doc);
	if (content) ed.init({ content });
	return { doc, ed };
};

/** A peer adds `z` at the root and moves `x` (with its child `x1`) into it; `edit` runs in the same commit. */
const moveIntoAdded = (edit?: (ed) => void) => {
	const A = open(1, [p('x', 'xx', [p('x1', 'one')], 'heading'), p('y', 'yy')]);
	const B = open(2, undefined, Y.encodeStateAsUpdate(A.doc));
	const reports = [];
	A.ed.onChange((c) => reports.push(c));
	const cells = createCells(A.ed);
	const before = { x: cells.get('x'), x1: cells.get('x1'), y: cells.get('y') };
	const sv = Y.encodeStateVector(A.doc);
	B.ed.transact(() => {
		B.ed.insertBlock({ parent: null, index: 0 }, { id: 'z', type: 'paragraph' });
		B.ed.moveBlock('x', { parent: 'z', index: 0 });
		edit?.(B.ed);
	});
	Y.applyUpdate(A.doc, Y.encodeStateAsUpdate(B.doc, sv), 'remote');
	expect(reports).toHaveLength(1);
	return { A, report: reports[0], cells, before };
};

describe('R2 — an added subtree names the visible blocks it adopted (K7)', () => {
	red('an unchanged block moved into an added subtree: moved, not rebuilt', () => {
		const { report, cells, before } = moveIntoAdded();
		expect([...report.added.keys()]).toEqual(['z']);
		expect(report.moved.has('x')).toBe(true);
		expect([...report.meta.keys()]).toEqual([]);
		expect([...report.content.keys()]).toEqual([]);
		// Every block that was visible and did not change keeps its cell.
		expect(cells.get('x')).toBe(before.x);
		expect(cells.get('x1')).toBe(before.x1);
		expect(cells.get('y')).toBe(before.y);
		expect(cells.get('z').childIds).toEqual(['x']);
		expect(cells.rootIds).toEqual(['z', 'y']);
	});

	red('a changed block moved into an added subtree: moved, meta and content', () => {
		const { A, report, cells, before } = moveIntoAdded((ed) => {
			ed.setBlockType('x', 'paragraph');
			ed.insertText('x', 2, '!');
		});
		expect(report.moved.has('x')).toBe(true);
		expect(report.meta.get('x')?.type).toBe('paragraph');
		expect(
			report.content
				.get('x')
				?.map((run) => run.text)
				.join('')
		).toBe('xx!');
		expect(cells.get('x')).not.toBe(before.x);
		expect(cells.get('x').type).toBe('paragraph');
		expect(cells.get('x1')).toBe(before.x1);
		// Later changes are reported against the adopted state.
		const reports = [];
		A.ed.onChange((c) => reports.push(c));
		A.ed.transact(() => {
			A.ed.setBlockType('x', 'heading');
			A.ed.deleteText('x', 2, 1);
		});
		expect(reports.map((r) => [[...r.meta.keys()], [...r.content.keys()]])).toEqual([
			[['x'], ['x']]
		]);
	});
});
