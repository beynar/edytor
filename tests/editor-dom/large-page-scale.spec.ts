/**
 * A keystroke's view work does not grow with the page, where it needs layout
 * (`view.scale`; the jsdom row `keystroke-scale.test.tsx` counts the rest).
 * The same keys in a block in the middle of `/test/large` at 1,000 and at
 * 5,000 blocks, with the shipped plugins and block handles, count:
 *
 * - the layout reads (`getBoundingClientRect`, `getClientRects`) from the key
 *   to the frame after it: the overlay's frame measures the chrome near the
 *   viewport and finds that band by binary search;
 * - the block elements the overlay's ResizeObserver watches: the top-level
 *   blocks near the viewport, never every block;
 * - the handles mounted (near the viewport, hovered, selected, focused);
 * - the reads of the whole document order (`facade.order`, `facade.compare`)
 *   a key makes: none (the handles sort their few blocks by path).
 *
 * A scaling contract, no wall clock: the counts at 5,000 blocks are those at
 * 1,000, give or take a small constant (the layout reads: at most one more
 * overlay frame's). The times are the profile's
 * (`large-page.profile.spec.ts`).
 */
import { expect, test, type Page } from './editorTest';

type Counts = { layout: number; watched: number; handles: number; order: number };

/** Before the page's scripts: count layout reads and the elements each ResizeObserver watches. */
const instrument = (page: Page) =>
	page.addInitScript(() => {
		const w = window as unknown as { __scale: { layout: number; watched: number } };
		w.__scale = { layout: 0, watched: 0 };
		for (const name of ['getBoundingClientRect', 'getClientRects'] as const) {
			const read = Element.prototype[name] as (this: Element) => unknown;
			(Element.prototype as unknown as Record<string, unknown>)[name] = function (this: Element) {
				w.__scale.layout++;
				return read.call(this);
			};
		}
		const watched = new WeakMap<ResizeObserver, Set<Element>>();
		const of = (observer: ResizeObserver) => {
			let set = watched.get(observer);
			if (!set) watched.set(observer, (set = new Set()));
			return set;
		};
		const { observe, unobserve, disconnect } = ResizeObserver.prototype;
		ResizeObserver.prototype.observe = function (target, options) {
			const set = of(this);
			if (!set.has(target)) w.__scale.watched++;
			set.add(target);
			return observe.call(this, target, options);
		};
		ResizeObserver.prototype.unobserve = function (target) {
			if (of(this).delete(target)) w.__scale.watched--;
			return unobserve.call(this, target);
		};
		ResizeObserver.prototype.disconnect = function () {
			w.__scale.watched -= of(this).size;
			of(this).clear();
			return disconnect.call(this);
		};
	});

const MOVE = process.platform === 'darwin' ? 'Meta+Shift+ArrowDown' : 'Control+Shift+ArrowDown';

/** Each key's counts, from its keydown to the frame after the one it renders in. */
const measure = async (page: Page, blocks: number): Promise<Record<string, Counts>> => {
	await page.goto(`/test/large?blocks=${blocks}`);
	await page.waitForFunction(() => '__large' in window, null, { timeout: 60_000 });
	const mid = `b${Math.floor(blocks / 2) + 1}`;
	const text = page.locator(
		`main > [data-edytor] [data-edytor-id="${mid}"] [data-edytor-text="true"]`
	);
	await text.scrollIntoViewIfNeeded();
	await text.click();
	await page.keyboard.press('End');
	// Count the view's reads of the whole document order.
	await page.evaluate(() => {
		const w = window as unknown as {
			__edytor: { facade: Record<string, (...args: unknown[]) => unknown> };
			__order: number;
		};
		w.__order = 0;
		const { facade } = w.__edytor;
		for (const name of ['order', 'compare']) {
			const read = facade[name]!;
			facade[name] = (...args) => (w.__order++, read(...args));
		}
	});
	const frames = () =>
		page.evaluate(
			() =>
				new Promise((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve)))
				)
		);
	const result: Record<string, Counts> = {};
	for (const [name, key] of [
		['type', 'x'],
		['enter', 'Enter'],
		['move', MOVE]
	] as const) {
		// Warm: the first key of a kind builds what later ones reuse.
		await page.keyboard.press(key);
		await frames();
		await page.evaluate(() => {
			const w = window as unknown as { __scale: { layout: number }; __order: number };
			w.__scale.layout = 0;
			w.__order = 0;
		});
		await page.keyboard.press(key);
		await frames();
		result[name] = await page.evaluate(() => {
			const w = window as unknown as {
				__scale: { layout: number; watched: number };
				__order: number;
			};
			return {
				layout: w.__scale.layout,
				watched: w.__scale.watched,
				handles: document.querySelectorAll('[data-edytor-block-handle-host]').length,
				order: w.__order
			};
		});
	}
	return result;
};

test.describe('view.scale — a keystroke costs the same on a page five times longer', () => {
	test('layout reads, watched blocks, handles and order reads at 1,000 and 5,000 blocks', async ({
		page
	}, testInfo) => {
		test.setTimeout(180_000);
		await instrument(page);
		const small = await measure(page, 1_000);
		const large = await measure(page, 5_000);
		testInfo.annotations.push({ type: 'counts', description: JSON.stringify({ small, large }) });
		for (const key of ['type', 'enter', 'move']) {
			const [at1k, at5k] = [small[key]!, large[key]!];
			// The same blocks watched and handled, give or take a constant.
			for (const counter of ['watched', 'handles'] as const)
				expect(at5k[counter], `${key}: ${counter} (${at1k[counter]} at 1,000)`).toBeLessThanOrEqual(
					at1k[counter] + 24
				);
			// The same reads per overlay frame; a key renders one or two frames
			// (a block that wraps a line resizes, which measures again).
			expect(at5k.layout, `${key}: layout reads (${at1k.layout} at 1,000)`).toBeLessThanOrEqual(
				2 * at1k.layout + 64
			);
		}
		for (const key of ['type', 'enter', 'move'])
			expect(large[key]!.order, `${key}: whole-order reads`).toBe(0);
	});
});
