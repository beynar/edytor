import type { Block } from '$lib/block/block.svelte.js';
import { convertToKind, type KindRow } from '$lib/kinds.js';
import type { Plugin } from '$lib/plugins.js';

/**
 * Convert `block`, the shortcut's prefix removal leading the conversion: one
 * plan, so a refusal of either refuses both (F-M3). The caret lands at the
 * start of the converted kind's first text. Answers whether it applied.
 */
const applyShortcut = (block: Block, row: KindRow, prefixLength: number) => {
	const { edytor } = block;
	const prefix = edytor.facade.prepare.deleteText(block.model!.id, 0, prefixLength);
	return edytor.dispatcher.lead(prefix, () => convertToKind(edytor, block, row, true)).out === true;
};

/** Markdown prefixes come from the kind catalogue: a row whose shortcut the typed character completes. */
export const markdownShortcutsPlugin: Plugin = (edytor) => {
	/** The typed text landing as typed after a refused conversion. */
	let fallback = false;
	return {
		onBeforeOperation: ({ operation, payload, block, prevent }) => {
			if (fallback || operation !== 'insertText' || block !== edytor.selection.state.startBlock) {
				return;
			}

			// A collapsed caret at the end of the block's first text, completing a kind's prefix.
			const { startText, yStart, isCollapsed } = edytor.selection.state;
			if (!isCollapsed || !startText || startText !== block.firstText) return;
			if (yStart !== startText.length || payload.value.length !== 1 || !block.convertible) return;
			const prefix = startText.stringContent.slice(0, yStart);
			const row = edytor.kinds.find((kind) => kind.markdown?.includes(prefix + payload.value));
			if (!row) return;

			prevent(() => {
				if (applyShortcut(block, row, prefix.length)) return;
				fallback = true;
				try {
					startText.insertText(payload);
				} finally {
					fallback = false;
				}
				edytor.dispatcher.caret(startText, (payload.start ?? yStart) + payload.value.length);
			});
		}
	};
};
