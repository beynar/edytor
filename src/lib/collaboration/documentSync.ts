/**
 * View readiness wait (U5/F3).
 *
 * A `<Edytor {sync}>` view attaches its provider to the DOCUMENT
 * ({@link EdytorDocument.attachSync}: document lifetime, one provider per
 * transport target), and must not `edytor.sync()` while the document is
 * `pending` (that would seed it locally before the provider hydrates).
 * {@link whenDocumentReady} is one subscription to the document's
 * decision: `document.sync()` emits `onReady` on every decision path
 * (provider `synced`, every provider settled without syncing, an explicit
 * call).
 */
import type { EdytorDocument } from '$lib/crdt/index.js';

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
