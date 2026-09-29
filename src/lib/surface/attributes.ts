/**
 * The attribute-ownership table (R11, R12; plan §4.4 `surface/observer`, §5
 * L33). The core declares which attributes it owns on the elements it renders;
 * after a flush an owned attribute that differs from the table is foreign
 * damage and is healed in place. Everything else on a tolerant element (the
 * root, a block element: plugin attach hooks, component props, `open` on a
 * native toggle) belongs to the browser or an extension and is never touched.
 * Strict elements (text and atom elements) carry nothing but what the table
 * lists. A mark element's attributes are part of its render: damage there
 * re-renders the content. Identity is read from the owned-element registry,
 * never from the attributes themselves (a stripped `data-edytor-id` still
 * resolves).
 */
import type { Edytor } from '../edytor.svelte.js';

export type Owned = {
	/** Attribute → required value ('' for a bare attribute, null when absent). */
	owned: Record<string, string | null>;
	/** Owned inline-style properties; null → unset. */
	style: Record<string, string | null>;
	/** Strip every attribute and style property the table does not list. */
	strict: boolean;
};
export type Kind = 'block' | 'text' | 'mark' | 'atom' | 'anchor';

/** Chromium expands these shorthands into longhands: a longhand of an owned shorthand is owned. */
const LONGHANDS: Record<string, readonly string[]> = {
	outline: ['outline-width', 'outline-style', 'outline-color'],
	'white-space': ['white-space-collapse', 'text-wrap-mode', 'text-wrap']
};

/** A text inside a void block is its own editing host (the core sets it at attach). */
export const insideVoid = (edytor: Edytor, block: string) => {
	for (let id: string | null = block; id; id = edytor.facade.parentOf(id))
		if (edytor.definitionOf(edytor.cells?.get(id)?.type ?? '').void) return true;
	return false;
};

/** What the table owns on `element` (the root, or a registered element). */
export const ownedOf = (
	edytor: Edytor,
	element: Element,
	entry: { kind: Kind; block: string; name?: string } | null
): Owned | null => {
	if (element === edytor.node)
		return {
			strict: false,
			owned: { 'data-edytor': '', contenteditable: edytor.readonly ? 'false' : 'true' },
			style: {}
		};
	if (!entry) return null;
	const { block } = entry;
	if (entry.kind === 'mark') {
		const name = entry.name ?? null;
		const isVoid = Boolean(name && edytor.marks.get(name)?.void);
		return {
			strict: false,
			owned: {
				'data-edytor-mark': name,
				'data-edytor-mark-void': isVoid ? '' : null,
				contenteditable: isVoid ? 'false' : null
			},
			style: {}
		};
	}
	if (entry.kind === 'anchor')
		return {
			strict: true,
			owned: { 'data-edytor-render-anchor': '', contenteditable: 'false', 'aria-hidden': 'true' },
			style: { display: 'none' }
		};
	if (entry.kind === 'atom') {
		const atom = edytor.nodeToInlineBlock.get(element);
		return {
			strict: true,
			owned: {
				'data-edytor-inline-block': atom?.type ?? element.getAttribute('data-edytor-inline-block'),
				'data-edytor-id': atom?.id ?? element.getAttribute('data-edytor-id'),
				contenteditable: 'false'
			},
			style: {}
		};
	}
	const cell = edytor.cells?.get(block);
	const isVoid = Boolean(cell && edytor.definitionOf(cell.type).void);
	if (entry.kind === 'block') {
		const handle = edytor.idToBlock.block(block);
		const { selectedBlocks, focusedBlocks } = edytor.selection;
		return {
			strict: false,
			owned: {
				'data-edytor-block': 'true',
				'data-edytor-id': block,
				'data-edytor-type': cell?.type ?? null,
				'data-edytor-void': isVoid ? 'true' : null,
				'data-edytor-selected': selectedBlocks.has(handle) ? 'true' : null,
				'data-edytor-focused': focusedBlocks.has(handle) ? 'true' : null,
				contenteditable: isVoid ? 'false' : null
			},
			style: isVoid ? { 'user-select': 'none' } : {}
		};
	}
	const text = edytor.nodeToText.get(element);
	const voided = insideVoid(edytor, block);
	return {
		strict: true,
		owned: {
			'data-edytor-text': 'true',
			'data-edytor-id': text?.id ?? element.getAttribute('data-edytor-id'),
			'data-edytor-text-empty': String(text ? text.isEmpty : true),
			'data-placeholder': edytor.placeholderAt(block),
			contenteditable: voided ? 'true' : null
		},
		style: { 'white-space': 'break-spaces', outline: voided ? 'none' : null }
	};
};

const setStyle = (element: HTMLElement, property: string, value: string | null) => {
	const current = element.style.getPropertyValue(property);
	if (value === null) {
		if (current === '') return false;
		element.style.removeProperty(property);
		return element.style.getPropertyValue(property) === '';
	}
	if (current === value && !element.style.getPropertyPriority(property)) return false;
	// `removeProperty` first: a foreign `!important` makes a plain write a no-op.
	element.style.removeProperty(property);
	element.style.setProperty(property, value);
	// A property the engine rejects (unprefixed `user-select` on older WebKit) is not a heal.
	return element.style.getPropertyValue(property) === value;
};

/** Heal `element` against `table`; answers whether anything was written. */
export const heal = (element: HTMLElement, table: Owned) => {
	let healed = false;
	for (const [name, value] of Object.entries(table.owned)) {
		if (value === null ? !element.hasAttribute(name) : element.getAttribute(name) === value)
			continue;
		if (value === null) element.removeAttribute(name);
		else element.setAttribute(name, value);
		healed = true;
	}
	if (table.strict) {
		for (const property of Array.from(element.style)) {
			const owned =
				Object.hasOwn(table.style, property) ||
				Object.keys(table.style).some((name) => LONGHANDS[name]?.includes(property));
			if (owned) continue;
			element.style.removeProperty(property);
			healed = true;
		}
		for (const { name } of Array.from(element.attributes))
			if (name !== 'style' && !Object.hasOwn(table.owned, name)) {
				element.removeAttribute(name);
				healed = true;
			}
	}
	for (const [property, value] of Object.entries(table.style))
		healed = setStyle(element, property, value) || healed;
	// An empty `style` attribute is residue: the renderer never serializes one.
	if (element.hasAttribute('style') && element.style.length === 0) {
		element.removeAttribute('style');
		healed = true;
	}
	return healed;
};

/** `element` differs from its table: healing a detached copy would write. */
export const diverges = (element: HTMLElement, table: Owned) =>
	heal(element.cloneNode(false) as HTMLElement, table);
