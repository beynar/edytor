import { expect, test, type Page } from './editorTest';
import {
	dispatchClipboardEvent,
	dispatchPaste,
	modKey,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/**
 * Silly stress: what an impatient, careless or playful user does, at a
 * volume no other row reaches, each against what the contract says the
 * result is (never what the editor happens to do). Every row ends with the
 * fixture's truth check (the host is its cells) and no page error.
 *
 * - a long burst typed at once lands whole, in order;
 * - sixty Enters inside a word and sixty Backspaces give the word back, the
 *   caret at the seam (`del.caret.char`, `del.start.*`);
 * - emoji, flags, skin tones, ZWJ families and combining marks: each
 *   Backspace removes one grapheme cluster (`del.caret.char`), an arrow
 *   never stops inside one;
 * - the select-all ladder, then typing, replaces everything; undo gives it
 *   all back, redo takes it again (`sel.blocks.exact`);
 * - undo pressed until nothing changes gives the starting document back,
 *   redo until nothing changes the last one;
 * - Bold pressed eleven times is bold, Italic ten times is not;
 * - every markdown prefix on one line, each undone by Backspace at the
 *   block's start (`del.start.kind`), leaves a paragraph;
 * - five hundred pasted lines are five hundred blocks; select all and
 *   Backspace empties the page; cut everything and paste it back;
 * - a 5,000-character word wraps: nothing scrolls sideways;
 * - thirty Enters at a heading's end make paragraphs; a to-do clicked 21
 *   times is checked; twenty-five lines nested with Tab come back out with
 *   Shift+Tab; Delete held from the page's start empties it; the slash menu
 *   dismissed ten times leaves its slashes, `/h2` Enter leaves no query.
 */

type Node = {
	type: string;
	id?: string;
	data?: Record<string, unknown>;
	content?: { text?: string; marks?: Record<string, unknown> }[];
	children?: Node[];
};
const para = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });

const open = async (page: Page, children: unknown[]) => {
	await page.goto(
		`/test/dom?scenario=dst&handles=true&polish=1&dst=${encodeURIComponent(JSON.stringify({ children }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
};

const value = (page: Page) => readJsonByTestId<{ children: Node[] }>(page, 'value');
const textOf = (node: Node) => (node.content ?? []).map((part) => part.text ?? '').join('');
const flat = (nodes: Node[]): Node[] =>
	nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
const texts = async (page: Page) => flat((await value(page)).children).map(textOf);
const kinds = async (page: Page) => flat((await value(page)).children).map((node) => node.type);
const graphemes = (text: string) =>
	[...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map((s) => s.segment);

/** A deterministic text of `n` characters: letters, digits, spaces and punctuation. */
const burst = (n: number) => {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 .,;:!?-()\'"';
	let seed = 7;
	return Array.from({ length: n }, () => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return alphabet[seed % alphabet.length];
	}).join('');
};

/** Press `key` until the document stops changing (at most `limit` times): how many times it changed. */
const pressUntilStill = async (page: Page, key: string, limit = 120) => {
	let last = JSON.stringify(await value(page));
	for (let i = 0; i < limit; i++) {
		await page.keyboard.press(key);
		const now = JSON.stringify(await value(page));
		if (now === last) return i;
		last = now;
	}
	throw new Error(`${key} still changed the document after ${limit} presses`);
};

test.describe('silly stress', () => {
	test('a 1,500-character burst typed at once lands whole, in order', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, [para('A', 'start')]);
		await setSelectionByTextIndex(page, 0, 5);
		const typed = burst(1500);
		await page.keyboard.type(typed);
		await expect.poll(() => texts(page)).toEqual(['start' + typed]);
		issues.assertClean();
	});

	test('sixty Enters inside a word and sixty Backspaces give the word back, the caret at the seam', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, [para('A', 'helloworld')]);
		await setSelectionByTextIndex(page, 0, 5);
		for (let i = 0; i < 60; i++) await page.keyboard.press('Enter');
		await expect.poll(async () => (await texts(page)).length).toBe(61);
		const split = await texts(page);
		expect([split[0], split.at(-1), split.slice(1, -1).every((text) => text === '')]).toEqual([
			'hello',
			'world',
			true
		]);
		for (let i = 0; i < 60; i++) await page.keyboard.press('Backspace');
		await expect.poll(() => texts(page)).toEqual(['helloworld']);
		await page.keyboard.type('X');
		await expect.poll(() => texts(page)).toEqual(['helloXworld']);
		issues.assertClean();
	});

	test('emoji, flags, skin tones, ZWJ families and combining marks: one Backspace, one cluster', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const text = 'a👨‍👩‍👧‍👦b🇫🇷c👍🏽dé̃f𝒳g🏳️‍🌈h';
		await open(page, [para('A', text)]);
		const clusters = graphemes(text);
		await setSelectionByTextIndex(page, 0, text.length);
		for (let removed = 1; removed <= clusters.length; removed++) {
			await page.keyboard.press('Backspace');
			await expect.poll(() => texts(page)).toEqual([clusters.slice(0, -removed).join('')]);
		}
		issues.assertClean();
	});

	test('an arrow never stops inside a cluster: a character typed after each step lands between two', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const text = '👨‍👩‍👧‍👦🇫🇷👍🏽é̃𝒳🏳️‍🌈';
		const clusters = graphemes(text);
		for (let steps = 1; steps <= clusters.length; steps++) {
			await open(page, [para('A', text)]);
			await setSelectionByTextIndex(page, 0, text.length);
			for (let i = 0; i < steps; i++) await page.keyboard.press('ArrowLeft');
			await page.keyboard.type('|');
			const at = clusters.length - steps;
			await expect
				.poll(() => texts(page))
				.toEqual([[...clusters.slice(0, at), '|', ...clusters.slice(at)].join('')]);
		}
		issues.assertClean();
	});

	test('the select-all ladder, then typing, replaces everything; undo gives it back, redo takes it again', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const start = [para('A', 'alpha'), para('B', 'bravo'), para('C', 'charlie')];
		await open(page, start);
		await setSelectionByTextIndex(page, 1, 2);
		for (let i = 0; i < 3; i++) await page.keyboard.press(`${modKey}+a`);
		await page.keyboard.type('x');
		await expect.poll(() => texts(page)).toEqual(['x']);
		await pressUntilStill(page, `${modKey}+z`);
		await expect.poll(() => texts(page)).toEqual(['alpha', 'bravo', 'charlie']);
		await pressUntilStill(page, `${modKey}+Shift+z`);
		await expect.poll(() => texts(page)).toEqual(['x']);
		issues.assertClean();
	});

	test('undo until nothing changes gives the starting document back, redo until nothing changes the last', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, [para('A', 'one'), para('B', 'two')]);
		const before = await texts(page);
		await setSelectionByTextIndex(page, 0, 3);
		await page.keyboard.type(' plus');
		await page.keyboard.press('Enter');
		await page.keyboard.type('new line');
		await setSelectionByTextIndex(page, 2, 0);
		await page.keyboard.press('Backspace');
		await page.keyboard.press('Backspace');
		await page.keyboard.type('# ');
		await page.keyboard.type('title');
		await page.keyboard.press(`${modKey}+a`);
		await page.keyboard.press(`${modKey}+b`);
		const after = await value(page);
		await pressUntilStill(page, `${modKey}+z`);
		await expect.poll(() => texts(page)).toEqual(before);
		await pressUntilStill(page, `${modKey}+Shift+z`);
		await expect.poll(() => value(page)).toEqual(after);
		issues.assertClean();
	});

	test('Bold pressed eleven times is bold, Italic pressed ten times is not', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, [para('A', 'make this word loud')]);
		await setSelectionByTextIndex(page, 0, 10);
		for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
		for (let i = 0; i < 11; i++) await page.keyboard.press(`${modKey}+b`);
		for (let i = 0; i < 10; i++) await page.keyboard.press(`${modKey}+i`);
		await expect
			.poll(async () => (await value(page)).children[0]!.content)
			.toEqual([
				{ text: 'make this ' },
				{ text: 'word', marks: { bold: true } },
				{ text: ' loud' }
			]);
		issues.assertClean();
	});

	test('every markdown prefix on one line, each undone by Backspace at its start, leaves a paragraph', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, [para('A', '')]);
		await setSelectionByTextIndex(page, 0, 0);
		for (const prefix of ['# ', '## ', '### ', '- ', '* ', '1. ', '> ', '[] ']) {
			await page.keyboard.type(prefix);
			await expect.poll(async () => (await kinds(page))[0]).not.toBe('paragraph');
			await page.keyboard.press('Backspace');
			await expect.poll(() => kinds(page)).toEqual(['paragraph']);
		}
		await page.keyboard.type('still here');
		await expect.poll(() => texts(page)).toEqual(['still here']);
		issues.assertClean();
	});

	test('five hundred pasted lines are five hundred blocks; select all and Backspace empties the page', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, [para('A', '')]);
		await setSelectionByTextIndex(page, 0, 0);
		const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
		await dispatchPaste(page, { text: lines.join('\n') });
		await expect.poll(() => texts(page)).toEqual(lines);
		await setSelectionByTextIndex(page, 250, 2);
		for (let i = 0; i < 3; i++) await page.keyboard.press(`${modKey}+a`);
		await page.keyboard.press('Backspace');
		// An emptied document stores no block: the view shows its virtual paragraph.
		await expect.poll(() => texts(page)).toEqual([]);
		await page.keyboard.type('fresh');
		await expect.poll(() => texts(page)).toEqual(['fresh']);
		issues.assertClean();
	});

	test('a 5,000-character word with no space wraps: the editor never grows past its track', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, [para('A', 'x'.repeat(5000)), para('B', 'after')]);
		// The test page's editor sits in a grid track sized by its content, as in many apps;
		// its debug printouts (which never wrap) are hidden, so only the editor sizes it.
		const overflow = await page.evaluate(async () => {
			for (const id of ['value', 'selection'])
				document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.style.display = 'none';
			await new Promise((resolve) => requestAnimationFrame(resolve));
			const host = document.querySelector<HTMLElement>('[data-edytor]')!;
			const root = document.scrollingElement!;
			return [host.getBoundingClientRect().width - innerWidth, root.scrollWidth - root.clientWidth];
		});
		expect(overflow.map((n) => n <= 1)).toEqual([true, true]);
		issues.assertClean();
	});

	test('cut everything and paste it back gives the same document', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, [
			{ id: 'H', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Title' }] },
			{
				id: 'P',
				type: 'paragraph',
				content: [{ text: 'plain ' }, { text: 'bold', marks: { bold: true } }]
			},
			{ id: 'L1', type: 'bulleted-list-item', content: [{ text: 'one' }] },
			{ id: 'L2', type: 'bulleted-list-item', content: [{ text: 'two' }] },
			{ id: 'Q', type: 'quote', content: [{ text: 'said' }] }
		]);
		const before = { texts: await texts(page), kinds: await kinds(page) };
		await setSelectionByTextIndex(page, 0, 1);
		for (let i = 0; i < 3; i++) await page.keyboard.press(`${modKey}+a`);
		const { clipboardData } = await dispatchClipboardEvent(page, 'cut');
		await expect.poll(() => texts(page)).toEqual([]);
		await page.keyboard.type('z');
		await page.keyboard.press('Backspace');
		await dispatchPaste(page, {
			text: clipboardData['text/plain'],
			html: clipboardData['text/html'],
			data: clipboardData
		});
		await expect
			.poll(async () => ({ texts: await texts(page), kinds: await kinds(page) }))
			.toEqual(before);
		issues.assertClean();
	});

	test("thirty Enters at a heading's end make paragraphs, never more headings", async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, [
			{ id: 'H', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Title' }] }
		]);
		await setSelectionByTextIndex(page, 0, 5);
		for (let i = 0; i < 30; i++) await page.keyboard.press('Enter');
		await expect.poll(() => kinds(page)).toEqual(['heading', ...Array(30).fill('paragraph')]);
		issues.assertClean();
	});

	test('a to-do box clicked twenty-one times is checked', async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, [
			{ id: 'T', type: 'todo-item', data: { checked: false }, content: [{ text: 'task' }] }
		]);
		const box = page.locator('[data-edytor-todo-checkbox]').first();
		for (let i = 0; i < 21; i++) await box.click();
		await expect.poll(async () => (await value(page)).children[0]!.data?.checked).toBe(true);
		await expect(box).toBeChecked();
		issues.assertClean();
	});

	test('twenty-five lines nested with Tab come back out with Shift+Tab, in order', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, [para('A', 'l0')]);
		await setSelectionByTextIndex(page, 0, 2);
		for (let i = 1; i <= 25; i++) {
			await page.keyboard.press('Enter');
			await page.keyboard.press('Tab');
			await page.keyboard.type(`l${i}`);
		}
		const depth = (nodes: Node[], d = 0): number =>
			Math.max(d, ...nodes.map((node) => depth(node.children ?? [], d + 1)));
		await expect.poll(async () => depth((await value(page)).children)).toBe(26);
		const lines = Array.from({ length: 26 }, (_, i) => `l${i}`);
		expect(await texts(page)).toEqual(lines);
		for (let i = 0; i < 25; i++) await page.keyboard.press('Shift+Tab');
		await expect
			.poll(async () => (await value(page)).children.at(-1)?.content?.[0]?.text)
			.toBe('l25');
		expect(await texts(page)).toEqual(lines);
		issues.assertClean();
	});

	test("Delete held from the page's start empties it", async ({ page }) => {
		const issues = trackPageIssues(page);
		await open(page, [para('A', 'alpha'), para('B', 'bravo'), para('C', 'charlie')]);
		await setSelectionByTextIndex(page, 0, 0);
		await pressUntilStill(page, 'Delete');
		await expect.poll(async () => (await texts(page)).join('')).toBe('');
		expect((await texts(page)).length).toBeLessThanOrEqual(1);
		issues.assertClean();
	});

	test('the slash menu dismissed ten times leaves its slashes; /h2 Enter leaves no query', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page, [para('A', 'a'), para('B', '')]);
		await setSelectionByTextIndex(page, 0, 1);
		// A slash opens the menu after whitespace (never inside a word, `1/2`).
		for (let i = 0; i < 10; i++) {
			await page.keyboard.type(' /');
			await expect(page.getByTestId('slash-menu')).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(page.getByTestId('slash-menu')).toHaveCount(0);
		}
		await expect.poll(async () => (await texts(page))[0]).toBe('a' + ' /'.repeat(10));
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.type('/h2');
		await expect(page.getByTestId('slash-menu-item')).toHaveText('Heading 2');
		await page.keyboard.press('Enter');
		await expect
			.poll(async () => [(await kinds(page))[1], (await texts(page))[1]])
			.toEqual(['heading', '']);
		issues.assertClean();
	});
});
