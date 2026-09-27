import { expect, test, type Page } from './editorTest';

import {
	dispatchComposition,
	expectSelection,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/**
 * G2/G10 — composition node lock: while a composition is live, model/remote
 * changes must not unmount or clobber the DOM node the IME owns, and the
 * composition region must be reconciled by anchor so the final commit lands
 * where the user actually composed.
 */

type EdytorWindow = Window & { __EDYTOR__?: any };

/** Block id of `root.children[index]` (paragraph under the root). */
const getBlockId = (page: Page, childIndex: number) =>
	page.evaluate((index) => {
		const edytor = (window as EdytorWindow).__EDYTOR__;
		const block = edytor?.root?.children?.[index];
		return block?.id ?? block?._blockId ?? null;
	}, childIndex);

/** Programmatic "remote" write — no `edytor.transaction` origin → mirror treats it as remote. */
const remoteInsertText = (page: Page, blockId: string, offset: number, text: string) =>
	page.evaluate(
		({ id, at, value }) => {
			const edytor = (window as EdytorWindow).__EDYTOR__;
			if (!edytor?.facade) throw new Error('Missing edytor facade');
			return edytor.facade.insertText(id, at, value);
		},
		{ id: blockId, at: offset, value: text }
	);

const remoteFormatRange = (
	page: Page,
	blockId: string,
	offset: number,
	length: number,
	marks: Record<string, unknown>
) =>
	page.evaluate(
		({ id, at, length: len, attributes }) => {
			const edytor = (window as EdytorWindow).__EDYTOR__;
			if (!edytor?.facade) throw new Error('Missing edytor facade');
			return edytor.facade.formatRange(id, at, len, attributes);
		},
		{ id: blockId, at: offset, length, attributes: marks }
	);

/** Pin the DOM node(s) the composition is hosted in so identity can be asserted later. */
const stashCompositionDom = (page: Page, textIndex: number) =>
	page.evaluate((index) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const host = texts[index];
		if (!host) throw new Error(`Missing text element at index ${index}`);
		const win = window as unknown as Record<string, unknown>;
		win.__compHost = host;
		win.__compChildNodes = Array.from(host.childNodes);
		win.__compParent = host.parentElement;
	}, textIndex);

/**
 * True while the stashed host element is still mounted AND still owns the
 * exact child nodes it had when stashed (no span remount, no inner-text
 * clobber by a keyed re-render).
 */
const compositionDomIntact = (page: Page) =>
	page.evaluate(() => {
		const win = window as unknown as Record<string, any>;
		const host = win.__compHost as HTMLElement | undefined;
		const children = (win.__compChildNodes as Node[] | undefined) ?? [];
		const parent = win.__compParent as HTMLElement | undefined;
		if (!host || !parent) return false;
		if (!host.isConnected || !parent.isConnected) return false;
		if (host.parentElement !== parent) return false;
		return children.every((node) => node.parentNode === host);
	});

type SerializedValue = {
	children: Array<{ content?: Array<{ text: string; marks?: Record<string, unknown> }> }>;
};

const readBlockText = async (page: Page, childIndex: number) => {
	const value = await readJsonByTestId<SerializedValue>(page, 'value');
	return value.children[childIndex]?.content?.map((part) => part.text).join('') ?? '';
};

const readBlockContent = async (page: Page, childIndex: number) => {
	const value = await readJsonByTestId<SerializedValue>(page, 'value');
	return value.children[childIndex]?.content ?? [];
};

test.describe('composition node lock against remote/model edits', () => {
	test('remote edit in a different block does not touch the composition node', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page);

		// Compose at the end of "note" (block 1, text index 1).
		await setSelectionByTextIndex(page, 1, 4);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' }
		]);
		await stashCompositionDom(page, 1);

		const otherBlockId = await getBlockId(page, 2);
		await remoteInsertText(page, otherBlockId, 0, 'REMOTE');
		await page.waitForTimeout(30);

		await expect.poll(() => compositionDomIntact(page)).toBe(true);
		// Preview still visible, unclobbered.
		expect(await readBlockText(page, 1)).toBe('noten');

		await dispatchComposition(page, [{ type: 'compositionend', data: 'に' }]);

		await expect.poll(() => readBlockText(page, 1)).toBe('noteに');
		await expect.poll(() => readBlockText(page, 2)).toBe('REMOTEtail');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 'noteに'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('remote edit in a sibling text segment does not clobber the composition node', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=nestedInline');
		await waitForEditorReady(page);

		// Content of block 0: [bold "hello", mention, bold "World", mention, bold "Prout"]
		// → text elements 0:"hello" 1:"World" 2:"Prout" (3: nested "One").
		// Compose at the end of "Prout" (segment 2).
		await setSelectionByTextIndex(page, 2, 5);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' }
		]);
		await stashCompositionDom(page, 2);

		const blockId = await getBlockId(page, 0);
		// Remote insert inside the FIRST segment ("hello") — same block, different segment.
		await remoteInsertText(page, blockId, 0, 'R');
		await page.waitForTimeout(30);

		await expect.poll(() => compositionDomIntact(page)).toBe(true);
		expect(await readBlockText(page, 0)).toBe('RhelloWorldProutn');

		await dispatchComposition(page, [{ type: 'compositionend', data: 'に' }]);

		await expect.poll(() => readBlockText(page, 0)).toBe('RhelloWorldProutに');

		issues.assertClean();
	});

	test('remote insert before the composition inside the same text shifts the commit anchor', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page);

		await setSelectionByTextIndex(page, 1, 4);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' }
		]);
		await stashCompositionDom(page, 1);

		const blockId = await getBlockId(page, 1);
		// Remote insert at offset 0 — BEFORE the composition region (at 4→5 in model space).
		await remoteInsertText(page, blockId, 0, 'R');
		await page.waitForTimeout(30);

		// The DOM the IME owns must not be rewritten — it still shows the
		// pre-remote base plus the live preview.
		await expect.poll(() => compositionDomIntact(page)).toBe(true);
		expect(
			await page.evaluate(() => {
				const host = (window as unknown as Record<string, any>).__compHost as HTMLElement;
				return host.textContent;
			})
		).toBe('noten');

		// A second preview keystroke must still land after the composition
		// anchor (which moved right by one in model space).
		await dispatchComposition(page, [
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'ni' }
		]);
		expect(await readBlockText(page, 1)).toBe('Rnoteni');

		await dispatchComposition(page, [{ type: 'compositionend', data: 'に' }]);

		await expect.poll(() => readBlockText(page, 1)).toBe('Rnoteに');

		issues.assertClean();
	});

	test('remote insert after the composition inside the same text keeps the preview region', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page);

		await setSelectionByTextIndex(page, 1, 4);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' }
		]);
		await stashCompositionDom(page, 1);

		const blockId = await getBlockId(page, 1);
		// Remote insert at the very end — AFTER the composition region.
		await remoteInsertText(page, blockId, 5, 'R');
		await page.waitForTimeout(30);

		await expect.poll(() => compositionDomIntact(page)).toBe(true);

		await dispatchComposition(page, [{ type: 'compositionend', data: 'に' }]);

		await expect.poll(() => readBlockText(page, 1)).toBe('noteにR');

		issues.assertClean();
	});

	test('remote format on the composing text does not remount or re-render the host', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page);

		await setSelectionByTextIndex(page, 1, 4);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' }
		]);
		await stashCompositionDom(page, 1);

		const blockId = await getBlockId(page, 1);
		// Bold the first two chars remotely — splits the segment's render deltas.
		await remoteFormatRange(page, blockId, 0, 2, { bold: true });
		await page.waitForTimeout(30);

		await expect.poll(() => compositionDomIntact(page)).toBe(true);

		await dispatchComposition(page, [{ type: 'compositionend', data: 'に' }]);

		await expect
			.poll(() => readBlockContent(page, 1))
			.toEqual([{ text: 'no', marks: { bold: true } }, { text: 'teに' }]);

		issues.assertClean();
	});

	test('local format during composition does not orphan the composition or double-insert', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page);

		await setSelectionByTextIndex(page, 1, 4);
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' }
		]);
		await stashCompositionDom(page, 1);

		// Local formatting op on the host mid-composition (e.g. a hotkey or
		// plugin call): `markText` → `refreshFromModel` bumps `domVersion`,
		// which is part of the content each-key — the naive path remounts the
		// span out from under the IME.
		await page.evaluate(() => {
			const edytor = (window as EdytorWindow).__EDYTOR__;
			const text = edytor?.root?.children?.[1]?.content?.[0];
			text?.markText({ mark: 'bold', start: 0, end: 2 });
		});
		await page.waitForTimeout(30);

		await expect.poll(() => compositionDomIntact(page)).toBe(true);

		// Browser still considers the composition live and commits via
		// insertFromComposition — the preview already lives in the model, so
		// the final data must REPLACE the region, not append to it.
		await dispatchComposition(page, [
			{ type: 'beforeinput', inputType: 'insertFromComposition', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect
			.poll(() => readBlockContent(page, 1))
			.toEqual([{ text: 'no', marks: { bold: true } }, { text: 'teに' }]);
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 'noteに'.length,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('remote insert before composition during the compositionstart window anchors the commit', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page);

		await setSelectionByTextIndex(page, 1, 4);
		await dispatchComposition(page, [{ type: 'compositionstart', data: '' }]);
		await stashCompositionDom(page, 1);

		const blockId = await getBlockId(page, 1);
		// Remote edit lands BEFORE the first composition beforeinput —
		// the session has not written yet, but the DOM must stay locked.
		await remoteInsertText(page, blockId, 0, 'R');
		await page.waitForTimeout(30);

		await expect.poll(() => compositionDomIntact(page)).toBe(true);
		expect(
			await page.evaluate(() => {
				const host = (window as unknown as Record<string, any>).__compHost as HTMLElement;
				return host.textContent;
			})
		).toBe('note');

		await dispatchComposition(page, [
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'n' },
			{ type: 'compositionend', data: 'に' }
		]);

		await expect.poll(() => readBlockText(page, 1)).toBe('Rnoteに');

		issues.assertClean();
	});
});
