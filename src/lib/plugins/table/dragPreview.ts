/**
 * The ghost of a dragged table row or column (`table.drag`): its cells as
 * boxes of their columns' widths, in the table's own border, background and
 * text style, holding their text (a row's side by side, a column's one under
 * the other). A drawing, not a clone: a row is a subgrid of its table's grid
 * and lays out nowhere else. Built at the drag's start and mounted by the
 * drag library for the frame the browser takes its picture
 * (`setCustomNativeDragPreview`), then removed with it.
 */

/** The ghost's caps: wider or taller content is cut. */
const MAX_WIDTH = 600;
const MAX_HEIGHT = 300;

/** The cell's look the ghost copies (it is mounted under `body`, not in the table). */
const LOOK = [
	'color',
	'backgroundColor',
	'fontFamily',
	'fontSize',
	'fontStyle',
	'fontWeight',
	'lineHeight',
	'letterSpacing',
	'paddingTop',
	'paddingRight',
	'paddingBottom',
	'paddingLeft',
	'borderRightColor',
	'borderRightStyle',
	'borderRightWidth',
	'borderBottomColor',
	'borderBottomStyle',
	'borderBottomWidth',
	'whiteSpace',
	'overflowWrap'
] as const;

export type TablePreview = {
	/** The ghost, `[data-edytor-table-drag-preview]`, to mount in the drag library's container. */
	element: HTMLElement;
	/** Where the pointer sits in the ghost: where it grabbed the row or column. */
	offset: () => { x: number; y: number };
};

/**
 * The ghost of `lines` (a row: one line of its cells; a column: one line per
 * row, its cell there; `null` for a padded cell), each column `widths[i]`
 * wide, `heights[j]` the line's height, grabbed at `pointer` relative to
 * `box`, the row's or column's box. A transparent gutter keeps the offset
 * positive (the grips are outside the box), as every browser requires.
 */
export const tablePreview = (
	document: Document,
	lines: (HTMLElement | null)[][],
	widths: number[],
	heights: number[],
	box: DOMRect,
	pointer: { clientX: number; clientY: number }
): TablePreview => {
	const view = document.defaultView;
	const grid = document.createElement('div');
	Object.assign(grid.style, {
		display: 'grid',
		gridTemplateColumns: widths.map((w) => `${w}px`).join(' '),
		gridAutoRows: 'auto',
		boxSizing: 'border-box'
	});
	const first = lines.flat().find((cell) => cell !== null) ?? null;
	const table = first?.closest<HTMLElement>('[data-edytor-table-grid]');
	const frame = table && view?.getComputedStyle(table);
	if (frame) {
		grid.style.borderTop = frame.borderTop;
		grid.style.borderLeft = frame.borderLeft;
	}
	lines.forEach((cells, row) =>
		cells.forEach((cell) => {
			const copy = document.createElement('div');
			const style = cell && view?.getComputedStyle(cell);
			if (style) for (const property of LOOK) copy.style[property] = style[property];
			Object.assign(copy.style, {
				boxSizing: 'border-box',
				minHeight: `${heights[row] ?? 0}px`,
				overflow: 'hidden'
			});
			if (!style?.backgroundColor || style.backgroundColor === 'rgba(0, 0, 0, 0)')
				copy.style.backgroundColor = '#fff';
			copy.textContent = cell?.querySelector('[data-edytor-text]')?.textContent ?? '';
			grid.append(copy);
		})
	);

	const dx = pointer.clientX - box.left;
	const dy = pointer.clientY - box.top;
	const width = Math.min(
		MAX_WIDTH,
		widths.reduce((sum, w) => sum + w, 0)
	);
	const clip = document.createElement('div');
	Object.assign(clip.style, {
		width: `${width}px`,
		maxHeight: `${MAX_HEIGHT}px`,
		overflow: 'hidden'
	});
	clip.append(grid);

	const element = document.createElement('div');
	element.dataset.edytorTableDragPreview = 'true';
	element.setAttribute('aria-hidden', 'true');
	element.setAttribute('inert', '');
	Object.assign(element.style, {
		width: 'max-content',
		paddingLeft: `${Math.max(0, -dx)}px`,
		paddingTop: `${Math.max(0, -dy)}px`,
		pointerEvents: 'none'
	});
	element.append(clip);
	return {
		element,
		offset: () => ({
			x: Math.min(Math.max(0, dx), width),
			y: Math.min(Math.max(0, dy), MAX_HEIGHT)
		})
	};
};
