<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import type { Block } from '$lib/block/block.svelte.js';
	import type { BlockMoveDirection } from '$lib/session/moves.js';
	import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';
	import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
	import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
	import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
	import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
	import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
	import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
	import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
	import { convertToKind, type KindRow } from '$lib/kinds.js';
	import type { BlockHandleActivation } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
	import type { Plugin } from '$lib/plugins.js';
	import { page } from '$app/state';
	import { createIndexeddbSync } from '$lib/collaboration/providers.js';
	import './demo.css';

	let edytor = $state<EdytorContext>();
	let isMounted = $state(false);
	let blockMenuNode = $state<HTMLDivElement>();
	let blockMenuTrigger: HTMLElement | null = null;
	let repositionBlockMenu: (() => void) | null = null;
	let blockMenu = $state<{ blockId: string } | null>(null);
	let copiedBlockId = $state<string | null>(null);
	let copyFailed = $state(false);

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
	const plugins = [
		arrowMovePlugin,
		imagePlugin,
		codePlugin,
		markdownShortcutsPlugin,
		mentionPlugin,
		slashMenuPlugin,
		toolbarPlugin,
		demoPagePlugin,
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
				data: { icon: '✦' },
				content: [
					{ text: 'Everything here is editable. ' },
					{ text: 'Grab the six-dot handle', marks: { bold: true } },
					{ text: ' to move a block, nest it, or open its menu.' }
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
			{ id: 'page-end', type: 'paragraph', content: [{ text: '' }] }
		]
	};

	// "Turn into" rows: the kind catalogue's conversions that keep the block's content.
	const blockChoices = $derived(edytor?.kinds.filter((kind) => !kind.replaces) ?? []);
	const activeBlock = $derived(
		blockMenu && edytor ? edytor.idToBlock.get(blockMenu.blockId) : undefined
	);

	const copyWithoutIds = (value: JSONBlock): JSONBlock => ({
		type: value.type,
		...(value.data ? { data: value.data } : {}),
		...(value.content
			? {
					content: value.content.map((part) =>
						'text' in part
							? { text: part.text, ...(part.marks ? { marks: part.marks } : {}) }
							: { type: part.type, ...(part.data ? { data: part.data } : {}) }
					)
				}
			: {}),
		...(value.children ? { children: value.children.map(copyWithoutIds) } : {})
	});
	const restoreCaret = async (block: Block | null | undefined) => {
		if (!edytor || !block) return;
		await tick();
		const text = block.firstEditableText ?? (block.definition.void ? undefined : block.firstText);
		if (!text) return;
		// Clear any atomic block selection before the DOM caret write.
		edytor.selection.setAtTextOffset(text, 0);
		edytor.selection.setAtTextOffset(text, 0);
		edytor.node?.focus({ preventScroll: true });
	};
	const addBlockBelow = async () => {
		const added = activeBlock?.insertBlockAfter({ block: { type: 'paragraph' } });
		blockMenu = null;
		await restoreCaret(added);
	};
	const duplicateBlock = async () => {
		const duplicate = activeBlock?.insertBlockAfter({ block: copyWithoutIds(activeBlock.value) });
		blockMenu = null;
		await restoreCaret(duplicate);
	};
	const deleteBlock = () => {
		const block = activeBlock;
		if (!block) return;
		const next = block.nextBlock ?? block.previousBlock;
		block.removeBlock();
		blockMenu = null;
		void restoreCaret(next);
	};
	const transformBlock = (choice: KindRow) => {
		const block = activeBlock;
		if (edytor) convertToKind(edytor, block, choice);
		blockMenu = null;
		void restoreCaret(block);
	};
	const canMove = (direction: BlockMoveDirection) =>
		!!activeBlock && !!edytor?.canMoveBlocks({ blocks: [activeBlock], direction });
	const moveBlock = (direction: BlockMoveDirection) => {
		const block = activeBlock;
		if (!block || !edytor) return;
		edytor.moveBlocks({ blocks: [block], direction });
		blockMenu = null;
		void restoreCaret(block);
	};
	const copyBlockLink = async () => {
		const block = activeBlock;
		if (!block) return;
		const anchor = `block-${block.id}`;
		try {
			await navigator.clipboard.writeText(`${location.origin}${location.pathname}#${anchor}`);
			copiedBlockId = block.id;
			copyFailed = false;
		} catch {
			copyFailed = true;
		}
	};
	const closeBlockMenu = (restoreFocus = false) => {
		blockMenu = null;
		if (restoreFocus && blockMenuTrigger?.isConnected) {
			blockMenuTrigger.focus({ preventScroll: true });
		}
	};
	const handleBlockMenuKeyDown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeBlockMenu(true);
			return;
		}
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
		if (!blockMenuNode) return;
		const items = Array.from(
			blockMenuNode.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
		);
		if (!items.length) return;
		event.preventDefault();
		const current = items.findIndex((item) => item === document.activeElement);
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? items.length - 1
					: event.key === 'ArrowDown'
						? (current + 1) % items.length
						: (current - 1 + items.length) % items.length;
		items[next]?.focus({ preventScroll: true });
		items[next]?.scrollIntoView({ block: 'nearest' });
	};

	const openBlockMenu = ({ block, anchor }: BlockHandleActivation) => {
		const text = block.firstEditableText ?? block.firstText;
		if (text) edytor?.selection.setAtTextOffset(text, 0);
		else edytor?.selection.selectBlocks();
		blockMenuTrigger = anchor;
		blockMenu = { blockId: block.id };
		copiedBlockId = null;
		copyFailed = false;
		void tick().then(() => {
			repositionBlockMenu?.();
			blockMenuNode
				?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
				?.focus({ preventScroll: true });
		});
	};
	const positionBlockMenu = (node: HTMLDivElement) => {
		const gap = 8;
		const edge = 8;
		let frame = 0;
		let placeAbove = false;
		let hasPlacement = false;
		let observedAnchor: HTMLElement | null = null;
		const position = () => {
			frame = 0;
			const anchor = blockMenuTrigger;
			if (!anchor?.isConnected) {
				blockMenu = null;
				return;
			}
			if (anchor !== observedAnchor) {
				if (observedAnchor) observer.unobserve(observedAnchor);
				observer.observe(anchor);
				observedAnchor = anchor;
				hasPlacement = false;
			}

			const anchorRect = anchor.getBoundingClientRect();
			const menuWidth = node.getBoundingClientRect().width;
			const viewportWidth = window.innerWidth;
			const viewportHeight = window.innerHeight;
			if (
				anchorRect.bottom < 0 ||
				anchorRect.top > viewportHeight ||
				anchorRect.right < 0 ||
				anchorRect.left > viewportWidth
			) {
				blockMenu = null;
				return;
			}
			const right = anchorRect.right + gap;
			const left = anchorRect.left - gap - menuWidth;
			const x =
				right + menuWidth <= viewportWidth - edge
					? right
					: left >= edge
						? left
						: Math.max(edge, Math.min(right, viewportWidth - edge - menuWidth));

			const contentHeight = Math.min(node.scrollHeight, 520);
			const below = Math.max(0, viewportHeight - edge - anchorRect.top);
			const visibleAnchorBottom = Math.min(anchorRect.bottom, viewportHeight - edge);
			const above = Math.max(0, visibleAnchorBottom - edge);
			if (!hasPlacement) {
				placeAbove = below < contentHeight / 2 && above > below;
				hasPlacement = true;
			} else if (placeAbove && above < contentHeight / 2 && below > above) {
				placeAbove = false;
			} else if (!placeAbove && below < contentHeight / 2 && above > below) {
				placeAbove = true;
			}
			node.style.maxHeight = `${Math.min(contentHeight, placeAbove ? above : below)}px`;
			const menuHeight = node.getBoundingClientRect().height;
			const y = placeAbove
				? Math.max(edge, visibleAnchorBottom - menuHeight)
				: Math.max(edge, Math.min(anchorRect.top, viewportHeight - edge - menuHeight));
			node.style.left = `${x}px`;
			node.style.top = `${y}px`;
			node.style.visibility = 'visible';
		};
		const schedule = () => {
			if (!frame) frame = window.requestAnimationFrame(position);
		};
		const observer = new ResizeObserver(schedule);
		observer.observe(node);
		if (edytor?.node) observer.observe(edytor.node);
		window.addEventListener('scroll', schedule, true);
		window.addEventListener('resize', schedule);
		repositionBlockMenu = position;
		position();
		return {
			destroy() {
				if (repositionBlockMenu === position) repositionBlockMenu = null;
				window.cancelAnimationFrame(frame);
				observer.disconnect();
				window.removeEventListener('scroll', schedule, true);
				window.removeEventListener('resize', schedule);
			}
		};
	};

	onMount(() => {
		// The live editor creates per-view DOM state; mount it after the static
		// workspace shell hydrates so server/client markup stays identical.
		isMounted = true;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			const target = event.target;
			if (
				target instanceof Element &&
				!target.closest('[data-demo-block-menu], [data-testid="block-handle"]')
			)
				blockMenu = null;
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && blockMenu) closeBlockMenu(true);
		};
		window.addEventListener('pointerdown', closeOnOutsidePointer, true);
		window.addEventListener('keydown', closeOnEscape);
		return () => {
			window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
			window.removeEventListener('keydown', closeOnEscape);
		};
	});

	// `?blocks=5000`: the demo content repeated (ids stripped) to that many top-level blocks.
	const withoutIds = ({ id: _, children, ...block }: JSONBlock): JSONBlock => ({
		...block,
		...(children && { children: children.map(withoutIds) })
	});
	const bigValue = (doc: JSONDoc, count: number): JSONDoc =>
		count > 0
			? {
					children: Array.from({ length: count }, (_, i) =>
						withoutIds(doc.children[i % doc.children.length]!)
					)
				}
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

<div class="demo-shell">
	<aside class="demo-sidebar" aria-label="Workspace">
		<div class="workspace-switcher">
			<span class="workspace-avatar">e</span><span class="workspace-name">Edytor workspace</span
			><span class="workspace-chevron">⌄</span>
		</div>
		<div class="sidebar-section">
			<div class="sidebar-heading">Private</div>
			<div class="sidebar-row sidebar-row-active">
				<span class="sidebar-icon">✦</span><span>A calmer place to think</span>
			</div>
		</div>
		<div class="sidebar-section">
			<div class="sidebar-heading">Quick start</div>
			<p class="sidebar-note">
				Select words to format them. Type / on a line for blocks. Grab ⋮⋮ to move, nest, or open the
				block menu.
			</p>
		</div>
		<div class="sidebar-bottom"><span>Edytor playground</span></div>
	</aside>
	<div class="demo-workspace">
		<header class="demo-topbar">
			<div class="demo-breadcrumbs">
				<span class="breadcrumb-icon">✦</span><span>A calmer place to think</span><span
					class="breadcrumb-chevron">⌄</span
				>
			</div>
			<div class="topbar-actions">
				<span class="demo-indicator"><span></span> Demo document</span>
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
				<div class="page-icon" aria-hidden="true">✦</div>
				<div class="page-kicker">YOUR SPACE TO MAKE SOMETHING</div>
				<div class="page-editor">
					{#if isMounted}
						<Edytor
							{plugins}
							value={initialValue}
							{sync}
							class="demo-edytor"
							blockHandles={page.url.searchParams.get('handles') === '0'
								? false
								: { onActivate: openBlockMenu }}
							placeholder={(view) => (view.focused ? "Type '/' for commands" : null)}
							bind:edytor
						/>
					{/if}
				</div>
				<div class="page-footer"><span>✦</span> A blank page is an invitation. Keep writing.</div>
			</div>
		</main>
	</div>
	{#if blockMenu && activeBlock}
		<div
			class="demo-block-menu"
			data-demo-block-menu
			role="menu"
			tabindex="-1"
			aria-label="Block actions"
			use:positionBlockMenu
			bind:this={blockMenuNode}
			onkeydown={handleBlockMenuKeyDown}
		>
			<div class="block-menu-heading">Turn into</div>
			<div class="block-menu-types">
				{#each blockChoices as choice (choice.id)}
					<button type="button" role="menuitem" onclick={() => transformBlock(choice)}
						><span class="block-menu-icon">{choice.icon}</span><span>{choice.label}</span></button
					>
				{/each}
			</div>
			<div class="block-menu-divider"></div>
			<button
				type="button"
				role="menuitem"
				onclick={() => moveBlock('up')}
				disabled={!canMove('up')}><span class="block-menu-icon">↑</span><span>Move up</span></button
			>
			<button
				type="button"
				role="menuitem"
				onclick={() => moveBlock('down')}
				disabled={!canMove('down')}
				><span class="block-menu-icon">↓</span><span>Move down</span></button
			>
			<button
				type="button"
				role="menuitem"
				onclick={() => moveBlock('in')}
				disabled={!canMove('in')}><span class="block-menu-icon">→</span><span>Indent</span></button
			>
			<button
				type="button"
				role="menuitem"
				onclick={() => moveBlock('out')}
				disabled={!canMove('out')}
				><span class="block-menu-icon">←</span><span>Outdent</span></button
			>
			<div class="block-menu-divider"></div>
			<button type="button" role="menuitem" onclick={addBlockBelow}
				><span class="block-menu-icon">＋</span><span>Add block below</span></button
			>
			<button type="button" role="menuitem" onclick={duplicateBlock}
				><span class="block-menu-icon">⧉</span><span>Duplicate</span></button
			>
			<button type="button" role="menuitem" onclick={copyBlockLink}
				><span class="block-menu-icon">↗</span><span
					>{copyFailed
						? 'Copy failed'
						: copiedBlockId === activeBlock.id
							? 'Copied link'
							: 'Copy link to block'}</span
				></button
			>
			<div class="block-menu-divider"></div>
			<button type="button" role="menuitem" class="block-menu-danger" onclick={deleteBlock}
				><span class="block-menu-icon">⌫</span><span>Delete</span></button
			>
		</div>
	{/if}
</div>
