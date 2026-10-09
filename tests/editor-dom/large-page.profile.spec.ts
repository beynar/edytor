/**
 * WU-17 (R10): the client-scale profile. Loads `/test/large` (N top-level
 * blocks of mixed kinds under the Notion theme, the shipped plugins and
 * block handles) at 5,000 and 10,000 blocks, with and without
 * `--edytor-block-visibility: auto`, and measures in Chromium:
 *
 * - the load: the document seeded and indexed, the view mounted, the first
 *   paint (two frames after the mount), and the layout / style
 *   recalculation the load cost (CDP `Performance.getMetrics`);
 * - scrolling: 120 frames of an 80px `scrollBy` from the middle ("wheel")
 *   and 60 frames of 1/60 of the page each ("jump"), the frame time;
 * - the keys, each from its `keydown` to the frame after it (a `rAF`, then
 *   a task): a character, Enter, Mod+Shift+ArrowDown (a block move), each
 *   ten times in a block in the middle; a paste of 50 lines, five times;
 * - one DOM caret move inside a key event and outside it (`caretInKey`).
 *
 * Env-gated (`LARGE_PROFILE=1`, never in the lanes): numbers, not
 * assertions. Results go to `test-results/large-page-profile.json`; the
 * site's `customization/styling` "Long pages" and the plan's ledger quote
 * them.
 *
 *   LARGE_PROFILE=1 pnpm exec playwright test --project=chromium large-page.profile --workers=1
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from './editorTest';

const LOADS = Number(process.env.LARGE_PROFILE_LOADS ?? 3);
const SIZES = (process.env.LARGE_PROFILE_SIZES ?? '5000,10000').split(',').map(Number);

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN;
};
const p95 = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
};
const round = (x: number) => Math.round(x * 10) / 10;

type Large = { start: number; created: number; mounted: number; painted: number };

const load = async (page: Page, blocks: number, cv: boolean) => {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Performance.enable');
	await page.goto(`/test/large?blocks=${blocks}${cv ? '' : '&cv=0'}`);
	await page.waitForFunction(() => '__large' in window, null, { timeout: 120_000 });
	const large = (await page.evaluate(() => (window as unknown as { __large: Large }).__large))!;
	const { metrics } = await cdp.send('Performance.getMetrics');
	const metric = (name: string) => (metrics.find((m) => m.name === name)?.value ?? 0) * 1000;
	await cdp.detach();
	return {
		document: large.created - large.start,
		mount: large.mounted - large.created,
		painted: large.painted - large.start,
		layout: metric('LayoutDuration'),
		style: metric('RecalcStyleDuration')
	};
};

/** Frame times while scrolling `frames` frames of `step(pageHeight)` px each, from `from`. */
const scroll = (page: Page, from: 'middle' | 'top', frames: number, step: 'wheel' | 'jump') =>
	page.evaluate(
		async ({ from, frames, step }) => {
			const height = document.documentElement.scrollHeight;
			window.scrollTo(0, from === 'middle' ? height / 2 : 0);
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			const by = step === 'wheel' ? 80 : height / frames;
			const times: number[] = [];
			let last = performance.now();
			for (let i = 0; i < frames; i++) {
				window.scrollBy(0, by);
				const now = await new Promise<number>((r) => requestAnimationFrame(r));
				times.push(now - last);
				last = now;
			}
			return times;
		},
		{ from, frames, step }
	);

/** Arms the key timer: each `keydown` (or paste) records the time to the frame after it. */
const armTimer = (page: Page) =>
	page.evaluate(() => {
		const w = window as unknown as { __lat: number[] };
		w.__lat = [];
		// Trusted keys only, not a chord's modifiers (Meta+Shift+ArrowDown is three keydowns).
		const time = (event: Event) => {
			const modifier = /^(Meta|Shift|Control|Alt)$/.test((event as KeyboardEvent).key);
			if (event.type === 'keydown' && (!event.isTrusted || modifier)) return;
			const t0 = performance.now();
			requestAnimationFrame(() => {
				const channel = new MessageChannel();
				channel.port1.onmessage = () => w.__lat.push(performance.now() - t0);
				channel.port2.postMessage(0);
			});
		};
		window.addEventListener('keydown', time, { capture: true });
		window.addEventListener('paste', time, { capture: true });
	});
const latencies = (page: Page) =>
	page.evaluate(() => (window as unknown as { __lat: number[] }).__lat.splice(0));

const keys = async (page: Page, key: string, times: number) => {
	for (let i = 0; i < times; i++) {
		await page.keyboard.press(key);
		await expect.poll(() => page.evaluate(() => (window as any).__lat.length)).toBe(i + 1);
	}
	return latencies(page);
};

const paste = async (page: Page, times: number) => {
	const lines = Array.from({ length: 50 }, (_, i) => `Pasted line ${i}`).join('\n');
	for (let i = 0; i < times; i++) {
		await page.evaluate((lines) => {
			const data = new DataTransfer();
			data.setData('text/plain', lines);
			document.activeElement!.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		}, lines);
		await expect.poll(() => page.evaluate(() => (window as any).__lat.length)).toBe(i + 1);
	}
	return latencies(page);
};

/**
 * One DOM caret move (`Selection.collapse` in the caret's text) inside a
 * trusted `keydown` listener, and the same move in a task: Chromium makes
 * the first cost time with the document's size (the projector's write and
 * a text patch that resets the caret both run inside the input event).
 */
const caretInKey = async (page: Page, times: number) => {
	await page.evaluate(() => {
		const w = window as unknown as { __caret: number[] };
		w.__caret = [];
		window.addEventListener(
			'keydown',
			(event) => {
				if (event.key !== 'F8') return;
				event.preventDefault();
				event.stopImmediatePropagation();
				const selection = getSelection()!;
				const t0 = performance.now();
				selection.collapse(selection.anchorNode, selection.anchorOffset ? 0 : 1);
				w.__caret.push(performance.now() - t0);
			},
			{ capture: true }
		);
	});
	for (let i = 0; i < times; i++) await page.keyboard.press('F8');
	return page.evaluate((times) => {
		const selection = getSelection()!;
		const outside: number[] = [];
		for (let i = 0; i < times; i++) {
			const t0 = performance.now();
			selection.collapse(selection.anchorNode, selection.anchorOffset ? 0 : 1);
			outside.push(performance.now() - t0);
		}
		return { inKey: (window as unknown as { __caret: number[] }).__caret, outside };
	}, times);
};

const rootCount = (page: Page) =>
	page.evaluate(
		() => (window as unknown as { __edytor: any }).__edytor.value.children.length as number
	);

test.describe('WU-17 — large-page profile', () => {
	test.skip(!process.env.LARGE_PROFILE, 'the profile runs under LARGE_PROFILE=1');
	test.setTimeout(1_200_000);

	test('5,000 and 10,000 blocks, with and without content-visibility', async ({
		page
	}, testInfo) => {
		test.skip(testInfo.project.name !== 'chromium', 'Chromium only (CDP metrics)');
		const results: Record<string, unknown> = {};
		for (const blocks of SIZES)
			for (const cv of [false, true]) {
				const loads = [];
				for (let i = 0; i < LOADS; i++) loads.push(await load(page, blocks, cv));
				const wheel = await scroll(page, 'middle', 120, 'wheel');
				const jump = await scroll(page, 'top', 60, 'jump');
				// The keys, in a block in the middle.
				const mid = `b${Math.floor(blocks / 2) + 1}`;
				const text = page.locator(
					`main > [data-edytor] [data-edytor-id="${mid}"] [data-edytor-text="true"]`
				);
				await text.scrollIntoViewIfNeeded();
				await text.click();
				await page.keyboard.press('End');
				await armTimer(page);
				const type = await keys(page, 'x', 10);
				const enter = await keys(page, 'Enter', 10);
				await page.keyboard.type('moved');
				// Each key's time lands a frame later: wait for all five before dropping them.
				await expect.poll(() => page.evaluate(() => (window as any).__lat.length)).toBe(5);
				await latencies(page);
				const move = await keys(
					page,
					process.platform === 'darwin' ? 'Meta+Shift+ArrowDown' : 'Control+Shift+ArrowDown',
					10
				);
				const before = await rootCount(page);
				const pasted = await paste(page, 5);
				expect(await rootCount(page)).toBeGreaterThan(before);
				const caret = await caretInKey(page, 5);
				const of = (key: 'document' | 'mount' | 'painted' | 'layout' | 'style') =>
					round(median(loads.map((l) => l[key])));
				results[`${blocks}${cv ? ' cv' : ''}`] = {
					document: of('document'),
					mount: of('mount'),
					painted: of('painted'),
					layout: of('layout'),
					style: of('style'),
					wheel: [round(median(wheel)), round(p95(wheel))],
					jump: round(median(jump)),
					type: [round(median(type)), round(p95(type))],
					enter: [round(median(enter)), round(p95(enter))],
					move: [round(median(move)), round(p95(move))],
					paste50: [round(median(pasted)), round(p95(pasted))],
					caretInKey: round(median(caret.inKey)),
					caretOutside: round(median(caret.outside))
				};
			}
		mkdirSync('test-results', { recursive: true });
		writeFileSync('test-results/large-page-profile.json', JSON.stringify(results, null, '\t'));
		console.log(JSON.stringify(results, null, 1));
	});
});
