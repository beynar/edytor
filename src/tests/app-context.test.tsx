/** @jsxImportSource ./jsx */
/**
 * GATE-3 probes — application-context behavior the facade tests cannot see.
 *
 * These run the REAL `Edytor` runtime (live wrappers, facade, undo manager,
 * awareness) — not the raw engine — against the questions Gate 3 owns:
 *
 *  1. cloneJson boundary: non-JSON values in block data/marks coerce at the
 *     replicated boundary — the contract is JSON-only and dev builds report
 *     every offending path (F4: loud, never silent).
 *  2. Undo in app context: a local undo must not revert a remote peer's
 *     edit (HI01-adjacent — the pending registry row is still open).
 *  3. Selection anchors under remote structural edits (SE01-adjacent).
 *  4. Lifecycle: an Edytor on an EXTERNAL doc/awareness registers
 *     doc/awareness listeners — `Edytor.destroy()` must release ALL of them
 *     (facade updateHandler, awareness change/update subs, undo-manager doc
 *     observers), returning shared-object listener counts to baseline.
 */
// @ts-nocheck -- probes touch engine internals (_observers) intentionally.
import { describe, expect, test, vi } from 'vitest';
import { createTestEdytor } from './test.utils.js';
import { Y } from '$lib/crdt/engine.js';
import { Awareness } from '$lib/crdt/index.js';

const REMOTE_ORIGIN = { remote: true };

/** Wire two docs into a synchronous full-duplex update pump (local edits only). */
const pump = (docA, docB) => {
	docA.on('update', (update, origin) => {
		if (origin !== REMOTE_ORIGIN) Y.applyUpdate(docB, update, REMOTE_ORIGIN);
	});
	docB.on('update', (update, origin) => {
		if (origin !== REMOTE_ORIGIN) Y.applyUpdate(docA, update, REMOTE_ORIGIN);
	});
};

/** Prime a fresh peer doc with the editor's current state (updates only fire on new txns). */
const prime = (edytor, docB) => {
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(edytor.doc), REMOTE_ORIGIN);
};

const observerCount = (observable, event) => observable._observers?.get(event)?.size ?? 0;

const textContent = (block) => block.value.content.map((p) => ('text' in p ? p.text : '')).join('');

describe('gate3: cloneJson boundary loss', () => {
	// Contract (F4, resolved): data/marks/payloads are JSON-TYPED ONLY.
	// Non-JSON values still coerce the same way (they can never cross the
	// wire), but the boundary now reports every offending path in dev — the
	// loss is never silent.
	test('non-JSON values in block data are coerced AND reported at the boundary', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const { edytor } = createTestEdytor(
				<root>
					<paragraph>hello</paragraph>
				</root>
			);
			const block = edytor.root.children[0];
			const date = new Date('2024-01-01T00:00:00Z');
			const map = new Map([['k', 'v']]);

			block.setData({
				when: date,
				lookup: map,
				undef: undefined,
				fn: () => 1
			});

			const persisted = edytor.facade.toJSON().children[0].data;
			expect(persisted.when).toBe('2024-01-01T00:00:00.000Z'); // Date → string
			expect(persisted.lookup).toEqual({}); // Map → {}
			expect('undef' in persisted).toBe(false); // undefined key dropped
			expect('fn' in persisted).toBe(false); // function dropped

			// The dev guard named every offending path — no silent loss.
			const reports = warn.mock.calls.map((call) => String(call[0])).join('\n');
			expect(reports).toContain('cloneJson');
			expect(reports).toContain('Date');
			expect(reports).toContain('Map');
			expect(reports).toContain('undefined');
			expect(reports).toContain('function');
		} finally {
			warn.mockRestore();
		}
	});

	test('marks with non-JSON values are coerced AND reported too', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const { edytor } = createTestEdytor(
				<root>
					<paragraph>hello</paragraph>
				</root>
			);
			const block = edytor.root.children[0];
			const text = block.content[0];
			const date = new Date('2024-06-01T00:00:00Z');
			text.insertText({ value: 'X', start: 0, end: 0, marks: { link: { at: date } } });
			const stored = edytor.facade.toJSON().children[0].content[0];
			expect(stored.marks.link.at).toBe('2024-06-01T00:00:00.000Z');

			const reports = warn.mock.calls.map((call) => String(call[0])).join('\n');
			expect(reports).toContain('cloneJson');
			expect(reports).toContain('Date');
		} finally {
			warn.mockRestore();
		}
	});
});

describe('gate3: undo in app context', () => {
	test('local undo preserves a remote peer edit (two live docs)', async () => {
		const { edytor } = createTestEdytor(
			<root>
				<paragraph>base</paragraph>
			</root>
		);
		const B = new edytor.doc.constructor();
		pump(edytor.doc, B);
		prime(edytor, B);

		const text = edytor.root.children[0].content[0];
		text.insertText({ value: 'AAA ', start: 0, end: 0 }); // local undoable

		// Peer B edits through its own facade binding.
		const facadeB = edytor.crdt.doc.create(B, { defaultType: 'paragraph' });
		const bId = facadeB.childrenIds(null)[0];
		facadeB.insertText(bId, 4 + 4, ' BBB'); // after 'AAA base'

		expect(textContent(edytor.root.children[0])).toBe('AAA base BBB');

		edytor.undoManager.undo();
		await Promise.resolve();

		expect(textContent(edytor.root.children[0])).toBe('base BBB'); // remote edit preserved
	});

	test('redo after remote edit re-applies only the local change', async () => {
		const { edytor } = createTestEdytor(
			<root>
				<paragraph>base</paragraph>
			</root>
		);
		const B = new edytor.doc.constructor();
		pump(edytor.doc, B);
		prime(edytor, B);

		const text = edytor.root.children[0].content[0];
		text.insertText({ value: 'X', start: 0, end: 0 });
		const facadeB = edytor.crdt.doc.create(B, { defaultType: 'paragraph' });
		facadeB.insertText(facadeB.childrenIds(null)[0], 5, ' R');

		edytor.undoManager.undo();
		await Promise.resolve();
		edytor.undoManager.redo();
		await Promise.resolve();

		expect(textContent(edytor.root.children[0])).toBe('Xbase R');
	});
});

describe('gate3: selection anchors under remote structural edits', () => {
	test('caret anchor follows a remote merge of the caret block', async () => {
		const { edytor } = createTestEdytor(
			<root>
				<paragraph>first</paragraph>
				<paragraph>second</paragraph>
			</root>
		);
		const B = new edytor.doc.constructor();
		pump(edytor.doc, B);
		prime(edytor, B);

		const caretText = edytor.root.children[1].content[0];
		const anchor = edytor.selection.createTextAnchor(caretText, 2, 'left');
		expect(anchor).not.toBeNull();

		// Remote peer merges block[1] into block[0].
		const facadeB = edytor.crdt.doc.create(B, { defaultType: 'paragraph' });
		const [b0, b1] = facadeB.childrenIds(null);
		facadeB.mergeBlocks(b1, b0);
		await Promise.resolve();

		const resolved = edytor.selection.resolveTextAnchor(anchor);
		expect(resolved).not.toBeNull();
		// 'second' merged into 'first' → caret at 'first|second' offset 5+2.
		expect(resolved.text.parent.id).toBe(b0);
		expect(resolved.offset).toBe(7);
	});

	test('caret anchor follows a remote split of the caret block', async () => {
		const { edytor } = createTestEdytor(
			<root>
				<paragraph>abcdef</paragraph>
			</root>
		);
		const B = new edytor.doc.constructor();
		pump(edytor.doc, B);
		prime(edytor, B);

		const text = edytor.root.children[0].content[0];
		const anchor = edytor.selection.createTextAnchor(text, 5, 'left');
		const facadeB = edytor.crdt.doc.create(B, { defaultType: 'paragraph' });
		const bId = facadeB.childrenIds(null)[0];
		facadeB.splitBlock(bId, 3, 'b-remote-split');
		await Promise.resolve();

		const resolved = edytor.selection.resolveTextAnchor(anchor);
		expect(resolved).not.toBeNull();
		// Offset 5 lands in the second half ('def' at offset 2).
		expect(resolved.offset).toBe(2);
	});
});

describe('gate3: lifecycle — listener retention on external doc/awareness', () => {
	test('Edytor.destroy() releases every listener the editor registered on shared objects', () => {
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);
		const editors = [];
		const fixture = (
			<root>
				<paragraph>x</paragraph>
			</root>
		);

		const updatesBefore = observerCount(doc, 'update');
		const awarenessBefore = observerCount(awareness, 'change') + observerCount(awareness, 'update');

		for (let i = 0; i < 5; i++) {
			editors.push(createTestEdytor(fixture, { doc, awareness }).edytor);
		}

		// U4b/F2: `{doc}` goes through `attachDocument`'s raw-doc dedupe —
		// all five editors compose ONE EdytorDocument, so the doc-level
		// listeners (facade updateHandler, undo-manager observers) are
		// registered ONCE. arch-v2 G0 (L61) deleted the view's dead
		// `refreshRemotePresence` awareness subscription (it bumped a
		// revision nothing read), so a view holds no awareness listener;
		// `destroy()` must still release everything it did register.
		expect(editors[1].document).toBe(editors[0].document);
		expect(observerCount(doc, 'update') - updatesBefore).toBeGreaterThanOrEqual(1);
		expect(
			observerCount(awareness, 'change') + observerCount(awareness, 'update') - awarenessBefore
		).toBe(0);
		expect(typeof editors[0].destroy).toBe('function');

		for (const editor of editors) {
			editor.destroy();
		}

		// Counts return to baseline — nothing on the shared doc/awareness
		// retains the dead editors (facade dispose + awareness off + undo
		// manager teardown all ran inside destroy()).
		expect(observerCount(doc, 'update')).toBe(updatesBefore);
		expect(observerCount(awareness, 'change') + observerCount(awareness, 'update')).toBe(
			awarenessBefore
		);

		// Idempotent — a second destroy is a no-op, not a crash.
		expect(() => editors[0].destroy()).not.toThrow();
		expect(observerCount(doc, 'update')).toBe(updatesBefore);
	});
});
