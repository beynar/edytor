<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		audio as createAudioPlugin,
		blockHandles,
		chrome,
		blockMenu as createBlockMenuPlugin,
		bookmark as createBookmarkPlugin,
		code as createCodePlugin,
		comments as createCommentsPlugin,
		embed as createEmbedPlugin,
		file as createFilePlugin,
		find as createFindPlugin,
		image as createImagePlugin,
		mediaEmptyPlugin,
		imageToolbarPlugin,
		mention as createMentionPlugin,
		pageLink as createPageLinkPlugin,
		richText as createRichTextPlugin,
		slashMenu as createSlashMenuPlugin,
		suggestionsPlugin,
		suggestionBarPlugin,
		toolbar as createToolbarPlugin,
		video as createVideoPlugin
	} from '$registry/edytor/chrome/plugins.js';
	import { setWords } from '$registry/edytor/chrome/words.svelte.js';
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import { richTextPlaceholder } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { withRulesAndTriggers } from '$lib/plugins/triggers/triggers.js';
	import { createColumnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
	import { createPagePlugin } from '$lib/plugins/page/PagePlugin.svelte';
	import { createTocPlugin } from '$lib/plugins/toc/TocPlugin.svelte';
	import { createMemoryCommentsClient } from '$lib/collaboration/comments/client.js';
	import type { Plugin } from '$lib/plugins.js';
	import type { JSONDoc } from '$lib/utils/json.js';
	import { fr, frKeywords, frLanguages } from '../fixtures/labels.fr.js';
	import { frWords } from '../fixtures/words.fr.js';

	/**
	 * Every bundled plugin in a French view, default plugins on (each listed
	 * one replaces its default): the package's words are the view's
	 * `labels`, the chrome's the demo chrome's `words`.
	 */
	let { edytor = $bindable(), value }: { edytor?: EdytorContext; value: JSONDoc } = $props();
	setWords(frWords);
	onDestroy(() => setWords());
	/** An upload, so the panels offer one. */
	const upload = async () => 'https://example.com/file.bin';
	const plugins = [
		// Notion's hints in empty blocks: a plugin's placeholder.
		() => ({ placeholder: richTextPlaceholder }),
		blockHandles(),
		createSlashMenuPlugin(),
		createToolbarPlugin(),
		createBlockMenuPlugin({ linkTo: (block) => `#${block.id}` }),
		mediaEmptyPlugin,
		imageToolbarPlugin,
		createImagePlugin({ upload }),
		createEmbedPlugin(),
		createBookmarkPlugin(),
		createFilePlugin({ upload }),
		createVideoPlugin({ upload }),
		createAudioPlugin({ upload }),
		createCodePlugin({ languages: frLanguages }),
		createFindPlugin(),
		suggestionsPlugin,
		suggestionBarPlugin,
		createColumnsPlugin(),
		createPagePlugin({ create: () => 'page-1' }),
		createTocPlugin(),
		createCommentsPlugin({ client: createMemoryCommentsClient({ user: 'ada' }), user: 'ada' }),
		createMentionPlugin({ items: () => [] }),
		createPageLinkPlugin({ search: () => [] }),
		// An app's own trigger naming nothing: the chrome's words for it.
		((edytor) =>
			withRulesAndTriggers(
				edytor,
				{},
				{
					triggers: [{ char: '%', items: () => [], onPick: () => true, menu: chrome.triggerMenu }]
				}
			)) as Plugin,
		createRichTextPlugin()
	];
</script>

<Edytor bind:edytor {plugins} {value} labels={{ ...fr, keywords: frKeywords }} />
