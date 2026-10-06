/**
 * Phase 2, H12 — `requireHydration`: an empty document is decided only by
 * a provider that synced. A provider's bound or failure never seeds it, so
 * a first visit offline writes no `value` (which a different seed in the
 * room would later meet as duplicate blocks); a view keeps it read-only.
 */
import { describe, expect, it } from 'vitest';
import { createDocument, SyncRefusedError, type EdytorSync } from '../../../lib/crdt/index.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONDoc } from '../../../lib/utils/json.js';

const value: JSONDoc = {
	children: [{ id: 'local', type: 'paragraph', content: [{ text: 'seed' }] }]
};
const remote: JSONDoc = {
	children: [{ id: 'room', type: 'paragraph', content: [{ text: 'room' }] }]
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A provider that settles only when the test says: bound `ms`, `synced`/`failed` on demand. */
const controlled = (ms: number) => {
	const handle: { synced?: () => void; failed?: (error: unknown) => void } = {};
	const sync: EdytorSync = Object.assign(
		({ synced, failed }: Parameters<EdytorSync>[0]) => {
			handle.synced = synced;
			handle.failed = (error) => failed?.(error, null);
			return () => {};
		},
		{ bound: ms }
	);
	return { sync, handle };
};

describe('requireHydration (H12)', () => {
	it('without it, a provider bound elapsing seeds the value (the offline first visit)', async () => {
		const document = createDocument();
		const { sync } = controlled(20);
		document.attachSync(sync, { value });
		await wait(40);
		expect(document.readiness).toBe('local');
		expect(document.facade.toJSON().children.map((b) => b.id)).toEqual(['local']);
		document.destroy();
	});

	it('with it, neither a bound nor a failure decides; the first synced does, with the room content', async () => {
		const document = createDocument({ requireHydration: true });
		const { sync, handle } = controlled(20);
		document.attachSync(sync, { value });
		await wait(40);
		handle.failed!(new Error('offline'));
		expect(document.readiness).toBe('pending');
		expect(document.facade.isInitialized()).toBe(false);
		// Online: the room's content arrives, then the provider reports synced.
		const room = createDocument({ value: remote });
		const { Y } = await import('../../../lib/crdt/engine.js');
		Y.applyUpdate(document.doc, room.encode(), 'remote');
		handle.synced!();
		expect(document.readiness).toBe('hydrated');
		expect(document.facade.toJSON().children.map((b) => b.id)).toEqual(['room']);
		room.destroy();
		document.destroy();
	});

	it('with it, an empty room that synced seeds the value; a refusal keeps it pending', async () => {
		const document = createDocument({ requireHydration: true });
		const { sync, handle } = controlled(10);
		document.attachSync(sync, { value });
		await wait(20);
		expect(document.readiness).toBe('pending');
		handle.synced!();
		expect(document.readiness).toBe('local');
		expect(document.facade.toJSON().children.map((b) => b.id)).toEqual(['local']);
		document.destroy();

		const refused = createDocument({ requireHydration: true });
		const second = controlled(Infinity);
		refused.attachSync(second.sync, { value });
		second.handle.failed!(new SyncRefusedError(4403, 'document access denied'));
		expect(refused.readiness).toBe('pending');
		refused.destroy();
	});

	it('a view keeps its document read-only until it is hydrated', async () => {
		const document = createDocument({ requireHydration: true });
		const { sync, handle } = controlled(10);
		document.attachSync(sync, { value });
		const view = new Edytor({ document, plugins: [richTextPlugin], sync: true, value });
		await wait(20);
		expect(view.dispatcher.permits()).toBe(false);
		handle.synced!();
		await wait(0);
		expect(document.ready).toBe(true);
		expect(view.dispatcher.permits()).toBe(true);
		view.destroy();
		document.destroy();
	});

	it('a reattach naming another requireHydration is a conflict', async () => {
		const { attachDocument, SemanticConflictError } = await import('../../../lib/crdt/index.js');
		const { Y } = await import('../../../lib/crdt/engine.js');
		const doc = new Y.Doc();
		const first = attachDocument(doc, { requireHydration: true });
		expect(() => attachDocument(doc, { requireHydration: false })).toThrow(SemanticConflictError);
		expect(attachDocument(doc, { requireHydration: true })).toBe(first);
		first.destroy();
		first.destroy();
	});
});
