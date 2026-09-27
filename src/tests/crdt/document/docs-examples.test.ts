/**
 * U9 — the published document examples exercised against the shipped API.
 *
 * `docs/crdt-v14-document.md` + the README show `createDocument` /
 * `loadDocument` / `attachDocument` / `attachSync` / `history` /
 * `attribution` snippets. This suite runs those same flows so doc drift
 * fails a test here instead of a consumer. Imports mirror the doc's
 * `edytor/crdt/edytor` surface (`$lib/crdt/index.js` in-repo).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import {
	attachDocument,
	bindCrdt,
	createDocument,
	DocumentNotReadyError,
	loadDocument,
	type JSONDoc
} from '../../../lib/crdt/index.js';

const docValue = (text = 'hello', id = 'p1'): JSONDoc => ({
	children: [{ type: 'paragraph', id, content: [{ text }] }]
});

describe('docs: headless create → edit → undo → encode → load', () => {
	it('runs the documented flow verbatim', () => {
		const document = createDocument({
			value: docValue(),
			actor: { id: 'user-42', name: 'Ada', color: '#7559ee' }
		});
		expect(document.ready).toBe(true);
		expect(document.readiness).toBe('local');

		const [block] = document.facade.project().children;
		expect(block.id).toBe('p1');
		document.transact(() => document.facade.insertText(block.id, 5, ' world'));
		expect(document.facade.blockText(block.id)).toBe('hello world');

		document.history.undo();
		expect(document.facade.blockText(block.id)).toBe('hello');
		document.history.redo();
		expect(document.facade.blockText(block.id)).toBe('hello world');

		const saved = document.encode();
		const restored = loadDocument(saved);
		expect(restored.readiness).toBe('hydrated');
		expect(restored.facade.toJSON()).toEqual(document.facade.toJSON());

		document.destroy();
		restored.destroy();
	});

	it('a value-less document stays pending until sync() decides content', () => {
		const document = createDocument();
		expect(document.readiness).toBe('pending');
		// Reads are legal while pending; the gated service refuses typed.
		expect(document.facade.project().children).toHaveLength(0);
		expect(() => document.history).toThrowError(DocumentNotReadyError);
		document.sync({ children: [] });
		expect(document.readiness).toBe('local');
		document.destroy();
	});
});

describe('docs: attachDocument around a caller-owned doc', () => {
	it('borrows the doc and never destroys it', () => {
		const doc = new Y.Doc();
		const document = attachDocument(doc, { actor: { id: 'user-42' } });
		expect(document.doc).toBe(doc);
		expect(document.readiness).toBe('pending');
		document.sync();
		expect(document.readiness).toBe('local');
		document.destroy();
		// The borrowed doc outlives the document — a second attach heals.
		const reattached = attachDocument(doc);
		expect(reattached.doc).toBe(doc);
		reattached.destroy();
		doc.destroy();
	});

	it('dedupes a reattach onto the same document', () => {
		const doc = new Y.Doc();
		const a = attachDocument(doc);
		const b = attachDocument(doc);
		expect(b).toBe(a);
		a.destroy(); // releases one reference — document survives
		expect(a.destroyed).toBe(false);
		b.destroy(); // last reference tears it down
		expect(a.destroyed).toBe(true);
		doc.destroy();
	});
});

describe('docs: attachSync drives readiness through a sync factory', () => {
	it('runs the documented provider-attach contract', async () => {
		const crdt = bindCrdt(Y);
		const document = createDocument();
		expect(document.readiness).toBe('pending');

		const cleanup = document.attachSync(crdt.providers.createIndexeddbSync('u9-docs-example'), {
			value: { children: [] }
		});
		expect(cleanup).toBeTypeOf('function');

		// fake-indexeddb hydrates an empty room → synced → seed-if-empty.
		await vi.waitFor(() => expect(document.readiness).not.toBe('pending'), {
			timeout: 5_000
		});
		expect(document.readiness).toBe('local');
		expect(document.facade.project().children.length).toBeGreaterThan(0);

		// The tracked provider cleanup runs under document.destroy().
		document.destroy();
	});
});

describe('docs: attribution + actor reads', () => {
	it('resolves the actor and stamps block-level attribution on committed edits', () => {
		const document = createDocument({
			value: docValue(),
			actor: { id: 'user-42', name: 'Ada', color: '#7559ee' }
		});
		expect(document.attribution.actorOf(document.clientID)).toBe('user-42');
		expect(document.attribution.actors.get('user-42')).toEqual({
			name: 'Ada',
			color: '#7559ee'
		});
		const [block] = document.facade.project().children;
		document.transact(() => document.facade.insertText(block.id, 5, '!'));
		// U1 compact block attribution — the edit's author stamps the block.
		// The seed itself carries no stamp (R13 §2.1, D-3): no `createdBy`.
		expect(document.attribution.block(block.id)).toMatchObject({
			createdBy: undefined,
			contributors: new Set(['user-42']),
			lastChangedBy: 'user-42'
		});
		// U2 — no per-edit capture records on a fresh document.
		expect(document.attribution.legacy()).toBeNull();
		document.destroy();
	});
});
