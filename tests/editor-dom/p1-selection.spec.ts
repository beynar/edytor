/**
 * arch-v2 phase 2 P1.2 — selection races from the native review's browser
 * probes (`review-probes/browser/selection.probe.ts`, `collab.probe.ts`),
 * re-targeted at arch-v2's test route (three engines).
 *
 * Contracts (docs/editor-delete-contract.md "Selection ownership and
 * lifecycle", plan §8.3 F-S4 / F-S11): a selection the page's own script
 * sets is adopted, not reverted by a render that lands in the same task; a
 * caret move the browser performs is never lost to a model update that
 * arrives before its `selectionchange`, locally or from a peer typing every
 * 8 ms.
 */
import { expect, test } from './editorTest';
import {
	b,
	caret,
	domSelection,
	model,
	open,
	openRoom,
	selection,
	setDom,
	texts
} from './p1-helpers';

const BASIC = [b('b0', 'first'), b('b1', 'note'), b('b2', 'tail')];

test.describe('P1 — selection races (review-probes/selection)', () => {
	test('a script selection racing a render in the same task is adopted (F-S11c, local)', async ({
		page
	}) => {
		await open(page, BASIC);
		await caret(page, 'b1', 1);
		await page.evaluate(() => {
			const host = document.querySelector('[data-edytor-id="b2"] [data-edytor-text="true"]')!;
			const node = document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode()!;
			window.getSelection()!.setBaseAndExtent(node, 1, node, 3);
			// A model change (and its render) in the same task, before selectionchange.
			(window as Window & { __EDYTOR__?: any }).__EDYTOR__.facade.insertText('b0', 0, 'R');
		});
		await expect.poll(() => texts(page)).toEqual(['Rfirst', 'note', 'tail']);
		await expect
			.poll(() => selection(page))
			.toMatchObject({ range: 'b2@1-b2@3', collapsed: false });
		expect((await domSelection(page))?.dom).toBe('b2@1->b2@3');
		await page.keyboard.type('Z');
		await expect.poll(() => texts(page)).toEqual(['Rfirst', 'note', 'tZl']);
	});

	test('ArrowRight with a model update applied before its selectionchange keeps the move (F-S11a, local)', async ({
		page
	}) => {
		await open(page, BASIC);
		await caret(page, 'b1', 1);
		await page.evaluate(() => {
			document.addEventListener(
				'keydown',
				() =>
					setTimeout(() =>
						(window as Window & { __EDYTOR__?: any }).__EDYTOR__.facade.insertText('b0', 0, 'R')
					),
				{ capture: true, once: true }
			);
		});
		await page.keyboard.press('ArrowRight');
		await expect.poll(() => texts(page)).toEqual(['Rfirst', 'note', 'tail']);
		await expect.poll(() => selection(page)).toMatchObject({ range: 'b1@2-b1@2', collapsed: true });
		expect((await domSelection(page))?.dom).toBe('b1@2->b1@2');
		await page.keyboard.type('Z');
		await expect.poll(() => texts(page)).toEqual(['Rfirst', 'noZte', 'tail']);
	});
});

test.describe('P1 — selection races under remote traffic (review-probes/collab)', () => {
	test('a remote apply racing a page-script selection keeps the user selection (F-S11c, remote)', async ({
		browser
	}, info) => {
		const room = await openRoom(browser, info.project.use.baseURL, [
			b('c1', 'alpha'),
			b('c2', 'beta'),
			b('c3', 'gamma')
		]);
		const [a, peer] = room.pages;
		try {
			await caret(a, 'c1', 1);
			const results: string[] = [];
			for (let i = 0; i < 5; i++) {
				await peer.evaluate(() =>
					(window as Window & { __EDYTOR__?: any }).__EDYTOR__.facade.insertText('c3', 0, 'P')
				);
				// A new selection while the peer's update is in flight.
				await a.evaluate(() => {
					const host = document.querySelector('[data-edytor-id="c2"] [data-edytor-text="true"]')!;
					const node = document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode()!;
					window.getSelection()!.setBaseAndExtent(node, 1, node, 3);
				});
				await expect.poll(async () => (await model(a))[2].text).toBe(`${'P'.repeat(i + 1)}gamma`);
				await a.waitForTimeout(150);
				results.push(`${(await domSelection(a))?.dom} ${(await selection(a)).range}`);
				await caret(a, 'c1', 1);
			}
			expect(results).toEqual(Array(5).fill('c2@1->c2@3 c2@1-c2@3'));
		} finally {
			await room.close();
		}
	});

	test('arrow keys while a peer types every 8 ms never lose a caret move (F-S11a, remote)', async ({
		browser
	}, info) => {
		const room = await openRoom(browser, info.project.use.baseURL, [
			b('c1', 'abcdefghijklmnopqrstuvwxyz'),
			b('c2', 'beta'),
			b('c3', 'gamma')
		]);
		const [a, peer] = room.pages;
		try {
			await peer.evaluate(() => {
				const w = window as Window & { __EDYTOR__?: any; __p1Timer?: number };
				w.__p1Timer = window.setInterval(() => w.__EDYTOR__.facade.insertText('c3', 0, 'p'), 8);
			});
			const trials: string[] = [];
			for (let trial = 0; trial < 6; trial++) {
				await caret(a, 'c1', 0);
				for (let i = 0; i < 10; i++) {
					await a.keyboard.press('ArrowRight');
					await a.waitForTimeout(15);
				}
				await a.waitForTimeout(150);
				trials.push(`${(await domSelection(a))?.dom} ${(await selection(a)).range}`);
			}
			await peer.evaluate(() =>
				window.clearInterval((window as Window & { __p1Timer?: number }).__p1Timer)
			);
			// The peer's traffic really arrived while the keys were pressed.
			expect((await model(a))[2].text.length).toBeGreaterThan(20);
			expect(trials).toEqual(Array(6).fill('c1@10->c1@10 c1@10-c1@10'));
		} finally {
			await room.close();
		}
	});
});

/**
 * The projector displays a value only at the points it writes (text leaves).
 * Typing over a reversed range that ends in a run the render removes leaves
 * WebKit's selection on the text element itself, its `getRangeAt(0)` still
 * spanning from the text's start (DST seeds 24 and 34,
 * `selection-model-dom-mismatch`): that is not the caret, so it is written
 * again. Three engines; the range the engine reports must equal the value.
 */
test('typing over a reversed range across a removed mark run leaves the DOM caret at the value', async ({
	page
}) => {
	await open(page, [
		{
			id: 'b0',
			type: 'paragraph',
			content: [{ text: 'x' }, { text: 'alph', marks: { highlight: 'yellow' } }, { text: 'él' }]
		}
	]);
	await setDom(page, ['b0', 7], ['b0', 1]);
	await expect.poll(() => selection(page)).toMatchObject({ range: 'b0@1-b0@7', collapsed: false });
	await page.keyboard.insertText('é');
	await expect.poll(() => texts(page)).toEqual(['xé']);
	await expect.poll(() => selection(page)).toMatchObject({ range: 'b0@2-b0@2', collapsed: true });
	// The engine's range (what it edits at), not only anchor/focus.
	await expect
		.poll(() =>
			page.evaluate(() => {
				const range = window.getSelection()!.getRangeAt(0);
				const text = document.querySelector('[data-edytor-id="b0"] [data-edytor-text="true"]')!;
				const at = (node: Node, offset: number) => {
					const r = document.createRange();
					r.selectNodeContents(text);
					r.setEnd(node, offset);
					return r.toString().length;
				};
				return [
					at(range.startContainer, range.startOffset),
					at(range.endContainer, range.endOffset)
				];
			})
		)
		.toEqual([2, 2]);
});

/**
 * A pointer drag is the user's gesture: nothing writes the DOM selection
 * under it (R10, O57). Starting in an empty block, the engine's first range
 * covers only the empty text's filler and reads as a caret; displaying that
 * caret mid-drag reset the drag's anchor (WebKit, Firefox) or made it follow
 * the pointer (Chromium) — DST seed 35, `cross-browser-selection-divergence`.
 * Dragging from an empty block into the next one selects across both.
 */
test('a drag from an empty block into the next selects across both', async ({ page }) => {
	await open(page, [b('b0', ''), b('b1', 'note')]);
	const edge = (id: string, side: 'left' | 'right') =>
		page.evaluate(
			({ id, side }) => {
				const text = document.querySelector(`[data-edytor-id="${id}"] [data-edytor-text="true"]`)!;
				const rect = text.getBoundingClientRect();
				return {
					x: side === 'left' ? rect.left + 1 : rect.right - 1,
					y: rect.top + rect.height / 2
				};
			},
			{ id, side }
		);
	const from = await edge('b0', 'left');
	const to = await edge('b1', 'right');
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
	await expect.poll(() => selection(page)).toMatchObject({ range: 'b0@0-b1@4', collapsed: false });
	await expect.poll(() => domSelection(page)).toEqual({ dom: 'b0@0->b1@4', collapsed: false });
});
