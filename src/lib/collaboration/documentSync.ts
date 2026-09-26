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
 *   hydrates). {@link whenDocumentReady} fires once the document decides
 *   its content state — `document.sync()` emits the `onReady` event on
 *   every decision path (provider `synced`, local seed, explicit call),
 *   with a poll backstop for any future path that bypasses it.
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
 * immediately when it already is — OR once every pending provider has
 * settled WITHOUT deciding (terminal `failed`, teardown before `synced`,
 * throwing factory): `syncPending` then clears while the document stays
 * `pending`, and the decision returns to the view's own readiness path
 * (its `notify` runs `edytor.sync()` → `document.sync()` — D4's
 * terminal-failure half). Returns a release function — always call it on
 * view teardown so a dead view stops waiting (and polling).
 *
 * Signals: `document.onReady` — the synchronous readiness event every
 * `document.sync()` emits (provider `synced`, local seed, explicit
 * decision); `document.onSyncSettled` — fires when a provider releases
 * its pending claim without a decision; plus a 50 ms poll as a backstop
 * in case a future readiness path bypasses both events.
 */
export const whenDocumentReady = (document: EdytorDocument, notify: () => void): (() => void) => {
	const offReady = document.onReady(() => check());
	const offSettled = document.onSyncSettled(() => check());
	const poll = setInterval(() => check(), 50);
	// A pending readiness wait must never keep a node/SSR process alive.
	(poll as unknown as { unref?: () => void }).unref?.();

	let released = false;
	const release = () => {
		if (released) {
			return;
		}
		released = true;
		offReady();
		offSettled();
		clearInterval(poll);
	};
	const check = () => {
		if (released) {
			return;
		}
		if (document.destroyed) {
			release();
			return;
		}
		// `ready` — the document decided. `syncFailed && !syncPending` —
		// a provider gave up and none remains in flight: notify so the
		// view's sync path makes the decision. Gating on the STICKY
		// `syncFailed` (not bare `!syncPending`) is what keeps this safe
		// before any provider attaches — construction-time `syncPending`
		// is also 0, but nothing has settled yet.
		if (document.ready || (document.syncFailed && !document.syncPending)) {
			release();
			notify();
		}
	};

	check(); // already-ready fast path — notifies synchronously
	return release;
};
