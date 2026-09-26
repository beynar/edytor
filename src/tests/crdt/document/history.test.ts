/**
 * U4 — the document-owned local history contract.
 *
 * Pins the capture policy in `src/lib/crdt/document.ts`:
 *
 * - REMOTE EXCLUSION — every update-integration transaction is non-local
 *   (`transaction.local === false`), so NO remote apply enters the local
 *   undo stack: not provider-stamped, not protocol-default-stamped, and
 *   NOT a raw originless `Y.applyUpdate(doc, u)` (the ADR hole — `null`
 *   stays tracked for untyped LOCAL transactions, so locality, not
 *   origin, is the remote gate).
 * - HYDRATION/BOOTSTRAP — all bootstrap and hydration writes predate
 *   capture (history attaches after init/sync); loaded/hydrated state is
 *   never an undo step.
 * - SELECTIVE OWNERSHIP — headless `document.transact`, untyped local
 *   (`null`-origin) transactions and every enrolled view origin are
 *   captured; untracked origins (repair/bookkeeping) are not.
 * - RETENTION — `clearHistory()` is the pruning surface; stacks are
 *   otherwise unbounded.
 * - PER-VIEW SELECTION SNAPSHOTS — one shared history, independent view
 *   selections: stack-item `meta['cursor-location']` is a Map keyed by
 *   each view's transaction origin, so undo restores the undoing view's
 *   own caret and dead views stop writing.
 */
import { describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import { Y } from '../../../lib/crdt/engine.js';
import { attachDocument, bindSync, createDocument, loadDocument } from '../../../lib/crdt/index.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { getHistorySelectionSnapshot } from '$lib/history/historySelectionSnapshot.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONDoc } from '../../../lib/utils/json.js';

const syncProtocol = bindSync(Y);

const docValue = (text = 'hello'): JSONDoc => ({
	children: [{ type: 'paragraph', content: [{ text }] }]
});

const firstBlock = (document: { facade: { project: () => { children: { id: string }[] } } }) =>
	document.facade.project().children[0];

const blockText = (document: { facade: { blockText: (id: string) => string } }, id: string) =>
	document.facade.blockText(id);

/** Flush the popped-handler's async caret restore (tick + microtasks). */
const flush = async () => {
	await tick();
	await new Promise((r) => setTimeout(r, 0));
	await tick();
};

/** A second replica whose full state hydrates `document`, then pushes live deltas. */
const remotePeer = (seed = 'seed') => {
	const remote = createDocument({ value: docValue(seed) });
	return {
		remote,
		hydrate: (document: { doc: Y.Doc }) => Y.applyUpdate(document.doc, remote.encode()),
		pushDelta: (document: { doc: Y.Doc }, origin?: unknown) =>
			Y.applyUpdate(
				document.doc,
				Y.encodeStateAsUpdate(remote.doc, Y.encodeStateVector(document.doc)),
				origin
			)
	};
};

describe('remote exclusion — no apply path enters local undo', () => {
	it('a raw ORIGINLESS remote applyUpdate is never captured (the ADR hole)', () => {
		const { remote, hydrate, pushDelta } = remotePeer('seed');
		const document = createDocument(); // pending — provider-style hydration
		hydrate(document);
		document.sync();
		expect(document.history.undoStack).toHaveLength(0);

		// A live remote delta applied with NO origin — `null` is a tracked
		// origin, so only the non-local transaction gate can exclude it.
		const [remoteBlock] = remote.facade.project().children;
		remote.transact(() => remote.facade.insertText(remoteBlock.id, 4, ' remote'));
		pushDelta(document); // origin === undefined → null at the engine
		expect(blockText(document, document.facade.project().children[0].id)).toBe('seed remote');
		expect(document.history.undoStack).toHaveLength(0);

		// …while a local edit still captures and undo spares the remote text.
		const [block] = document.facade.project().children;
		document.transact(() => document.facade.insertText(block.id, 0, 'L>'));
		expect(document.history.undoStack).toHaveLength(1);
		document.history.undo();
		expect(blockText(document, block.id)).toBe('seed remote');

		remote.destroy();
		document.destroy();
	});

	it('a remote apply nested inside a LOCAL transact is still excluded', () => {
		const { remote, hydrate, pushDelta } = remotePeer('seed');
		const document = createDocument();
		hydrate(document);
		document.sync();

		const [remoteBlock] = remote.facade.project().children;
		remote.transact(() => remote.facade.insertText(remoteBlock.id, 4, '!'));
		// applyUpdate forces transaction.local = false even when it merges
		// into an in-flight local transaction — the whole commit is
		// non-local and nothing is captured.
		document.transact(() => pushDelta(document));
		expect(document.history.undoStack).toHaveLength(0);

		remote.destroy();
		document.destroy();
	});

	it('protocol inbound applies (readSyncMessage) never capture — stamped or not', () => {
		const { remote, hydrate } = remotePeer('seed');
		const document = createDocument();
		hydrate(document);
		document.sync();

		const [remoteBlock] = remote.facade.project().children;
		remote.transact(() => remote.facade.insertText(remoteBlock.id, 4, ' wire'));

		// Feed the delta through the REAL protocol read path — once with a
		// provider-shaped origin, once with no origin at all (the protocol
		// layer's remoteApplyOrigin default then stamps it).
		for (const origin of [{ provider: true }, undefined] as const) {
			const update = Y.encodeStateAsUpdate(remote.doc, Y.encodeStateVector(document.doc));
			const e = encoding.createEncoder();
			syncProtocol.writeUpdate(e, update);
			const dec = decoding.createDecoder(encoding.toUint8Array(e));
			const enc = encoding.createEncoder();
			syncProtocol.readSyncMessage(dec, enc, document.doc, origin);
			expect(document.history.undoStack).toHaveLength(0);
		}
		expect(blockText(document, firstBlock(document).id)).toBe('seed wire');

		remote.destroy();
		document.destroy();
	});

	it('the protocol remoteApplyOrigin is stamped on unstamped inbound applies', () => {
		const { remote, hydrate } = remotePeer('seed');
		const document = createDocument();
		hydrate(document);
		document.sync();
		const [remoteBlock] = remote.facade.project().children;
		remote.transact(() => remote.facade.insertText(remoteBlock.id, 4, '!'));

		const update = Y.encodeStateAsUpdate(remote.doc, Y.encodeStateVector(document.doc));
		let seenOrigin: unknown;
		const off = (u: Uint8Array, origin: unknown) => {
			seenOrigin = origin;
		};
		document.doc.on('update', off);
		syncProtocol.applyUpdateStaged(document.doc, update, undefined);
		document.doc.off('update', off);
		// No explicit origin → the protocol's per-binding remote marker,
		// never `null` (the ambiguous untyped-local marker).
		expect(seenOrigin).toBe(syncProtocol.remoteApplyOrigin);

		remote.destroy();
		document.destroy();
	});
});

describe('hydration/bootstrap exclusion', () => {
	it('loadDocument: the restored state is never an undo step', () => {
		const source = createDocument({ value: docValue('loaded') });
		const restored = loadDocument(source.encode());
		expect(restored.readiness).toBe('hydrated');
		expect(restored.history.undoStack).toHaveLength(0);
		while (restored.history.undoStack.length > 0) restored.history.undo();
		expect(restored.facade.project().children).toHaveLength(1);

		source.destroy();
		restored.destroy();
	});

	it('attachDocument + hydration before sync(): nothing hydrates into the stack', () => {
		const { remote, hydrate } = remotePeer('hydrated');
		const raw = new Y.Doc();
		const document = attachDocument(raw);
		hydrate(document); // provider-hydrates the borrowed doc, originless
		document.sync();
		expect(document.readiness).toBe('hydrated');
		expect(document.history.undoStack).toHaveLength(0);
		expect(blockText(document, firstBlock(document).id)).toBe('hydrated');

		remote.destroy();
		document.destroy();
	});
});

describe('selective ownership — origins', () => {
	it('untracked local origins are not captured; null/document origins are', () => {
		const document = createDocument({ value: docValue('x') });
		const [block] = document.facade.project().children;

		// Bookkeeping/repair-style write: local transaction, foreign origin.
		document.doc.transact(() => document.facade.insertText(block.id, 1, '?'), Symbol('repair'));
		expect(document.history.undoStack).toHaveLength(0);

		// Untyped local transaction (raw doc.transact → origin null) captures.
		document.doc.transact(() => document.facade.insertText(block.id, 2, 'n'));
		expect(document.history.undoStack).toHaveLength(1);

		// The document's own headless origin captures — stopCapturing keeps
		// it from merging into the previous commit's stack item.
		document.history.stopCapturing();
		document.transact(() => document.facade.insertText(block.id, 3, 'd'));
		expect(document.history.undoStack).toHaveLength(2);

		document.destroy();
	});

	it('history.captureTimeout is honored — 0 keeps every commit separate', () => {
		const merged = createDocument({ value: docValue('x') });
		const [mBlock] = merged.facade.project().children;
		merged.transact(() => merged.facade.insertText(mBlock.id, 1, 'a'));
		merged.transact(() => merged.facade.insertText(mBlock.id, 2, 'b'));
		// Default 500 ms window fuses adjacent commits into one step.
		expect(merged.history.undoStack).toHaveLength(1);
		merged.destroy();

		const split = createDocument({ value: docValue('x'), history: { captureTimeout: 0 } });
		const [sBlock] = split.facade.project().children;
		split.transact(() => split.facade.insertText(sBlock.id, 1, 'a'));
		split.transact(() => split.facade.insertText(sBlock.id, 2, 'b'));
		expect(split.history.undoStack).toHaveLength(2);
		split.destroy();
	});
});

describe('retention — clearHistory', () => {
	it('clears undo and redo stacks; no-op before history attaches', () => {
		const pending = createDocument();
		expect(() => pending.clearHistory()).not.toThrow();
		expect(pending.ready).toBe(false);
		pending.destroy();

		const document = createDocument({ value: docValue('x') });
		const [block] = document.facade.project().children;
		document.transact(() => document.facade.insertText(block.id, 1, 'a'));
		document.history.stopCapturing();
		document.transact(() => document.facade.insertText(block.id, 2, 'b'));
		document.history.undo();
		expect(document.history.undoStack.length).toBeGreaterThan(0);
		expect(document.history.redoStack.length).toBeGreaterThan(0);

		document.clearHistory();
		expect(document.history.undoStack).toHaveLength(0);
		expect(document.history.redoStack).toHaveLength(0);
		// Capture continues after pruning.
		document.transact(() => document.facade.insertText(block.id, 3, 'c'));
		expect(document.history.undoStack).toHaveLength(1);
		document.destroy();
	});

	it('destroy() releases the manager exactly once and gates further access', () => {
		const document = createDocument({ value: docValue('x') });
		const manager = document.history;
		let destroyed = 0;
		document.doc.on('destroy', () => destroyed++);
		document.destroy();
		document.destroy();
		expect(manager.doc.isDestroyed).toBe(true);
		expect(destroyed).toBe(1);
		expect(() => document.history).toThrowError(/destroyed/);
		expect(() => document.clearHistory()).toThrowError(/destroyed/);
	});
});

describe('multi-view shared history — per-view selection snapshots', () => {
	const makeViews = (document: ReturnType<typeof createDocument>, count: number) =>
		Array.from({ length: count }, () => new Edytor({ document, plugins: [richTextPlugin] }));

	it('stack-item meta keys selection snapshots per view — undo restores each view’s own caret', async () => {
		const document = createDocument({ value: docValue('ab') });
		const [v1, v2] = makeViews(document, 2);
		v1.selection.init();
		v2.selection.init();
		const text = v1.root!.children[0]!.firstText!;

		// Each view parks its caret at a different offset, then edits.
		v1.selection.setCollapsedStateAtTextOffset(text, 1);
		v2.selection.setCollapsedStateAtTextOffset(text, 2);
		document.transact(() => document.facade.insertText(v1.root!.children[0]!.id, 2, 'X'));

		const stackItem = document.history.undoStack.at(-1)!;
		const snapshots = stackItem.meta.get('cursor-location') as Map<unknown, unknown>;
		expect(snapshots).toBeInstanceOf(Map);
		// Both live views wrote their OWN snapshot under their origin key.
		expect(snapshots.has(v1.transaction)).toBe(true);
		expect(snapshots.has(v2.transaction)).toBe(true);

		const s1 = getHistorySelectionSnapshot(v1, stackItem)!;
		const s2 = getHistorySelectionSnapshot(v2, stackItem)!;
		expect(s1.yEnd).toBe(1);
		expect(s2.yEnd).toBe(2);

		// POP POLICY (F1/U4b): the shared manager's `stack-item-popped`
		// reaches BOTH views' listeners, but only the ISSUING view restores
		// — undo/redo through `view.historyUndo()/historyRedo()` marks the
		// issuer. For v2 the pop is indistinguishable from a REMOTE undo:
		// its caret is left alone, never regressed to the snapshot it
		// recorded when the undone edit committed.
		v1.selection.setCollapsedStateAtTextOffset(text, 0);
		v2.selection.setCollapsedStateAtTextOffset(text, 0);
		v1.historyUndo();
		await flush();
		expect(v1.selection.state.yStart).toBe(1); // issuer restores its snapshot
		expect(v2.selection.state.yStart).toBe(0); // sibling untouched — not pulled back to 2

		// The popped item moved to the redo side carrying both views'
		// at-undo-time carets — still keyed per view.
		const popped = document.history.redoStack.at(-1)!;
		expect(getHistorySelectionSnapshot(v1, popped)?.yEnd).toBe(0);
		expect(getHistorySelectionSnapshot(v2, popped)?.yEnd).toBe(0);

		v1.selection.destroy();
		v2.selection.destroy();
		v1.destroy();
		v2.destroy();
		document.destroy();
	});

	it('a headless document.history.undo() restores no view caret', async () => {
		const document = createDocument({ value: docValue('ab') });
		const [v1, v2] = makeViews(document, 2);
		v1.selection.init();
		v2.selection.init();
		const text = v1.root!.children[0]!.firstText!;

		v1.selection.setCollapsedStateAtTextOffset(text, 1);
		v2.selection.setCollapsedStateAtTextOffset(text, 2);
		document.transact(() => document.facade.insertText(v1.root!.children[0]!.id, 2, 'X'));

		// No view issued the command — the pop restores nobody; both
		// carets stay where the views parked them.
		v1.selection.setCollapsedStateAtTextOffset(text, 0);
		document.history.undo();
		await flush();
		expect(v1.selection.state.yStart).toBe(0);
		expect(v2.selection.state.yStart).toBe(2);

		v1.selection.destroy();
		v2.selection.destroy();
		v1.destroy();
		v2.destroy();
		document.destroy();
	});

	it('a destroyed view stops writing snapshots — the shared manager no longer holds its handlers', () => {
		const document = createDocument({ value: docValue('ab') });
		const [v1, v2] = makeViews(document, 2);
		v1.selection.init();
		v2.selection.init();
		const [block] = document.facade.project().children;

		v2.selection.destroy(); // detach without tearing down the view

		document.transact(() => document.facade.insertText(block.id, 2, 'X'));
		const stackItem = document.history.undoStack.at(-1)!;
		const snapshots = stackItem.meta.get('cursor-location') as Map<unknown, unknown>;
		expect(snapshots.has(v1.transaction)).toBe(true);
		expect(snapshots.has(v2.transaction)).toBe(false);

		v1.selection.destroy();
		v1.destroy();
		v2.destroy();
		document.destroy();
	});
});
