<script module lang="ts">
	import { DEV } from 'esm-env';
	import type { Edytor } from '../edytor.svelte.js';
	import { UNKNOWN_KIND } from '../kinds.js';
	import { voidChrome, type Block as BlockHandle } from '../block/block.svelte.js';
	import type { BlockDefinition, BlockSnippetPayload, BlockView } from '../plugins.js';
	import type { PreviewCell } from '../surface/cells.js';
	import { replacedMark, Suggestion } from '../session/suggestions.svelte.js';

	const reported = new WeakMap<Edytor, Set<string>>();

	/** A snippet's view object: declared values read from the cell and the selection. */
	const blockViewOf = (edytor: Edytor, id: string): BlockView => {
		const handle = edytor.idToBlock.block(id);
		return {
			id,
			get type() {
				return edytor.cells?.get(id)?.type ?? handle.type;
			},
			get data() {
				return handle.data;
			},
			get selected() {
				return handle.selected;
			},
			get focused() {
				return handle.focused;
			},
			handle,
			void: handle.void
		};
	};

	/** A suggestion's block (`preview`): its declared values, no handle, never selected. */
	const previewViewOf = (cell: PreviewCell): BlockView => ({
		id: cell.id,
		type: cell.type,
		data: cell.data ?? {},
		selected: false,
		focused: false,
		handle: undefined,
		void: voidChrome
	});

	/** A child in the flow: a block's id, a block suggestion, or a preview's own block. */
	type Kid = string | Suggestion | PreviewCell;
	const kidKey = (kid: Kid) =>
		typeof kid === 'string' || kid instanceof Suggestion ? kid : kid.id;
	const idOf = (kid: Kid) =>
		typeof kid === 'string' ? kid : kid instanceof Suggestion ? undefined : kid.id;
	const previewOf = (kid: Kid) =>
		typeof kid === 'string' || kid instanceof Suggestion ? undefined : kid;
	const suggestionOf = (kid: Kid) => (kid instanceof Suggestion ? kid : undefined);

	/** Tags that take no content: the kind renders the element only. */
	const VOID_TAGS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'wbr']);

	/**
	 * The element a kind declares: a tag, or tag and attributes, from the
	 * block's data and id (a kind's own view state keyed by block, such as a
	 * column's width while a resize drags; reactive state the function reads
	 * re-renders the element).
	 */
	const elementOf = (
		declared: BlockDefinition['element'],
		data: Record<string, unknown> | undefined,
		id: string
	) => {
		const spec = typeof declared === 'function' ? declared(data ?? {}, id) : declared;
		if (spec === undefined) return undefined;
		return typeof spec === 'string' ? { tag: spec, attributes: {} } : { attributes: {}, ...spec };
	};

	/**
	 * Dev check of the declared `rendersContent`: a kind whose
	 * snippet rendered `content()` against its declaration is reported once
	 * per editor — an undeclared phantom slot would take carets and endpoints
	 * the user cannot see.
	 */
	const checkRendersContent = (block: BlockHandle, rendered: boolean) => {
		const kinds = reported.get(block.edytor) ?? new Set<string>();
		if (block.rendersContent === rendered || kinds.has(block.type)) return;
		reported.set(block.edytor, kinds.add(block.type));
		console.warn(
			`[edytor] block kind "${block.type}" declares rendersContent: ${!rendered} but its ` +
				`snippet ${rendered ? 'renders' : 'does not render'} content().`
		);
	};
</script>

<script lang="ts">
	import { getContext } from 'svelte';
	import Child from './Block.svelte';
	import Content from './Content.svelte';
	import SuggestionPreview from './Suggestion.svelte';
	import { blockDir, ownText } from '../surface/attributes.js';
	import { colorAttributes } from '../block/colors.js';

	let {
		id,
		preview,
		suggestion
	}: {
		id?: string;
		/** A suggestion's block: rendered from its preview cell, never registered (`Suggestion`). */
		preview?: PreviewCell;
		/** A block suggestion's preview in the flow among its siblings, in place of a block. */
		suggestion?: Suggestion;
	} = $props();

	const edytor = getContext<Edytor>('edytor');
	// The structure renders from the cell; the snippet receives a view object.
	const cell = $derived(preview ?? (id === undefined ? undefined : edytor.cells?.get(id)));
	const block = $derived(
		preview ? previewViewOf(preview) : id === undefined ? undefined : blockViewOf(edytor, id)
	);
	/** The suggestions shown at this block (none in a preview). */
	const shown = $derived(preview || id === undefined ? null : edytor.suggestions.at(id));
	/**
	 * The children: a preview's own, else the cell's ids with the suggestions
	 * shown around them and inside this block (`suggestions.around`).
	 */
	const kids = $derived(
		preview
			? preview.children
			: id === undefined
				? []
				: edytor.suggestions.around(edytor.cells?.get(id)?.childIds ?? [], id)
	);
	const definition = $derived(cell && edytor.definitionOf(cell.type));
	// The core renders the block element from the definition; the snippet renders inside it.
	const element = $derived(
		definition && id !== undefined
			? elementOf(definition.element ?? 'div', cell?.data, id)
			: undefined
	);
	/** The element's tag: none until the block has a cell and a definition. */
	const tag = $derived((cell && element && element.tag) || undefined);
	// The element around the block's own text (a heading's `h2`): the core's, so an override keeps it.
	const contentElement = $derived(
		definition && id !== undefined
			? elementOf(definition.contentElement, cell?.data, id)
			: undefined
	);
	/** Its direction from its own text (`blockDir`, bidi): none in a preview. */
	const dir = $derived(preview ? null : blockDir(ownText(cell?.runs ?? [])));
	/**
	 * `dir` as an attribute, absent when `null`: Svelte writes `dir` as a
	 * property, which would leave `dir=""` where the table wants none.
	 */
	const direction = (node: HTMLElement, value: 'rtl' | 'ltr' | null) => {
		const write = (next: 'rtl' | 'ltr' | null) =>
			next ? node.setAttribute('dir', next) : node.removeAttribute('dir');
		write(value);
		return { update: write };
	};
	/** Registers the block element: one element per block, re-registered when the tag changes. */
	const register = (node: HTMLElement) => block?.handle?.attach(node);
	/**
	 * Whether the selection holds this block, and whether it touches it: one
	 * boolean each, read from the block's own membership (`isSelected`,
	 * `isFocused`), so a selection change re-runs only the blocks it enters and
	 * leaves (a set's `has` re-runs the reader of every block outside it when
	 * its members change: a caret moving to another block re-ran every block's).
	 */
	const selected = $derived(!!block?.handle && edytor.selection.isSelected(block.handle));
	const focused = $derived(!!block?.handle && edytor.selection.isFocused(block.handle));
	/**
	 * Its colour and background by palette name (`block/colors.ts`), from its
	 * data; written below as two properties (a second spread in the object
	 * literal takes the engine's slow copy, three times the attributes' cost).
	 */
	const colors = $derived(colorAttributes(cell?.data));
	/** The block element's attributes: the kind's, then the core's. */
	const attributes = $derived(
		element && {
			...element.attributes,
			'data-edytor-color': colors['data-edytor-color'],
			'data-edytor-background': colors['data-edytor-background'],
			'data-edytor-block': 'true',
			'data-edytor-id': preview ? undefined : id,
			'data-edytor-type': cell?.type,
			'data-edytor-void': definition?.void ? 'true' : undefined,
			'data-edytor-selected': selected ? 'true' : undefined,
			'data-edytor-focused': focused ? 'true' : undefined,
			'data-edytor-suggestion-replaced': shown ? (replacedMark(shown) ?? undefined) : undefined,
			contenteditable: definition?.void ? ('false' as const) : undefined
		}
	);
	const userSelect = $derived(definition?.void ? 'none' : undefined);
	/** What renders inside the element: the kind's snippet, or a kind this view does not register. */
	const body = $derived(definition?.snippet ?? (definition === UNKNOWN_KIND ? unknown : undefined));
	/** The kind snippet's payload: its view object, its text, its children (none: `null`). */
	const payload = $derived({
		block: block!,
		content: contentElement ? wrappedContent : content,
		children: kids.length ? children : null
	});

	// The kind `content()` last rendered under — read after each render.
	let contentRenderedFor: string | undefined;
	$effect(() => {
		if (DEV && block?.handle) checkRendersContent(block.handle, contentRenderedFor === cell?.type);
	});
</script>

<!--
	The render places as few anchors as it can (`render.markers`, counted by
	`render-markers.test.tsx`): Svelte leaves an empty comment or text node for
	each block, dynamic element, component or snippet it places, except a
	static component or snippet that is the only thing its fragment renders,
	and the browser walks them all after each keystroke. So the bundled kinds'
	block tags are static elements (a dynamic element leaves two markers
	more), the text is a static component of the `content` snippet, and the
	children are one `each` of static components (a suggestion in the flow is
	one of them). The comments between the top-level nodes keep whitespace out
	of the markup.
-->
{#snippet content()}
	<Content
		id={id ?? ''}
		preview={preview?.runs}
		onrender={DEV ? () => (contentRenderedFor = cell?.type) : undefined}
	/>
{/snippet}<!--
	The kind's `contentElement` (a heading's `h2`) around the text.
-->{#snippet wrappedContent()}
	<svelte:element this={contentElement?.tag} {...contentElement?.attributes}>
		<Content
			id={id ?? ''}
			preview={preview?.runs}
			onrender={DEV ? () => (contentRenderedFor = cell?.type) : undefined}
		/>
	</svelte:element>
{/snippet}<!--
-->{#snippet children()}
	{#each kids as kid (kidKey(kid))}
		<Child id={idOf(kid)} preview={previewOf(kid)} suggestion={suggestionOf(kid)} />
	{/each}
{/snippet}<!--
	A kind this view does not register: a plain block, its text and children.
-->{#snippet unknown({
	content,
	children
}: BlockSnippetPayload)}
	{@render content()}<!--
	-->{#if children}
		<div data-edytor-children>
			{@render children()}
		</div>
	{/if}
{/snippet}<!--
	The block element: the bundled kinds' tags as static elements, any other
	through `svelte:element` (a void tag, a divider's `hr`, takes no body).
-->{#if suggestion}
	<SuggestionPreview {suggestion} />
{:else if tag === 'div'}
	<div {...attributes} style:user-select={userSelect} use:register use:direction={dir}>
		{@render body?.(payload)}
	</div>
{:else if tag === 'li'}
	<li {...attributes} style:user-select={userSelect} use:register use:direction={dir}>
		{@render body?.(payload)}
	</li>
{:else if tag === 'details'}
	<details {...attributes} style:user-select={userSelect} use:register use:direction={dir}>
		{@render body?.(payload)}
	</details>
{:else if tag === 'figure'}
	<figure {...attributes} style:user-select={userSelect} use:register use:direction={dir}>
		{@render body?.(payload)}
	</figure>
{:else if tag === 'hr'}
	<hr {...attributes} style:user-select={userSelect} use:register use:direction={dir} />
{:else if tag && VOID_TAGS.has(tag)}
	<svelte:element
		this={tag}
		{...attributes}
		style:user-select={userSelect}
		use:register
		use:direction={dir}
	/>
{:else if tag}
	<svelte:element
		this={tag}
		{...attributes}
		style:user-select={userSelect}
		use:register
		use:direction={dir}
	>
		{@render body?.(payload)}
	</svelte:element>
{/if}

<style>
	/*
	 * One nesting step (Notion's 24px): a kind's snippet renders its children
	 * in one `data-edytor-children` container, indented here, so a block
	 * nested under any kind sits one step in. A theme whose kind indents its
	 * children another way (a list's marker column) sets its own padding.
	 */
	:global([data-edytor-children]) {
		padding-inline-start: var(--edytor-nest-indent, 24px);
	}
	/*
	 * Block colours (`block/colors.ts`): Notion's palette by name, each a
	 * theme token with Notion's light value as its fallback. The text colour
	 * and the background reach the block's children, as in Notion; a mark's
	 * own colour inside wins.
	 */
	:global([data-edytor-block][data-edytor-color='gray']) {
		color: var(--edytor-color-gray, #7d7a75);
	}
	:global([data-edytor-block][data-edytor-color='brown']) {
		color: var(--edytor-color-brown, #9f765a);
	}
	:global([data-edytor-block][data-edytor-color='orange']) {
		color: var(--edytor-color-orange, #d27b2d);
	}
	:global([data-edytor-block][data-edytor-color='yellow']) {
		color: var(--edytor-color-yellow, #cb9434);
	}
	:global([data-edytor-block][data-edytor-color='green']) {
		color: var(--edytor-color-green, #50946e);
	}
	:global([data-edytor-block][data-edytor-color='blue']) {
		color: var(--edytor-color-blue, #387dc9);
	}
	:global([data-edytor-block][data-edytor-color='purple']) {
		color: var(--edytor-color-purple, #9a6bb4);
	}
	:global([data-edytor-block][data-edytor-color='pink']) {
		color: var(--edytor-color-pink, #c14c8a);
	}
	:global([data-edytor-block][data-edytor-color='red']) {
		color: var(--edytor-color-red, #cf5148);
	}
	:global([data-edytor-block][data-edytor-background='gray']) {
		background-color: var(--edytor-background-gray, #f0efed);
	}
	:global([data-edytor-block][data-edytor-background='brown']) {
		background-color: var(--edytor-background-brown, #f5ede9);
	}
	:global([data-edytor-block][data-edytor-background='orange']) {
		background-color: var(--edytor-background-orange, #fbebde);
	}
	:global([data-edytor-block][data-edytor-background='yellow']) {
		background-color: var(--edytor-background-yellow, #f9f3dc);
	}
	:global([data-edytor-block][data-edytor-background='green']) {
		background-color: var(--edytor-background-green, #e8f1ec);
	}
	:global([data-edytor-block][data-edytor-background='blue']) {
		background-color: var(--edytor-background-blue, #e5f2fc);
	}
	:global([data-edytor-block][data-edytor-background='purple']) {
		background-color: var(--edytor-background-purple, #f3ebf9);
	}
	:global([data-edytor-block][data-edytor-background='pink']) {
		background-color: var(--edytor-background-pink, #fae9f1);
	}
	:global([data-edytor-block][data-edytor-background='red']) {
		background-color: var(--edytor-background-red, #fce9e7);
	}
	/*
	 * An empty line a suggestion replaces (Ask AI on an empty line): the
	 * preview right after it stands in its place. It stays mounted, folded,
	 * so the caret it holds stays valid; typing in it unfolds it.
	 */
	:global([data-edytor-suggestion-replaced='empty']) {
		/* Over any theme's block spacing. */
		height: 0 !important;
		min-height: 0 !important;
		margin-block: 0 !important;
		padding-block: 0 !important;
		border-block-width: 0 !important;
		overflow: hidden;
	}
</style>
