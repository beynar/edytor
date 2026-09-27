import type { Edytor } from '$lib/edytor.svelte.js';
import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
import { serialize, type PresenceSelection } from '$lib/session/selection.js';

export type EdytorAwarenessUser = {
	name?: string;
	color?: string;
};

/**
 * A published text selection (L10): anchors only — `start`/`end` in
 * document order (`DocAnchor` wire shape), plus collapsed/reversed. The
 * only kind a peer renders as a caret.
 */
export type EdytorAwarenessSelection = {
	start: unknown;
	end: unknown;
	collapsed: boolean;
	reversed: boolean;
};

/**
 * One entry inside the per-view `selections` map — the selection payload
 * plus the local publish sequence `t`. `t` is a client-local monotonic
 * counter: within one client's presence map a higher `t` is always the
 * more recently changed view selection, which is what remote peers render.
 */
export type EdytorAwarenessViewSelection = PresenceSelection & {
	t?: number;
};

export type EdytorAwarenessState = {
	/** Durable actor identity — published once by the document (U5/U6 seam). */
	actor?: { id: string; name?: string; color?: string };
	user?: EdytorAwarenessUser;
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
 * Validate + coerce one `selections` entry as a text selection. `start`/
 * `end` must be present (a block set or an atom has none and is not
 * rendered as a caret); the flags coerce to their neutral value.
 */
export const normalizeAwarenessSelection = (value: unknown): EdytorAwarenessSelection | null => {
	if (!isRecord(value) || value.start === undefined || value.end === undefined) {
		return null;
	}
	return {
		start: value.start,
		end: value.end,
		collapsed: value.collapsed === true,
		reversed: value.reversed === true
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
 * The freshest text entry of a `selections` map — the one caret a peer
 * renders per client: among entries that pass `normalizeAwarenessSelection`
 * (a malformed payload cannot win by carrying a high `t`), the highest
 * publish sequence `t` wins — a missing `t` counts as 0 and the first valid
 * entry seeds the contest. `null` when no valid entry exists.
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

/** Write `selections` onto `nextState` (mutating the clone); no entry left drops the field. */
const writePresenceFields = (
	nextState: Record<string, unknown>,
	selections: Record<string, EdytorAwarenessViewSelection>
): void => {
	delete nextState.selections;
	if (Object.keys(selections).length > 0) {
		nextState.selections = selections;
	}
};

/** This view's presence payload: `serialize(value)` (anchors only), `null` for no selection. */
export const createAwarenessSelection = (selection: EdytorSelection): PresenceSelection | null =>
	serialize(selection.value, selection.projection);

/**
 * Drop the published local selections of DEAD views — called from
 * `selection.destroy()` so detaching the editor does not leave a stale
 * remote caret behind.
 *
 * U5/F4 — with views sharing one awareness slot, clearing must not strip
 * sibling views' entries: only keys owned by destroyed Edytors (this view,
 * when `Edytor.destroy()` set `destroyed` before `selection.destroy()`
 * ran) are removed; a still-mounted sibling's caret survives. Other
 * local-state fields (actor, user, …) are preserved. No-op when nothing
 * died (a live view's remount must not republish an identical map).
 */
export const clearAwarenessSelection = (awareness: AwarenessLike) => {
	const localState = awareness.getLocalState();
	if (!localState || !('selections' in localState)) {
		return;
	}
	const selections = sweepDestroyedViews(awareness, readSelections(localState));
	if (selections === readSelections(localState)) {
		return;
	}
	const nextState = { ...localState };
	writePresenceFields(nextState, selections);
	awareness.setLocalState(nextState);
};

/** Whether the published entry carries the same payload (`t`, the local publish recency, excluded). */
const publishedEntryEquals = (
	prev: EdytorAwarenessViewSelection | undefined,
	next: PresenceSelection
): boolean => prev !== undefined && jsonValuesEqual({ ...prev, t: undefined }, next);

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
		// Identical payload: keep the previous entry (and its `t`).
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
	if (jsonValuesEqual(nextState.selections ?? null, localState.selections ?? null)) {
		return;
	}
	awareness.setLocalState(nextState);
};
