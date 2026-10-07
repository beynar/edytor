/**
 * Notion's drag ghost: a copy of the dragged blocks, rendered as they look in
 * the editor, scaled down, that follows the pointer (the browser adds its own
 * drag-image translucency). Cloned once when the drag starts and mounted by
 * the drag library for the frame the browser takes its picture
 * (`setCustomNativeDragPreview`), then removed with it.
 */

/** The clones' layout width cap (the dragged blocks' own width is used below it). */
const MAX_WIDTH = 600;
/** The ghost's height cap, after scaling: taller content is cut, with no fade. */
const MAX_HEIGHT = 300;
/** The ghost is the blocks' own look, only smaller. */
const SCALE = 0.8;

/** View-only nodes a clone drops: render anchors, suggestions, peers' carets, handles and overlay. */
const VIEW_ONLY = [
	'[data-edytor-render-anchor]',
	'[data-edytor-text-suggestion]',
	'[data-edytor-suggestion]',
	'[data-edytor-remote-cursor]',
	'[data-edytor-remote-selection]',
	'[data-edytor-remote-presence]',
	'[data-edytor-block-handle-host]',
	'[data-edytor-overlay]'
].join(', ');

/**
 * Attributes that make a node editable or focusable, show view state (the
 * selected-block highlight, a placeholder), or let the editor find it as a
 * live node: a clone carries none, so no `[data-edytor-id]` lookup, no
 * selection mapping and no DOM observer ever picks it up.
 */
const LIVE = [
	'id',
	'contenteditable',
	'tabindex',
	'draggable',
	'data-placeholder',
	'data-edytor-id',
	'data-edytor-block',
	'data-edytor-text',
	'data-edytor-text-empty',
	'data-edytor-inline-block',
	'data-edytor-mark',
	'data-edytor-mark-void',
	'data-edytor-void',
	'data-edytor-selected',
	'data-edytor-focused',
	'data-edytor-suggestion-replaced',
	'data-edytor-block-drop-position',
	'data-edytor-composition-rest',
	'data-edytor-trailing-newline'
];

/** A block's own box: the theme sets it on `[data-edytor-block]`, which a clone no longer carries. */
const BOX = [
	'paddingTop',
	'paddingRight',
	'paddingBottom',
	'paddingLeft',
	'marginTop',
	'marginRight',
	'marginBottom',
	'marginLeft'
] as const;

/** The root's inherited text style: the ghost is mounted under `body`, not under the editor. */
const TEXT = [
	'color',
	'fontFamily',
	'fontSize',
	'fontStyle',
	'fontWeight',
	'lineHeight',
	'letterSpacing',
	'wordSpacing',
	'direction',
	'textAlign',
	'whiteSpace',
	'wordBreak',
	'overflowWrap'
] as const;

/** Neutralizes the layout the copied classes may carry (a page shell's grid, padding, height). */
const RESET: Partial<CSSStyleDeclaration> = {
	display: 'block',
	position: 'static',
	width: 'auto',
	height: 'auto',
	minWidth: '0',
	minHeight: '0',
	maxWidth: 'none',
	maxHeight: 'none',
	margin: '0',
	padding: '0',
	border: '0',
	outline: '0',
	background: 'none',
	boxShadow: 'none',
	transform: 'none',
	filter: 'none',
	opacity: '1',
	overflow: 'visible'
};

/** A block's rendered element, its whole subtree, without anything live or view-only. */
const cloneBlock = (node: HTMLElement) => {
	const clone = node.cloneNode(true) as HTMLElement;
	const view = node.ownerDocument.defaultView;
	const blocks = [node, ...node.querySelectorAll<HTMLElement>('[data-edytor-block]')];
	const copies = [clone, ...clone.querySelectorAll<HTMLElement>('[data-edytor-block]')];
	blocks.forEach((block, index) => {
		const style = view?.getComputedStyle(block);
		const copy = copies[index];
		if (style && copy) for (const property of BOX) copy.style[property] = style[property];
	});
	for (const element of clone.querySelectorAll(VIEW_ONLY)) element.remove();
	for (const element of [clone, ...clone.querySelectorAll('*')])
		for (const name of LIVE) element.removeAttribute(name);
	return clone;
};

/** The editor's look outside the editor: its ancestors' classes, then the root's own. */
const themed = (root: HTMLElement, content: HTMLElement) => {
	const { ownerDocument: document } = root;
	const view = document.defaultView;
	const classes = new Set<string>();
	for (
		let up = root.parentElement;
		up && up !== document.body && up !== document.documentElement;
		up = up.parentElement
	)
		up.classList.forEach((name) => classes.add(name));
	const scope = document.createElement('div');
	scope.className = [...classes].join(' ');
	Object.assign(scope.style, RESET);
	const shell = document.createElement('div');
	shell.className = root.className;
	shell.setAttribute('data-edytor', '');
	Object.assign(shell.style, RESET);
	const style = view?.getComputedStyle(root);
	if (style) {
		for (const property of TEXT) shell.style[property] = style[property];
		// The same custom properties, wherever the page set them.
		for (let index = 0; index < style.length; index++) {
			const name = style[index]!;
			if (name.startsWith('--')) shell.style.setProperty(name, style.getPropertyValue(name));
		}
	}
	// The clones sit one level below the root: root-child rules (a leading
	// Heading 1 styled as the page title) never reach a dragged heading.
	shell.append(content);
	scope.append(shell);
	return scope;
};

/** The root's content width, capped (`MAX_WIDTH`). */
const contentWidth = (root: HTMLElement) => {
	const style = root.ownerDocument.defaultView?.getComputedStyle(root);
	const padding = style ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) : 0;
	const width = root.clientWidth - (padding || 0);
	return width > 0 ? Math.min(width, MAX_WIDTH) : MAX_WIDTH;
};

export type DragPreview = {
	/** The ghost, `[data-edytor-drag-preview]`, to mount in the drag library's container. */
	element: HTMLElement;
	/**
	 * Once mounted: sizes the ghost to its scaled box (so the browser does not
	 * crop it) and answers where the pointer sits in it — on the ghost as it
	 * grabbed the first block.
	 */
	offset: () => { x: number; y: number };
};

/**
 * The ghost of `nodes` (the dragged blocks' elements, in document order),
 * grabbed at `pointer`: a copy of each block laid out at its own width (the
 * widest of them; the editor's content width when none is laid out), scaled by `SCALE` from its top left, cut at `MAX_HEIGHT`.
 * Nothing is added (no card, background, shadow, opacity, fade or count
 * badge): the blocks' own look. The pointer
 * keeps its place on the first block (a handle is left of it: a transparent
 * gutter keeps the offset positive, which every browser supports).
 */
export const dragPreview = (
	root: HTMLElement,
	nodes: HTMLElement[],
	pointer: { clientX: number; clientY: number }
): DragPreview => {
	const { ownerDocument: document } = root;
	const first = nodes[0]?.getBoundingClientRect();
	const dx = first ? pointer.clientX - first.left : 0;
	const dy = first ? pointer.clientY - first.top : 0;
	// Each block at its own width (a column's block at its column's), capped.
	const own = Math.max(0, ...nodes.map((node) => node.getBoundingClientRect().width));
	const width = own > 0 ? Math.min(own, MAX_WIDTH) : contentWidth(root);

	const list = document.createElement('div');
	let shown = 0;
	for (const node of nodes) {
		// Past the cap nothing more shows: the rest is not cloned.
		if (shown * SCALE > MAX_HEIGHT) break;
		const clone = cloneBlock(node);
		if (!list.childElementCount) clone.style.marginTop = '0';
		list.append(clone);
		shown += node.getBoundingClientRect().height;
	}

	// Laid out at full width, drawn at `SCALE` from its top left.
	const scaled = document.createElement('div');
	Object.assign(scaled.style, {
		width: `${width}px`,
		transform: `scale(${SCALE})`,
		transformOrigin: 'top left'
	});
	scaled.append(themed(root, list));

	// The scaled box: a transform does not resize the layout box, so this one is sized to it.
	const box = document.createElement('div');
	Object.assign(box.style, {
		position: 'relative',
		width: `${width * SCALE}px`,
		maxHeight: `${MAX_HEIGHT}px`,
		overflow: 'hidden'
	});
	box.append(scaled);

	const element = document.createElement('div');
	element.dataset.edytorDragPreview = 'true';
	element.dataset.count = String(nodes.length);
	element.setAttribute('aria-hidden', 'true');
	element.setAttribute('inert', '');
	Object.assign(element.style, {
		width: 'max-content',
		paddingLeft: `${Math.max(0, -dx)}px`,
		paddingTop: `${Math.max(0, -dy)}px`,
		pointerEvents: 'none'
	});
	element.append(box);

	const offset = () => {
		const height = Math.min(scaled.getBoundingClientRect().height, MAX_HEIGHT);
		if (height > 0) box.style.height = `${height}px`;
		return {
			x: Math.min(Math.max(0, dx * SCALE), width * SCALE),
			y: Math.min(Math.max(0, dy * SCALE), height || MAX_HEIGHT)
		};
	};
	return { element, offset };
};
