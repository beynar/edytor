/**
 * Line icons for the built-in kinds (20×20, drawn in `currentColor` through
 * a CSS mask), keyed by command id. Menus fall back to a command's text icon.
 */
const svg = (body: string) =>
	`url("data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="black" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
	)}")`;
const heading = (n: number) =>
	svg(
		`<path d="M3.5 5v10M10 5v10M3.5 10H10"/><text x="12" y="15.5" font-size="8" font-family="Arial" font-weight="700" fill="black" stroke="none">${n}</text>`
	);

const ICONS: Record<string, string> = {
	'block.paragraph': svg('<path d="M4.5 5.5h11M10 5.5v10"/>'),
	'block.heading1': heading(1),
	'block.heading2': heading(2),
	'block.heading3': heading(3),
	'block.bulleted-list-item': svg(
		'<circle cx="4.5" cy="6" r="1.1" fill="black" stroke="none"/><circle cx="4.5" cy="10" r="1.1" fill="black" stroke="none"/><circle cx="4.5" cy="14" r="1.1" fill="black" stroke="none"/><path d="M8 6h8.5M8 10h8.5M8 14h8.5"/>'
	),
	'block.numbered-list-item': svg(
		'<text x="2.2" y="8.6" font-size="6.2" font-family="Arial" font-weight="700" fill="black" stroke="none">1</text><text x="2.2" y="15.6" font-size="6.2" font-family="Arial" font-weight="700" fill="black" stroke="none">2</text><path d="M8 6.5h8.5M8 13.5h8.5"/>'
	),
	'block.todo-item': svg(
		'<rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/><path d="M7 10.3l2.1 2.1 4-4.6"/>'
	),
	'block.toggle': svg('<path d="M7.5 5.5l6 4.5-6 4.5z" fill="black"/>'),
	'block.quote': svg(
		'<path d="M4.5 4.5v11" stroke-width="2"/><path d="M8.5 6.5h8M8.5 10h8M8.5 13.5h5"/>'
	),
	'block.callout': svg(
		'<rect x="2.5" y="4" width="15" height="12" rx="2.5"/><circle cx="6.5" cy="8.2" r="1.3" fill="black" stroke="none"/><path d="M9.5 8.2h5M5.5 12.2h9"/>'
	),
	'block.divider': svg('<path d="M3 10h14"/><path d="M5 6h10M5 14h10" opacity=".35"/>'),
	'block.code': svg('<path d="M7.5 6L3.5 10l4 4M12.5 6l4 4-4 4"/>'),
	'mark.link': svg(
		'<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1"/>'
	),
	'action.duplicate': svg(
		'<rect x="6.5" y="6.5" width="10" height="10" rx="2"/><path d="M13.5 4.5v-.5a1.5 1.5 0 0 0-1.5-1.5H5A2.5 2.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h.5"/>'
	),
	'action.delete': svg(
		'<path d="M4 6h12M8 6V4.5h4V6M5.5 6l.8 9.2a1.5 1.5 0 0 0 1.5 1.3h4.4a1.5 1.5 0 0 0 1.5-1.3L14.5 6"/>'
	),
	'action.link': svg(
		'<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1"/>'
	),
	'action.turn': svg('<path d="M4 7.5h10.5l-3-3M16 12.5H5.5l3 3"/>'),
	'action.color': svg('<path d="M6 15.5L10 4.5l4 11M7.4 11.7h5.2"/>'),
	'action.up': svg('<path d="M10 16V4.5M5.5 9L10 4.5 14.5 9"/>'),
	'action.down': svg('<path d="M10 4v11.5M5.5 11l4.5 4.5 4.5-4.5"/>'),
	'action.chevron': svg('<path d="M8 5.5l4.5 4.5L8 14.5"/>')
};

/** The icon's CSS `mask-image` value for `id`, if the id has one. */
export const iconOf = (id: string): string | undefined => ICONS[id];
