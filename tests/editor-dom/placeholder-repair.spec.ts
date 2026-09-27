import { expect, test, type Page } from './editorTest';

import {
	dispatchComposition,
	getBlockLocators,
	gotoEditorRoute,
	modKey,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues
} from './helpers';

/**
 * The placeholder a user sees (plan §2.4 "Placeholder attribute", R11, D-8;
 * R5 rewrote the U6 repair-queue spec as user-visible assertions only).
 *
 * A placeholder shows only for the lone empty text of an empty block, never
 * during a composition, and follows every commit path: typing, deletion,
 * split and undo, remote and programmatic edits, a remount. What is asserted
 * is what the page shows — the placeholder text each block displays, read
 * from the rendered DOM and its computed styles — whatever renders it.
 */

type Shown = { block: number; text: string };

/** The placeholders a reader sees, by block index (document order) and text. */
const readShown = (page: Page): Promise<Shown[]> =>
	page.evaluate(() => {
		const blocks = Array.from(document.querySelectorAll('[data-edytor-block="true"]'));
		const blockOf = (node: Element) =>
			blocks.indexOf(node.closest('[data-edytor-block="true"]') as Element);
		const shown: Shown[] = [];
		// An in-flow placeholder element (the pre-R5 renderer).
		for (const node of document.querySelectorAll('[data-edytor-text-placeholder]')) {
			const style = getComputedStyle(node);
			if (style.display === 'none' || style.visibility === 'hidden') continue;
			if (node.getClientRects().length === 0) continue;
			shown.push({ block: blockOf(node), text: node.textContent?.trim() ?? '' });
		}
		// A generated `::before` on the empty text (R5: the attribute + shipped rule).
		for (const node of document.querySelectorAll('[data-edytor-text][data-placeholder]')) {
			const before = getComputedStyle(node, '::before');
			const content = before.content;
			if (!content || content === 'none' || content === 'normal') continue;
			if (before.display === 'none' || before.visibility === 'hidden') continue;
			const text = content.startsWith('"')
				? (JSON.parse(content) as string)
				: (node.getAttribute('data-placeholder') ?? '');
			if (text) shown.push({ block: blockOf(node), text });
		}
		return shown.sort((a, b) => a.block - b.block);
	});

const shownIn = (...blocks: number[]) => blocks.map((block) => ({ block, text: 'Start writing' }));

/** Click the start of block `index`'s first text row — where a placeholder is read. */
const clickBlockStart = async (page: Page, index: number) => {
	const text = getBlockLocators(page).nth(index).locator('[data-edytor-text="true"]').first();
	const row = text.locator('xpath=..');
	const box = await row.boundingBox();
	if (!box) throw new Error(`Missing text row of block ${index}`);
	await page.mouse.click(box.x + 2, box.y + box.height / 2);
};

const readBlockTexts = async (page: Page) =>
	(
		await readJsonByTestId<{ children: Array<{ content?: Array<{ text?: string }> }> }>(
			page,
			'value'
		)
	).children.map((block) => (block.content ?? []).map((part) => part.text ?? '').join(''));

const EMPTY_FIRST = '/test/dom?scenario=basic&empty=first&placeholder=Start%20writing';

test.describe('placeholder (user-visible)', () => {
	test('empty → type → placeholder gone; delete-all → placeholder returns', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, EMPTY_FIRST);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0));

		await clickBlockStart(page, 0);
		await page.keyboard.type('A');
		await expect.poll(() => readBlockTexts(page)).toEqual(['A', 'note', 'tail']);
		await expect.poll(() => readShown(page)).toEqual([]);

		await page.keyboard.press('Backspace');
		await expect.poll(() => readBlockTexts(page)).toEqual(['', 'note', 'tail']);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0));

		issues.assertClean();
	});

	test('deleting all marked text in a block restores its placeholder', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=marks&placeholder=Start%20writing');
		await expect.poll(() => readShown(page)).toEqual([]);

		// Block 0 holds 'Alpha' (bold) + ' beta' (plain): delete all of it.
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const block = edytor.root.children[0];
			const length = block.content.reduce(
				(total: number, part: { length?: number }) => total + (part.length ?? 0),
				0
			);
			edytor.facade.deleteText(block.id, 0, length);
		});

		await expect.poll(() => readBlockTexts(page)).toEqual(['', 'Gamma delta']);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0));

		issues.assertClean();
	});

	test('enter split then undo — the placeholder follows the emptied half only', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, EMPTY_FIRST);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0));

		// Split at offset 0 of 'note': the new first half is empty.
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Enter');
		await expect.poll(() => readBlockTexts(page)).toEqual(['', '', 'note', 'tail']);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0, 1));

		await page.keyboard.press(`${modKey}+z`);
		await expect.poll(() => readBlockTexts(page)).toEqual(['', 'note', 'tail']);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0));
		await expect(getBlockLocators(page)).toHaveCount(3);

		issues.assertClean();
	});

	test('composition cancel keeps the placeholder; committed IME text removes it', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, EMPTY_FIRST);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0));

		await setSelectionByTextIndex(page, 0, 0);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionend', data: '' }
		]);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0));

		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
			{ type: 'compositionend', data: 'é' }
		]);
		await expect.poll(() => readBlockTexts(page)).toEqual(['é', 'note', 'tail']);
		await expect.poll(() => readShown(page)).toEqual([]);

		issues.assertClean();
	});

	test('inline atoms — no placeholder beside mention separators', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=inline&placeholder=Start%20writing');
		await expect.poll(() => readShown(page)).toEqual([]);

		// Block 0 keeps only its mention between two empty texts: not one lone
		// empty text, so no placeholder.
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const tail = edytor.root.children[0].content.at(-1);
			edytor.doc.transact(() => {
				tail.deleteAt(0, tail.length);
			}, 'r5-inline-delete');
		});
		await expect
			.poll(() => page.evaluate(() => document.querySelector('[data-edytor-mention]') !== null))
			.toBe(true);
		await expect.poll(() => readShown(page)).toEqual([]);

		issues.assertClean();
	});

	test('a programmatic update while blurred removes the placeholder', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, EMPTY_FIRST);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0));

		await page.evaluate(() => {
			const button = document.createElement('button');
			button.dataset.testid = 'outside-focus-target';
			document.body.append(button);
			button.focus();
		});
		await expect(page.getByTestId('outside-focus-target')).toBeFocused();

		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const text = edytor?.root?.children?.[0]?.firstText;
			edytor.doc.transact(() => {
				text.insertAt(0, '!');
			}, 'remote-programmatic-update');
		});

		await expect.poll(() => readBlockTexts(page)).toEqual(['!', 'note', 'tail']);
		await expect.poll(() => readShown(page)).toEqual([]);

		issues.assertClean();
	});

	test('a remote edit over the real provider updates the receiving view', async ({ context }) => {
		const pageA = await context.newPage();
		const pageB = await context.newPage();
		const issuesA = trackPageIssues(pageA);
		const issuesB = trackPageIssues(pageB);
		const room = `r5-ph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		await gotoEditorRoute(pageA, `/test/dom?scenario=collab&collab=${room}`, {
			requireRuntime: true
		});
		await gotoEditorRoute(pageB, `/test/dom?scenario=collab&collab=${room}`, {
			requireRuntime: true
		});
		await expect
			.poll(async () => {
				const [a, b] = await Promise.all([readBlockTexts(pageA), readBlockTexts(pageB)]);
				return JSON.stringify(a) === JSON.stringify(b) && a[0] === 'alpha';
			})
			.toBe(true);
		await expect.poll(() => readShown(pageA)).toEqual([]);

		await pageB.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const block = edytor.root.children[0];
			edytor.facade.deleteText(block.id, 0, block.firstText.length);
		});
		await expect.poll(() => readBlockTexts(pageA)).toEqual(['', 'beta', 'gamma']);
		await expect
			.poll(async () => (await readShown(pageA)).map((shown) => shown.block))
			.toEqual([0]);

		await pageB.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.facade.insertText(edytor.root.children[0].id, 0, 'z');
		});
		await expect.poll(() => readBlockTexts(pageA)).toEqual(['z', 'beta', 'gamma']);
		await expect.poll(() => readShown(pageA)).toEqual([]);

		issuesA.assertClean();
		issuesB.assertClean();
	});

	// R7 rewrite (L39): no whole-editor remount exists; every block's text
	// elements are re-created instead.
	test('re-created text elements keep exactly one placeholder; typing removes it', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, EMPTY_FIRST);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0));

		await page.evaluate(() => {
			document
				.querySelector('[data-edytor-text="true"]')
				?.setAttribute('data-r5-preremount', 'true');
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			for (const block of edytor.root.children) edytor.cells.remount(block.id);
		});
		await expect(page.locator('[data-r5-preremount]')).toHaveCount(0);
		await expect(getBlockLocators(page)).toHaveCount(3);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0));

		await clickBlockStart(page, 0);
		await page.keyboard.type('R');
		await expect.poll(() => readBlockTexts(page)).toEqual(['R', 'note', 'tail']);
		await expect.poll(() => readShown(page)).toEqual([]);

		issues.assertClean();
	});

	test('a 60-keystroke burst in another block leaves the placeholder alone', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, EMPTY_FIRST);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0));

		await setSelectionByTextIndex(page, 1, 'note'.length);
		await page.keyboard.type('x'.repeat(60));
		await expect.poll(() => readBlockTexts(page)).toEqual(['', `note${'x'.repeat(60)}`, 'tail']);
		await expect.poll(() => readShown(page)).toEqual(shownIn(0));

		issues.assertClean();
	});
});
