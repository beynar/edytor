/**
 * KaTeX from a CDN, the equation plugin's default: its ESM build and its
 * stylesheet, fetched by the browser the first time an equation is drawn,
 * so no app bundles KaTeX. Once per base URL, whatever the views and
 * plugins: one module import, one `<link>` in the document's head.
 */
import type { KatexLike, KatexLoader } from './equation.svelte.js';
import { importUrl } from './importUrl.js';

/** The KaTeX version the default loader fetches: the one edytor is tested with. */
export const KATEX_VERSION = '0.18.7';

/**
 * Where the default loader fetches KaTeX: jsDelivr's copy of the npm
 * package's `dist`, at `KATEX_VERSION` exactly (`katex.mjs`,
 * `katex.min.css`, and the fonts the stylesheet names).
 */
export const KATEX_CDN = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/`;

/** Each base's KaTeX, loading or loaded; a failed load is forgotten, so a later view tries again. */
const loads = new Map<string, Promise<KatexLike>>();

/** The `katex` attribute of the stylesheets this module adds to a head. */
const MARK = 'data-edytor-katex';

/**
 * KaTeX's stylesheet at `href`, added once to the document's head; settles
 * when it loaded or failed (a failed stylesheet leaves KaTeX's markup
 * unstyled, never the equation undrawn).
 */
const stylesheet = (href: string): Promise<void> => {
	const head = document.head;
	let link = [...head.querySelectorAll<HTMLLinkElement>(`link[${MARK}]`)].find(
		(known) => known.getAttribute('href') === href
	);
	if (link?.sheet) return Promise.resolve();
	const settled = new Promise<void>((resolve) => {
		const done = () => resolve();
		link?.addEventListener('load', done, { once: true });
		link?.addEventListener('error', done, { once: true });
		if (link) return;
		link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = href;
		link.setAttribute(MARK, '');
		link.addEventListener('load', done, { once: true });
		link.addEventListener('error', done, { once: true });
		head.append(link);
	});
	return settled;
};

/** The KaTeX a module exports: itself, or its default export. */
const katexOf = (module: unknown): KatexLike => {
	const own = module as Partial<KatexLike> & { default?: Partial<KatexLike> };
	const katex = typeof own?.renderToString === 'function' ? own : own?.default;
	if (typeof katex?.renderToString !== 'function') throw new Error('No KaTeX in the module');
	return katex as KatexLike;
};

/** A base URL ending with one `/`. */
const baseOf = (base: string) => (base.endsWith('/') ? base : `${base}/`);

/**
 * A loader of KaTeX from `base` (a URL holding KaTeX's `dist` files, by
 * default `KATEX_CDN`): `katex.mjs` imported and `katex.min.css` added to
 * the document's head, once per base; it resolves once both settled.
 * Browser only: without a document it rejects and fetches nothing.
 * @internal
 */
export const cdnKatex =
	(base: string = KATEX_CDN): KatexLoader =>
	() => {
		const root = baseOf(base);
		if (typeof document === 'undefined')
			return Promise.reject(new Error('KaTeX loads in a browser only'));
		let pending = loads.get(root);
		if (!pending) {
			pending = Promise.all([
				importUrl(`${root}katex.mjs`),
				stylesheet(`${root}katex.min.css`)
			]).then(([module]) => katexOf(module));
			loads.set(root, pending);
			pending.catch(() => {
				if (loads.get(root) === pending) loads.delete(root);
			});
		}
		return pending;
	};

/**
 * The loader the plugin's `katex` option names: its own loader, a base URL
 * (`cdnKatex`), none for `false`, else jsDelivr (`KATEX_CDN`).
 * @internal
 */
export const katexLoaderOf = (option: KatexLoader | string | false | undefined) =>
	option === false ? undefined : typeof option === 'function' ? option : cdnKatex(option);
