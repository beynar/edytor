/**
 * Line icons for the built-in kinds and the chrome (20×20, drawn in
 * `currentColor` through a CSS mask): the chrome's own by name (`linkIcon`,
 * `alignIcons`, `altIcon`), so a view ships only those it shows, and the
 * menus' by command or row id (`iconOf`). Menus fall back to a command's
 * text icon.
 *
 * Every icon is one stroked path (`icon(d)`) plus its other shapes: the
 * wrapper's stroke is every line's, and shared outlines (a page, a table,
 * an arrow) are drawn once.
 */
/** An icon from its SVG shapes (pure: an unused icon is dropped). */
/* @__NO_SIDE_EFFECTS__ */
const svg = (...body: string[]) =>
	`url("data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="black" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">${body.join('')}</svg>`
	)}")`;
/** An icon: its other shapes, then its lines (`d`). */
/* @__NO_SIDE_EFFECTS__ */
const icon = (d: string, ...more: string[]) => svg(...more, `<path d="${d}"/>`);
/* @__NO_SIDE_EFFECTS__ */
const rect = (x: number, y: number, width: number, height: number, rx: number) =>
	`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}"/>`;
/** A filled dot, outlined by the stroke too when `stroked`. */
/* @__NO_SIDE_EFFECTS__ */
const dot = (cx: number, cy: number, r: number, stroked?: boolean) =>
	`<circle cx="${cx}" cy="${cy}" r="${r}" fill="black"${stroked ? '' : ' stroke="none"'}/>`;
/** A filled shape. */
/* @__NO_SIDE_EFFECTS__ */
const solid = (d: string, more = '') => `<path d="${d}" fill="black"${more}/>`;
/** A bold digit. */
/* @__NO_SIDE_EFFECTS__ */
const digit = (x: number, y: number, size: number, n: number) =>
	`<text x="${x}" y="${y}" font-size="${size}" font-family="Arial" font-weight="700" fill="black" stroke="none">${n}</text>`;

/* @__NO_SIDE_EFFECTS__ */
const heading = (n: number) => icon('M3.5 5v10M10 5v10M3.5 10H10', digit(12, 15.5, 8, n));
/** A toggle heading: the toggle's triangle, then the heading's level. */
/* @__NO_SIDE_EFFECTS__ */
const toggleHeading = (n: number) =>
	icon('M9 5v10M14 5v10M9 10h5', solid('M3 7l4 3-4 3z'), digit(15.5, 16, 6, n));

/** A layout of `n` columns: `n` rounded panels side by side. */
/* @__NO_SIDE_EFFECTS__ */
const columns = (n: number) => {
	const [gap, width] = [1.5, (15 - 1.5 * (n - 1)) / n];
	return svg(
		...Array.from({ length: n }, (_, i) => rect(2.5 + i * (width + gap), 4, width, 12, 1.5))
	);
};

/** A page: its outline, then its folded corner and `lines` (a new page, a file). */
/* @__NO_SIDE_EFFECTS__ */
const page = (lines = '') =>
	icon(
		`M11.5 2.5v4h4${lines}`,
		'<path d="M11.5 2.5H6A1.5 1.5 0 004.5 4v12A1.5 1.5 0 006 17.5h8a1.5 1.5 0 001.5-1.5V6.5z"/>'
	);
/** A table's frame, with its header's line and its shade. */
/* @__NO_SIDE_EFFECTS__ */
const table = (lines: string, shade?: string) =>
	svg(
		rect(2.5, 3.5, 15, 13, 2),
		`<path d="${lines}"/>`,
		shade ? solid(shade, ' opacity=".35" stroke="none"') : ''
	);
/** An arrow, up turned by `angle` degrees. */
/* @__NO_SIDE_EFFECTS__ */
const arrow = (angle: number) =>
	svg(`<path d="M10 16V4.5M5.5 9L10 4.5 14.5 9" transform="rotate(${angle} 10 10)"/>`);
/** An alignment: full lines, and short ones from `x`. */
/* @__NO_SIDE_EFFECTS__ */
const align = (x: number) => icon(`M3.5 5h13M${x} 8.3h8M3.5 11.7h13M${x} 15h8`);

/** A link: the toolbar's Link button, the link card, the block menu's Copy link. */
export const linkIcon = icon(
	'M8.5 11.5a3 3 0 004.2 0l2.6-2.6a3 3 0 00-4.2-4.2l-1 1M11.5 8.5a3 3 0 00-4.2 0l-2.6 2.6a3 3 0 004.2 4.2l1-1'
);

/** The image toolbar's alignments, by `data.align`. */
export const alignIcons = { left: align(3.5), center: align(6), right: align(8.5) };

/** The image toolbar's alt text button. */
export const altIcon = icon(
	'M5.5 12.5l1.8-5 1.8 5M6 11h2.6M11 7.5v5h2.5M14.5 7.5v5',
	rect(2.5, 4.5, 15, 11, 2)
);

/** The icons menus find by id: a command's, a block menu or table menu row's (`icon`). */
const ICONS: Record<string, string> = {
	'block.paragraph': icon('M4.5 5.5h11M10 5.5v10'),
	'block.heading1': heading(1),
	'block.heading2': heading(2),
	'block.heading3': heading(3),
	'block.bulleted-list-item': icon(
		'M8 6h8.5M8 10h8.5M8 14h8.5',
		dot(4.5, 6, 1.1),
		dot(4.5, 10, 1.1),
		dot(4.5, 14, 1.1)
	),
	'block.numbered-list-item': icon(
		'M8 6.5h8.5M8 13.5h8.5',
		digit(2.2, 8.6, 6.2, 1),
		digit(2.2, 15.6, 6.2, 2)
	),
	'block.todo-item': icon('M7 10.3l2.1 2.1 4-4.6', rect(3.5, 3.5, 13, 13, 2.5)),
	'block.toggle': svg(solid('M7.5 5.5l6 4.5-6 4.5z')),
	'block.toggle-heading1': toggleHeading(1),
	'block.toggle-heading2': toggleHeading(2),
	'block.toggle-heading3': toggleHeading(3),
	'block.toc': icon(
		'M3.5 5.5h13M6.5 10h10M9.5 14.5h7',
		dot(3.7, 10, 0.6, true),
		dot(6.7, 14.5, 0.6, true)
	),
	'page.new': page('M7.5 10.5h5M7.5 13.5h5'),
	'block.quote': icon('M8.5 6.5h8M8.5 10h8M8.5 13.5h5', '<path d="M4.5 4.5v11" stroke-width="2"/>'),
	'block.callout': icon('M9.5 8.2h5M5.5 12.2h9', rect(2.5, 4, 15, 12, 2.5), dot(6.5, 8.2, 1.3)),
	'block.divider': icon('M3 10h14', '<path d="M5 6h10M5 14h10" opacity=".35"/>'),
	'block.code': icon('M7.5 6L3.5 10l4 4M12.5 6l4 4-4 4'),
	'block.embed': icon('M8 8l-2 2 2 2M12 8l2 2-2 2', rect(2.5, 4, 15, 12, 2)),
	'block.bookmark': icon('M6 3.5h8a1 1 0 011 1v12l-5-3.5-5 3.5v-12a1 1 0 011-1z'),
	'block.file': page(),
	'block.video': icon('M13.5 8.5l4-2.5v8l-4-2.5', rect(2.5, 5, 11, 10, 2)),
	'block.audio': svg(
		'<path d="M7.5 14.5V5l9-1.5v9.5"/><circle cx="5.5" cy="14.5" r="2"/><circle cx="14.5" cy="13" r="2"/>'
	),
	'block.table': table('M2.5 8h15M2.5 12.3h15M7.5 3.5v13M12.5 3.5v13'),
	'table.header-row': table('M2.5 8h15', 'M3 4h14v4H3z'),
	'table.header-column': table('M7.5 3.5v13', 'M3 4h4.5v12H3z'),
	'table.left': arrow(-90),
	'table.right': arrow(90),
	'columns.2': columns(2),
	'columns.3': columns(3),
	'columns.4': columns(4),
	'columns.5': columns(5),
	'action.duplicate': icon(
		'M13.5 4.5v-.5A1.5 1.5 0 0012 2.5H5A2.5 2.5 0 002.5 5v7A1.5 1.5 0 004 13.5h.5',
		rect(6.5, 6.5, 10, 10, 2)
	),
	'action.delete': icon(
		'M4 6h12M8 6V4.5h4V6M5.5 6l.8 9.2a1.5 1.5 0 001.5 1.3h4.4a1.5 1.5 0 001.5-1.3L14.5 6'
	),
	'action.turn': icon('M4 7.5h10.5l-3-3M16 12.5H5.5l3 3'),
	'action.color': icon('M6 15.5L10 4.5l4 11M7.4 11.7h5.2'),
	'action.up': arrow(0),
	'action.down': arrow(180),
	'action.link': linkIcon
};

/** The icon's CSS `mask-image` value for `id`, if the id has one. */
export const iconOf = (id: string): string | undefined => ICONS[id];
