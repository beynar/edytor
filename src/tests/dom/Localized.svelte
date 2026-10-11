<script lang="ts">
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
		mention as createMentionPlugin,
		pageLink as createPageLinkPlugin,
		richText as createRichTextPlugin,
		slashMenu as createSlashMenuPlugin,
		suggestions as createSuggestionsPlugin,
		toolbar as createToolbarPlugin,
		video as createVideoPlugin
	} from '../../routes/chrome/plugins.js';
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import { createRichTextPlaceholder } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { createColumnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
	import { createPagePlugin } from '$lib/plugins/page/PagePlugin.svelte';
	import { createTocPlugin } from '$lib/plugins/toc/TocPlugin.svelte';
	import { createMemoryCommentsClient } from '$lib/collaboration/comments/client.js';
	import type { Plugin } from '$lib/plugins.js';
	import type { JSONDoc } from '$lib/utils/json.js';
	import { fr, frKeywords } from '../fixtures/labels.fr.js';

	/** Every bundled plugin in French, default plugins on (each listed one replaces its default). */
	let { edytor = $bindable(), value }: { edytor?: EdytorContext; value: JSONDoc } = $props();
	/** An upload, so the panels offer one. */
	const upload = async () => 'https://example.com/file.bin';
	const media = { labels: fr.media, upload };
	const plugins = [
		blockHandles({ labels: fr.blockHandles }),
		createSlashMenuPlugin({ labels: fr.slashMenu }),
		createToolbarPlugin({ labels: fr.toolbar }),
		createBlockMenuPlugin({ labels: fr.blockMenu, linkTo: (block) => `#${block.id}` }),
		createImagePlugin({ labels: fr.image, upload }),
		createEmbedPlugin({ labels: fr.media }),
		createBookmarkPlugin({ labels: fr.media }),
		createFilePlugin(media),
		createVideoPlugin(media),
		createAudioPlugin(media),
		createCodePlugin({ labels: fr.code }),
		createFindPlugin({ labels: fr.find }),
		createSuggestionsPlugin({ labels: fr.suggestions }),
		createColumnsPlugin({ labels: fr.columns }),
		createPagePlugin({ labels: fr.page, keywords: frKeywords, create: () => 'page-1' }),
		createTocPlugin({ labels: fr.toc, keywords: frKeywords }),
		createCommentsPlugin({
			labels: fr.comments,
			client: createMemoryCommentsClient({ user: 'ada' }),
			user: 'ada'
		}),
		createMentionPlugin({ labels: fr.mention, items: () => [] }),
		createPageLinkPlugin({ labels: fr.pageLink, search: () => [] }),
		// An app's own trigger naming nothing: the view's words.
		(() => ({
			triggers: [{ char: '%', items: () => [], onPick: () => true, menu: chrome.triggerMenu }]
		})) as Plugin,
		createRichTextPlugin({ labels: fr.richText, keywords: frKeywords })
	];
</script>

<Edytor
	bind:edytor
	{plugins}
	{value}
	labels={fr.editor}
	placeholder={createRichTextPlaceholder(fr.richText)}
/>
