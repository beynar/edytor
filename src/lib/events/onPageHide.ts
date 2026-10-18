/**
 * The page leaves for good (installed by `Edytor.attach`): a `pagehide` the
 * back/forward cache keeps nothing of. The view tells its document the
 * session's history ended (`document.endHistory()`, `hist.release.end`): the
 * history's rule releases what the session deleted. A page the cache keeps
 * may come back with its history, and a lost connection fires nothing here:
 * both keep it.
 *
 * The page's lifecycle is the sync layer's (`onPageLeave`, which the
 * providers leave by too): the view subscribes to its `write` phase, run
 * before the providers' teardown whatever order they subscribed in, so the
 * release goes out on a socket or store that is still open.
 */
import { onPageLeave } from '../crdt/providers/room.js';
import type { Edytor } from '../edytor.svelte.js';

/** End the view's session when its page leaves for good; answers the teardown. */
export const attachPageHide = (edytor: Edytor): (() => void) =>
	onPageLeave(() => edytor.document.endHistory(), 'write');
