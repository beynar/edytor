/**
 * Contract `doc.empty.virtual` (2026-09-28) in real browsers: an emptied
 * document shows a virtual paragraph with the caret in it; nothing is written
 * for it; the first keystrokes create a real block holding them, in one
 * update. In one editor (the last block deleted by a write the view did not
 * issue) and across two contexts on one websocket room (each peer deletes one
 * of the last two blocks while the room is held). Expected values are the
 * contract's, hand-written.
 */
import { expect, test, type Page } from './editorTest';
import { b, domSelection, model, open, openRoom } from './probe-helpers';

type EdytorWindow = Window & { __EDYTOR__?: any };

/** The document (not the view's lens): its blocks as written. */
const written = (page: Page) =>
	page.evaluate(() =>
		(window as EdytorWindow).__EDYTOR__.document.facade
			.toJSON()
			.children.map((block: { id: string; content?: { text?: string }[] }) => [
				block.id,
				(block.content ?? []).map((c) => c.text ?? '').join('')
			])
	);

/** What the view shows: its blocks and, when it shows one, the virtual paragraph's id. */
const view = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as EdytorWindow).__EDYTOR__;
		return {
			virtual: edytor.facade.virtual() as string | null,
			blocks: Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')).map(
				(node) => node.getAttribute('data-edytor-id')
			)
		};
	});

const caretIn = async (page: Page, block: string) =>
	expect.poll(async () => (await domSelection(page))?.dom).toBe(`${block}@0->${block}@0`);

test.describe('doc.empty.virtual', () => {
	test('one editor: the emptied document shows a virtual paragraph; typing creates it', async ({
		page
	}) => {
		await open(page, [b('a', 'alpha')]);
		await page.locator('[data-edytor-id="a"] [data-edytor-text="true"]').click();
		// A write this view did not issue (a peer's, an API call) deletes the last block.
		await page.evaluate(() =>
			(window as EdytorWindow).__EDYTOR__.document.facade.deleteBlocks(['a'])
		);
		await expect.poll(() => written(page)).toEqual([]);
		const { virtual, blocks } = await view(page);
		expect(virtual).toMatch(/^v_/);
		expect(blocks).toEqual([virtual]);
		await caretIn(page, virtual!);
		await page.keyboard.type('hi');
		await expect.poll(() => written(page)).toEqual([[virtual, 'hi']]);
		expect((await view(page)).virtual).toBeNull();
		expect(await model(page)).toMatchObject([{ id: virtual, text: 'hi' }]);
		expect((await domSelection(page))?.dom).toBe(`${virtual}@2->${virtual}@2`);
	});

	test('two contexts delete the last two blocks concurrently: both show a virtual paragraph; typing reaches the other', async ({
		browser,
		baseURL
	}) => {
		const room = await openRoom(browser, baseURL, [b('a', 'alpha'), b('z', 'omega')]);
		try {
			const [one, two] = room.pages as [Page, Page];
			for (const [page, id] of [
				[one, 'a'],
				[two, 'z']
			] as const)
				await page.locator(`[data-edytor-id="${id}"] [data-edytor-text="true"]`).click();
			room.relay.hold(room.room);
			// Each peer deletes the block the other keeps (its block selection, Backspace).
			for (const [page, id] of [
				[one, 'z'],
				[two, 'a']
			] as const) {
				await page.evaluate((target) => {
					const edytor = (window as EdytorWindow).__EDYTOR__;
					edytor.selection.selectBlocks(edytor.idToBlock.get(target));
				}, id);
				await page.locator('[data-edytor]').press('Backspace');
			}
			await expect.poll(() => written(one)).toEqual([['a', 'alpha']]);
			await expect.poll(() => written(two)).toEqual([['z', 'omega']]);
			room.relay.release(room.room);
			for (const page of [one, two]) {
				await expect.poll(() => written(page)).toEqual([]);
				await expect.poll(async () => (await view(page)).blocks.length).toBe(1);
				const { virtual, blocks } = await view(page);
				expect(blocks).toEqual([virtual]);
				await caretIn(page, virtual!);
			}
			const virtual = (await view(one)).virtual!;
			await one.keyboard.type('back');
			for (const page of [one, two])
				await expect.poll(() => written(page)).toEqual([[virtual, 'back']]);
			await expect.poll(async () => (await view(two)).virtual).toBeNull();
			expect(await model(two)).toMatchObject([{ id: virtual, text: 'back' }]);
		} finally {
			await room.close();
		}
	});
});
