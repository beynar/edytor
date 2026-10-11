import { mount, unmount, type Snippet } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { Suggestion } from '$lib/session/suggestions.svelte.js';
import SuggestionBars from './SuggestionBars.svelte';
import {
	suggestionsEnglish,
	labelsWith,
	type PartialLabels,
	type SuggestionsLabels
} from '$lib/labels.js';

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
	/** The plugin's words (`labels`), for your bar. */
	labels: SuggestionsLabels;
};

export type SuggestionsOptions = {
	/**
	 * The bar under each block suggestion (without it, none: the keys still
	 * accept and discard); placement and keys are the plugin's.
	 */
	bar?: Snippet<[SuggestionBarPayload]>;
	/** The words the bar shows, over the English ones. */
	labels?: PartialLabels<'suggestions'>;
};

const suggestionPlugins = new WeakSet<Plugin>();

/** Recognize any suggestions plugin instance (the component's default yields to yours). */
export const isSuggestionsPlugin = (plugin: Plugin) => suggestionPlugins.has(plugin);

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
 * The UI of `edytor.suggestions` (Notion AI's): the app's `bar` under each
 * block suggestion (Accept, Discard, and Try again when the app passed
 * `onRetry`), and keys for the latest one: Mod+Enter accepts, Escape
 * discards; Tab accepts an `end` suggestion at the caret.
 */
export const createSuggestionsPlugin = (options: SuggestionsOptions = {}): Plugin => {
	const labels = labelsWith(suggestionsEnglish, options.labels);
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
		},
		onEdytorAttached: () => {
			const { bar } = options;
			if (!bar) return;
			const bars = mount(SuggestionBars, {
				target: edytor.overlay.layer!,
				props: { edytor, bar, labels }
			});
			return () => void unmount(bars);
		}
	});
	suggestionPlugins.add(plugin);
	return plugin;
};

/** The suggestions' keys, with no bar. */
export const suggestionsPlugin = createSuggestionsPlugin();
