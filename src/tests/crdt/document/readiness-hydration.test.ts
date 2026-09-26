/**
 * Readiness race — adversarial review 2026-09-23, P1-1.
 *
 * A sibling view (readonly, or without a `sync` prop) must not decide a
 * pending injected document's content while a provider hydration is in
 * flight. Only the document's explicit readiness decision or the
 * provider's `synced` path may seed pending shared content. An injected
 * document with NO provider attached is treated as already decided —
 * the editable view's `document.sync()` is the explicit decision.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { attachDocument, createDocument, type EdytorDocument } from '../../../lib/crdt/index.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONDoc } from '../../../lib/utils/json.js';

const docValue = (text = 'remote'): JSONDoc => ({
	children: [{ type: 'paragraph', content: [{ text }] }]
});

const flushMicrotasks = async () => {
	// The readiness waiter's first "decided" check is deferred one
	// microtask so a sibling's provider can attach inside the same
	// synchronous mount flush; a macrotask covers either way.
	await new Promise((resolve) => setTimeout(resolve, 0));
};

const remoteUpdate = (text: string): Uint8Array => {
	const remote = createDocument({ value: docValue(text) });
	const update = remote.encode();
	remote.destroy();
	return update;
};

describe('pending injected document — sibling views never seed early', () => {
	it('a no-sync sibling waits for hydration instead of seeding the document', async () => {
		const document = attachDocument(new Y.Doc());
		let fireSynced!: () => void;
		const hydration = document.attachSync(({ synced }) => {
			fireSynced = synced;
			return () => {};
		});

		// Provider-carrying view (sync: true defers — the component would
		// attach the provider; the document-level attach above plays that
		// role here).
		const carrier = new Edytor({ document, plugins: [richTextPlugin], sync: true });
		void hydration;
		const sibling = new Edytor({
			document,
			plugins: [richTextPlugin],
			value: docValue('sibling-seed')
		});

		// The sibling must NOT have decided the pending document.
		expect(document.readiness).toBe('pending');
		expect(document.facade.isInitialized()).toBe(false);
		expect(sibling.synced).toBe(false);
		expect(carrier.synced).toBe(false);

		// Hydration delivers remote content, then the provider reports synced.
		Y.applyUpdate(document.doc, remoteUpdate('hydrated'), 'remote');
		fireSynced();
		expect(document.readiness).toBe('hydrated');
		await flushMicrotasks();

		expect(sibling.synced).toBe(true);
		// The sync-prop carrier mirrors the decided document too — `sync`
		// controls whether THIS view attaches a provider (component-side,
		// on mount), not whether it binds once a decision lands.
		expect(carrier.synced).toBe(true);
		// Exactly ONE root block — the remote one; no local bootstrap sibling.
		const children = document.facade.project().children;
		expect(children).toHaveLength(1);
		expect(children[0]!.content).toEqual([{ kind: 'text', text: 'hydrated' }]);

		sibling.destroy();
		carrier.destroy();
		document.destroy();
	});

	it('a readonly sibling does not seed — even while hydration is pending', async () => {
		const document = attachDocument(new Y.Doc());
		let fireSynced!: () => void;
		document.attachSync(({ synced }) => {
			fireSynced = synced;
			return () => {};
		});

		const readonlyView = new Edytor({
			document,
			plugins: [richTextPlugin],
			readonly: true,
			sync: true,
			value: docValue('readonly-seed')
		});
		await flushMicrotasks();

		// Readonly never decides: pending stays pending.
		expect(document.readiness).toBe('pending');
		expect(readonlyView.synced).toBe(false);

		Y.applyUpdate(document.doc, remoteUpdate('hydrated'), 'remote');
		fireSynced();
		await flushMicrotasks();

		expect(document.readiness).toBe('hydrated');
		expect(readonlyView.synced).toBe(true);
		expect(document.facade.project().children).toHaveLength(1);

		readonlyView.destroy();
		document.destroy();
	});

	it('an injected document with no provider is treated as already decided', async () => {
		const document = attachDocument(new Y.Doc());
		const view = new Edytor({ document, plugins: [richTextPlugin], value: docValue('solo') });

		// The decision is deferred one task so a provider could still
		// attach in this mount flush — binding is async now.
		expect(view.synced).toBe(false);
		await flushMicrotasks();

		expect(view.synced).toBe(true);
		expect(document.readiness).toBe('local');
		expect(document.facade.project().children[0]!.content).toEqual([
			{ kind: 'text', text: 'solo' }
		]);

		view.destroy();
		document.destroy();
	});

	it('a readonly view on a provider-less pending doc waits for an explicit decision', async () => {
		const document = attachDocument(new Y.Doc());
		const view = new Edytor({
			document,
			plugins: [richTextPlugin],
			readonly: true,
			value: docValue('must-not-seed')
		});
		await flushMicrotasks();

		// Strict-ready: no provider, no decision — the view stays unbound
		// rather than deciding shared content from a display-only view.
		expect(view.synced).toBe(false);
		expect(document.readiness).toBe('pending');

		// The document's explicit decision binds it.
		document.sync(docValue('decided'));
		await flushMicrotasks();
		expect(view.synced).toBe(true);
		expect(document.facade.project().children[0]!.content).toEqual([
			{ kind: 'text', text: 'decided' }
		]);

		view.destroy();
		document.destroy();
	});

	it('attachSync decides readiness inside the synced call itself', () => {
		const document = createDocument();
		let fireSynced!: () => void;
		document.attachSync(({ synced }) => {
			fireSynced = synced;
			return () => {};
		});

		// synced fires → document.sync runs inside it (readiness decided
		// before the provider's synced call returns).
		expect(document.ready).toBe(false);
		expect(document.syncPending).toBe(true);
		fireSynced();
		expect(document.ready).toBe(true);
		expect(document.syncPending).toBe(false);

		document.destroy();
	});

	it('view teardown releases a pending readiness wait', async () => {
		const document = attachDocument(new Y.Doc());
		const view = new Edytor({ document, plugins: [richTextPlugin], value: docValue('x') });
		expect(view.synced).toBe(false);
		view.destroy();

		// The dead view's waiter must not resurrect — a later decision
		// must not throw through a released notify.
		document.sync(docValue('decided'));
		await flushMicrotasks();
		expect(view.synced).toBe(false);
		document.destroy();
	});

	it('a destroyed document clears waiting views without notifying', async () => {
		const document = attachDocument(new Y.Doc());
		const view = new Edytor({ document, plugins: [richTextPlugin], value: docValue('x') });
		expect(view.synced).toBe(false);
		document.destroy();
		await flushMicrotasks();
		expect(view.synced).toBe(false);
		view.destroy();
	});
});
