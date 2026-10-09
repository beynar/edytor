<script lang="ts">
	import { onMount } from 'svelte';
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import type { JSONDoc } from '$lib/utils/json.js';
	import { richTextPlugin, richTextPlaceholder } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { createMentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
	import { createPageLinkPlugin } from '$lib/plugins/pageLink/PageLinkPlugin.svelte';
	import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
	import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
	import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
	import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
	import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
	import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
	import { createBlockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
	import { columnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
	import { findPlugin } from '$lib/plugins/find/findPlugin.js';
	import { createMarqueePlugin } from '$lib/plugins/marquee/marqueePlugin.js';
	import { tocPlugin } from '$lib/plugins/toc/TocPlugin.svelte';
	import { tablePlugin } from '$lib/plugins/table/TablePlugin.svelte';
	import { tableBlock } from '$lib/crdt/tables.js';
	import { createEquationPlugin } from '$lib/plugins/equation/EquationPlugin.svelte';
	import type { Plugin } from '$lib/plugins.js';
	import { page } from '$app/state';
	import { createIndexeddbSync } from '$lib/collaboration/providers.js';
	import '$lib/themes/notion.css';
	import './demo.css';

	let edytor = $state<EdytorContext>();
	let isMounted = $state(false);

	/** `#block-<id>` anchors: a copied block link scrolls to its block. */
	const demoPagePlugin: Plugin = () => ({
		onBlockAttached: ({ node, block }) => {
			const anchor = `block-${block.id}`;
			if (!block.isRoot && !node.ownerDocument.getElementById(anchor)) {
				node.id = anchor;
				if (location.hash === `#${anchor}`) {
					node.ownerDocument.defaultView?.requestAnimationFrame(() =>
						node.scrollIntoView({ block: 'center' })
					);
				}
			}
			return () => {
				if (node.id === anchor) node.removeAttribute('id');
			};
		}
	});
	/** The demo's people and pages: what an app's directory and search would answer. */
	const PEOPLE = [
		{ id: 'ada', label: 'Ada Lovelace', description: 'Engineering' },
		{ id: 'alan', label: 'Alan Turing', description: 'Research' },
		{ id: 'grace', label: 'Grace Hopper', description: 'Compilers' },
		{ id: 'katherine', label: 'Katherine Johnson', description: 'Flight' }
	];
	const PAGES = [
		{ id: 'roadmap', title: 'Roadmap', icon: '🗺️' },
		{ id: 'meeting-notes', title: 'Meeting notes', icon: '📝' },
		{ id: 'design-system', title: 'Design system', icon: '🎨' }
	];
	const matching = (query: string, text: string) =>
		text.toLowerCase().includes(query.trim().toLowerCase());
	const mentionPlugin = createMentionPlugin({
		items: (query) => PEOPLE.filter((person) => matching(query, person.label))
	});
	const pageLinkPlugin = createPageLinkPlugin({
		search: (query) => PAGES.filter((page) => matching(query, page.title)),
		href: (page) => `#${page.id}`
	});
	const plugins = [
		arrowMovePlugin,
		imagePlugin,
		codePlugin,
		markdownShortcutsPlugin,
		mentionPlugin,
		pageLinkPlugin,
		slashMenuPlugin,
		toolbarPlugin,
		createBlockMenuPlugin({
			linkTo: (block) => `${location.origin}${location.pathname}#block-${block.id}`
		}),
		demoPagePlugin,
		columnsPlugin,
		findPlugin,
		// Drag from the page's margins or below the last block to select blocks (Notion).
		createMarqueePlugin({ container: '.demo-main' }),
		tocPlugin,
		tablePlugin,
		// KaTeX loads from jsDelivr the first time an equation shows.
		createEquationPlugin(),
		richTextPlugin
	];
	const demoValue: JSONDoc = {
		children: [
			{
				id: 'page-title',
				type: 'heading',
				data: { level: 'h1' },
				content: [{ text: 'A calmer place to think' }]
			},
			{
				id: 'page-intro',
				type: 'paragraph',
				content: [
					{ text: 'Edytor is a canvas for notes that grow into something more. ' },
					{ text: 'Select text', marks: { bold: true } },
					{ text: ' to format it, or type ' },
					{ text: '/', marks: { code: true } },
					{ text: ' on a new line to add a block.' }
				]
			},
			{
				id: 'page-callout',
				type: 'callout',
				data: { icon: '💡' },
				content: [{ text: 'Everything here is editable' }],
				children: [
					{
						id: 'page-callout-body',
						type: 'paragraph',
						content: [
							{ text: 'Grab the six-dot handle', marks: { bold: true } },
							{ text: ' to move a block, nest it, or open its menu. Click the icon to change it.' }
						]
					}
				]
			},
			{
				id: 'page-section',
				type: 'heading',
				data: { level: 'h2' },
				content: [{ text: 'Make room for ideas' }]
			},
			{
				id: 'page-section-intro',
				type: 'paragraph',
				content: [{ text: 'Start with a thought. Give it structure when you need it.' }]
			},
			{
				id: 'page-task-one',
				type: 'todo-item',
				data: { checked: false },
				content: [{ text: 'Write down the first rough version' }]
			},
			{
				id: 'page-task-two',
				type: 'todo-item',
				data: { checked: false },
				content: [{ text: 'Move related thoughts together' }]
			},
			{
				id: 'page-bullet-one',
				type: 'bulleted-list-item',
				content: [{ text: 'Blocks are the building pieces.' }]
			},
			{
				id: 'page-bullet-two',
				type: 'bulleted-list-item',
				content: [{ text: 'Your words stay yours, even as the page changes.' }]
			},
			{
				id: 'page-quote',
				type: 'quote',
				content: [{ text: 'The best ideas rarely arrive in order.' }]
			},
			{
				id: 'page-columns',
				type: 'columns',
				children: [
					{
						id: 'page-column-left',
						type: 'column',
						children: [
							{
								id: 'page-column-left-text',
								type: 'paragraph',
								content: [{ text: 'Put two thoughts side by side.' }]
							}
						]
					},
					{
						id: 'page-column-right',
						type: 'column',
						children: [
							{
								id: 'page-column-right-text',
								type: 'paragraph',
								content: [{ text: 'Each column holds any block.' }]
							}
						]
					}
				]
			},
			{
				...tableBlock({
					cells: [
						['Block', 'What it holds'],
						['Table', 'Rows of cells, each a line of text'],
						['Columns', 'Any blocks, side by side']
					],
					headerRow: true,
					widths: [140, 260]
				}),
				id: 'page-table'
			},
			{
				id: 'page-toggle',
				type: 'toggle',
				content: [{ text: 'A few more ways to work' }],
				children: [
					{
						id: 'page-toggle-child',
						type: 'paragraph',
						content: [{ text: 'Turn a block into a heading, list, quote, callout, or code.' }]
					}
				]
			},
			{
				id: 'page-code',
				type: 'code',
				content: [{ text: '' }],
				children: [
					{
						id: 'page-code-line',
						type: 'codeLine',
						content: [{ text: 'const idea = "start somewhere";' }]
					}
				]
			},
			{
				id: 'page-math',
				type: 'paragraph',
				content: [
					{ text: 'Write math inline, like ' },
					{
						type: 'inlineEquation',
						id: 'page-math-inline',
						data: { expression: 'e^{i\\pi} + 1 = 0' }
					},
					{ text: ', or as a block:' }
				]
			},
			{
				id: 'page-equation',
				type: 'equation',
				data: { expression: '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}' }
			},
			{
				id: 'page-mentions',
				type: 'paragraph',
				content: [
					{ text: 'Ask ' },
					{ type: 'mention', id: 'page-mention-ada', data: { id: 'ada', label: 'Ada Lovelace' } },
					{ text: ' about the ' },
					{
						type: 'pageLink',
						id: 'page-link-roadmap',
						data: { id: 'roadmap', title: 'Roadmap', icon: '🗺️', href: '#roadmap' }
					},
					{ text: ': type ' },
					{ text: '@', marks: { code: true } },
					{ text: ' to mention someone, ' },
					{ text: '[[', marks: { code: true } },
					{ text: ' to link a page.' }
				]
			},
			{ id: 'page-end', type: 'paragraph', content: [{ text: '' }] }
		]
	};

	onMount(() => {
		// The live editor creates per-view DOM state; mount it after the static
		// workspace shell hydrates so server/client markup stays identical.
		isMounted = true;
	});

	// `?blocks=5000`: the demo content repeated to that many top-level blocks.
	// The copies drop every id (the editor mints fresh ones).
	const bigValue = (doc: JSONDoc, count: number): JSONDoc =>
		count > 0
			? JSON.parse(
					JSON.stringify({
						children: Array.from({ length: count }, (_, i) => doc.children[i % doc.children.length])
					}),
					(key, value) => (key === 'id' ? undefined : value)
				)
			: doc;
	const initialValue = bigValue(demoValue, Number(page.url.searchParams.get('blocks')));
	// One local document per `?doc=` (or per `?blocks=` variant): its tabs sync
	// (IndexedDB + BroadcastChannel) and it persists across reloads.
	const docName = page.url.searchParams.get('doc') ?? page.url.searchParams.get('blocks') ?? 'page';
	const sync = createIndexeddbSync(`edytor-demo-${docName}`);
</script>

<svelte:head>
	<title>Edytor — A calmer place to think</title>
	<meta
		name="description"
		content="A living document playground for the Edytor rich text editor."
	/>
</svelte:head>

<div class="demo-shell edytor-notion">
	<aside class="demo-sidebar" aria-label="Workspace">
		<div class="workspace-switcher">
			<span class="workspace-avatar">E</span><span class="workspace-name">Edytor workspace</span
			><span class="workspace-chevron">⌄</span>
		</div>
		<div class="sidebar-section">
			<div class="sidebar-row"><span class="sidebar-icon">⌕</span><span>Search</span></div>
			<div class="sidebar-row"><span class="sidebar-icon">⌂</span><span>Home</span></div>
		</div>
		<div class="sidebar-section">
			<div class="sidebar-heading">Private</div>
			<div class="sidebar-row sidebar-row-active">
				<span class="sidebar-icon">🌱</span><span>A calmer place to think</span>
			</div>
		</div>
		<div class="sidebar-section">
			<div class="sidebar-heading">Try</div>
			<p class="sidebar-note">
				Type <kbd>/</kbd> for blocks, select text to format, drag <kbd>⋮⋮</kbd> to move, and click
				it for the block menu. Markdown works too: <kbd>#</kbd>, <kbd>-</kbd>,
				<kbd>[]</kbd>, <kbd>&gt;</kbd>, <kbd>**bold**</kbd>.
			</p>
		</div>
	</aside>
	<div class="demo-workspace">
		<header class="demo-topbar">
			<div class="demo-breadcrumbs">
				<span class="breadcrumb-icon">🌱</span><span>A calmer place to think</span>
			</div>
			<div class="topbar-actions">
				<span class="demo-indicator">Edited just now</span>
				<button type="button" title="Undo" aria-label="Undo" onclick={() => edytor?.historyUndo()}
					>↶</button
				>
				<button type="button" title="Redo" aria-label="Redo" onclick={() => edytor?.historyRedo()}
					>↷</button
				>
			</div>
		</header>
		<main class="demo-main">
			<div class="document-page">
				<div class="page-icon" aria-hidden="true">🌱</div>
				<div class="page-editor">
					{#if isMounted}
						<Edytor
							{plugins}
							value={initialValue}
							{sync}
							class="demo-edytor"
							aria-label="A calmer place to think"
							blockHandles={page.url.searchParams.get('handles') === '0' ? false : undefined}
							placeholder={richTextPlaceholder}
							bind:edytor
						/>
					{/if}
				</div>
			</div>
		</main>
	</div>
</div>
