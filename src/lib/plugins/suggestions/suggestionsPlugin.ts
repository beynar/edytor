import { mount, unmount, type Snippet } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { Suggestion } from '$lib/session/suggestions.svelte.js';
import SuggestionBars from './SuggestionBars.svelte';
import { labelsWith, type PartialLabels, type SuggestionsLabels } from '$lib/labels.js';

/** What a `bar` snippet receives: one block suggestion and its actions. */
export type SuggestionBarPayload = {
	suggestion: Suggestion;
	/** Place it in the document and give the editor its focus back. */
	accept: () => void;
	discard: () => void;
	/** Ask for another answer (`onRetry`); `undefined` without one. */
	retry: (() => void) | undefined;
	readonly: boolean;
	/** The words the built-in bar shows (the plugin's `labels`), for yours. */
	labels: SuggestionsLabels;
};

export type SuggestionsOptions = {
	/** Replace the bar under each block suggestion; placement and keys stay the plugin's. */
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
	const { startBlock, isCollapsed } = edytor.selection.state;
	if (!startBlock || !isCollapsed || startBlock.definition.continues || startBlock.list) return;
	return edytor.suggestions.at(startBlock.id).end.at(-1);
};

/**
 * The default UI of `edytor.suggestions` (Notion AI's): a bar under each
 * block suggestion (Accept, Discard, and Try again when the app passed
 * `onRetry`), and keys for the latest one: Mod+Enter accepts, Escape
 * discards; Tab accepts an `end` suggestion at the caret.
 */
export const createSuggestionsPlugin = (options: SuggestionsOptions = {}): Plugin => {
	const labels = labelsWith('suggestions', options.labels);
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
			const bars = mount(SuggestionBars, {
				target: edytor.overlay.layer!,
				props: { edytor, bar: options.bar, labels }
			});
			return () => void unmount(bars);
		}
	});
	suggestionPlugins.add(plugin);
	return plugin;
};

/** The default suggestion UI. */
export const suggestionsPlugin = createSuggestionsPlugin();
