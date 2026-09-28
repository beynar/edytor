/**
 * U1 — views sharing one assembled document.
 *
 * The contract: every `Edytor` bound to the same `EdytorDocument` shares ONE
 * facade (one maintained run view), ONE history manager and ONE awareness —
 * while keeping view-local state (transaction origin, mirror, selection)
 * independent. View teardown releases only view-lifetime resources; the
 * document's services and semantics outlive any single view.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import {
	attachDocument,
	Awareness,
	createDocument,
	SemanticConflictError,
	type EdytorDocument
} from '../../../lib/crdt/index.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { BlockDefinition, Plugin } from '../../../lib/plugins.js';
import type { JSONDoc } from '../../../lib/utils/json.js';

const docValue = (text = 'shared'): JSONDoc => ({
	children: [{ type: 'paragraph', content: [{ text }] }]
});

/** First-root-block text of a view's JSON export (the mirror's view). */
const firstBlockText = (view: Edytor): string =>
	(view.value.children[0]?.content ?? [])
		.filter((part): part is { text: string } => 'text' in part)
		.map((part) => part.text)
		.join('');

const makeView = (document: EdytorDocument, plugins: Plugin[] = [richTextPlugin]) =>
	new Edytor({ document, plugins });

const makeViews = (document: EdytorDocument, count: number) =>
	Array.from({ length: count }, () => makeView(document));

const destroyAll = (...views: Edytor[]) => views.forEach((view) => view.destroy());

describe('views sharing one document', () => {
	it.each([1, 2, 10])('%i view(s) share one facade/runs/awareness/history', (count) => {
		const document = createDocument({ value: docValue() });
		const views = makeViews(document, count);

		for (const view of views) {
			expect(view.document).toBe(document);
			expect(view.doc).toBe(document.doc);
			// One facade per document ⇒ one maintained run view lease. A view
			// reads it through its lens (its virtual paragraph, `doc.empty.virtual`).
			expect(Object.getPrototypeOf(view.facade)).toBe(document.facade);
			expect(view.awareness).toBe(document.awareness);
			expect(view.undoManager).toBe(document.history);
			expect(view.synced).toBe(true);
			expect(view.ownsDocument).toBe(false);
		}

		views.forEach((view) => view.destroy());
		expect(document.destroyed).toBe(false);
		document.destroy();
	});

	it('an edit through one view mirrors into the sibling views', () => {
		const document = createDocument({ value: docValue('one') });
		const [v1, v2, v3] = makeViews(document, 3);
		const [block] = document.facade.project().children;

		v1.transact(() => v1.facade.insertText(block.id, 3, ' TWO'));

		expect(firstBlockText(v2)).toBe('one TWO');
		expect(firstBlockText(v3)).toBe('one TWO');

		destroyAll(v1, v2, v3);
		document.destroy();
	});

	it('shared history captures every view’s local-edit origin', () => {
		const document = createDocument({ value: docValue('x') });
		const [v1, v2] = makeViews(document, 2);
		const [block] = document.facade.project().children;

		// View-local transaction origins differ (the mirror can still tell a
		// view's own commits apart), but one history tracks them all.
		expect(v1.transaction).not.toBe(v2.transaction);
		v1.transact(() => v1.facade.insertText(block.id, 1, 'a'));
		document.history.stopCapturing();
		v2.transact(() => v2.facade.insertText(block.id, 2, 'b'));
		expect(firstBlockText(v2)).toBe('xab');

		expect(document.history.undoStack.length).toBe(2);
		document.history.undo(); // v2's edit — most recent
		expect(firstBlockText(v1)).toBe('xa');
		document.history.undo(); // v1's edit
		expect(firstBlockText(v2)).toBe('x');

		v1.destroy();
		v2.destroy();
		document.destroy();
	});

	it('unmounting one view preserves the siblings’ services', () => {
		const document = createDocument({ value: docValue() });
		const [v1, v2] = makeViews(document, 2);

		v1.destroy();

		// Nothing document-level died with the view.
		expect(document.destroyed).toBe(false);
		expect(document.doc.isDestroyed).toBe(false);
		expect(document.awareness.getLocalState()).not.toBeNull();

		const [block] = document.facade.project().children;
		v2.transact(() => v2.facade.insertText(block.id, 0, 'still '));
		expect(firstBlockText(v2)).toBe('still shared');

		// History still works — the dead view is not a hole in the service.
		document.history.stopCapturing();
		document.history.undo();
		expect(firstBlockText(v2)).toBe('shared');

		v2.destroy();
		document.destroy();
	});

	it('structural rules seeded by a view survive its teardown', () => {
		const document = createDocument({
			value: { children: [{ type: 'divider' }] }
		});
		const v1 = makeView(document); // richTextPlugin declares divider void
		const [block] = document.facade.project().children;
		expect(block.type).toBe('divider');
		expect(document.facade.isVoid(block.id)).toBe(true);

		v1.destroy();

		// The rule is document-level — enforcement outlives the view.
		expect(document.facade.isVoid(block.id)).toBe(true);
		expect(
			document.facade.insertBlock({ parent: block.id, index: 0 }, { id: 'x', type: 'paragraph' })
				.status
		).toBe('refused');

		// A sibling attaching later inherits the adopted rules (compatible
		// re-declaration is a no-op, not a conflict).
		const v2 = makeView(document);
		expect(document.facade.isVoid(block.id)).toBe(true);
		v2.destroy();
		document.destroy();
	});

	it('a view with incompatible rules errors instead of silently winning', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document); // adopts divider={void:true} …
		v1.destroy();

		const dividerNotVoid: Plugin = () => ({
			blocks: { divider: { void: false } as unknown as BlockDefinition }
		});
		expect(() => makeView(document, [dividerNotVoid])).toThrowError(SemanticConflictError);
		document.destroy();
	});

	it('rejects `document` combined with separate `doc`/`awareness`', () => {
		const document = createDocument();
		expect(
			() => new Edytor({ document, doc: new Y.Doc(), plugins: [richTextPlugin] })
		).toThrowError(/cannot be combined/);
		expect(
			() => new Edytor({ document, awareness: undefined, doc: new Y.Doc(), plugins: [] })
		).toThrowError(/cannot be combined/);
		expect(() => new Edytor({ document, actor: { id: 'u1' }, plugins: [] })).toThrowError(
			/cannot be combined/
		);
		document.destroy();
	});

	it('an owned document takes the view `actor` (identity + presence profile)', () => {
		const view = new Edytor({ actor: { id: 'u1', name: 'Ada' }, plugins: [richTextPlugin] });
		expect(view.document.actor.id).toBe('u1');
		expect(view.document.awareness.getLocalState()?.user?.name).toBe('Ada');
		view.destroy();
	});
});

describe('view-owned vs borrowed teardown', () => {
	it('a borrowed raw doc survives the view that internally owns a document around it', () => {
		const raw = new Y.Doc();
		const view = new Edytor({ doc: raw, plugins: [richTextPlugin], value: docValue() });
		expect(view.ownsDocument).toBe(true);
		expect(view.synced).toBe(true);

		view.destroy();
		expect(view.document.destroyed).toBe(true);
		// Borrowing granted no destruction authority — the caller's doc lives.
		expect(raw.isDestroyed).toBe(false);

		// …and the same raw doc composes a fresh document afterward.
		const next = attachDocument(raw);
		expect(next.facade.isInitialized()).toBe(true);
		next.destroy();
		expect(raw.isDestroyed).toBe(false);
	});

	it('a view-owned document is released exactly once with the view', () => {
		const view = new Edytor({ plugins: [richTextPlugin], value: docValue() });
		const document = view.document;
		view.destroy();
		view.destroy(); // safe
		expect(document.destroyed).toBe(true);
		// The view-created awareness was owned by the document — dropped.
		expect(document.awareness.getLocalState()).toBeNull();
	});

	it('an injected awareness is borrowed — never destroyed by the view', () => {
		const raw = new Y.Doc();
		const awareness = new Awareness(raw);
		const view = new Edytor({
			doc: raw,
			awareness,
			plugins: [richTextPlugin],
			value: docValue()
		});
		expect(view.awareness).toBe(awareness);

		view.destroy();
		expect(view.document.destroyed).toBe(true);
		// The caller's awareness survives — it was only borrowed.
		expect(awareness.getLocalState()).not.toBeNull();
		awareness.destroy();
	});

	it('the sync-prop path keeps deferral — no premature seed', () => {
		// A pending document a provider may still hydrate.
		const document = attachDocument(new Y.Doc());
		const view = new Edytor({
			document,
			plugins: [richTextPlugin],
			sync: true,
			value: docValue('deferred')
		});

		// Nothing seeded — the provider's `synced` callback hasn't fired.
		expect(view.synced).toBe(false);
		expect(document.readiness).toBe('pending');
		expect(document.facade.isInitialized()).toBe(false);
		expect(document.facade.project().children).toHaveLength(0);

		// The same call the component's synced callback makes.
		view.sync(docValue('deferred'));
		expect(view.synced).toBe(true);
		expect(document.readiness).toBe('local');
		expect(firstBlockText(view)).toBe('deferred');

		view.destroy();
		document.destroy();
	});
});

describe('attachDocument dedupe — one document per raw doc', () => {
	it('reattaching the same raw doc returns the live document and retains a reference', () => {
		const raw = new Y.Doc();
		const first = attachDocument(raw);
		const second = attachDocument(raw);
		expect(second).toBe(first);

		// Each attach holds one reference: the first release leaves the
		// document serving, the second tears it down.
		first.destroy();
		expect(first.destroyed).toBe(false);
		second.destroy();
		expect(second.destroyed).toBe(true);
		expect(raw.isDestroyed).toBe(false); // borrowed — never doc.destroy()ed
	});

	it('a divergent reattach raises SemanticConflictError instead of forking', () => {
		const raw = new Y.Doc();
		const awarenessA = new Awareness(raw);
		const awarenessB = new Awareness(raw);
		const document = attachDocument(raw, { awareness: awarenessA });

		expect(() => attachDocument(raw, { awareness: awarenessB })).toThrowError(
			SemanticConflictError
		);
		expect(() => attachDocument(raw, { actor: { id: 'other' } })).toThrowError(
			SemanticConflictError
		);
		expect(() => attachDocument(raw, { history: { captureTimeout: 1 } })).toThrowError(
			SemanticConflictError
		);
		expect(() => attachDocument(raw, { semantics: { defaultType: 'other' } })).toThrowError(
			SemanticConflictError
		);

		// Compatible reattach still works after the refused attempts.
		expect(attachDocument(raw)).toBe(document);
		document.destroy();
		document.destroy();
		awarenessA.destroy();
		awarenessB.destroy();
	});

	it('compatible semantic contributions on reattach merge additively', () => {
		const raw = new Y.Doc();
		const document = attachDocument(raw, { semantics: { roles: { a: { island: true } } } });
		const again = attachDocument(raw, { semantics: { roles: { b: { void: true } } } });
		expect(again).toBe(document);
		expect(document.semantics.roles.get('a')).toMatchObject({ island: true });
		expect(document.semantics.roles.get('b')).toMatchObject({ void: true });
		document.destroy();
		document.destroy();
	});

	it('createDocument always allocates fresh, but its raw doc is registered', () => {
		const a = createDocument();
		const b = createDocument();
		expect(a).not.toBe(b);
		// Attaching a factory-owned raw doc returns the live document —
		// a second EdytorDocument on one raw doc is impossible.
		expect(attachDocument(a.doc)).toBe(a);
		a.destroy(); // the createDocument reference
		expect(a.destroyed).toBe(false); // the attach reference still holds it
		a.destroy(); // the attach reference — last release tears down
		expect(a.destroyed).toBe(true);
		b.destroy();
	});

	it('two legacy `{doc}` views on one raw doc share the document, released ref-wise', () => {
		const raw = new Y.Doc();
		const v1 = new Edytor({ doc: raw, plugins: [richTextPlugin], value: docValue() });
		const v2 = new Edytor({ doc: raw, plugins: [richTextPlugin] });
		expect(v2.document).toBe(v1.document);

		v1.destroy();
		expect(v1.document.destroyed).toBe(false); // v2's reference keeps it alive
		expect(raw.isDestroyed).toBe(false);
		v2.destroy();
		expect(v1.document.destroyed).toBe(true);
		expect(raw.isDestroyed).toBe(false); // the borrowed raw doc survives
	});
});

describe('view origin tracking lifecycle', () => {
	it('view teardown untracks its origin — future commits from it stop capturing', () => {
		const document = createDocument({ value: docValue('x') });
		const [block] = document.facade.project().children;
		const tracked = () => document.history.trackedOrigins;
		const before = tracked().size;

		const v1 = makeView(document);
		expect(tracked().size).toBe(before + 1);
		v1.transact(() => v1.facade.insertText(block.id, 1, 'a'));
		expect(document.history.undoStack).toHaveLength(1);

		v1.destroy();
		expect(tracked().size).toBe(before);
		// Already-captured work stays undoable — the view's history is
		// not erased with it.
		document.history.undo();
		expect(document.facade.blockText(block.id)).toBe('x');
		// …but a NEW commit under the dead view's origin no longer captures.
		document.doc.transact(() => document.facade.insertText(block.id, 1, 'z'), v1.transaction);
		expect(document.history.undoStack).toHaveLength(0);

		document.destroy();
	});
});

describe('constructor failure cleanup', () => {
	const throwingPlugin: Plugin = () => {
		throw new Error('plugin boom');
	};

	it('an injected document survives a failed view — and gains no stale origin', () => {
		const document = createDocument({ value: docValue() });
		const tracked = () => document.history.trackedOrigins;
		const before = tracked().size;

		expect(() => makeView(document, [throwingPlugin])).toThrowError('plugin boom');
		expect(document.destroyed).toBe(false);
		expect(tracked().size).toBe(before);

		// The document still serves a healthy sibling view.
		const v1 = makeView(document);
		expect(tracked().size).toBe(before + 1);
		v1.destroy();
		document.destroy();
	});

	it('a semantic conflict strands no origin on the injected document', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document); // adopts divider={void:true}
		const tracked = () => document.history.trackedOrigins;
		const before = tracked().size;

		const dividerNotVoid: Plugin = () => ({
			blocks: { divider: { void: false } as unknown as BlockDefinition }
		});
		expect(() => makeView(document, [dividerNotVoid])).toThrowError(SemanticConflictError);
		expect(tracked().size).toBe(before); // adoption failed before enrollment
		expect(document.semantics.roles.get('divider')).toMatchObject({ void: true });

		v1.destroy();
		document.destroy();
	});

	it('a failed view destroys the document it internally owned', () => {
		const raw = new Y.Doc();
		expect(
			() => new Edytor({ doc: raw, plugins: [throwingPlugin], value: docValue() })
		).toThrowError('plugin boom');

		// If the failed view's document leaked, this reattach returns IT —
		// refs 2 — and a single destroy could not tear it down.
		const next = attachDocument(raw);
		next.destroy();
		expect(next.destroyed).toBe(true); // fresh single-reference document
	});
});
