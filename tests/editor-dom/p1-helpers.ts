/**
 * arch-v2 phase 2 P1.2 — helpers for the ported browser review probes
 * (`review-probes/browser/*.probe.ts`, written against another engine's
 * view). They address blocks by id on `/test/dom?dst=…` documents and read
 * three independent things: the model (`facade`), the selection value
 * (`selection.projection`) and the DOM (text elements, the native
 * selection mapped back to `(block, offset)` test-side, inline atoms
 * counting one).
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect } from './editorTest';
import { waitForEditorReady } from './helpers';
import { startOpaqueRelay, type OpaqueRelay } from './ws-relay';

type Part = string | { atom: string };
export type Doc = unknown[];

/** A block literal: `b('id', 'text' | parts, { type, children })`. */
export const b = (
	id: string,
	content: string | Part[],
	opts: { type?: string; children?: unknown[] } = {}
) => ({
	id,
	type: opts.type ?? 'paragraph',
	content: (typeof content === 'string' ? (content ? [content] : []) : content).map((p) =>
		typeof p === 'string' ? { text: p } : { type: p.atom, id: `${id}-${p.atom}`, data: {} }
	),
	...(opts.children ? { children: opts.children } : {})
});

export const docUrl = (children: Doc, extra = '') =>
	`/test/dom?scenario=p1&dst=${encodeURIComponent(JSON.stringify({ children }))}${extra}`;

export const open = async (page: Page, children: Doc, extra = '') => {
	await page.goto(docUrl(children, extra));
	await waitForEditorReady(page, { requireRuntime: true });
};

type Row = { id: string; type: string; text: string; depth: number };

/** The model, document order: id, type, text (atoms as `⟨type⟩`), depth. */
export const model = (page: Page) =>
	page.evaluate((): Row[] => {
		const f = (window as Window & { __EDYTOR__?: any }).__EDYTOR__.facade;
		return f.order().map((id: string) => ({
			id,
			type: f.blockTypeOf(id),
			text: (f.blockJSON(id).content ?? [])
				.map((c: { text?: string; type?: string }) => c.text ?? `⟨${c.type}⟩`)
				.join(''),
			depth: f.ancestorsOf(id).length
		}));
	});

export const texts = async (page: Page) => (await model(page)).map((r) => r.text);

/** The selection value (model side). */
export const selection = (page: Page) =>
	page.evaluate(() => {
		const s = (window as Window & { __EDYTOR__?: any }).__EDYTOR__.selection.projection;
		const at = (p: { block: string; offset: number } | null) =>
			p ? `${p.block}@${p.offset}` : null;
		return {
			kind: s.kind as string,
			range: `${at(s.start)}-${at(s.end)}`,
			collapsed: Boolean(s.isCollapsed)
		};
	});

/**
 * In-page: the block's own units (its text elements and inline atoms, not
 * a nested block's) and the `(block, offset)` ↔ DOM point mapping.
 */
const inPage = () => {
	const blockEl = (id: string) =>
		document.querySelector<HTMLElement>(`[data-edytor-block="true"][data-edytor-id="${id}"]`);
	const ownerOf = (el: Element) => el.closest('[data-edytor-block="true"]');
	const units = (host: Element) =>
		[...host.querySelectorAll('[data-edytor-text="true"], [data-edytor-inline-block]')].filter(
			(el) => ownerOf(el) === host && !el.parentElement?.closest('[data-edytor-inline-block]')
		);
	const textNodes = (el: Element): Text[] => {
		if (el.getAttribute('data-edytor-text-empty') === 'true') return [];
		const out: Text[] = [];
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (!n.parentElement?.closest('[data-edytor-trailing-newline]')) out.push(n as Text);
		}
		return out;
	};
	/** Compare DOM points: < 0 when (a) is before (b). */
	const cmp = (an: Node, ao: number, bn: Node, bo: number) => {
		const r = document.createRange();
		r.setStart(an, ao);
		return -r.comparePoint(bn, bo);
	};
	const locate = (node: Node | null, offset: number) => {
		if (!node) return null;
		const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
		const host = el?.closest('[data-edytor-block="true"]');
		if (!host) return { block: null, offset: -1 };
		let total = 0;
		for (const u of units(host)) {
			if (u.hasAttribute('data-edytor-inline-block')) {
				const parent = u.parentNode!;
				const index = [...parent.childNodes].indexOf(u as ChildNode);
				if (cmp(parent, index + 1, node, offset) <= 0) total += 1;
				else break;
				continue;
			}
			for (const t of textNodes(u)) {
				if (cmp(t, 0, node, offset) >= 0)
					return { block: host.getAttribute('data-edytor-id'), offset: total };
				if (cmp(t, t.data.length, node, offset) >= 0) {
					return {
						block: host.getAttribute('data-edytor-id'),
						offset: total + (node === t ? offset : t.data.length)
					};
				}
				total += t.data.length;
			}
		}
		return { block: host.getAttribute('data-edytor-id'), offset: total };
	};
	const point = (id: string, offset: number): [Node, number] => {
		const host = blockEl(id);
		if (!host) throw new Error(`missing block ${id}`);
		let left = offset;
		let last: [Node, number] | null = null;
		for (const u of units(host)) {
			if (u.hasAttribute('data-edytor-inline-block')) {
				const parent = u.parentNode!;
				const index = [...parent.childNodes].indexOf(u as ChildNode);
				if (left === 0) return [parent, index];
				left -= 1;
				last = [parent, index + 1];
				continue;
			}
			const nodes = textNodes(u);
			if (nodes.length === 0) {
				if (left === 0) return [u, 0];
				continue;
			}
			for (const t of nodes) {
				if (left <= t.data.length) return [t, left];
				left -= t.data.length;
				last = [t, t.data.length];
			}
		}
		if (last) return last;
		throw new Error(`no point ${id}@${offset}`);
	};
	/** The block's own text as the DOM shows it (atoms as `⟨type⟩`). */
	const shown = (id: string) => {
		const host = blockEl(id);
		if (!host) return null;
		return units(host)
			.map((u) =>
				u.hasAttribute('data-edytor-inline-block')
					? `⟨${u.getAttribute('data-edytor-inline-block')}⟩`
					: textNodes(u)
							.map((t) => t.data)
							.join('')
			)
			.join('');
	};
	return { blockEl, locate, point, shown };
};

/** The native selection mapped back to `anchor->focus` as `block@offset`. */
export const domSelection = (page: Page) =>
	page.evaluate((src) => {
		const h = new Function(`return (${src})()`)();
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return null;
		const a = h.locate(sel.anchorNode, sel.anchorOffset);
		const f = h.locate(sel.focusNode, sel.focusOffset);
		return {
			dom: `${a?.block}@${a?.offset}->${f?.block}@${f?.offset}`,
			collapsed: sel.isCollapsed
		};
	}, inPage.toString());

/** Each block's own text as the DOM shows it, in model order. */
export const domTexts = (page: Page) =>
	page.evaluate((src) => {
		const h = new Function(`return (${src})()`)();
		const f = (window as Window & { __EDYTOR__?: any }).__EDYTOR__.facade;
		return f.order().map((id: string) => h.shown(id));
	}, inPage.toString());

/** Set the native selection at model coordinates (and focus the editor). */
export const setDom = (
	page: Page,
	anchor: [string, number],
	focus: [string, number] = anchor,
	focusEditor = true
) =>
	page.evaluate(
		({ src, anchor, focus, focusEditor }) => {
			const h = new Function(`return (${src})()`)();
			const [an, ao] = h.point(anchor[0], anchor[1]);
			const [fn, fo] = h.point(focus[0], focus[1]);
			if (focusEditor) document.querySelector<HTMLElement>('[data-edytor]')?.focus();
			window.getSelection()!.setBaseAndExtent(an, ao, fn, fo);
		},
		{ src: inPage.toString(), anchor, focus, focusEditor }
	);

/** Place a collapsed caret and wait until the selection value adopted it. */
export const caret = async (page: Page, block: string, offset: number) => {
	await setDom(page, [block, offset]);
	await expect
		.poll(() => selection(page))
		.toMatchObject({ range: `${block}@${offset}-${block}@${offset}`, collapsed: true });
};

export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Two (or more) contexts on one websocket room, each on the same `dst` document. */
export type Room = {
	relay: OpaqueRelay;
	pages: Page[];
	contexts: BrowserContext[];
	close: () => Promise<void>;
};

export const openRoom = async (
	browser: Browser,
	baseURL: string | undefined,
	children: Doc,
	count = 2
): Promise<Room> => {
	const relay = await startOpaqueRelay();
	const room = `p1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const contexts: BrowserContext[] = [];
	const close = async () => {
		for (const c of contexts) await c.close();
		await relay.close();
	};
	try {
		const pages: Page[] = [];
		for (let i = 0; i < count; i++) {
			const c = await browser.newContext({ baseURL });
			contexts.push(c);
			pages.push(await c.newPage());
		}
		const extra = `&collabws=${room}&wsserver=${encodeURIComponent(relay.url)}&wsbackoff=400`;
		await Promise.all(
			pages.map(async (p) => {
				await p.goto(docUrl(children, extra));
				await waitForEditorReady(p, { requireRuntime: true });
			})
		);
		await expect
			.poll(
				async () =>
					new Set(await Promise.all(pages.map(async (p) => JSON.stringify(await model(p))))).size
			)
			.toBe(1);
		return { relay, pages, contexts, close };
	} catch (error) {
		await close();
		throw error;
	}
};
