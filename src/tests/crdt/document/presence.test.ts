/**
 * U5 — shared awareness presence + document-lifetime sync.
 *
 * One awareness instance per document is shared by every view; actor/user
 * are document-level fields published once; `selections` holds ONE entry
 * per live view, keyed by the key that view minted and written only by it
 * (T6/R1 — a view's own teardown clears its entry; nobody sweeps another
 * view's key). D-16: no legacy `selection` mirror; a peer renders the
 * freshest valid entry.
 *
 * `Awareness.destroy()` is idempotent (F6 — the owned-doc + owned-
 * awareness composition used to double-emit). View-carried `sync`
 * factories attach through `document.attachSync` — one provider per
 * transport target per document, released by `document.destroy()` (F3, T4).
 */
import { describe, expect, it, vi } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import {
	applyAwarenessUpdate,
	attachDocument,
	Awareness,
	createDocument,
	encodeAwarenessUpdate,
	type EdytorDocument
} from '../../../lib/crdt/index.js';
import {
	freshestPublishedSelection,
	publishPresence,
	whenDocumentReady,
	type EdytorSync
} from '../../../lib/collaboration/index.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { noSelection } from '../../../lib/session/selection.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONDoc } from '../../../lib/utils/json.js';

const docValue = (text = 'shared'): JSONDoc => ({
	children: [{ type: 'paragraph', content: [{ text }] }]
});

const makeView = (document: EdytorDocument) => new Edytor({ document, plugins: [richTextPlugin] });

type PresenceSelections = Record<string, { t?: number; start?: unknown }>;

const selectionsOf = (document: EdytorDocument): PresenceSelections =>
	(document.awareness.getLocalState()?.selections ?? {}) as PresenceSelections;

/** The caret offset a peer renders for the document's freshest entry (resolved by `view`). */
const freshestOffset = (document: EdytorDocument, view: Edytor) => {
	const winner = freshestPublishedSelection(selectionsOf(document));
	return winner ? view.selection.resolveTextAnchor(winner.start as never)?.offset : undefined;
};

/** Write the view's caret: `select()` publishes it. */
const publishSelection = (view: Edytor, offset = 0) => {
	view.selection.setAtTextOffset(view.root!.children[0]!.firstText!, offset);
};

describe('shared awareness identity', () => {
	it('views never create their own awareness on an injected document', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		const v2 = makeView(document);
		expect(v1.awareness).toBe(document.awareness);
		expect(v2.awareness).toBe(document.awareness);
		expect(v1.awareness).toBe(v2.awareness);
		v1.destroy();
		v2.destroy();
		document.destroy();
	});

	it('publishes actor/user once at document construction — document-level fields', () => {
		const document = createDocument({
			value: docValue(),
			actor: { id: 'user-7', name: 'Ada', color: '#0ea5e9' }
		});
		const state = document.awareness.getLocalState();
		expect(state?.actor).toEqual({ id: 'user-7', name: 'Ada', color: '#0ea5e9' });
		expect(state?.user).toEqual({ name: 'Ada', color: '#0ea5e9' });
		document.destroy();
	});
});

describe('per-view selection presence', () => {
	it('sibling views publish distinct entries — no clobbering', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		const v2 = makeView(document);

		publishSelection(v1, 1);
		expect(Object.keys(selectionsOf(document))).toHaveLength(1);
		expect(freshestOffset(document, v1)).toBe(1);

		publishSelection(v2, 3);
		const selections = selectionsOf(document);
		expect(Object.keys(selections)).toHaveLength(2);
		// The mirror is the freshest entry (v2's publish has the higher `t`).
		expect(freshestOffset(document, v1)).toBe(3);
		expect(Object.values(selections).every((entry) => typeof entry.t === 'number')).toBe(true);
		expect(new Set(Object.values(selections).map((entry) => entry.t)).size).toBe(2);

		v1.destroy();
		v2.destroy();
		document.destroy();
	});

	it('view teardown drops only its own entry — the sibling caret survives', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		const v2 = makeView(document);

		publishSelection(v1, 1);
		publishSelection(v2, 4);
		expect(Object.keys(selectionsOf(document))).toHaveLength(2);

		v1.destroy(); // clears v1's own key
		const survivors = selectionsOf(document);
		expect(Object.keys(survivors)).toHaveLength(1);
		expect(freshestOffset(document, v2)).toBe(4); // v2's caret is the mirror now

		v2.destroy();
		// Last live view gone — presence fields drop entirely, document
		// fields (actor) survive on the still-alive document.
		expect(document.awareness.getLocalState()?.selections).toBeUndefined();
		expect(document.awareness.getLocalState()?.selection).toBeUndefined();
		expect(document.awareness.getLocalState()?.actor).toBeDefined();
		document.destroy();
	});

	it('a view destroyed without selection teardown still clears its own entry (F-T10, C14)', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		const v2 = makeView(document);

		publishSelection(v1, 2);
		publishSelection(v2, 6);
		v1.selection.destroy = () => {}; // the selection layer's teardown never runs

		v1.destroy(); // no sibling activity needed
		expect(Object.keys(selectionsOf(document))).toEqual([v2.presenceKey]);
		expect(freshestOffset(document, v2)).toBe(6);

		v2.destroy();
		document.destroy();
	});

	it('a sibling publish writes only its own key — no sweep (R1)', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		const v2 = makeView(document);

		publishSelection(v1, 2);
		const entry = selectionsOf(document)[v1.presenceKey];
		v1.destroyed = true; // dead, teardown not run yet: the entry is still v1's to clear

		publishSelection(v2, 6);
		expect(selectionsOf(document)[v1.presenceKey]).toEqual(entry);

		v1.destroyed = false;
		v1.destroy();
		v2.destroy();
		document.destroy();
	});

	it('a cleared (null) selection removes only the publishing view key', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		const v2 = makeView(document);

		publishSelection(v1, 1);
		publishSelection(v2, 5);

		// v1's selection goes null (blur) — its key drops, v2's survives.
		v1.selection.select(noSelection);
		expect(Object.keys(selectionsOf(document))).toHaveLength(1);
		expect(freshestOffset(document, v2)).toBe(5);

		v1.destroy();
		v2.destroy();
		document.destroy();
	});

	it('presence writes never produce doc updates or undo steps', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		let docUpdates = 0;
		document.doc.on('update', () => docUpdates++);

		publishSelection(v1, 2);
		v1.destroy();

		expect(docUpdates).toBe(0); // awareness writes never touch doc state
		expect(document.history.undoStack).toHaveLength(0);
		document.destroy();
	});
});

describe('awareness destroy idempotence (F6)', () => {
	it('document.destroy() destroys owned awareness exactly once', () => {
		const document = createDocument({ value: docValue() });
		const awareness = document.awareness;
		let destroyEmits = 0;
		let removedBroadcasts = 0;
		awareness.on('destroy', () => destroyEmits++);
		awareness.on('update', ({ removed }) => {
			removedBroadcasts += removed.length;
		});

		document.destroy();
		// owned doc destroy re-fires the awareness doc-hook — the guard
		// makes the second invocation a no-op.
		expect(destroyEmits).toBe(1);
		expect(removedBroadcasts).toBe(1);
		expect(awareness.getLocalState()).toBeNull();

		awareness.destroy(); // a direct double-destroy stays a no-op
		expect(destroyEmits).toBe(1);
		expect(removedBroadcasts).toBe(1);
	});

	it('doc.destroy() alone still destroys awareness once', () => {
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);
		let destroyEmits = 0;
		awareness.on('destroy', () => destroyEmits++);
		doc.destroy();
		expect(destroyEmits).toBe(1);
		expect(awareness.getLocalState()).toBeNull();
	});
});

describe('awareness state merge after provider sync', () => {
	it('applies remote awareness updates carrying per-view selections', () => {
		const document = createDocument({ value: docValue() });
		const remoteDoc = new Y.Doc();
		const remoteAwareness = new Awareness(remoteDoc);
		const remoteSelection = { start: 2, end: 2, collapsed: true, reversed: false };
		remoteAwareness.setLocalState({
			user: { name: 'Remote', color: '#dc2626' },
			selections: { 'view-1': { ...remoteSelection, t: 1 } }
		});

		const update = encodeAwarenessUpdate(remoteAwareness, [remoteAwareness.clientID]);
		applyAwarenessUpdate(document.awareness, update, 'test-provider');

		const state = document.awareness.getStates().get(remoteAwareness.clientID);
		expect(state?.user).toEqual({ name: 'Remote', color: '#dc2626' });
		expect((state?.selections as PresenceSelections)['view-1']?.start).toBe(2);
		// Local state untouched by the remote merge.
		expect(document.awareness.getLocalState()?.actor).toBeDefined();

		remoteAwareness.destroy();
		document.destroy();
	});
});

describe('document.attachSync — document-lifetime providers (F3, T4)', () => {
	it('attaches once per target per document — a keyless factory is its own target', () => {
		const document = createDocument();
		let attachCount = 0;
		let cleanups = 0;
		const sync: EdytorSync = (payload) => {
			attachCount++;
			payload.synced();
			return () => {
				cleanups++;
			};
		};

		expect(document.attachSync(sync)).toBeTypeOf('function');
		expect(document.attachSync(sync)).toBeUndefined(); // dedupe no-op
		expect(attachCount).toBe(1);
		expect(document.ready).toBe(true); // synced ran document.sync(value)

		document.destroy();
		expect(cleanups).toBe(1); // released by the document, not a view
	});

	it('distinct factories attach independently (composition, not dedupe)', () => {
		const document = createDocument();
		let attachCount = 0;
		let cleanups = 0;
		const makeSync = (): EdytorSync => (payload) => {
			attachCount++;
			payload.synced();
			return () => {
				cleanups++;
			};
		};

		expect(document.attachSync(makeSync())).toBeTypeOf('function');
		expect(document.attachSync(makeSync())).toBeTypeOf('function');
		expect(attachCount).toBe(2);
		document.destroy();
		expect(cleanups).toBe(2);
	});

	it('attaching on a destroyed document refuses without running the factory', () => {
		const document = createDocument({ value: docValue() });
		document.destroy();
		expect(() =>
			document.attachSync(() => {
				throw new Error('must not run');
			})
		).toThrow(/attachSync/);
	});
});

describe('whenDocumentReady — view readiness wait (F3)', () => {
	it('notifies synchronously on an already-ready document', () => {
		const document = createDocument({ value: docValue() });
		let notified = 0;
		const release = whenDocumentReady(document, () => notified++);
		expect(notified).toBe(1);
		release();
		document.destroy();
	});

	it('notifies after an externally-driven document.sync (local seed)', async () => {
		const document = createDocument(); // pending
		let notified = 0;
		const release = whenDocumentReady(document, () => notified++);
		expect(notified).toBe(0);
		// The doc 'update' fires DURING the seed commit — before _readiness
		// flips — so the poll backstop is what lands this notification.
		document.sync(docValue());
		await vi.waitFor(() => expect(notified).toBe(1));
		release();
		document.destroy();
	});

	it('externally-driven hydrated sync notifies synchronously via onReady', () => {
		const remote = createDocument({ value: docValue('remote') });
		const document = createDocument(); // pending
		Y.applyUpdate(document.doc, remote.encode()); // hydrated, still pending
		expect(document.ready).toBe(false);

		let notified = 0;
		const release = whenDocumentReady(document, () => notified++);
		// Hydrated path — asserts schema, writes nothing to the doc; the
		// onReady event inside document.sync() lands the notification
		// synchronously (no update event, no poll needed).
		document.sync();
		expect(notified).toBe(1);
		release();

		remote.destroy();
		document.destroy();
	});

	it('release stops the wait — a destroyed document never notifies', async () => {
		const document = createDocument();
		let notified = 0;
		const release = whenDocumentReady(document, () => notified++);
		release();
		document.sync();
		expect(notified).toBe(0);
		document.destroy();
	});
});

describe('attachSync + view integration', () => {
	it('a provider attached by one caller wakes every waiting view', () => {
		const remote = createDocument({ value: docValue('hydrated') });
		const document = attachDocument(new Y.Doc());
		let reportSynced: (() => void) | null = null;
		const sync: EdytorSync = ({ synced }) => {
			reportSynced = synced;
			return () => {};
		};

		let v1Inits = 0;
		let v2Inits = 0;
		const release1 = whenDocumentReady(document, () => v1Inits++);
		const release2 = whenDocumentReady(document, () => v2Inits++);

		document.attachSync(sync);
		Y.applyUpdate(document.doc, remote.encode());
		reportSynced!(); // provider reports synced → document.sync + notify

		expect(v1Inits).toBe(1);
		expect(v2Inits).toBe(1);
		expect(document.readiness).toBe('hydrated');

		release1();
		release2();
		remote.destroy();
		document.destroy();
	});

	it('a throwing readiness waiter does not break sibling waiters or synced (U6b/R5)', () => {
		const remote = createDocument({ value: docValue('hydrated') });
		const document = attachDocument(new Y.Doc());
		let reportSynced: (() => void) | null = null;
		const sync: EdytorSync = ({ synced }) => {
			reportSynced = synced;
			return () => {};
		};
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});

		let fired = 0;
		const r1 = whenDocumentReady(document, () => fired++);
		const r2 = whenDocumentReady(document, () => {
			throw new Error('waiter boom');
		});
		const r3 = whenDocumentReady(document, () => fired++);

		document.attachSync(sync);
		Y.applyUpdate(document.doc, remote.encode());
		expect(() => reportSynced!()).not.toThrow();

		expect(fired).toBe(2);
		expect(err).toHaveBeenCalledWith(
			'[edytor-document] ready listener failed; continuing',
			expect.any(Error)
		);

		err.mockRestore();
		r1();
		r2();
		r3();
		remote.destroy();
		document.destroy();
	});
});

describe('presence teardown (U6b/R4, T6)', () => {
	it('clearing a key that holds no entry does not broadcast', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		const v2 = makeView(document);
		publishSelection(v1, 3);

		const spy = vi.spyOn(document.awareness, 'setLocalState');
		v2.destroy(); // v2 never published — nothing to clear
		expect(spy).not.toHaveBeenCalled();

		v1.destroy();
		document.destroy();
	});

	it("a view's teardown broadcasts once and drops the emptied field", () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		publishSelection(v1, 3);

		const spy = vi.spyOn(document.awareness, 'setLocalState');
		v1.destroy();
		expect(spy).toHaveBeenCalledTimes(1);
		expect(document.awareness.getLocalState()?.selections).toBeUndefined();

		document.destroy();
	});
});

describe('publishPresence — write dedupe (U8a)', () => {
	it('does not rebroadcast when the published payload is unchanged', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		publishSelection(v1, 3);

		const t0 = Object.values(selectionsOf(document))[0]?.t;
		expect(typeof t0).toBe('number');

		const spy = vi.spyOn(document.awareness, 'setLocalState');
		publishSelection(v1, 3); // identical caret — same texts, same offsets
		expect(spy).not.toHaveBeenCalled();
		// The entry keeps its original `t` — an identical republish must
		// not steal "freshest" recency.
		expect(Object.values(selectionsOf(document))[0]?.t).toBe(t0);

		v1.destroy();
		document.destroy();
	});

	it('still broadcasts (with a bumped `t`) when the payload changes', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		publishSelection(v1, 3);

		const t0 = Object.values(selectionsOf(document))[0]?.t ?? 0;

		const spy = vi.spyOn(document.awareness, 'setLocalState');
		publishSelection(v1, 4);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(freshestOffset(document, v1)).toBe(4);
		const [entry] = Object.values(selectionsOf(document));
		expect(entry.t).toBeGreaterThan(t0);

		v1.destroy();
		document.destroy();
	});

	it('a deduped republish cannot steal the freshest-mirror slot from a sibling', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		const v2 = makeView(document);
		publishSelection(v1, 1);
		publishSelection(v2, 5); // v2 is freshest

		const spy = vi.spyOn(document.awareness, 'setLocalState');
		publishSelection(v1, 1); // v1 re-emits an UNCHANGED caret
		expect(spy).not.toHaveBeenCalled();
		// v2 stays the freshest — v1's `t` was not re-stamped.
		expect(freshestOffset(document, v1)).toBe(5);

		v1.destroy();
		v2.destroy();
		document.destroy();
	});

	it('a cleared selection still writes once (then dedupes)', () => {
		const document = createDocument({ value: docValue() });
		const v1 = makeView(document);
		publishSelection(v1, 2);

		const spy = vi.spyOn(document.awareness, 'setLocalState');
		v1.selection.select(noSelection);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(document.awareness.getLocalState()?.selections).toBeUndefined();

		publishPresence(document.awareness, v1.presenceKey, null); // already cleared — no-op
		expect(spy).toHaveBeenCalledTimes(1);

		v1.destroy();
		document.destroy();
	});
});
