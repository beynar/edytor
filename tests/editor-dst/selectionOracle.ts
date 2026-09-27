/**
 * Independent semantic expectations for a PASSIVE peer's selection
 * after remote edits — the oracle the collaboration runner applies.
 *
 * Production anchor resolution stays an integration-consistency check
 * (the endpoint's own `TextAnchor` re-resolved on the converged
 * document through `resolveTextAnchor` — production's recovery path
 * verbatim). The expectations below are derived independently from
 * pre/post model state; they exist because anchor resolution alone
 * cannot say whether the caret "should" have moved — only where a
 * resolvable anchor lands.
 *
 * Contract source: `restoreRelativePosition`/`restoreDeadSelectionEndpoints`
 * (selection.svelte.ts) and `docs/editor-delete-contract.md`
 * (`sel.ride.*`, `sel.seam.*`).
 */

/** An exact landing spot — block identity, text identity, UTF-16 offset. */
export type EndpointSpot = { blockId: string; textId: string; offset: number };

export type PassiveEndpoint = {
	end: 'start' | 'end';
	/** The endpoint's position on the pre-step document. */
	pre: EndpointSpot;
	/** The captured anchor resolved back to the pre endpoint — diagnostic
	 * only: production resolves whatever anchor object the state holds,
	 * stale or not, so acceptance never gates on self-consistency. */
	anchorOk: boolean;
	/** The captured anchor — the SAME anchor object production's
	 * `restoreRelativePosition`/`restoreDeadSelectionEndpoints`
	 * resolves — re-resolved on the converged document. This is the
	 * ATOM-IDENTITY evidence for the endpoint's position: a text whose
	 * items were rewritten (string-identical or not) resolves the
	 * anchor elsewhere, and a dead anchor resolves null. */
	resolvedAnchor: EndpointSpot | null;
	/** The endpoint's block died between pre and post. */
	blockDied: boolean;
	/** The endpoint's text part survives in the post document — the
	 * dump-visible proxy for wrapper liveness: a live text wrapper
	 * means `restoreDeadSelectionEndpoints` returns early and the
	 * absolute position stands. */
	textIdAlive: boolean;
	/** Dead-block repair seam — the surviving neighbor from the PREVIOUS
	 * sibling ordering (not a stale index into the shortened array). */
	seam: EndpointSpot | null;
	/** The root's first editable text — production's last-resort
	 * landing when no anchor and no seam answer. */
	rootFallback: EndpointSpot | null;
};

/**
 * The acceptable landing set for one passive endpoint — every spot
 * exact on block + text + UTF-16 offset, mirroring production's
 * resolution order:
 *
 *   1. the endpoint's own anchor re-resolved on the converged
 *      document — when it resolves, it is the ONLY acceptable spot.
 *      This is the atom-identity test: `aa|aa` stays `aaaa` after a
 *      remote delete+append, but the anchor resolves to offset 1, so
 *      stale offset 2 is rejected without any string comparison;
 *   2. the repair seam, when the anchor is dead and the endpoint's
 *      block died — or the root's first editable text when the dead
 *      chain produces no landing;
 *   3. the unchanged pre position ONLY when the anchor is dead and
 *      the endpoint's text still exists — a live wrapper returns the
 *      repair early, leaving the absolute position standing.
 *
 * Anything outside the set is misplaced — including a caret in the
 * wrong live block and a stale position inside edited text.
 */
export const acceptableEndpointSpots = (ep: PassiveEndpoint): EndpointSpot[] => {
	if (ep.resolvedAnchor) return [ep.resolvedAnchor];
	if (ep.blockDied || !ep.textIdAlive) {
		return ep.seam ? [ep.seam] : ep.rootFallback ? [ep.rootFallback] : [];
	}
	return [ep.pre];
};

/** An expected whole-selection shape after a passive remote step. */
export type SelectionShape = {
	start: EndpointSpot;
	end: EndpointSpot;
	isCollapsed: boolean;
};

/**
 * JOINT range expectation — the per-endpoint sets above are correct for
 * a collapsed caret (one endpoint is the whole selection), but a RANGE's
 * endpoints do not recover independently: production's
 * `restoreDeadSelectionEndpoints.writeResolved` collapses the whole
 * selection to the surviving anchor when exactly one endpoint resolves,
 * and to the seam/root fallback when neither does. A dead start whose
 * anchor is gone therefore lands on the live END's resolution — never
 * on its own vacated seam. Example: B selects `alpha@1 → beta@3`, A
 * removes `alpha` — production collapses to `beta@3`, which independent
 * endpoint expectations (dead start → `beta@0`) wrongly reject.
 *
 * `startDead`/`endDead` mirror the wrapper-liveness gate
 * (`!state.startText.isInDocument`): a part id absent from every live block's
 * `content` is dead; a null pre textId is NOT dead (production returns
 * early on a null startText — nothing repairs, the position stands).
 * `seam` must be null when the start BLOCK survived — production's
 * seam walk reads the dead block's drop links, which a live block does
 * not have, so an end-only death falls straight to the root fallback.
 */
export const acceptableSelectionShapes = (sel: {
	isCollapsed: boolean;
	preStart: EndpointSpot;
	preEnd: EndpointSpot;
	resolvedStart: EndpointSpot | null;
	resolvedEnd: EndpointSpot | null;
	startDead: boolean;
	endDead: boolean;
	seam: EndpointSpot | null;
	rootFallback: EndpointSpot | null;
}): SelectionShape[] => {
	const caret = (spot: EndpointSpot): SelectionShape => ({
		start: spot,
		end: spot,
		isCollapsed: true
	});
	const shape = (s: EndpointSpot, e: EndpointSpot): SelectionShape =>
		s.blockId === e.blockId && s.textId === e.textId && s.offset === e.offset
			? caret(s)
			: { start: s, end: e, isCollapsed: false };

	if (sel.isCollapsed) {
		if (sel.resolvedStart) return [caret(sel.resolvedStart)];
		if (!sel.startDead) return [caret(sel.preStart)];
		const target = sel.seam ?? sel.rootFallback;
		return target ? [caret(target)] : [];
	}

	if (sel.resolvedStart && sel.resolvedEnd) {
		return [shape(sel.resolvedStart, sel.resolvedEnd)];
	}
	const survivor = sel.resolvedStart ?? sel.resolvedEnd;
	if (survivor) return [caret(survivor)];
	if (!sel.startDead && !sel.endDead) {
		return [shape(sel.preStart, sel.preEnd)];
	}
	const target = sel.seam ?? sel.rootFallback;
	return target ? [caret(target)] : [];
};

/**
 * Structural invariants that hold for a passive text selection across
 * ANY remote edit, regardless of where the endpoints landed:
 *
 *   - a text selection must not vanish — remote edits repair the model
 *     selection, they never clear it;
 *   - a collapsed caret stays collapsed — no production path expands a
 *     passive caret into a range.
 *
 * Returns a failure reason, or `null` when the invariants hold.
 */
export const passiveSelectionInvariantViolation = (input: {
	pre: { kind: string | null; isCollapsed?: boolean | null } | null | undefined;
	post: { kind: string | null; isCollapsed?: boolean | null } | null | undefined;
}): string | null => {
	const { pre, post } = input;
	if (!pre || pre.kind !== 'text') return null;
	if (!post || post.kind !== 'text') {
		return 'text selection vanished after a remote edit';
	}
	if (pre.isCollapsed === true && post.isCollapsed !== true) {
		return 'a collapsed caret became a range after a remote edit';
	}
	return null;
};

/** Same-position check for the zero-delivery contract: nothing remote
 * reached the peer, so no part of the selection may move. */
export const selectionMoved = (
	pre: {
		startBlockId: string | null;
		endBlockId: string | null;
		startTextId: string | null;
		endTextId: string | null;
		yStart: number;
		yEnd: number;
	},
	post: {
		startBlockId: string | null;
		endBlockId: string | null;
		startTextId: string | null;
		endTextId: string | null;
		yStart: number;
		yEnd: number;
	}
): boolean =>
	post.startBlockId !== pre.startBlockId ||
	post.endBlockId !== pre.endBlockId ||
	post.startTextId !== pre.startTextId ||
	post.endTextId !== pre.endTextId ||
	post.yStart !== pre.yStart ||
	post.yEnd !== pre.yEnd;
