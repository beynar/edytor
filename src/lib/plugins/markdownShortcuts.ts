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

/**
 * Notion's inline markdown, completed by the typed closing character: the
 * mark, the opening marker's length and the closing marker already typed.
 * `**b**` bold, `*i*`/`_i_` italic, `` `c` `` code, `~s~`/`~~s~~` strike.
 */
const inlineMarkdown = (before: string, typed: string) => {
	const find = (open: string, closing: string, mark: string) => {
		const body = before.slice(0, before.length - closing.length);
		const at = body.lastIndexOf(open);
		const content = at === -1 ? '' : body.slice(at + open.length);
		// Non-empty, not padded, and not the tail of a longer marker (`***`).
		if (!content || content.trim() !== content || content.includes(open)) return null;
		if (open.length === 1 && body[at - 1] === open) return null;
		return { mark, start: at, open: open.length, content: content.length, closing: closing.length };
	};
	if (typed === '`') return find('`', '', 'code');
	if (typed === '*')
		return before.endsWith('*') ? find('**', '*', 'bold') : find('*', '', 'italic');
	if (typed === '_') return find('_', '', 'italic');
	if (typed === '~')
		return before.endsWith('~') ? find('~~', '~', 'strike') : find('~', '', 'strike');
	return null;
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

			const { startText, yStart, isCollapsed } = edytor.selection.state;

			// Inline: a closing marker typed after marked-up text (not in code lines).
			const inline =
				isCollapsed && startText && payload.value.length === 1 && block.type !== 'codeLine'
					? inlineMarkdown(startText.stringContent.slice(0, yStart), payload.value)
					: null;
			if (inline && edytor.marks.has(inline.mark) && block.model) {
				const id = block.model.id;
				const at = startText!.segStart + inline.start;
				const { facade } = edytor;
				const plan = () =>
					facade.compose(
						facade.prepare.setMark(id, at + inline.open, inline.content, inline.mark, true),
						...(inline.closing
							? [facade.prepare.deleteText(id, at + inline.open + inline.content, inline.closing)]
							: []),
						facade.prepare.deleteText(id, at, inline.open)
					);
				prevent(() => {
					const applied = edytor.dispatcher.dispatch(
						'inlineMarkdown',
						payload,
						{ block, text: startText! },
						(_p, prepared = plan()) => ('writes' in prepared ? facade.apply(prepared) : null),
						plan
					);
					if (!applied) {
						// Refused: the character lands as typed (as for a block prefix).
						fallback = true;
						try {
							startText!.insertText(payload);
						} finally {
							fallback = false;
						}
						edytor.dispatcher.caret(startText!, yStart + payload.value.length);
						return;
					}
					// Typing after the shortcut continues without the mark.
					edytor.selection.stage({});
					edytor.dispatcher.caret(startText!, inline.start + inline.content);
				});
				return;
			}

			// A collapsed caret at the end of the block's first text, completing a kind's prefix.
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
