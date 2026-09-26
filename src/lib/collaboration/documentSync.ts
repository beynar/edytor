/**
 * Shared-document provider attach + readiness wait (U5/F3).
 *
 * A `<Edytor {sync}>` view historically ran its `sync` factory on MOUNT and
 * destroyed the provider on unmount. That is correct while the view owns
 * its document, but wrong when the document is INJECTED and shared:
 * siblings mounting the same `sync` prop would each spawn a provider on
 * one doc, and unmounting the sync-carrying view killed the document's
 * provider while the siblings stayed mounted.
 *
 * For injected documents the `sync` prop therefore attaches through
 * {@link EdytorDocument.attachSync} — the provider is document-lifetime
 * (released by `document.destroy()`, never by a view unmount). Two
 * policies live here:
 *
 * - **Dedupe** — the SAME factory instance attaching twice on one
 *   document is a no-op (siblings sharing one `sync` prop is the common
 *   composition; erroring would punish correct usage). DISTINCT
 *   factories still attach independently (intentional composition like
 *   IndexedDB + websocket). Note the dedupe key is factory IDENTITY —
 *   `createIndexeddbSync('room')` evaluated inline per view produces
 *   distinct factories and does not dedupe.
 *
 * - **Readiness wait** — the view must not `edytor.sync()` while the
 *   document is `pending` (that would seed it locally before the provider
 *   hydrates). {@link whenDocumentReady} is one subscription to the
 *   document's decision: `document.sync()` emits `onReady` on every
 *   decision path (provider `synced`, every provider settled without
 *   syncing, an explicit call).
 */
import type { EdytorDocument, EdytorSync } from '$lib/crdt/index.js';
import type { JSONDoc } from '$lib/utils/json.js';

/** Sync factories already attached per document — dedupe by identity. */
const attachedSyncFactories = new WeakMap<EdytorDocument, Set<EdytorSync>>();

/**
 * Attach a view's `sync` factory to the DOCUMENT (document-lifetime
 * provider — `document.destroy()` runs the cleanup regardless of view
 * teardown). The provider's `synced` runs `document.sync(value)` — the
 * readiness transition, which wakes every view waiting on
 * {@link whenDocumentReady} synchronously.
 *
 * Returns `true` when this call attached the provider, `false` when it
 * was a no-op — the same factory already attached on this document, or
 * the document is destroyed.
 */
export const attachDocumentSync = (
	document: EdytorDocument,
	sync: EdytorSync,
	value?: JSONDoc
): boolean => {
	if (document.destroyed) {
		return false;
	}
	let attached = attachedSyncFactories.get(document);
	if (attached === undefined) {
		attached = new Set();
		attachedSyncFactories.set(document, attached);
	}
	if (attached.has(sync)) {
		return false; // dedupe — one provider per factory per document
	}
	document.attachSync(sync, { value });
	attached.add(sync);
	return true;
};

/**
 * Run `notify` once `document` decides its content state (`ready`), or
 * immediately when it already is. Returns a release function — always call
 * it on view teardown so a dead view stops waiting. A destroyed document
 * never notifies (it drops its readiness waiters).
 */
export const whenDocumentReady = (document: EdytorDocument, notify: () => void): (() => void) => {
	if (document.ready && !document.destroyed) {
		notify();
		return () => {};
	}
	return document.onReady(notify);
};
