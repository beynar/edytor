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

export type EdytorAwarenessState = {
	user?: EdytorAwarenessUser;
	selection?: EdytorAwarenessSelection;
};

const withoutSelection = (state: Record<string, unknown>) => {
	const nextState = { ...state };
	delete nextState.selection;
	return nextState;
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
 * Drop the published local selection — called from `selection.destroy()`
 * so detaching the editor does not leave a stale remote caret behind.
 * Other local-state fields (user, …) are preserved; if nothing is
 * published this is a no-op.
 */
export const clearAwarenessSelection = (awareness: {
	getLocalState: () => Record<string, unknown> | null;
	setLocalState: (state: Record<string, unknown> | null) => void;
}) => {
	const localState = awareness.getLocalState();
	if (!localState || !('selection' in localState)) {
		return;
	}
	awareness.setLocalState(withoutSelection(localState));
};

export const publishAwarenessSelection = (selection: EdytorSelection) => {
	const awareness = selection.edytor.awareness;
	const localState = awareness.getLocalState();
	if (!localState) {
		return;
	}

	const awarenessSelection = createAwarenessSelection(selection);
	if (!awarenessSelection) {
		awareness.setLocalState(withoutSelection(localState));
		return;
	}

	awareness.setLocalState({
		...localState,
		selection: awarenessSelection
	});
};
