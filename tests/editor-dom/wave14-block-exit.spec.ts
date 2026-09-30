import { expect, test, type Page } from './editorTest';
import {
	dispatchComposition,
	dispatchPaste,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/**
 * Wave 14 (`docs/reviews/2026-09-30-rescore-11.md`), leaving a block
 * selection in every engine. EW-06: Escape over a lone selected divider
 * puts the caret at the start of the next line, and typing, Enter and a
 * paste land there, never in the divider. EW-01: a composition over a block
 * selection starts in the empty paragraph that replaces it — the DOM caret
 * is there before the IME writes — and the commit lands there alone (the
 * real-IME rows are `ime-baseline.cdp.spec.ts`). Expected states are
 * hand-authored.
 */

type Block = { type: string; content?: { text?: string }[] };

const lines = async (page: Page) =>
	(await readJsonByTestId<{ children: Block[] }>(page, 'value')).children.map(
		(block) => `${block.type}:${(block.content ?? []).map((part) => part.text ?? '').join('')}`
	);

const selectedBlocks = (page: Page) =>
	page.evaluate(() => (window as any).__EDYTOR__.selection.selectedBlocks.size as number);

/** `[first, divider, after]`, the divider selected with Backspace from `|after`. */
const selectDivider = async (page: Page) => {
	await page.goto('/test/dom?scenario=divider');
	await waitForEditorReady(page, { requireRuntime: true });
	await setSelectionByTextIndex(page, 1, 0); // |after divider
	await page.keyboard.press('Backspace');
	await expect.poll(() => selectedBlocks(page)).toBe(1);
};

test.describe('Escape over a lone selected divider (EW-06)', () => {
	for (const [name, act, expected] of [
		[
			'typing',
			(page: Page) => page.keyboard.type('Z'),
			['paragraph:before divider', 'divider:', 'paragraph:Zafter divider']
		],
		[
			'Enter',
			async (page: Page) => {
				await page.keyboard.press('Enter');
				await page.keyboard.type('E');
			},
			['paragraph:before divider', 'divider:', 'paragraph:', 'paragraph:Eafter divider']
		],
		[
			'a paste',
			(page: Page) => dispatchPaste(page, { text: 'P' }),
			['paragraph:before divider', 'divider:', 'paragraph:Pafter divider']
		]
	] as const) {
		test(`${name} after Escape lands at the start of the next line`, async ({ page }) => {
			const issues = trackPageIssues(page);
			await selectDivider(page);
			await page.keyboard.press('Escape');
			await expect.poll(() => selectedBlocks(page)).toBe(0);
			await act(page);
			await expect.poll(() => lines(page)).toEqual(expected);
			issues.assertClean();
		});
	}
});

test.describe('a composition over a block selection (EW-01)', () => {
	test('starts in the paragraph that replaces the blocks; the commit lands there alone', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await selectDivider(page);
		await dispatchComposition(page, [{ type: 'compositionstart', data: '' }]);
		// The IME has a caret in the new, empty paragraph before it writes.
		const caret = await page.evaluate(() => {
			const selection = document.getSelection();
			const node = selection?.focusNode;
			const element = (
				node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
			)?.closest('[data-edytor-block]');
			const blocks = [...document.querySelectorAll('[data-edytor-block]')];
			return { rangeCount: selection?.rangeCount, block: element ? blocks.indexOf(element) : -1 };
		});
		expect(caret).toEqual({ rangeCount: 1, block: 1 });
		await dispatchComposition(page, [
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に', cancelable: false },
			{ type: 'compositionend', data: '日' }
		]);
		await expect
			.poll(() => lines(page))
			.toEqual(['paragraph:before divider', 'paragraph:日', 'paragraph:after divider']);
		issues.assertClean();
	});

	test('after an earlier composition: the session stays live and the commit lands (DR-behavior-1)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=divider');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 'before divider'.length);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'x', cancelable: false },
			{ type: 'compositionend', data: 'x' }
		]);
		await expect.poll(() => lines(page)).toContain('paragraph:before dividerx');
		// Past the composition's tail.
		await page.waitForTimeout(600);
		await setSelectionByTextIndex(page, 1, 0); // |after divider
		await page.keyboard.press('Backspace');
		await expect.poll(() => selectedBlocks(page)).toBe(1);
		await dispatchComposition(page, [{ type: 'compositionstart', data: '' }]);
		expect(await page.evaluate(() => (window as any).__EDYTOR__.composition.phase)).toBe('live');
		await dispatchComposition(page, [
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に', cancelable: false },
			{ type: 'compositionend', data: '日' }
		]);
		await expect
			.poll(() => lines(page))
			.toEqual(['paragraph:before dividerx', 'paragraph:日', 'paragraph:after divider']);
		expect(await page.evaluate(() => (window as any).__EDYTOR__.composition.host)).toBeNull();
		issues.assertClean();
	});
});

/**
 * FX-01 (`docs/reviews/2026-09-30-rescore-12.md`): the word keys, with and
 * without Shift, over a block selection that starts or ends in a block that
 * renders no content. The seeds and the expected documents are the jsdom
 * table's (`wave14-ime-escape.test.tsx`, SW14-keys-1): the caret or range
 * lands on a shown line, voids alone stay selected, and a typed character
 * never lands in hidden content.
 */
test.describe('the word keys over a block selection (FX-01)', () => {
	type Json = { id: string; type: string; content?: { text: string }[]; children?: Json[] };
	const p = (id: string, text = id): Json => ({ id, type: 'paragraph', content: [{ text }] });
	const divider = (id: string): Json => ({ id, type: 'divider' });
	const list: Json = {
		id: 'L',
		type: 'unordered-list',
		children: [
			{ id: 'i1', type: 'list-item', content: [{ text: 'one' }] },
			{ id: 'i2', type: 'list-item', content: [{ text: 'two' }] }
		]
	};
	const code: Json = {
		id: 'C',
		type: 'code',
		content: [{ text: 'cap' }],
		children: [
			{ id: 'l1', type: 'codeLine', content: [{ text: 'x' }] },
			{ id: 'l2', type: 'codeLine', content: [{ text: 'y' }] }
		]
	};
	const seed = [p('first'), p('before'), divider('d'), p('after')];
	const shapes: Record<string, { seed: Json[]; select: string[] | 'backspace' }> = {
		divider: { seed, select: 'backspace' },
		'paragraph, divider': { seed, select: ['before', 'd'] },
		list: { seed: [p('a'), list, p('z')], select: ['L'] },
		code: { seed: [p('a'), code, p('z')], select: ['C'] }
	};
	const replaced = ['paragraph:first', 'paragraph:before', 'paragraph:Z', 'paragraph:after'];
	const typed: Record<string, Record<string, string[]>> = {
		divider: { left: replaced, right: replaced, 'shift left': replaced, 'shift right': replaced },
		'paragraph, divider': {
			left: ['paragraph:first', 'paragraph:Zbefore', 'divider:', 'paragraph:after'],
			right: ['paragraph:first', 'paragraph:beforeZ', 'divider:', 'paragraph:after'],
			'shift left': ['paragraph:firstZ', 'divider:', 'paragraph:after'],
			'shift right': ['paragraph:first', 'paragraph:Zafter']
		},
		list: {
			left: ['paragraph:a', 'unordered-list:', 'list-item:Zone', 'list-item:two', 'paragraph:z'],
			right: ['paragraph:a', 'unordered-list:', 'list-item:one', 'list-item:twoZ', 'paragraph:z'],
			'shift left': ['paragraph:aZ', 'paragraph:z'],
			'shift right': ['paragraph:a', 'unordered-list:', 'list-item:Zz']
		},
		code: {
			left: ['paragraph:a', 'code:cap', 'codeLine:Zx', 'codeLine:y', 'paragraph:z'],
			right: ['paragraph:a', 'code:cap', 'codeLine:x', 'codeLine:yZ', 'paragraph:z'],
			'shift left': ['paragraph:aZ', 'paragraph:z'],
			'shift right': ['paragraph:a', 'code:cap', 'codeLine:Z', 'paragraph:z']
		}
	};
	/** Every block's `type:text`, depth-first (hidden content included). */
	const all = async (page: Page) => {
		const out: string[] = [];
		const walk = (blocks: Json[] = []) =>
			blocks.forEach((block) => {
				out.push(`${block.type}:${(block.content ?? []).map((part) => part.text).join('')}`);
				walk(block.children);
			});
		walk((await readJsonByTestId<{ children: Json[] }>(page, 'value')).children);
		return out;
	};

	for (const [shape, { seed, select }] of Object.entries(shapes))
		for (const row of ['left', 'right', 'shift left', 'shift right'])
			test(`over ${shape}: ${row}, then typing, writes only shown lines`, async ({ page }) => {
				const issues = trackPageIssues(page);
				await page.goto(
					`/test/dom?scenario=dst&dst=${encodeURIComponent(JSON.stringify({ children: seed }))}`
				);
				await waitForEditorReady(page, { requireRuntime: true });
				if (select === 'backspace') {
					await setSelectionByTextIndex(page, 2, 0); // |after
					await page.keyboard.press('Backspace');
				} else
					await page.evaluate((ids) => {
						const edytor = (window as any).__EDYTOR__;
						edytor.selection.selectBlocks(...ids.map((id: string) => edytor.idToBlock.get(id)));
					}, select);
				await expect.poll(() => selectedBlocks(page)).toBeGreaterThan(0);
				// Word motion is Alt+Arrow on Apple, Ctrl+Arrow elsewhere.
				const word = (await page.evaluate(() => /Mac/.test(navigator.platform)))
					? 'Alt'
					: 'Control';
				const arrow = row.endsWith('left') ? 'ArrowLeft' : 'ArrowRight';
				await page.keyboard.press(`${row.startsWith('shift') ? 'Shift+' : ''}${word}+${arrow}`);
				await page.keyboard.type('Z');
				await expect.poll(() => all(page)).toEqual(typed[shape]![row]);
				issues.assertClean();
			});
});

/**
 * DR-behavior-1/2 (wave 15): over a grip-selected parent whose nested
 * children are not selected, the navigation keys read the parent's own line
 * (a block selection is exactly its members), as Escape does; the document
 * keys over a lone selected divider go to the document's edge. The jsdom
 * rows are `wave14-ime-escape.test.tsx`; expected states are hand-authored.
 */
test.describe('the navigation keys over a selected parent and a lone divider (wave 15)', () => {
	type Json = { id: string; type: string; content?: { text: string }[]; children?: Json[] };
	const p = (id: string, text = id): Json => ({ id, type: 'paragraph', content: [{ text }] });
	const parent: Json[] = [
		{ ...p('P', 'parent'), children: [p('c1', 'kid one'), p('c2', 'kid two')] },
		p('z', 'zed')
	];
	const depthFirst = async (page: Page) => {
		const out: string[] = [];
		const walk = (blocks: Json[] = []) =>
			blocks.forEach((block) => {
				out.push((block.content ?? []).map((part) => part.text).join(''));
				walk(block.children);
			});
		walk((await readJsonByTestId<{ children: Json[] }>(page, 'value')).children);
		return out;
	};
	const open = async (page: Page, children: Json[]) => {
		await page.goto(
			`/test/dom?scenario=dst&dst=${encodeURIComponent(JSON.stringify({ children }))}`
		);
		await waitForEditorReady(page, { requireRuntime: true });
	};
	const kept = ['kid one', 'kid two', 'zed'];
	for (const [chord, expected] of [
		['End', ['parentZ', ...kept]],
		['Word+ArrowRight', ['parentZ', ...kept]],
		['Home', ['Zparent', ...kept]],
		['Shift+End', ['Z', ...kept]],
		['Shift+Home', ['Z', ...kept]],
		['Shift+Word+ArrowLeft', ['Z', ...kept]]
	] as const)
		test(`over a selected parent: ${chord}, then typing, leaves its children`, async ({ page }) => {
			const issues = trackPageIssues(page);
			await open(page, parent);
			await page.evaluate(() => {
				const edytor = (window as any).__EDYTOR__;
				edytor.selection.selectBlocks(edytor.idToBlock.get('P'));
			});
			await expect.poll(() => selectedBlocks(page)).toBe(1);
			const word = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? 'Alt' : 'Control';
			await page.keyboard.press(chord.replace('Word', word));
			await page.keyboard.type('Z');
			await expect.poll(() => depthFirst(page)).toEqual(expected);
			issues.assertClean();
		});

	for (const [chord, expected] of [
		['PageDown', ['before divider', '', 'after dividerZ']],
		['PageUp', ['Zbefore divider', '', 'after divider']]
	] as const)
		test(`over a lone selected divider: ${chord} goes to the document edge`, async ({ page }) => {
			const issues = trackPageIssues(page);
			await selectDivider(page);
			await page.keyboard.press(chord);
			await page.keyboard.type('Z');
			await expect
				.poll(async () => (await lines(page)).map((line) => line.split(':')[1]))
				.toEqual(expected);
			issues.assertClean();
		});
});
