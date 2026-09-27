import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { TextAnchor } from '$lib/selection/selection.svelte.js';
import type { PresenceSelection } from '$lib/session/selection.js';

/**
 * Presence (L10, R1): one entry per view key, `selections[viewKey] =
 * serialize(value) + t`. The view that minted a key is the only writer of
 * its entry — it publishes on `select()` when the value changed and clears
 * the entry in its own teardown. Peers render one caret per client, the
 * freshest valid text entry, resolved here; geometry lives with the
 * remote-caret renderer.
 */

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
	 * Per-view presence: one entry per live view of this client, keyed by the
	 * client-local key its view minted. Sibling views share ONE awareness
	 * state slot (one clientID); each writes and clears only its own key.
	 */
	selections?: Record<string, EdytorAwarenessViewSelection>;
};

/**
 * Structural awareness surface used by `publishPresence` — the real
 * `Awareness` satisfies it; tests may substitute stubs.
 */
type AwarenessLike = {
	getLocalState: () => Record<string, unknown> | null;
	setLocalState: (state: Record<string, unknown> | null) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

/**
 * JSON-value structural equality — the presence write's dedupe compare
 * (also used for mark sets). Mirrors stringify equivalence without
 * serializing: object key order is ignored and `undefined`-valued keys are
 * skipped, so two payloads compare equal exactly when peers could not tell
 * the resulting states apart.
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

let presenceKeys = 0;
/** A client-local presence key, minted once by the view that owns the entry. */
export const mintPresenceKey = (): string => `view-${++presenceKeys}`;

/** Local publish sequence — orders `selections` entries by write recency. */
let publishSeq = 0;

/**
 * Write the entry under `key` — `payload` null removes it. Called only by
 * the view that minted `key` (R1): other keys are copied untouched. An
 * unchanged payload (`t` aside) is not rebroadcast and keeps its `t`, so a
 * no-op republish cannot steal the freshest slot from a sibling; the field
 * is dropped when no entry is left. Other local-state fields are kept.
 */
export const publishPresence = (
	awareness: AwarenessLike,
	key: string,
	payload: PresenceSelection | null
) => {
	const local = awareness.getLocalState();
	if (!local) return;
	const { selections, ...state } = local;
	const { [key]: previous, ...others } = isRecord(selections)
		? (selections as Record<string, EdytorAwarenessViewSelection>)
		: {};
	if (
		payload === null
			? previous === undefined
			: previous !== undefined && jsonValuesEqual({ ...previous, t: undefined }, payload)
	) {
		return;
	}
	const next = payload === null ? others : { ...others, [key]: { ...payload, t: ++publishSeq } };
	awareness.setLocalState(Object.keys(next).length > 0 ? { ...state, selections: next } : state);
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

/**
 * Strict wire-shape guard for serialized selection anchors (U09): `{b}`
 * is the backing text's home block id and `a` is the engine anchor
 * `{i: {c,k}|null, a: number}` (a < 0 = left affinity). Foreign presence
 * payloads — e.g. v13 `RelativePosition` objects shaped
 * `{type, item, assoc}` — fail this check, so mismatched formats are
 * safely ignored rather than interpreted with wrong offsets.
 */
const isEngineAnchor = (value: unknown): value is TextAnchor['a'] =>
	isRecord(value) &&
	typeof value.a === 'number' &&
	(value.i === null ||
		(isRecord(value.i) && typeof value.i.c === 'number' && typeof value.i.k === 'number'));

const isTextAnchor = (value: unknown): value is TextAnchor =>
	isRecord(value) &&
	typeof value.b === 'string' &&
	isEngineAnchor(value.a) &&
	(value.o === undefined || typeof value.o === 'string');

export type PresencePoint = { text: Text; offset: number };

const resolveAnchor = (edytor: Edytor, value: unknown): PresencePoint | null => {
	try {
		const resolved = isTextAnchor(value) ? edytor.selection.resolveTextAnchor(value) : null;
		return resolved
			? {
					text: resolved.text,
					offset: Math.min(Math.max(resolved.offset, 0), resolved.text.length)
				}
			: null;
	} catch {
		return null;
	}
};

/**
 * A peer's caret in this view: the freshest valid text entry of its
 * awareness state with both anchors resolved, or `null` — an anchor that
 * does not resolve paints nothing.
 */
export const resolvePeerSelection = (
	edytor: Edytor,
	state: unknown
): { start: PresencePoint; end: PresencePoint; collapsed: boolean; reversed: boolean } | null => {
	const selection =
		isRecord(state) && isRecord(state.selections)
			? freshestPublishedSelection(state.selections)
			: null;
	const start = selection && resolveAnchor(edytor, selection.start);
	const end = start && resolveAnchor(edytor, selection.end);
	return selection && start && end
		? { start, end, collapsed: selection.collapsed, reversed: selection.reversed }
		: null;
};
