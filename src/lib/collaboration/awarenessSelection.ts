import type { Edytor } from '$lib/edytor.svelte.js';
import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
import type { TextAnchor } from '$lib/selection/selection.svelte.js';

export type EdytorAwarenessUser = {
	name?: string;
	color?: string;
};

export type EdytorAwarenessSelection = {
	start: unknown;
	end: unknown;
	startTextId: string;
	endTextId: string;
	yStart: number;
	yEnd: number;
	isCollapsed: boolean;
	isReversed: boolean;
};

/**
 * One entry inside the per-view `selections` map — the selection payload
 * plus the local publish sequence `t`. `t` is a client-local monotonic
 * counter: within one client's presence map a higher `t` is always the
 * more recently changed view selection, which is what remote peers render.
 */
export type EdytorAwarenessViewSelection = EdytorAwarenessSelection & {
	t?: number;
};

export type EdytorAwarenessState = {
	/** Durable actor identity — published once by the document (U5/U6 seam). */
	actor?: { id: string; name?: string; color?: string };
	user?: EdytorAwarenessUser;
	/**
	 * Canonical caret — mirrors the FRESHEST entry of `selections` (same
	 * shape pre-U5 peers read; they see one caret per client, which is the
	 * correct semantic for "where is this actor now").
	 */
	selection?: EdytorAwarenessSelection;
	/**
	 * Per-view presence (U5/F4): one entry per live view of this client,
	 * keyed by a client-local view id. Sibling views share ONE awareness
	 * state slot (one clientID), so a single `selection` field made view
	 * teardown clobber the siblings' published caret — each view now owns
	 * its key and a destroyed view's key is swept without touching the rest.
	 */
	selections?: Record<string, EdytorAwarenessViewSelection>;
};

/**
 * Structural awareness surface used by the selection publish/clear
 * helpers — the real `Awareness` satisfies it; tests may substitute stubs.
 */
type AwarenessLike = {
	getLocalState: () => Record<string, unknown> | null;
	setLocalState: (state: Record<string, unknown> | null) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

/**
 * JSON-value structural equality — the dedupe compare for presence
 * fields (S12, replacing per-emit `JSON.stringify`). Mirrors stringify
 * equivalence without serializing: object key order is ignored (order
 * carries no meaning on the wire) and `undefined`-valued keys are
 * skipped (stringify drops them), so two payloads compare equal exactly
 * when peers could not tell the resulting states apart.
 */
export const jsonValuesEqual = (a: unknown, b: unknown): boolean => {
	if (a === b) {
		return true;
	}
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
		return false;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => jsonValuesEqual(value, (b as unknown[])[index]))
		);
	}
	const aEntries = Object.entries(a).filter(([, value]) => value !== undefined);
	const bRecord = b as Record<string, unknown>;
	const bKeys = Object.keys(bRecord).filter((key) => bRecord[key] !== undefined);
	return (
		aEntries.length === bKeys.length &&
		aEntries.every(([key, value]) => jsonValuesEqual(value, bRecord[key]))
	);
};

/**
 * Validate + coerce one wire-shaped selection entry — a `selections`
 * map value or the legacy `selection` field. `start`/`end` must be
 * present (a presence payload without endpoints is not a selection);
 * every other field coerces to its neutral value. Publish and consume
 * run through this one gate so they reject the same payloads.
 */
export const normalizeAwarenessSelection = (value: unknown): EdytorAwarenessSelection | null => {
	if (!isRecord(value) || value.start === undefined || value.end === undefined) {
		return null;
	}
	const { start, end, startTextId, endTextId, yStart, yEnd, isCollapsed, isReversed } = value;
	return {
		start,
		end,
		startTextId: typeof startTextId === 'string' ? startTextId : '',
		endTextId: typeof endTextId === 'string' ? endTextId : '',
		yStart: typeof yStart === 'number' ? yStart : 0,
		yEnd: typeof yEnd === 'number' ? yEnd : 0,
		isCollapsed: isCollapsed === true,
		isReversed: isReversed === true
	};
};

/**
 * Stable per-view presence keys — minted lazily, live as long as the
 * Edytor they identify. Keys only need uniqueness inside one client's
 * `selections` map; remote peers never interpret them.
 */
const viewPresenceIds = new WeakMap<Edytor, string>();
let viewPresenceCounter = 0;
const viewPresenceId = (edytor: Edytor): string => {
	let id = viewPresenceIds.get(edytor);
	if (id === undefined) {
		id = `view-${++viewPresenceCounter}`;
		viewPresenceIds.set(edytor, id);
	}
	return id;
};

/**
 * viewId → owning Edytor, per shared awareness. The destroy path
 * (`selection.destroy()` → `clearAwarenessSelection(awareness)`) cannot
 * identify WHICH view is tearing down through the shared awareness object
 * alone — the registry is the ownership record: an entry whose Edytor is
 * `destroyed` is dead and gets swept, everything else is preserved.
 */
const presenceOwners = new WeakMap<AwarenessLike, Map<string, Edytor>>();
const ownersOf = (awareness: AwarenessLike): Map<string, Edytor> => {
	let owners = presenceOwners.get(awareness);
	if (owners === undefined) {
		owners = new Map();
		presenceOwners.set(awareness, owners);
	}
	return owners;
};

/** Local publish sequence — orders `selections` entries by write recency. */
let publishSeq = 0;

/** The live `selections` map inside a local-state record (empty when absent/foreign). */
const readSelections = (
	state: Record<string, unknown>
): Record<string, EdytorAwarenessViewSelection> =>
	isRecord(state.selections)
		? (state.selections as Record<string, EdytorAwarenessViewSelection>)
		: {};

/**
 * Drop `selections` keys owned by destroyed views. Returns the SAME map
 * reference when nothing was swept (callers compare by identity), a copy
 * otherwise; dead owners are also dropped from the registry so it cannot
 * grow past the live view set.
 */
const sweepDestroyedViews = (
	awareness: AwarenessLike,
	selections: Record<string, EdytorAwarenessViewSelection>
): Record<string, EdytorAwarenessViewSelection> => {
	const owners = presenceOwners.get(awareness);
	if (owners === undefined) {
		return selections;
	}
	let swept: Record<string, EdytorAwarenessViewSelection> | undefined;
	for (const [viewId, edytor] of owners) {
		if (edytor.destroyed) {
			swept ??= { ...selections };
			delete swept[viewId];
			owners.delete(viewId);
		}
	}
	return swept ?? selections;
};

/**
 * The freshest VALID entry of a `selections` map — the single winner
 * publish and consume must agree on (D17). The publish path mirrors the
 * winner into the legacy `selection` field and remote peers render the
 * winner of the same contest, so "freshest" is defined once here: among
 * entries that pass `normalizeAwarenessSelection` (a malformed payload
 * cannot steal the mirror by carrying a high `t`), the highest publish
 * sequence `t` wins — a missing `t` counts as 0 and the first valid
 * entry seeds the contest. Returns the normalized selection with local
 * bookkeeping stripped, `null` when no valid entry exists.
 */
export const freshestPublishedSelection = (
	selections: Record<string, unknown>
): EdytorAwarenessSelection | null => {
	let freshest: EdytorAwarenessSelection | null = null;
	let freshestSeq = Number.NEGATIVE_INFINITY;
	for (const entry of Object.values(selections)) {
		const normalized = normalizeAwarenessSelection(entry);
		if (normalized === null) {
			continue;
		}
		const t = isRecord(entry) && typeof entry.t === 'number' ? entry.t : 0;
		if (t > freshestSeq) {
			freshest = normalized;
			freshestSeq = t;
		}
	}
	return freshest;
};

/** Write `selections` + the `selection` mirror onto `nextState` (mutating the clone). */
const writePresenceFields = (
	nextState: Record<string, unknown>,
	selections: Record<string, EdytorAwarenessViewSelection>
): void => {
	delete nextState.selection;
	delete nextState.selections;
	if (Object.keys(selections).length === 0) {
		return;
	}
	nextState.selections = selections;
	const mirror = freshestPublishedSelection(selections);
	if (mirror !== null) {
		nextState.selection = mirror;
	}
};

export const createAwarenessSelection = (
	selection: EdytorSelection
): EdytorAwarenessSelection | null => {
	const { startText, endText, yStart, yEnd, isCollapsed, isReversed } = selection.state;
	if (!startText || !endText) {
		return null;
	}

	// U09 — endpoints are serialized backing-text anchors with explicit
	// affinity: the range START binds 'right' (glued to the first atom
	// inside the range — concurrent inserts at the boundary stay outside),
	// END and collapsed carets bind 'left' (glued to the last atom — the
	// baseline assoc=-1 caret behavior). `yStart`/`yEnd` + text ids remain
	// for older peers; anchor-aware peers resolve `start`/`end` first.
	return {
		start: selection.createTextAnchor(
			startText,
			yStart,
			isCollapsed ? 'left' : 'right'
		) satisfies TextAnchor | null,
		end: selection.createTextAnchor(endText, yEnd, 'left') satisfies TextAnchor | null,
		startTextId: startText.id,
		endTextId: endText.id,
		yStart,
		yEnd,
		isCollapsed,
		isReversed
	};
};

/**
 * Drop the published local selections of DEAD views — called from
 * `selection.destroy()` so detaching the editor does not leave a stale
 * remote caret behind.
 *
 * U5/F4 — with views sharing one awareness slot, clearing must not strip
 * sibling views' entries: only keys owned by destroyed Edytors (this view,
 * when `Edytor.destroy()` set `destroyed` before `selection.destroy()`
 * ran) are removed; a still-mounted sibling's caret survives. The
 * `selection` mirror is recomputed from the survivors; other local-state
 * fields (actor, user, …) are preserved. No-op when nothing is published
 * or nothing died.
 */
export const clearAwarenessSelection = (awareness: AwarenessLike) => {
	const localState = awareness.getLocalState();
	if (!localState || (!('selection' in localState) && !('selections' in localState))) {
		return;
	}

	const selections = sweepDestroyedViews(awareness, readSelections(localState));
	const swept = selections !== readSelections(localState);
	if (!('selection' in localState) && !swept) {
		// No legacy mirror to drop and no dead entry — nothing changed.
		return;
	}

	const nextState = { ...localState };
	writePresenceFields(nextState, selections);
	// U6b/R4 — a live view's remount (or any no-op sweep) recomputes an
	// identical presence map: `selections` is the same reference (the
	// sweep only allocates when it actually drops a key) and the
	// recomputed `selection` mirror is deep-equal. Broadcasting that
	// state would republish an unchanged presence map to every peer —
	// skip the write entirely.
	const unchanged =
		nextState.selections === localState.selections &&
		jsonValuesEqual(nextState.selection ?? null, localState.selection ?? null);
	if (!unchanged) {
		awareness.setLocalState(nextState);
	}
};

/**
 * TextAnchor (`{b, a:{i:{c,k}|null, a}}`) structural equality — used to
 * detect "the published payload did not actually change" without relying
 * on JSON key order.
 */
const anchorsEqual = (a: unknown, b: unknown): boolean => {
	if (a === b) {
		return true;
	}
	if (!isRecord(a) || !isRecord(b) || a.b !== b.b || a.o !== b.o) {
		return false;
	}
	const innerA = a.a;
	const innerB = b.a;
	if (!isRecord(innerA) || !isRecord(innerB) || innerA.a !== innerB.a) {
		return false;
	}
	const itemA = innerA.i;
	const itemB = innerB.i;
	if (itemA === itemB) {
		return true;
	}
	if (!isRecord(itemA) || !isRecord(itemB)) {
		return false;
	}
	return itemA.c === itemB.c && itemA.k === itemB.k;
};

/**
 * Whether the already-published entry for a view carries the same payload
 * as a freshly derived one — `t` (local publish recency) is excluded: it
 * orders CHANGES, and re-stamping an identical payload would only steal
 * "freshest mirror" status without carrying new information.
 */
const publishedEntryEquals = (
	prev: EdytorAwarenessViewSelection | undefined,
	next: EdytorAwarenessSelection
): boolean =>
	prev !== undefined &&
	prev.startTextId === next.startTextId &&
	prev.endTextId === next.endTextId &&
	prev.yStart === next.yStart &&
	prev.yEnd === next.yEnd &&
	prev.isCollapsed === next.isCollapsed &&
	prev.isReversed === next.isReversed &&
	anchorsEqual(prev.start, next.start) &&
	anchorsEqual(prev.end, next.end);

export const publishAwarenessSelection = (selection: EdytorSelection) => {
	const edytor = selection.edytor;
	if (edytor.destroyed) {
		return; // a dead view never publishes
	}
	const awareness = edytor.awareness;
	const localState = awareness.getLocalState();
	if (!localState) {
		return;
	}

	const viewId = viewPresenceId(edytor);
	ownersOf(awareness).set(viewId, edytor);

	const currentSelections = readSelections(localState);
	const sweptSelections = sweepDestroyedViews(awareness, currentSelections);
	const swept = sweptSelections !== currentSelections;
	const selections = { ...sweptSelections };

	const awarenessSelection = createAwarenessSelection(selection);
	const previousEntry = selections[viewId];
	let changed = swept;
	if (awarenessSelection) {
		if (!publishedEntryEquals(previousEntry, awarenessSelection)) {
			selections[viewId] = { ...awarenessSelection, t: ++publishSeq };
			changed = true;
		}
		// U8a — identical payload: keep the previous entry (and its `t`).
		// The emit-side dedupe already suppresses most of these calls; this
		// guard catches the rest (e.g. an emit triggered by a non-selection
		// field the key ignores, or a second editor sharing the path).
	} else if (viewId in selections) {
		delete selections[viewId];
		changed = true;
	}

	if (!changed) {
		return;
	}
	const nextState = { ...localState };
	writePresenceFields(nextState, selections);
	// Final guard — `swept` can report a change even when the dropped keys
	// were absent from `selections` (a dead owner with nothing published).
	// Compare the presence fields structurally: identical means the write
	// would broadcast a state no peer can distinguish from the current one.
	if (
		jsonValuesEqual(nextState.selections ?? null, localState.selections ?? null) &&
		jsonValuesEqual(nextState.selection ?? null, localState.selection ?? null)
	) {
		return;
	}
	awareness.setLocalState(nextState);
};
