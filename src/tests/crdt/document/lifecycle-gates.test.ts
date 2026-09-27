/**
 * Lifecycle gates — the review pins (D9, D14, D15, D4-document-side):
 *
 * - D9: `facade.onChange` detaches the doc `update` listener and drops the
 *   diff baseline when the last subscriber leaves — commits while
 *   unsubscribed must perform no diff work, and the next subscription
 *   re-baselines lazily.
 * - D14: `document.transact` and every facade mutation throw after
 *   teardown (`DocumentDestroyedError` / `EdytorDocDisposedError`); reads
 *   stay dead-safe.
 * - D15: while a provider owns the pending window the document is the only
 *   owner of "pending" — `history` refuses (`DocumentNotReadyError`). The
 *   facade twin (`EdytorDocSyncPendingError`) is deleted (arch-v2 T3, L56).
 * - D4/`failed`: a terminal provider failure releases the pending claim;
 *   once every attached provider settled without syncing, the document
 *   decides itself (R13) and `whenDocumentReady` wakes on that one event.
 *   (arch-v2 T2 deletes the hand-back of the decision to the views, L56.)
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import {
	attachDocument,
	createDocument,
	DocumentDestroyedError,
	DocumentNotReadyError,
	EdytorDocDisposedError,
	type EdytorSync
} from '../../../lib/crdt/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { whenDocumentReady } from '../../../lib/collaboration/documentSync.js';
import type { JSONDoc } from '../../../lib/utils/json.js';
import { DEFAULT_SEED_ID } from '../default-seed.js';

const E = bindEdytorDoc(Y);

const docValue = (text = 'hello'): JSONDoc => ({
	children: [{ type: 'paragraph', content: [{ text }] }]
});

/** A provider factory that captures its payload for manual driving. */
const fakeSync = () => {
	let captured: { synced: (p?: unknown) => void; failed: (r?: unknown) => void } | undefined;
	const sync: EdytorSync = (payload) => {
		// `failed` is optional on the payload — the fake narrows it to
		// required so tests can invoke `provider().failed(...)` directly.
		captured = payload as typeof captured;
	};
	return { sync, provider: () => captured! };
};

describe('D9 — onChange teardown', () => {
	it('detaches the update listener when the last subscriber leaves', () => {
		const document = createDocument({ value: docValue() });
		const doc = document.doc as unknown as {
			on: (name: string, f: (...args: never[]) => void) => void;
			off: (name: string, f: (...args: never[]) => void) => void;
		};
		// Count `update` registrations made AFTER construction (the facade's
		// `invalidate` was registered inside createDocument, before this
		// patch — it is not part of the counted set).
		let updateListeners = 0;
		const on = doc.on.bind(doc);
		const off = doc.off.bind(doc);
		doc.on = (name, f) => {
			if (name === 'update') updateListeners++;
			return on(name, f);
		};
		doc.off = (name, f) => {
			if (name === 'update') updateListeners--;
			return off(name, f);
		};
		try {
			const seen: unknown[] = [];
			const unsub = document.facade.onChange((c) => seen.push(c));
			expect(updateListeners).toBe(1);

			unsub();
			unsub(); // idempotent — the detach path must not double-off
			expect(updateListeners).toBe(0);

			// Commit while unsubscribed: no listener → no diff work, and
			// nothing is queued for a later subscriber.
			const [block] = document.facade.project().children;
			document.facade.insertText(block.id, 0, 'while-away ');
			expect(seen).toHaveLength(0);

			// Re-subscription re-baselines lazily: the listener reattaches and
			// only post-resubscribe commits are diffed — 'while-away' is
			// folded into the new baseline, never delivered.
			const seen2: { content: Map<string, unknown> }[] = [];
			const unsub2 = document.facade.onChange((c) => seen2.push(c));
			expect(updateListeners).toBe(1);
			document.facade.insertText(block.id, 0, 'after ');
			expect(seen2).toHaveLength(1);
			expect(seen2[0].content.has(block.id)).toBe(true);

			unsub2();
			expect(updateListeners).toBe(0);
		} finally {
			doc.on = on;
			doc.off = off;
		}
		document.destroy();
	});
});

describe('D14 — post-destroy gates', () => {
	it('document.transact throws after destroy', () => {
		const document = createDocument({ value: docValue() });
		document.destroy();
		expect(() => document.transact(() => {})).toThrowError(DocumentDestroyedError);
		expect(() => document.transact(() => {})).toThrowError(/destroyed/);
	});

	it('facade mutations throw after document.destroy()', () => {
		const document = createDocument({ value: docValue() });
		const [block] = document.facade.project().children;
		document.destroy();
		expect(() => document.facade.insertText(block.id, 0, 'x')).toThrowError(EdytorDocDisposedError);
		expect(() => document.facade.transact(() => {})).toThrowError(EdytorDocDisposedError);
		expect(() => document.facade.init()).toThrowError(EdytorDocDisposedError);
		expect(() => document.facade.createUndoManager()).toThrowError(EdytorDocDisposedError);
	});

	it('facade.dispose() is terminal for writes; reads stay dead-safe', () => {
		const doc = new Y.Doc();
		const facade = E.create(doc);
		facade.init();
		facade.dispose();
		expect(() => facade.insertText(DEFAULT_SEED_ID, 0, 'x')).toThrowError(EdytorDocDisposedError);
		expect(() => facade.transact(() => {})).toThrowError(EdytorDocDisposedError);
		expect(() => facade.createUndoManager()).toThrowError(EdytorDocDisposedError);
		// Reads are deliberately NOT gated — the borrowed doc outlives the
		// facade and stale inspection must keep working.
		expect(facade.isInitialized()).toBe(true);
		expect(facade.project().children).toHaveLength(1);
		doc.destroy();
	});

	it('attachDocument keeps the borrowed doc writable after destroy', () => {
		const doc = new Y.Doc();
		const document = attachDocument(doc);
		document.sync();
		const [block] = document.facade.project().children;
		document.destroy();
		expect(() => document.facade.insertText(block.id, 0, 'x')).toThrowError(EdytorDocDisposedError);
		// The borrowed doc itself is untouched by teardown.
		expect(() => doc.transact(() => {})).not.toThrow();
		doc.destroy();
	});
});

describe('D15 — the document alone owns the pending window (T3, L56)', () => {
	// The facade's `syncPending` twin and `EdytorDocSyncPendingError` are
	// deleted (L56); "pending" has one owner, the document's readiness.
	it('history refuses while a provider owns the pending window; the provider decides', () => {
		const document = createDocument(); // pending — no value
		const { sync, provider } = fakeSync();
		document.attachSync(sync);
		expect(document.syncPending).toBe(true);
		expect(() => document.history).toThrowError(DocumentNotReadyError);
		expect(document.facade.isInitialized()).toBe(false);

		provider().synced(); // the only provider settled on an empty doc → seed
		expect(document.ready).toBe(true);
		expect(document.readiness).toBe('local');
		expect(document.facade.project().children.map((b) => b.id)).toEqual([DEFAULT_SEED_ID]);
		expect(() => document.history).not.toThrow();
		document.destroy();
	});

	it('an explicit document.sync() decides while the provider is still in flight', () => {
		const document = createDocument();
		const { sync } = fakeSync();
		document.attachSync(sync);
		document.sync();
		expect(document.readiness).toBe('local');
		expect(() => document.facade.init()).not.toThrow();
		document.destroy();
	});

	it('a bare pending facade (no provider) is not gated', () => {
		const document = createDocument();
		// The D15 marker is set only by attachSync — a pending document with
		// no provider attached keeps the plain facade contract.
		expect(() => document.facade.init()).not.toThrow();
		document.destroy();
	});
});

describe("provider 'failed' contract (D4 document side)", () => {
	it('failed() of the last pending provider decides the document (R13)', () => {
		const document = createDocument();
		const { sync, provider } = fakeSync();
		let notified = 0;
		const release = whenDocumentReady(document, () => {
			notified++;
		});
		document.attachSync(sync, { value: docValue('seeded') });
		expect(document.syncPending).toBe(true);
		expect(notified).toBe(0); // attaching a provider is not a decision

		// Every attached provider settled and none synced: the document
		// decides once — seed-if-empty with the attach's value — and every
		// waiter wakes on the one readiness event.
		provider().failed(new Error('hydration refused'));
		expect(document.syncPending).toBe(false);
		expect(document.readiness).toBe('local');
		expect(notified).toBe(1);
		expect(JSON.stringify(document.facade.toJSON())).toContain('"seeded"');
		expect(() => document.facade.init()).not.toThrow(); // gate released
		release();
		document.destroy();
	});

	it('a failure while a sibling provider is still pending does not wake waiters early', () => {
		const document = createDocument();
		const first = fakeSync();
		const second = fakeSync();
		let notified = 0;
		const release = whenDocumentReady(document, () => {
			notified++;
		});
		document.attachSync(first.sync);
		document.attachSync(second.sync);
		first.provider().failed(new Error('gave up'));
		expect(document.syncPending).toBe(true); // second still in flight
		expect(notified).toBe(0);

		second.provider().failed(new Error('also failed'));
		expect(document.syncPending).toBe(false);
		expect(notified).toBe(1);
		release();
		document.destroy();
	});

	it('tearing down an unsynced provider releases the claim the same way', () => {
		const document = createDocument();
		let toreDown = false;
		const sync: EdytorSync = () => () => {
			toreDown = true;
		};
		let notified = 0;
		const release = whenDocumentReady(document, () => {
			notified++;
		});
		const cleanup = document.attachSync(sync);
		expect(document.syncPending).toBe(true);
		expect(typeof cleanup).toBe('function');
		(cleanup as () => void)();
		expect(toreDown).toBe(true); // the factory's own cleanup ran
		expect(document.syncPending).toBe(false);
		expect(document.readiness).toBe('local'); // no provider left: decided
		expect(document.facade.project().children.map((b) => b.id)).toEqual([DEFAULT_SEED_ID]);
		expect(notified).toBe(1);
		release();
		document.destroy();
	});

	it('document.destroy() tears the providers down without deciding', () => {
		const document = createDocument();
		let toreDown = false;
		document.attachSync(() => () => {
			toreDown = true;
		});
		document.destroy();
		expect(toreDown).toBe(true);
		expect(document.readiness).toBe('pending');
	});
});
