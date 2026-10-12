import type { Snippet } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { branded } from '../brand.js';
import type { Suggestion } from '$lib/session/suggestions.svelte.js';

/** What a `bar` snippet receives: one block suggestion and its actions. */
export type SuggestionBarPayload = {
	suggestion: Suggestion;
	/** Place it in the document and give the editor its focus back. */
	accept: () => void;
	discard: () => void;
	/** Ask for another answer (`onRetry`); `undefined` without one. */
	retry: (() => void) | undefined;
	readonly: boolean;
	/** The view's keys are a Mac's: Mod is ⌘ (name the Accept key with it). */
	mac: boolean;
};

export type SuggestionBarOptions = {
	/** The bar under each block suggestion and its words; its placement is the plugin's. */
	bar: Snippet<[SuggestionBarPayload]>;
};

/**
 * The `end` suggestion a Tab at the caret accepts: a collapsed caret in its
 * block, unless that block indents with Tab (a list-like kind or a list's item).
 */
const endAtCaret = (edytor: Edytor) => {
	const { startText } = edytor.selection.textRange();
	const { isCollapsed } = edytor.selection.projection;
	const startBlock = startText?.parent;
	if (!startBlock || !isCollapsed || startBlock.definition.continues || startBlock.list) return;
	return edytor.suggestions.at(startBlock.id).end.at(-1);
};

/**
 * The keys of `edytor.suggestions` (Notion AI's), a default plugin: for the
 * latest one, Mod+Enter accepts and Escape discards; Tab accepts an `end`
 * suggestion at the caret. Its bar is `createSuggestionBarPlugin`'s.
 */
export const createSuggestionsPlugin = (): Plugin => {
	const plugin: Plugin = (edytor) => ({
		hotkeys: {
			'mod+enter': ({ prevent }) => {
				const latest = edytor.suggestions.latest;
				if (latest) prevent(() => latest.accept());
			},
			escape: ({ prevent }) => {
				const latest = edytor.suggestions.latest;
				if (latest) prevent(() => latest.discard());
			},
			tab: ({ prevent }) => {
				const suggestion = endAtCaret(edytor);
				if (suggestion) prevent(() => suggestion.accept());
			}
		}
	});
	return branded('suggestions', plugin);
};
