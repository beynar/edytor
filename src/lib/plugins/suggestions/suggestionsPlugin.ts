import type { Snippet } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { branded } from '../brand.js';
import type { AnySuggestion } from '$lib/session/suggestions.svelte.js';

/** What a `bar` snippet receives: one suggestion (a block suggestion, or a shared one) and its actions. */
export type SuggestionBarPayload = {
	suggestion: AnySuggestion;
	/** Accept it (a view-local one: place it in the document) and give the editor its focus back. */
	accept: () => void;
	/** Drop it (a shared one: its author withdraws it, a decider rejects it). */
	discard: () => void;
	/** Reject a shared one (a view-local one: drop it). */
	reject: () => void;
	/** Ask for another answer (`onRetry`); `undefined` without one. */
	retry: (() => void) | undefined;
	readonly: boolean;
	/** This view may accept or reject it (a shared one; else: not readonly). */
	canDecide: boolean;
	/** A shared one's author, as their profile names them ("Ada", with `suggestion.via`: "Ada (AI)"). */
	author: { id: string; name?: string; color?: string } | undefined;
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
