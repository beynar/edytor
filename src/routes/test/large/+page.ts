import type { PageLoad } from './$types';

/**
 * `/test/large` — a large page (P8): `blocks` top-level blocks (default
 * 5,000) under the Notion theme, the shipped plugins and block handles.
 * the theme's opt-in `content-visibility` is on
 * (`--edytor-block-visibility: auto`); `cv=0` leaves it off (the theme's
 * default, the "before" measurement); `peer=1` mounts a second, hidden view on a second document
 * bridged in the page, whose caret shows as a remote caret.
 */
export const load: PageLoad = ({ url }) => ({
	blocks: Math.max(1, Number(url.searchParams.get('blocks')) || 5000),
	cv: url.searchParams.get('cv') !== '0',
	peer: url.searchParams.get('peer') === '1'
});

/** Client-rendered: the measurements time the editor's own mount (a 20k-block SSR is another lane). */
export const ssr = false;
