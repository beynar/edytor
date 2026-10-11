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

	return (change) => {
		const { dispatcher, facade, selection } = edytor;
		if (running || change.operation !== 'insertText' || !rules.length) return;
		// Typed text only: a paste or a drop (a URL pasted at the caret) completes no rule.
		if (dispatcher.command?.startsWith('insertFrom')) return;
		const { payload, block, prevent, text } = change;
		const [, offset, value] = payload;
		const { startText, yStart } = selection.textRange();
		// Only text typed at the caret: an insertion elsewhere completes no rule.
		if (!selection.caret || !text || text !== startText) return;
		if (offset !== text.segStart + yStart) return;
		if (!value || inCodeLines(edytor, block)) return;
		const before = text.stringContent.slice(0, yStart);
		const subject = before + value;
		// The rules that match, with the typed text inside their match.
		const matches = rules.flatMap((rule) => {
			const match = matchAtEnd(rule.find, subject);
			return match && match.index <= before.length ? [{ rule, match }] : [];
		});
		if (!matches.length) return;

		/** The typed text lands as typed, the caret after it. */
		const typeAsIs = () => {
			edytor.insertText(...payload);
			dispatcher.caret(text, yStart + value.length);
		};

		/**
		 * Run `rule` over `match`: whether it wrote, or `null` when it declined
		 * (the next rule is asked).
		 */
		const apply = (rule: InputRule, match: RegExpExecArray): boolean | null => {
			/** The match's start in the segment; the match in the block, `from` to the caret. */
			const start = match.index;
			const from = text.segStart + start;
			const to = text.segStart + yStart;
			let removed: boolean | null = null;
			/** Remove the match in the same plan as `then`'s first operation: `ctx.remove`. */
			const remove = (then?: () => unknown) => {
				const last = dispatcher.last;
				if (to > from) {
					const removal = facade.prepare.deleteText(block.id, from, to - from);
					const run = dispatcher.lead(removal, () => then?.());
					// Nothing took the lead: the matched text goes on its own, unless `then` declined.
					if (!run.taken && run.out !== false && text.index !== -1)
						edytor.deleteText(block.id, from, to - from);
				} else dispatcher.alone(() => then?.());
				removed = dispatcher.last !== last && dispatcher.last?.status === 'applied';
				return removed;
			};
			const ctx: InputRuleContext = {
				edytor,
				block,
				from,
				to,
				typed: value,
				caret: (offset) => void dispatcher.caret({ block, offset }),
				remove
			};
			const last = dispatcher.last;
			// Whatever the rule writes is a step of its own, even when no removal leads it.
			const out = dispatcher.alone(() => rule.replace(match, ctx));
			if (typeof out === 'string') {
				const written = remove(() =>
					dispatcher.alone(() => edytor.insertText(block.id, from, out))
				);
				if (written) dispatcher.caret({ block, offset: from + out.length });
				return written;
			}
			if (out === false || out === null) return removed;
			if (removed !== null) return removed;
			// Written without `remove`: what its own commands did decides.
			if (dispatcher.last !== last) return dispatcher.last?.status === 'applied';
			return out === true ? true : null;
		};

		prevent(() => {
			running = true;
			try {
				for (const { rule, match } of matches) {
					const written = apply(rule, match);
					if (written !== null) return written || typeAsIs();
				}
				typeAsIs();
			} finally {
				running = false;
			}
		});
	};
};
