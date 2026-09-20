import { expect, test, type Page } from './editorTest';

import {
	expectSelection,
	getPlaceholderLocators,
	getTextLocators,
	modKey,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

const replaceManagedTextNodeWithBrowserWrapper = async (
	page: Page,
	payload: {
		textIndex: number;
		value: string;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, value, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const replacement = document.createElement('span');
		replacement.dataset.testBrowserReplacement = 'true';
		replacement.textContent = value;
		text.replaceWith(replacement);

		const leaf = replacement.firstChild ?? replacement;
		const range = document.createRange();
		if (leaf.nodeType === Node.TEXT_NODE) {
			range.setStart(leaf, Math.min(caretOffset, leaf.textContent?.length ?? 0));
		} else {
			range.setStart(replacement, Math.min(caretOffset, replacement.childNodes.length));
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		replacement.parentElement?.focus();
	}, payload);
};

const insertBrowserWrapperInsideManagedText = async (
	page: Page,
	payload: {
		textIndex: number;
		value: string;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, value, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const wrapper = document.createElement('span');
		wrapper.dataset.testBrowserNestedWrapper = 'true';
		wrapper.textContent = value;
		text.append(wrapper);

		const leaf = wrapper.firstChild ?? wrapper;
		const range = document.createRange();
		if (leaf.nodeType === Node.TEXT_NODE) {
			range.setStart(leaf, Math.min(caretOffset, leaf.textContent?.length ?? 0));
		} else {
			range.setStart(wrapper, Math.min(caretOffset, wrapper.childNodes.length));
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
	}, payload);
};

const insertWebKitConvertedSpaceInsideManagedText = async (
	page: Page,
	payload: {
		textIndex: number;
	}
) => {
	await page.evaluate(({ textIndex }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const convertedSpace = document.createElement('span');
		convertedSpace.className = 'Apple-converted-space';
		convertedSpace.dataset.testConvertedSpace = 'true';
		convertedSpace.textContent = '\u00A0';
		text.append(convertedSpace);

		const leaf = convertedSpace.firstChild ?? convertedSpace;
		const range = document.createRange();
		if (leaf.nodeType === Node.TEXT_NODE) {
			range.setStart(leaf, leaf.textContent?.length ?? 0);
		} else {
			range.setStart(convertedSpace, convertedSpace.childNodes.length);
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
	}, payload);
};

const wrapManagedTextContentWithBrowserWrapper = async (
	page: Page,
	payload: {
		textIndex: number;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const wrapper = document.createElement('span');
		wrapper.dataset.testBrowserNoopWrapper = 'true';
		while (text.firstChild) {
			wrapper.append(text.firstChild);
		}
		text.append(wrapper);

		const leaf = wrapper.firstChild ?? wrapper;
		const range = document.createRange();
		if (leaf.nodeType === Node.TEXT_NODE) {
			range.setStart(leaf, Math.min(caretOffset, leaf.textContent?.length ?? 0));
		} else {
			range.setStart(wrapper, Math.min(caretOffset, wrapper.childNodes.length));
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
	}, payload);
};

const insertBrowserManagedMarkCloneInsideManagedText = async (
	page: Page,
	payload: {
		textIndex: number;
		value: string;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, value, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const mark = document.createElement('span');
		mark.dataset.edytorMark = 'bold';
		mark.dataset.testBrowserManagedMarkClone = 'true';
		const bold = document.createElement('b');
		bold.textContent = value;
		mark.append(bold);
		text.append(mark);

		const leaf = bold.firstChild ?? bold;
		const range = document.createRange();
		if (leaf.nodeType === Node.TEXT_NODE) {
			range.setStart(leaf, Math.min(caretOffset, leaf.textContent?.length ?? 0));
		} else {
			range.setStart(bold, Math.min(caretOffset, bold.childNodes.length));
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
	}, payload);
};

const flipLinkBoldDomNestingInsideManagedText = async (
	page: Page,
	payload: {
		textIndex: number;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const boldMark = text.querySelector<HTMLElement>('[data-edytor-mark="bold"]');
		const linkMark = text.querySelector<HTMLElement>('[data-edytor-mark="link"]');
		if (!linkMark || !boldMark) {
			throw new Error('Missing nested link/bold mark DOM');
		}

		const flippedLink = document.createElement('span');
		flippedLink.dataset.edytorMark = 'link';
		flippedLink.dataset.testBrowserFlippedLinkBold = 'true';
		const anchor = document.createElement('a');
		anchor.href = 'https://example.com/';
		anchor.target = '_blank';
		const flippedBold = document.createElement('span');
		flippedBold.dataset.edytorMark = 'bold';
		const bold = document.createElement('b');
		bold.textContent = 'Link';
		flippedBold.append(bold);
		anchor.append(flippedBold);
		flippedLink.append(anchor);
		boldMark.replaceWith(flippedLink);

		const leaf = bold.firstChild ?? bold;
		const range = document.createRange();
		if (leaf.nodeType === Node.TEXT_NODE) {
			range.setStart(leaf, Math.min(caretOffset, leaf.textContent?.length ?? 0));
		} else {
			range.setStart(bold, Math.min(caretOffset, bold.childNodes.length));
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
	}, payload);
};

const readFirstText = async (page: Page) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text: string }> }>;
	}>(page, 'value');
	return value.children[0]?.content?.[0]?.text;
};

const replaceManagedTextCharacterData = async (
	page: Page,
	payload: {
		textIndex: number;
		value: string;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, value, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const textNodes: Text[] = [];
		const collectTextNodes = (node: Node) => {
			for (const child of node.childNodes) {
				if (child.nodeType === Node.TEXT_NODE && child.textContent !== '\u200B') {
					textNodes.push(child as Text);
					continue;
				}
				collectTextNodes(child);
			}
		};
		collectTextNodes(text);

		const textNode = textNodes.find((node) => node.textContent && node.textContent.length > 0);
		if (!textNode) {
			throw new Error(`Missing text node in managed text at index ${textIndex}`);
		}

		textNode.data = value;
		const range = document.createRange();
		range.setStart(textNode, Math.min(caretOffset, textNode.data.length));
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
	}, payload);
};

const splitManagedTextDomTextNode = async (
	page: Page,
	payload: {
		textIndex: number;
		splitOffset: number;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, splitOffset, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const textNodes: Text[] = [];
		const collectTextNodes = (node: Node) => {
			for (const child of node.childNodes) {
				if (child.nodeType === Node.TEXT_NODE && child.textContent !== '\u200B') {
					textNodes.push(child as Text);
					continue;
				}
				collectTextNodes(child);
			}
		};
		collectTextNodes(text);

		const textNode = textNodes.find((node) => node.textContent && node.textContent.length > 0);
		if (!textNode) {
			throw new Error(`Missing text node in managed text at index ${textIndex}`);
		}

		const nextTextNode = textNode.splitText(Math.min(splitOffset, textNode.data.length));
		const range = document.createRange();
		range.setStart(nextTextNode, Math.min(caretOffset, nextTextNode.data.length));
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
		document.dispatchEvent(new Event('selectionchange'));
	}, payload);
};

const readFirstMarkTextNodeCount = async (page: Page) =>
	page
		.locator('[data-edytor-mark="bold"]')
		.first()
		.evaluate((mark) => {
			let count = 0;
			const walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT);
			let current = walker.nextNode();
			while (current) {
				if ((current.textContent ?? '').length > 0) {
					count += 1;
				}
				current = walker.nextNode();
			}
			return count;
		});

test.describe('browser DOM mutation reconciliation', () => {
	test('does not restore stale managed nodes during a Svelte-owned text remount', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page, { requireRuntime: true });

		await page.evaluate(() => {
			const edytor = (
				window as Window & {
					__EDYTOR__?: {
						root?: { children?: Array<{ firstText?: { refreshFromModel: () => void } }> };
					};
				}
			).__EDYTOR__;
			const text = edytor?.root?.children?.[0]?.firstText;
			if (!text) {
				throw new Error('Missing first text');
			}

			text.refreshFromModel();
		});

		await expect(getTextLocators(page)).toHaveCount(2);
		await expect
			.poll(() => page.locator('[data-edytor-type="paragraph"]').first().locator('p').textContent())
			.toBe('Alpha beta');

		issues.assertClean();
	});

	test('keeps live text mapping after mark remount and clear', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 0, 0, 5);
		await page.keyboard.press(`${modKey}+B`);

		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: { clear: () => void } }).__EDYTOR__;
			if (!edytor) {
				throw new Error('Missing test editor runtime');
			}
			edytor.clear();
		});

		const texts = getTextLocators(page);
		await expect(texts).toHaveCount(1);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('a');

		await expect(texts.first()).toContainText('a');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles characterData-only browser text mutations without an input event', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await replaceManagedTextCharacterData(page, {
			textIndex: 0,
			value: 'leads',
			caretOffset: 5
		});

		await expect.poll(() => readFirstText(page)).toBe('leads');
		await expect(getTextLocators(page).first()).toHaveText('leads');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('preserves marks during marked characterData-only browser text mutations', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 5);

		await replaceManagedTextCharacterData(page, {
			textIndex: 0,
			value: 'Alphas',
			caretOffset: 6
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{
							text: string;
							marks?: Record<string, unknown>;
						}>;
					}>;
				}>(page, 'value');

				return value.children[0]?.content?.map((part) => ({
					text: part.text,
					marks: part.marks ?? null
				}));
			})
			.toEqual([
				{ text: 'Alphas', marks: { bold: true } },
				{ text: ' beta', marks: null }
			]);

		await expect(page.locator('[data-edytor-mark="bold"]').first()).toHaveText('Alphas');
		await expect(getTextLocators(page).first()).toHaveText('Alphas beta');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('preserves deleted mark context after deletion-only characterData mutations', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 5);

		await replaceManagedTextCharacterData(page, {
			textIndex: 0,
			value: '',
			caretOffset: 0
		});

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await page.keyboard.type('Z');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{
							text: string;
							marks?: Record<string, unknown>;
						}>;
					}>;
				}>(page, 'value');

				return value.children[0]?.content?.map((part) => ({
					text: part.text,
					marks: part.marks ?? null
				}));
			})
			.toEqual([
				{ text: 'Z', marks: { bold: true } },
				{ text: ' beta', marks: null }
			]);

		await expect(page.locator('[data-edytor-mark="bold"]').first()).toHaveText('Z');
		await expect(getTextLocators(page).first()).toHaveText('Z beta');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs browser-created text-node splits inside marked DOM', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await splitManagedTextDomTextNode(page, {
			textIndex: 0,
			splitOffset: 2,
			caretOffset: 2
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{
							text: string;
							marks?: Record<string, unknown>;
						}>;
					}>;
				}>(page, 'value');

				return {
					content: value.children[0]?.content?.map((part) => ({
						text: part.text,
						marks: part.marks ?? null
					})),
					markTextNodeCount: await readFirstMarkTextNodeCount(page)
				};
			})
			.toEqual({
				content: [
					{ text: 'Alpha', marks: { bold: true } },
					{ text: ' beta', marks: null }
				],
				markTextNodeCount: 1
			});

		await expect(page.locator('[data-edytor-mark="bold"]').first()).toHaveText('Alpha');
		await expect(getTextLocators(page).first()).toHaveText('Alpha beta');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs browser-flipped nested link and bold mark DOM from the model', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=links');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 4);
		await page.keyboard.press(`${modKey}+B`);
		await setSelectionByTextIndex(page, 0, 4);

		await flipLinkBoldDomNestingInsideManagedText(page, {
			textIndex: 0,
			caretOffset: 4
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{
							text: string;
							marks?: Record<string, unknown>;
						}>;
					}>;
				}>(page, 'value');

				return {
					content: value.children[0]?.content?.map((part) => ({
						text: part.text,
						marks: part.marks ?? null
					})),
					flippedDomCount: await page.locator('[data-test-browser-flipped-link-bold]').count(),
					canonicalLinkText: await page.locator('[data-edytor-mark="link"] a').textContent(),
					boldMarkCount: await page.locator('[data-edytor-mark="bold"]').count(),
					linkMarkCount: await page.locator('[data-edytor-mark="link"]').count()
				};
			})
			.toEqual({
				content: [
					{
						text: 'Link',
						marks: {
							link: { href: 'https://example.com', target: '_blank' },
							bold: true
						}
					},
					{ text: ' tail', marks: null }
				],
				flippedDomCount: 0,
				canonicalLinkText: 'Link',
				boldMarkCount: 1,
				linkMarkCount: 1
			});
		await expect(page.locator('[data-edytor-mark="bold"] [data-edytor-mark="link"] a')).toHaveText(
			'Link'
		);
		await expect(getTextLocators(page).first()).toHaveText('Link tail');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles text when the browser replaces a managed text wrapper', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await replaceManagedTextNodeWithBrowserWrapper(page, {
			textIndex: 0,
			value: 'lead!',
			caretOffset: 5
		});

		await expect.poll(() => readFirstText(page)).toBe('lead!');
		await expect(page.locator('[data-test-browser-replacement]')).toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles text when the browser inserts an unmanaged wrapper inside managed text', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await insertBrowserWrapperInsideManagedText(page, {
			textIndex: 0,
			value: '!',
			caretOffset: 1
		});

		await expect.poll(() => readFirstText(page)).toBe('lead!');
		await expect(page.locator('[data-test-browser-nested-wrapper]')).toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('normalizes WebKit converted-space wrappers to logical spaces', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await insertWebKitConvertedSpaceInsideManagedText(page, {
			textIndex: 0
		});

		await expect.poll(() => readFirstText(page)).toBe('lead ');
		await expect(page.locator('[data-test-converted-space]')).toHaveCount(0);
		await expect(getTextLocators(page).first()).toHaveText('lead ');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('remounts stale browser-cloned managed mark DOM from the model', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await insertBrowserManagedMarkCloneInsideManagedText(page, {
			textIndex: 0,
			value: 'lead',
			caretOffset: 4
		});

		await expect.poll(() => readFirstText(page)).toBe('lead');
		await expect(page.locator('[data-test-browser-managed-mark-clone]')).toHaveCount(0);
		await expect(getTextLocators(page).first()).toHaveText('lead');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('removes browser wrappers that do not change managed text content', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await wrapManagedTextContentWithBrowserWrapper(page, {
			textIndex: 0,
			caretOffset: 4
		});

		await expect.poll(() => readFirstText(page)).toBe('lead');
		await expect(page.locator('[data-test-browser-noop-wrapper]')).toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});
});
