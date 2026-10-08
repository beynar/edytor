/**
 * The facade's change events.
 *
 * ── Change events ──────────────────────────────────────────────────────
 *
 * `onChange` emits one {@link DocChange} per committed transaction (local
 * AND remote — derived from `doc.on('update')`). The payload names exactly
 * what changed: added subtrees, removed ids, moved ids, meta changes,
 * content changes (as maintained runs) and per-parent child-order changes —
 * enough for an independent mirror to apply the diff without re-reading
 * the document. Updates that produce no semantic diff (e.g. a losing
 * placement candidate or a meta-only write) are suppressed.
 */
import { callEach } from '../protocols/observable.js';
import type { IndexReport, RunView } from '../text/runs.js';
import type { DocChange } from './types.js';

/** The change events of one facade over its doc's index. */
export const docEvents = (c: { runsView: RunView }) => {
	const { runsView } = c;

	// ── change events ─────────────────────────────────────────────────

	let changeVersion = 0;
	const subs = new Set<(change: DocChange) => void>();
	let unsubscribe: (() => void) | null = null;
	/** One `DocChange` per commit, from the index's change report (the fold). */
	const emitChange = (report: IndexReport, origin: unknown, local: boolean): void => {
		// Listener isolation: a throwing subscriber never starves the rest.
		callEach('[edytor-doc] change', [...subs], {
			origin,
			local,
			version: ++changeVersion,
			...report
		});
	};

	/**
	 * Subscribe to semantic changes — one {@link DocChange} per committed
	 * transaction that changed the visible document, local and remote.
	 * No writes, ever. Returns an unsubscribe; with no subscriber left the
	 * index stops building reports.
	 * One named exception: the composition session's commit
	 * that re-places its host's block (`session/composition` `restructured`) writes from its subscriber —
	 * safe because the engine queues a transaction opened in an `update`
	 * handler until the current one finishes, so every listener sees the
	 * structural change's report first and the commit's report after it.
	 */
	const onChange = (cb: (change: DocChange) => void): (() => void) => {
		subs.add(cb);
		unsubscribe ??= runsView.onReport(emitChange);
		return () => {
			subs.delete(cb);
			if (subs.size === 0) {
				unsubscribe?.();
				unsubscribe = null;
			}
		};
	};

	/** Stop reporting: every subscriber is dropped. */
	const close = (): void => {
		unsubscribe?.();
		unsubscribe = null;
		subs.clear();
		// The doc's index lives as long as the doc — other facades on it
		// keep reading it.
	};

	return { onChange, close };
};
