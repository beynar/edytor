<script lang="ts">
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import {
		createRichTextPlaceholder,
		createRichTextPlugin
	} from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { createSlashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
	import { createToolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
	import { createBlockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
	import { createImagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
	import { createEmbedPlugin } from '$lib/plugins/media/EmbedPlugin.svelte';
	import { createBookmarkPlugin } from '$lib/plugins/media/BookmarkPlugin.svelte';
	import { createFilePlugin } from '$lib/plugins/media/FilePlugin.svelte';
	import { createVideoPlugin } from '$lib/plugins/media/VideoPlugin.svelte';
	import { createAudioPlugin } from '$lib/plugins/media/AudioPlugin.svelte';
	import { createCodePlugin } from '$lib/plugins/code/CodePlugin.svelte';
	import { createFindPlugin } from '$lib/plugins/find/findPlugin.js';
	import { createSuggestionsPlugin } from '$lib/plugins/suggestions/suggestionsPlugin.js';
	import { createColumnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
	import { createPagePlugin } from '$lib/plugins/page/PagePlugin.svelte';
	import { createTocPlugin } from '$lib/plugins/toc/TocPlugin.svelte';
	import { createCommentsPlugin } from '$lib/plugins/comments/commentsPlugin.js';
	import { createMemoryCommentsClient } from '$lib/collaboration/comments/client.js';
	import { createMentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
	import { createPageLinkPlugin } from '$lib/plugins/pageLink/PageLinkPlugin.svelte';
	import type { Plugin } from '$lib/plugins.js';
	import type { JSONDoc } from '$lib/utils/json.js';
	import { fr, frKeywords } from '../fixtures/labels.fr.js';

	/** Every bundled plugin in French, default plugins on (each listed one replaces its default). */
	let { edytor = $bindable(), value }: { edytor?: EdytorContext; value: JSONDoc } = $props();
	/** An upload, so the panels offer one. */
	const upload = async () => 'https://example.com/file.bin';
	const media = { labels: fr.media, upload };
	const plugins = [
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
		(() => ({ triggers: [{ char: '%', items: () => [], onPick: () => true }] })) as Plugin,
		createRichTextPlugin({ labels: fr.richText, keywords: frKeywords })
	];
</script>

<Edytor
	bind:edytor
	{plugins}
	{value}
	labels={fr.editor}
	blockHandles={{ labels: fr.blockHandles }}
	placeholder={createRichTextPlaceholder(fr.richText)}
/>
