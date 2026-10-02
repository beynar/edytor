import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { TextAnchor } from '$lib/selection/selection.svelte.js';
import type { PresenceSelection } from '$lib/session/selection.js';
import { isRecord, jsonEquals } from '$lib/utils/json.js';

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
): boolean => {
	const local = awareness.getLocalState();
	if (!local) return false;
	const { selections, ...state } = local;
	const { [key]: previous, ...others } = isRecord(selections)
		? (selections as Record<string, EdytorAwarenessViewSelection>)
		: {};
	if (
		payload === null
			? previous === undefined
			: previous !== undefined && jsonEquals({ ...previous, t: undefined }, payload)
	) {
		return false;
	}
	const next = payload === null ? others : { ...others, [key]: { ...payload, t: ++publishSeq } };
	awareness.setLocalState(Object.keys(next).length > 0 ? { ...state, selections: next } : state);
	return true;
};

/** What a view shares of its selection: the selection itself, the block holding its focus, or nothing. */
export type PresenceShare = 'caret' | 'block' | 'none';

export type PresenceOptions = {
	/** `'caret'` (default): the selection; `'block'`: the focused block only, so moving inside it publishes nothing; `'none'`: nothing. */
	share?: PresenceShare;
	/** Minimum ms between two presence writes (default `0`). The first goes at once; later ones collapse into one write of the newest at the window's end. */
	throttle?: number;
};

/**
 * One view's presence writer (R1): the only writer of its key, under the
 * view's `share` and `throttle`. `select()` hands it the full payload; the
 * view's teardown calls `clear()`.
 */
export class PresenceWriter {
	throttle: number;
	#share: PresenceShare;
	#last = Number.NEGATIVE_INFINITY;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** The newest payload a throttled window holds back (`undefined`: none). */
	#held: PresenceSelection | null | undefined;
	/** The last payload and focused block handed in, kept so a share change republishes at once. */
	#latest: [PresenceSelection | null, string | null] = [null, null];

	constructor(
		private readonly awareness: AwarenessLike,
		private readonly key: string,
		{ share = 'caret', throttle = 0 }: PresenceOptions = {}
	) {
		this.#share = share;
		this.throttle = throttle;
	}

	get share(): PresenceShare {
		return this.#share;
	}
	set share(share: PresenceShare) {
		if (share === this.#share) return;
		this.#share = share;
		this.write(...this.#latest);
	}

	/** Publish `payload` (the full selection; `focus`: the block holding its focus) as this view shares it, within the throttle. */
	write(payload: PresenceSelection | null, focus: string | null = null) {
		this.#latest = [payload, focus];
		const shared = this.#shared(payload, focus);
		const wait = this.#last + this.throttle - Date.now();
		if (this.#timer === undefined && wait <= 0) return this.#publish(shared);
		this.#held = shared;
		// Named rule (presence throttle): the window's one trailing write.
		this.#timer ??= setTimeout(() => {
			const held = this.#held;
			[this.#timer, this.#held] = [undefined, undefined];
			if (held !== undefined) this.#publish(held);
		}, wait);
	}

	/** Remove this view's entry and drop a held write (the view's teardown). */
	clear() {
		clearTimeout(this.#timer);
		[this.#timer, this.#held, this.#latest] = [undefined, undefined, [null, null]];
		publishPresence(this.awareness, this.key, null);
	}

	#publish(payload: PresenceSelection | null) {
		if (publishPresence(this.awareness, this.key, payload)) this.#last = Date.now();
	}

	#shared(payload: PresenceSelection | null, focus: string | null): PresenceSelection | null {
		if (this.#share === 'none' || !payload) return null;
		if (this.#share === 'caret' || 'blocks' in payload) return payload;
		if ('atom' in payload) return { blocks: [payload.block] };
		return focus ? { blocks: [focus] } : null;
	}
}

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
	isRecord(value) && typeof value.b === 'string' && isEngineAnchor(value.a);

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

/** A published block set (`{ blocks }`: a block selection, or a view sharing blocks only). */
const normalizeAwarenessBlocks = (value: unknown): string[] | null =>
	isRecord(value) &&
	Array.isArray(value.blocks) &&
	value.blocks.length > 0 &&
	value.blocks.every((id) => typeof id === 'string')
		? (value.blocks as string[])
		: null;

/**
 * A peer's presence in this view, from the freshest valid entry of its
 * awareness state (text or block set, highest `t`): a caret with both
 * anchors resolved, or the live blocks of a block set; `null` when nothing
 * resolves (paints nothing).
 */
export const resolvePeerSelection = (
	edytor: Edytor,
	state: unknown
):
	| { start: PresencePoint; end: PresencePoint; collapsed: boolean; reversed: boolean }
	| { blocks: string[] }
	| null => {
	let selection: EdytorAwarenessSelection | null = null;
	let blocks: string[] | null = null;
	let seq = Number.NEGATIVE_INFINITY;
	const entries = isRecord(state) && isRecord(state.selections) ? state.selections : {};
	for (const entry of Object.values(entries)) {
		const text = normalizeAwarenessSelection(entry);
		const set = text ? null : normalizeAwarenessBlocks(entry);
		const t = isRecord(entry) && typeof entry.t === 'number' ? entry.t : 0;
		if ((text || set) && t > seq) [selection, blocks, seq] = [text, set, t];
	}
	if (blocks) {
		const live = blocks.filter((id) => edytor.facade.isVisibleBlock(id));
		return live.length ? { blocks: live } : null;
	}
	if (!selection) return null;
	const { collapsed, reversed } = selection;
	const start = resolveAnchor(edytor, selection.start);
	const end = start && resolveAnchor(edytor, selection.end);
	return start && end ? { start, end, collapsed, reversed } : null;
};
