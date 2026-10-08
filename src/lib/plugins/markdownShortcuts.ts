import { convertToKind, type KindRow } from '$lib/kinds.js';
import type { InputRule, Plugin } from '$lib/plugins.js';

/**
 * Notion's inline markdown, completed by the typed closing character: the
 * mark, the opening marker's start and length, the content's length and
 * the closing marker already typed. `**b**` bold, `*i*`/`_i_` italic,
 * `` `c` `` code, `~s~`/`~~s~~` strike.
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

/**
 * The text that can complete inline markdown: a closing marker after
 * marked-up text (the rule's filter; `inlineMarkdown` reads the markers).
 */
const INLINE = new RegExp(
	[
		/(?:^|[^`])`[^`\s](?:[^`]*[^`\s])?`$/,
		/(?:^|[^*])\*[^*\s](?:[^*]*[^*\s])?\*$/,
		/\*\*[^*\s](?:(?:[^*]|\*(?!\*))*[^*\s])?\*\*$/,
		/(?:^|[^_])_[^_\s](?:[^_]*[^_\s])?_$/,
		/(?:^|[^~])~[^~\s](?:[^~]*[^~\s])?~$/,
		/~~[^~\s](?:(?:[^~]|~(?!~))*[^~\s])?~~$/
	]
		.map((pattern) => pattern.source)
		.join('|')
);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Markdown prefixes come from the kind catalogue: a row whose shortcut the typed character completes. */
export const markdownShortcutsPlugin: Plugin = (edytor) => {
	/** The catalogue's prefixes as one pattern, from a text's start (built once the catalogue is). */
	let prefixes: { kinds: readonly KindRow[]; find: RegExp } | null = null;
	const prefixPattern = () => {
		if (prefixes?.kinds !== edytor.kinds) {
			const all = edytor.kinds.flatMap((kind) => kind.markdown ?? []).map(escape);
			prefixes = {
				kinds: edytor.kinds,
				find: all.length ? new RegExp(`^(?:${all.join('|')})$`) : /(?!)/
			};
		}
		return prefixes.find;
	};

	/** Inline: a closing marker typed after marked-up text (not in code lines). */
	const inline: InputRule = {
		find: INLINE,
		replace: (match, { block, to, typed, caret }) => {
			const before = match.input.slice(0, match.input.length - typed.length);
			const found = typed.length === 1 ? inlineMarkdown(before, typed) : null;
			if (!found || !edytor.marks.has(found.mark)) return false;
			const text = block.textAtOffset(to)?.text;
			if (!text) return false;
			const { id } = block;
			// The segment's start, in block offsets: the caret, less the text before it.
			const at = to - before.length + found.start;
			const { facade, dispatcher } = edytor;
			const plan = () =>
				facade.compose(
					facade.prepare.setMark(id, at + found.open, found.content, found.mark, true),
					...(found.closing
						? [facade.prepare.deleteText(id, at + found.open + found.content, found.closing)]
						: []),
					facade.prepare.deleteText(id, at, found.open)
				);
			const payload = { value: typed, start: before.length, end: before.length };
			const applied = dispatcher.dispatch(
				'inlineMarkdown',
				payload,
				{ block, text },
				(_p, prepared = plan()) => ('writes' in prepared ? facade.apply(prepared) : null),
				plan
			);
			if (!applied) return false;
			// Typing after the shortcut continues without the mark.
			edytor.selection.stage({});
			caret(at + found.content);
			return true;
		}
	};

	/**
	 * A kind's prefix typed from the block's start, at a collapsed caret in
	 * its first text: the prefix's removal leads the conversion (one plan, so
	 * a refusal of either refuses both); the text after the caret is kept
	 * (Notion). The caret lands at the start of the converted kind's first text.
	 */
	const prefix: InputRule = {
		get find() {
			return prefixPattern();
		},
		replace: (match, { block, from, to, typed, remove }) => {
			if (from !== 0 || typed.length !== 1 || !block.convertible) return false;
			const row = edytor.kinds.find((kind) => kind.markdown?.includes(match[0]));
			if (!row) return false;
			// A replacing kind (divider, code) would erase the rest: only a block holding just the prefix.
			const text = block.firstText;
			const alone = text === block.lastText && to === text?.length && !block.hasChildren;
			if (row.replaces && !alone) return false;
			let converted = false;
			remove(() => (converted = convertToKind(edytor, block, row, true) === true));
			return converted;
		}
	};

	return { inputRules: [inline, prefix] };
};
