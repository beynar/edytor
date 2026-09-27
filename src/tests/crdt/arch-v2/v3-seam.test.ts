/**
 * arch-v2 — checkpoint V3 rows, doc lane: the seam of a vanished endpoint is a
 * pure function of replicated placement (§2.4 "Seam of a vanished endpoint",
 * §4.1 `doc/anchors`, L25; reader-selection R3).
 *
 * `seam(doc, dead, displayable)`: climb while the dead block's display parent
 * is dead; in the live parent's visible children (ordered by `(rank, id)`),
 * the start of the first displayable stop at or after the dead block's slot,
 * else the end of the last displayable stop before it; with neither, the same
 * question one level up (the parent itself is then a stop before the slot);
 * with nothing displayable anywhere, `null`. Stops descend into children
 * (forward: own content, then children in order; backward: children last
 * first, then own content). `displayable` is the Surface fact (cell mounted
 * and not hidden by view state); the document never reads the view.
 *
 * Contract rows: `sel.seam.next-sibling` (start of the sibling that slid into
 * the slot; last block → the previous sibling's end), `sel.seam.nested-subtree`
 * (the topmost dead ancestor's slot), the previous-ordering row (several
 * adjacent dead siblings), the editable-descent rows, F-S14's doc half (a
 * hidden subtree is skipped, the answer continues outward in document order),
 * and "the same answer on every replica".
 *
 * Red on the reference: `doc/anchors` does not exist there (the seam walked
 * wrapper links captured at mirror drop time, `_dropNext/_dropPrev`).
 * Expected values come from the contract rows, never from running the code.
 */
// @ts-nocheck -- tests drive the vendored engine JS directly (excluded lane).
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);
const REMOTE = { remote: true };

/** Red on the reference (no `doc/anchors`); green since V3. */
const row = it.fails;

const b = (id: string, text: string, children?: unknown[], type = 'paragraph') => ({
	id,
	type,
	content: [{ kind: 'text', text }],
	...(children ? { children } : {})
});

const facadeOf = (content: unknown[], clientID = 20) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	const ed = E.create(doc);
	ed.init({ content });
	return { doc, ed };
};

const seamOf = async () => (await import('../../../lib/crdt/anchors.js')).seam;

/** Every block's own content displays. */
const all = () => true;

describe('V3 — seam of a vanished endpoint (doc/anchors)', () => {
	row('sel.seam.next-sibling: the start of the sibling that slid into the slot', async () => {
		const seam = await seamOf();
		const { ed } = facadeOf([b('a', 'aa'), b('bb', 'bb'), b('c', 'cc')]);
		ed.deleteBlock('bb');
		expect(seam(ed, 'bb', all)).toEqual({ block: 'c', offset: 0 });
	});

	row('sel.seam.next-sibling: the last block lands at the previous sibling end', async () => {
		const seam = await seamOf();
		const { ed } = facadeOf([b('a', 'alpha'), b('bb', 'beta')]);
		ed.deleteBlock('bb');
		expect(seam(ed, 'bb', all)).toEqual({ block: 'a', offset: 5 });
	});

	row('sel.seam.nested-subtree: the topmost dead ancestor gives the slot', async () => {
		const seam = await seamOf();
		const { ed } = facadeOf([
			b('alpha', 'alpha'),
			b('list', '', [b('item', 'beta')], 'ordered-list'),
			b('omega', 'omega')
		]);
		ed.deleteBlock('list');
		// The caret was inside `item`: the dead chain climbs to `list`'s slot.
		expect(seam(ed, 'item', all)).toEqual({ block: 'omega', offset: 0 });
		expect(seam(ed, 'list', all)).toEqual({ block: 'omega', offset: 0 });
	});

	row('several adjacent dead siblings: the slot is the replicated rank, not an index', async () => {
		const seam = await seamOf();
		const { ed } = facadeOf([b('a', 'aa'), b('bb', 'bb'), b('c', 'cc'), b('d', 'dd')]);
		ed.deleteBlock('bb');
		ed.deleteBlock('c');
		expect(seam(ed, 'bb', all)).toEqual({ block: 'd', offset: 0 });
		expect(seam(ed, 'c', all)).toEqual({ block: 'd', offset: 0 });
	});

	row('a non-displayable sibling is passed over (a void block, an unrendered slot)', async () => {
		const seam = await seamOf();
		const { ed } = facadeOf([b('a', 'aa'), b('x', 'xx'), b('y', ''), b('c', 'cc')]);
		ed.deleteBlock('a');
		const shown = (id: string) => id !== 'y';
		expect(seam(ed, 'a', (id: string) => id !== 'x' && shown(id))).toEqual({
			block: 'c',
			offset: 0
		});
	});

	row(
		'forward descent: a container without displayable content lands in its first child',
		async () => {
			const seam = await seamOf();
			const { ed } = facadeOf([
				b('p', 'pp'),
				b('list', '', [b('i1', 'one'), b('i2', 'two')], 'ordered-list'),
				b('q', 'qq')
			]);
			ed.deleteBlock('p');
			expect(seam(ed, 'p', (id: string) => id !== 'list')).toEqual({ block: 'i1', offset: 0 });
		}
	);

	row(
		'backward descent: the last displayable stop before the slot, children last first',
		async () => {
			const seam = await seamOf();
			const { ed } = facadeOf([
				b('list', '', [b('i1', 'one'), b('i2', 'two')], 'ordered-list'),
				b('p', 'pp')
			]);
			ed.deleteBlock('p');
			expect(seam(ed, 'p', (id: string) => id !== 'list')).toEqual({ block: 'i2', offset: 3 });
		}
	);

	row(
		'F-S14 (doc half): a hidden subtree is skipped; the answer continues in document order',
		async () => {
			const seam = await seamOf();
			// `toggle` is collapsed: its children are not displayable.
			const hidden = new Set(['h1', 'h2']);
			const shown = (id: string) => !hidden.has(id);
			const { ed } = facadeOf([
				b('toggle', 'sum', [b('h1', 'one'), b('h2', 'two')], 'toggle'),
				b('after', 'after')
			]);
			ed.deleteBlock('h2');
			// Never the hidden `h1`: the next displayable stop after the slot.
			expect(seam(ed, 'h2', shown)).toEqual({ block: 'after', offset: 0 });
			ed.deleteBlock('after');
			// Nothing after it: the toggle's own content is the stop before the slot.
			expect(seam(ed, 'h2', shown)).toEqual({ block: 'toggle', offset: 3 });
		}
	);

	row('nothing displayable anywhere: null (the view waits for a mount)', async () => {
		const seam = await seamOf();
		const { ed } = facadeOf([b('a', 'aa'), b('bb', 'bb')]);
		ed.deleteBlock('bb');
		expect(seam(ed, 'bb', () => false)).toBeNull();
	});

	row('no origin: the first displayable stop of the document', async () => {
		const seam = await seamOf();
		const { ed } = facadeOf([b('list', '', [b('i1', 'one')], 'ordered-list'), b('q', 'qq')]);
		expect(seam(ed, null, (id: string) => id !== 'list')).toEqual({ block: 'i1', offset: 0 });
	});

	row('the same answer on every replica, whatever order the deletes arrived in', async () => {
		const seam = await seamOf();
		const content = [b('a', 'aa'), b('bb', 'bb'), b('c', 'cc'), b('d', 'dd')];
		const one = facadeOf(content, 31);
		const two = { doc: new Y.Doc() };
		two.doc.clientID = 32;
		Y.applyUpdate(two.doc, Y.encodeStateAsUpdate(one.doc), REMOTE);
		two.ed = E.create(two.doc);
		const before = Y.encodeStateVector(one.doc);
		one.ed.deleteBlock('bb');
		two.ed.deleteBlock('c');
		const fromOne = Y.encodeStateAsUpdate(one.doc, before);
		const fromTwo = Y.encodeStateAsUpdate(two.doc, before);
		Y.applyUpdate(one.doc, fromTwo, REMOTE);
		Y.applyUpdate(two.doc, fromOne, REMOTE);
		for (const dead of ['bb', 'c']) {
			expect(seam(one.ed, dead, all)).toEqual({ block: 'd', offset: 0 });
			expect(seam(two.ed, dead, all)).toEqual(seam(one.ed, dead, all));
		}
	});
});
