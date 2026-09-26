/**
 * U2 — the retired per-edit capture pipeline is gone: ordinary editing
 * performs NO attribution writes. One engine update per keystroke, zero
 * `a/` records, no run-level authorship decoration, no authorship-boundary
 * run splitting. `blockattr` (U1) is the durable attribution that remains.
 */
import { describe, expect, it } from 'vitest';
import {
	applyUpdate,
	docValue,
	firstBlock,
	recordKeys,
	wireDocs,
	authoredDocument
} from './helpers.js';
import {
	createDocument,
	loadDocument,
	type DocumentActor,
	type EdytorDocument
} from '../../../lib/crdt/index.js';

const alice: DocumentActor = { id: 'alice', name: 'Alice', color: '#a11' };
const bob: DocumentActor = { id: 'bob', name: 'Bob', color: '#1b1' };

/** Count `update` events on `document.doc` while `fn` runs. */
const countUpdates = (document: EdytorDocument, fn: () => void): number => {
	let n = 0;
	const on = () => n++;
	document.doc.on('update', on);
	try {
		fn();
	} finally {
		document.doc.off('update', on);
	}
	return n;
};

/** Deep-scan a JSON/projection payload for any `attribution` key. */
const hasAttributionKey = (value: unknown): boolean => {
	if (value === null || typeof value !== 'object') return false;
	if (Array.isArray(value)) return value.some(hasAttributionKey);
	return (
		Object.prototype.hasOwnProperty.call(value, 'attribution') ||
		Object.values(value).some(hasAttributionKey)
	);
};

describe('U2 — ordinary editing writes no attribution', () => {
	it('ten+ consecutive keystrokes → exactly 1 update each and zero a/ records', () => {
		const d = authoredDocument(docValue(''), alice);
		const block = firstBlock(d);
		expect(recordKeys(d)).toHaveLength(0);

		const typed = 'hello world';
		const updates = countUpdates(d, () => {
			for (let i = 0; i < typed.length; i++) {
				d.transact(() => d.facade.insertText(block.id, i, typed[i]!));
			}
		});
		// One engine transaction per keystroke — the `l` stamp + `b/`
		// contributor write ride inside it; no attribution follow-up update.
		expect(updates).toBe(typed.length);
		expect(recordKeys(d)).toHaveLength(0);
		expect(d.attribution.legacy()).toBeNull();
		expect(d.facade.blockText(block.id)).toBe('hello world');
		d.destroy();
	});

	it('bare facade ops (no document.transact wrapper) are also one update each', () => {
		const d = authoredDocument(docValue(''), alice);
		const block = firstBlock(d);
		const updates = countUpdates(d, () => {
			d.facade.insertText(block.id, 0, 'a');
			d.facade.insertText(block.id, 1, 'b');
			d.facade.insertText(block.id, 2, 'c');
		});
		expect(updates).toBe(3);
		expect(recordKeys(d)).toHaveLength(0);
		d.destroy();
	});

	it('two actors typing into one block — runs stay merged, no attribution field anywhere', () => {
		const a = authoredDocument(docValue('hi'), alice);
		const block = firstBlock(a);
		const b = createDocument({ actor: bob });
		applyJoin(a, b);
		const unwire = wireDocs(a, b);

		a.facade.insertText(block.id, 2, 'AA');
		b.facade.insertText(block.id, 4, 'BB');

		// One merged run per mark set — no authorship boundary splitting.
		const runs = a.facade.runs(block.id);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toEqual({ kind: 'text', text: 'hiAABB' });
		expect(hasAttributionKey(runs)).toBe(false);
		expect(hasAttributionKey(a.facade.contentItems(block.id))).toBe(false);
		expect(hasAttributionKey(a.facade.project())).toBe(false);
		expect(hasAttributionKey(a.facade.toJSON())).toBe(false);
		expect(hasAttributionKey(a.facade.contentJSON(block.id))).toBe(false);
		// The peer's projection agrees — and neither side wrote a/ records.
		expect(b.facade.runs(block.id)).toEqual(runs);
		expect(recordKeys(a)).toHaveLength(0);
		expect(recordKeys(b)).toHaveLength(0);
		// Authorship still lands — at the BLOCK level (U1).
		expect(a.attribution.block(block.id)?.lastChangedBy).toBe('bob');
		expect([...a.attribution.block(block.id)!.contributors].sort()).toEqual(['alice', 'bob']);

		unwire();
		a.destroy();
		b.destroy();
	});

	it('undo/redo across typed edits stays one update per step', () => {
		const d = authoredDocument(docValue('hi'), alice);
		const block = firstBlock(d);
		d.transact(() => d.facade.insertText(block.id, 2, '!'));
		expect(d.facade.blockText(block.id)).toBe('hi!');

		const undoUpdates = countUpdates(d, () => d.history.undo());
		expect(undoUpdates).toBe(1);
		expect(d.facade.blockText(block.id)).toBe('hi');
		const redoUpdates = countUpdates(d, () => d.history.redo());
		expect(redoUpdates).toBe(1);
		expect(d.facade.blockText(block.id)).toBe('hi!');
		expect(recordKeys(d)).toHaveLength(0);
		d.destroy();
	});

	it('document.attribution exposes the dictionary + block reads without a capture pipeline', () => {
		const d = authoredDocument(docValue('hi'), alice);
		const block = firstBlock(d);
		expect(d.attribution.actorOf(d.clientID)).toBe('alice');
		expect(d.attribution.actors.get('alice')).toEqual({ name: 'Alice', color: '#a11' });
		expect(d.attribution.block(block.id)).toMatchObject({ createdBy: 'alice' });
		d.attribution.setProfile({ name: 'Alice L.' });
		expect(d.attribution.actors.get('alice')?.name).toBe('Alice L.');
		// Dictionary writes are the only a/-adjacent traffic — never `a/` keys.
		expect(recordKeys(d)).toHaveLength(0);
		d.destroy();
	});

	it('encode → load keeps a document with no a/ state clean of it', () => {
		const d = authoredDocument(docValue('hi'), alice);
		const block = firstBlock(d);
		d.transact(() => d.facade.insertText(block.id, 2, '!'));
		const restored = loadDocument(d.encode(), { actor: bob });
		expect(recordKeys(restored)).toHaveLength(0);
		expect(restored.attribution.legacy()).toBeNull();
		restored.destroy();
		d.destroy();
	});
});

/** Full-state hydration + `sync()` — the "peer joined late" path. */
const applyJoin = (a: EdytorDocument, b: EdytorDocument): void => {
	applyUpdate(b.doc, a.encode());
	b.sync();
};
