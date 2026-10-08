/**
 * Input rules: text typed at a caret that a plugin's rule replaces
 * (`## ` → a heading, `:smile:` → 😄). The one engine behind every
 * plugin's `inputRules`: it reads the typed text and the caret, finds the
 * first rule whose `find` ends at the typed text, and replaces the typed
 * `insertText` with the rule's replacement — a command of its own, the
 * matched text's removal leading its first operation (`dispatcher.lead`), so
 * a refusal of either writes neither and the typed text lands as typed.
 */
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { InputRule, InputRuleContext, PluginOperations } from '$lib/plugins.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { TextOperations } from '$lib/text/text.utils.js';

/** A line of a `lines` island (a code block's line): no rule, no trigger runs there. */
export const inCodeLines = (edytor: Edytor, block: Block) => {
	const parent = block.parent;
	return !!parent && !parent.isRoot && edytor.blocks.get(parent.type)?.lines === true;
};

/** `find` over `subject`, a match only when it ends at the subject's end. */
const matchAtEnd = (find: RegExp, subject: string) => {
	find.lastIndex = 0;
	const match = find.exec(subject);
	find.lastIndex = 0;
	return match && match.index + match[0].length === subject.length ? match : null;
};

/**
 * The `onBeforeOperation` hook that runs `rules` (one plugin's, in order):
 * an `insertText` at the collapsed caret, in its text segment, completing a
 * match, is replaced by the first rule that writes.
 */
export const inputRulesHook = (
	edytor: Edytor,
	rules: readonly InputRule[]
): NonNullable<PluginOperations['onBeforeOperation']> => {
	/** A rule's replacement, or the typed text after it declined, is running: no rule runs on its writes. */
	let running = false;

	/** The typed text lands as typed, the caret after it. */
	const typeAsIs = (text: Text, payload: TextOperations['insertText'], at: number) => {
		text.insertText(payload);
		edytor.dispatcher.caret(text, at + payload.value.length);
	};

	return (change) => {
		if (running || change.operation !== 'insertText' || !rules.length) return;
		// Typed text only: a paste or a drop (a URL pasted at the caret) completes no rule.
		if (edytor.dispatcher.command?.startsWith('insertFrom')) return;
		const { payload, block, prevent, text } = change;
		const caret = edytor.selection.caret;
		const { startText, yStart } = edytor.selection.state;
		// Only text typed at the caret: an insertion elsewhere completes no rule.
		if (!caret || !startText || text !== startText || caret.block.id !== block.id) return;
		if ((payload.start ?? yStart) !== yStart || (payload.end ?? yStart) !== yStart) return;
		if (!payload.value || inCodeLines(edytor, block)) return;
		const before = startText.stringContent.slice(0, yStart);
		const subject = before + payload.value;
		// The first rule that matches, with the typed text inside its match.
		const first = rules.findIndex((rule) => {
			const match = matchAtEnd(rule.find, subject);
			return !!match && match.index <= before.length;
		});
		if (first === -1) return;

		prevent(() => {
			running = true;
			try {
				for (const rule of rules.slice(first)) {
					const match = matchAtEnd(rule.find, subject);
					if (!match || match.index > before.length) continue;
					const written = apply(rule, match, startText, block, yStart, caret.offset, payload);
					if (written !== null) {
						if (!written) typeAsIs(startText, payload, yStart);
						return;
					}
				}
				typeAsIs(startText, payload, yStart);
			} finally {
				running = false;
			}
		});
	};

	/**
	 * Run `rule` over `match`: whether it wrote, or `null` when it declined
	 * (the next rule is asked).
	 */
	function apply(
		rule: InputRule,
		match: RegExpExecArray,
		text: Text,
		block: Block,
		yStart: number,
		caretOffset: number,
		payload: TextOperations['insertText']
	): boolean | null {
		const { dispatcher, facade } = edytor;
		/** The match's start in the segment, and in the block. */
		const start = match.index;
		const from = caretOffset - (yStart - start);
		const to = caretOffset;
		let removed: boolean | null = null;
		/** Remove the match in the same plan as `then`'s first operation: `ctx.remove`. */
		const removeMatch = (then?: () => unknown) => {
			const last = dispatcher.last;
			if (to > from) {
				const removal = facade.prepare.deleteText(block.id, from, to - from);
				const run = dispatcher.lead(removal, () => then?.());
				// Nothing took the lead: the matched text goes on its own, unless `then` declined.
				if (!run.taken && run.out !== false && text.index !== -1)
					block.deleteContentAtRange({
						start: [text.index, start],
						end: [text.index, yStart]
					});
			} else dispatcher.alone(() => then?.());
			removed = dispatcher.last !== last && dispatcher.last?.status === 'applied';
			return removed;
		};
		const ctx: InputRuleContext = {
			edytor,
			block,
			from,
			to,
			typed: payload.value,
			caret: (offset) => void dispatcher.caret({ block, offset }),
			remove: removeMatch
		};
		const last = dispatcher.last;
		// Whatever the rule writes is a step of its own, even when no removal leads it.
		const out = dispatcher.alone(() => rule.replace(match, ctx));
		if (typeof out === 'string') {
			const written = removeMatch(() =>
				dispatcher.alone(() => text.insertText({ value: out, start, end: start }))
			);
			if (written) dispatcher.caret({ block, offset: from + out.length });
			return written;
		}
		if (out === false || out === null) return removed ?? null;
		if (removed !== null) return removed;
		// Written without `remove`: what its own commands did decides.
		if (dispatcher.last !== last) return dispatcher.last?.status === 'applied';
		return out === true ? true : null;
	}
};
