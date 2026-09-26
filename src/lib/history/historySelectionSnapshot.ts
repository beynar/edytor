import { tick } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import { Text } from '$lib/text/text.svelte.js';

type HistorySelectionSnapshot = {
	isCollapsed: boolean;
	startTextId: string | null;
	startTextPath: number[] | null;
	yEnd: number;
	selectedBlockIds: string[];
};

type StackItemWithSelectionMeta = {
	meta?: {
		get?: (key: string) => unknown;
	};
};

/**
 * Stack-item `meta` carries selection snapshots PER VIEW — a
 * `Map<view transaction origin, snapshot>` under each meta key (one
 * shared document history, independent view selections — see
 * `selection.svelte.ts` `init`). Resolve the calling view's entry via
 * its `edytor.transaction` key.
 */
const viewSnapshot = (
	stackItem: StackItemWithSelectionMeta | null | undefined,
	edytor: Edytor,
	key: string
): unknown => {
	const map = stackItem?.meta?.get?.(key);
	return map instanceof Map ? map.get(edytor.transaction) : undefined;
};

const historyCommandVersions = new WeakMap<Edytor, number>();
const historyCommandDocVersions = new WeakMap<Edytor, number>();
const CURSOR_LOCATION_META = 'cursor-location';
const RESTORE_CURSOR_LOCATION_META = 'restore-cursor-location';

const isHistorySelectionSnapshot = (value: unknown): value is HistorySelectionSnapshot => {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const snapshot = value as Partial<HistorySelectionSnapshot>;
	return (
		typeof snapshot.isCollapsed === 'boolean' &&
		(typeof snapshot.startTextId === 'string' || snapshot.startTextId === null) &&
		(Array.isArray(snapshot.startTextPath) || snapshot.startTextPath === null) &&
		typeof snapshot.yEnd === 'number' &&
		Array.isArray(snapshot.selectedBlockIds)
	);
};

const cloneHistorySelectionSnapshot = (
	snapshot: HistorySelectionSnapshot
): HistorySelectionSnapshot => ({
	isCollapsed: snapshot.isCollapsed,
	startTextId: snapshot.startTextId,
	startTextPath: snapshot.startTextPath ? [...snapshot.startTextPath] : null,
	yEnd: snapshot.yEnd,
	selectedBlockIds: [...snapshot.selectedBlockIds]
});

export const getHistorySelectionSnapshot = (
	edytor: Edytor,
	stackItem: StackItemWithSelectionMeta | null | undefined,
	options: { preferRestore?: boolean } = {}
): HistorySelectionSnapshot | null => {
	const snapshot =
		(options.preferRestore
			? viewSnapshot(stackItem, edytor, RESTORE_CURSOR_LOCATION_META)
			: undefined) ?? viewSnapshot(stackItem, edytor, CURSOR_LOCATION_META);
	return isHistorySelectionSnapshot(snapshot) ? cloneHistorySelectionSnapshot(snapshot) : null;
};

export const beginHistoryCommandRestore = (edytor: Edytor) => {
	const version = (historyCommandVersions.get(edytor) ?? 0) + 1;
	historyCommandVersions.set(edytor, version);
	historyCommandDocVersions.delete(edytor);
	return () => {
		if (historyCommandVersions.get(edytor) !== version) {
			return false;
		}

		const docVersion = historyCommandDocVersions.get(edytor);
		// The undo/redo commit is baselined synchronously (see
		// `captureHistoryCommandDocVersion`); any LATER committed change —
		// the user typing into the restore window, a remote update — makes
		// the stored offsets stale. Without this check the delayed DOM
		// restore lands mid-typing and snaps the caret back over newer
		// input, so the next insertion lands at the stale offset.
		return docVersion === undefined || edytor._docCommitVersion === docVersion;
	};
};

/**
 * Records the post-commit document version of the in-flight history
 * command. Must run synchronously after `undo()`/`redo()` commits (all
 * call sites invoke `refreshDomAfterHistoryChange` in the same task).
 * Until a baseline exists the `shouldRestore` predicate only checks the
 * command version, so paths that never reach this keep their old
 * semantics.
 */
export const captureHistoryCommandDocVersion = (edytor: Edytor) => {
	historyCommandDocVersions.set(edytor, edytor._docCommitVersion);
};

const getTextByPath = (edytor: Edytor, path: number[] | null) => {
	if (!path || path.length < 2) {
		return null;
	}

	let block = edytor.root;
	for (const index of path.slice(0, -1)) {
		block = block?.children[index];
	}

	const part = block?.content[path.at(-1)!];
	return part instanceof Text ? part : null;
};

const isCurrentText = (text: Text | null | undefined) => Boolean(text && text.isInDocument);

const getCollapsedHistorySelectionText = (
	edytor: Edytor,
	snapshot: HistorySelectionSnapshot | null,
	shouldRestore: () => boolean = () => true
): Text | null => {
	if (!snapshot?.isCollapsed || snapshot.selectedBlockIds.length > 0 || !shouldRestore()) {
		return null;
	}

	const textById = snapshot.startTextId ? edytor.getTextById(snapshot.startTextId) : null;
	const text = isCurrentText(textById) ? textById : getTextByPath(edytor, snapshot.startTextPath);
	return text && shouldRestore() ? text : null;
};

export const restoreCollapsedHistorySelectionState = (
	edytor: Edytor,
	snapshot: HistorySelectionSnapshot | null,
	shouldRestore: () => boolean = () => true
) => {
	const text = getCollapsedHistorySelectionText(edytor, snapshot, shouldRestore);
	if (!text) {
		return;
	}

	edytor.selection.setCollapsedStateAtTextOffset(text, Math.min(snapshot!.yEnd, text.length));
};

export const restoreCollapsedHistorySelection = async (
	edytor: Edytor,
	snapshot: HistorySelectionSnapshot | null,
	shouldRestore: () => boolean = () => true
) => {
	await tick();
	const text = getCollapsedHistorySelectionText(edytor, snapshot, shouldRestore);
	if (!text) {
		return;
	}

	edytor.selection.ignoreNextSelectionChange = true;
	await edytor.selection.setAtTextOffset(text, Math.min(snapshot!.yEnd, text.length));
};
