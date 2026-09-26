import { expect, test, type Page } from './editorTest';

import {
	dispatchComposition,
	getBlockLocators,
	getPlaceholderLocators,
	getTextLocators,
	gotoEditorRoute,
	modKey,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/**
 * U6 — bounded placeholder repair, proven in a real browser.
 *
 * Old behavior: every facade commit ran `removeStalePlaceholdersIn(node)`
 * plus a 7-phase scheduled sweep — ~8 FULL-editor `querySelectorAll` sweeps
 * per commit, uncancellable and uncoalesced. The rewrite scopes repair to
 * the DOM roots the committed `DocChange` touched, coalesces a burst into
 * ONE repair window (immediate → microtask → rAF → 50/250/1000ms retries),
 * and `release()` on destroy makes every pending pass a no-op.
 *
 * `__EDYTOR__.placeholderRepair.stats` (`windows`/`passes`/`rootsScanned`/
 * `removed`) plus a `querySelectorAll` call counter make the boundedness
 * directly observable.
 */

type RepairStats = { windows: number; passes: number; rootsScanned: number; removed: number };

const readRepairStats = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		if (!edytor?.placeholderRepair) {
			throw new Error('Missing editor runtime or placeholderRepair queue');
		}
		return { ...edytor.placeholderRepair.stats, size: edytor.placeholderRepair.size };
	});

const readBlockTexts = async (page: Page) =>
	(
		await readJsonByTestId<{ children: Array<{ content?: Array<{ text?: string }> }> }>(
			page,
			'value'
		)
	).children.map((block) => (block.content ?? []).map((part) => part.text ?? '').join(''));

/**
 * Count `querySelectorAll` calls for the placeholder selector, split by
 * whether the receiver is the `[data-edytor]` root (the old full-editor
 * sweep) or a deeper scoped root (the new contract).
 */
const installPlaceholderScanCounter = async (page: Page) => {
	await page.addInitScript(() => {
		const counts = { root: 0, scoped: 0, total: 0 };
		(window as Window & { __PH_QSA__?: typeof counts }).__PH_QSA__ = counts;
		const original = Element.prototype.querySelectorAll;
		Element.prototype.querySelectorAll = function (
			this: Element,
			selector: string
		): NodeListOf<Element> {
			if (typeof selector === 'string' && selector.includes('data-edytor-text-placeholder')) {
				counts.total++;
				if (this.hasAttribute('data-edytor')) {
					counts.root++;
				} else {
					counts.scoped++;
				}
			}
			return original.call(this, selector);
		};
	});
};

const readPlaceholderScanCounts = (page: Page) =>
	page.evaluate(() => {
		const counts = (
			window as Window & {
				__PH_QSA__?: { root: number; scoped: number; total: number };
			}
		).__PH_QSA__;
		if (!counts) {
			throw new Error('Missing placeholder scan counter — installPlaceholderScanCounter?');
		}
		return { ...counts };
	});

test.describe('bounded placeholder repair (U6)', () => {
	test('empty → type → placeholder gone; delete-all → placeholder returns', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=first&placeholder=Start%20writing');

		await expect(getPlaceholderLocators(page)).toHaveCount(1);

		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('A');
		await expect(getPlaceholderLocators(page)).toHaveCount(0);
		await expect.poll(() => readBlockTexts(page)).toEqual(['A', 'note', 'tail']);

		await page.keyboard.press('Backspace');
		await expect(getPlaceholderLocators(page)).toHaveCount(1);
		await expect.poll(() => readBlockTexts(page)).toEqual(['', 'note', 'tail']);

		issues.assertClean();
	});

	test('deleting all marked text in a block restores its placeholder', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=marks&placeholder=Start%20writing');

		await expect(getPlaceholderLocators(page)).toHaveCount(0);

		// Block 0 holds 'Alpha' (bold) + ' beta' (plain) — delete ALL marked
		// text through the facade commit path; the emptied block must regain
		// exactly one placeholder.
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
		await expect(getPlaceholderLocators(page)).toHaveCount(1);
		await expect
			.poll(() =>
				page.evaluate(() => {
					const block = document.querySelectorAll('[data-edytor-block="true"]')[0];
					return block?.querySelectorAll('[data-edytor-text-placeholder]').length ?? -1;
				})
			)
			.toBe(1);

		issues.assertClean();
	});

	test('enter split then undo — placeholder follows the emptied half only', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=first&placeholder=Start%20writing');
		await expect(getPlaceholderLocators(page)).toHaveCount(1);

		// Split at offset 0 of 'note': the new first half is empty → its own
		// placeholder, the second half keeps 'note' → none.
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Enter');

		await expect(getPlaceholderLocators(page)).toHaveCount(2);
		await expect.poll(() => readBlockTexts(page)).toEqual(['', '', 'note', 'tail']);

		await page.keyboard.press(`${modKey}+z`);
		await expect(getPlaceholderLocators(page)).toHaveCount(1);
		await expect.poll(() => readBlockTexts(page)).toEqual(['', 'note', 'tail']);
		await expect(getBlockLocators(page)).toHaveCount(3);

		issues.assertClean();
	});

	test('composition cancel keeps the placeholder; committed IME text removes it', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=first&placeholder=Start%20writing');
		await expect(getPlaceholderLocators(page)).toHaveCount(1);

		await setSelectionByTextIndex(page, 0, 0);
		// Cancelled composition (start + end, no insertion) — placeholder stays.
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'compositionend', data: '' }
		]);
		await expect(getPlaceholderLocators(page)).toHaveCount(1);

		// Committed composition text — placeholder goes.
		await dispatchComposition(page, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'é' },
			{ type: 'compositionend', data: 'é' }
		]);
		await expect(getPlaceholderLocators(page)).toHaveCount(0);
		await expect.poll(() => readBlockTexts(page)).toEqual(['é', 'note', 'tail']);

		issues.assertClean();
	});

	test('inline atoms — no stray placeholders beside mention separators', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=inline&placeholder=Start%20writing');

		// Block 0: '' + mention + 'tail'; block 1: 'lead ' + mention + ' end'.
		// Both have visible text — no placeholder anywhere.
		await expect(getPlaceholderLocators(page)).toHaveCount(0);

		// Delete 'tail' → block 0 holds only the mention between empty text
		// segments (3 content parts → `shouldShowPlaceholder` correctly stays
		// off: a placeholder only mounts on a sole-empty-text block). The pin
		// is that repair never leaves stray or duplicate placeholders beside
		// the atom separators.
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const block = edytor.root.children[0];
			const tail = block.content.at(-1);
			edytor.doc.transact(() => {
				tail.deleteAt(0, tail.length);
			}, 'u6-inline-delete');
		});

		await expect
			.poll(() =>
				page.evaluate(() => {
					const block = document.querySelectorAll('[data-edytor-block="true"]')[0];
					return block?.querySelectorAll('[data-edytor-text-placeholder]').length ?? -1;
				})
			)
			.toBeLessThanOrEqual(1);
		await expect(getPlaceholderLocators(page)).toHaveCount(0);

		issues.assertClean();
	});

	test('programmatic update while blurred sweeps the placeholder', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=first&placeholder=Start%20writing');
		await expect(getPlaceholderLocators(page)).toHaveCount(1);

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

		await expect(getPlaceholderLocators(page)).toHaveCount(0);
		await expect.poll(() => readBlockTexts(page)).toEqual(['!', 'note', 'tail']);

		issues.assertClean();
	});

	test('remote edit over the real provider repairs the receiving view', async ({ context }) => {
		const pageA = await context.newPage();
		const pageB = await context.newPage();
		const issuesA = trackPageIssues(pageA);
		const issuesB = trackPageIssues(pageB);
		const room = `u6-ph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

		await expect(getPlaceholderLocators(pageA)).toHaveCount(0);

		// B empties block 'collab-b1' remotely — A's copy must gain its
		// placeholder from the remote change's scoped repair.
		await pageB.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const block = edytor.root.children[0];
			edytor.facade.deleteText(block.id, 0, block.firstText.length);
		});
		await expect(getPlaceholderLocators(pageA)).toHaveCount(1);
		await expect.poll(() => readBlockTexts(pageA)).toEqual(['', 'beta', 'gamma']);

		// B types back in — A's placeholder goes away again.
		await pageB.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.facade.insertText(edytor.root.children[0].id, 0, 'z');
		});
		await expect(getPlaceholderLocators(pageA)).toHaveCount(0);
		await expect.poll(() => readBlockTexts(pageA)).toEqual(['z', 'beta', 'gamma']);

		issuesA.assertClean();
		issuesB.assertClean();
	});

	test('keyed remount keeps repair live; release() freezes all pending passes', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=first&placeholder=Start%20writing');
		await expect(getPlaceholderLocators(page)).toHaveCount(1);

		// Tag the pre-remount block node — a keyed remount detaches it.
		await page.evaluate(() => {
			document
				.querySelector('[data-edytor-block="true"]')
				?.setAttribute('data-u6-preremount', 'true');
		});

		// {#key editorDomRevision} remount — old nodes detach, keyed resolvers
		// retarget the fresh nodes instead of scanning dead ones.
		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.refreshEditorDom();
		});
		await expect(getPlaceholderLocators(page)).toHaveCount(1);
		await expect(page.locator('[data-u6-preremount]')).toHaveCount(0);
		await expect(getBlockLocators(page)).toHaveCount(3);

		// The queue still repairs after remount: typing into the empty block
		// removes its placeholder.
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('R');
		await expect(getPlaceholderLocators(page)).toHaveCount(0);
		await expect.poll(() => readBlockTexts(page)).toEqual(['R', 'note', 'tail']);

		// Everything drains — no pending roots after the longest retry.
		await expect.poll(() => readRepairStats(page), { timeout: 3000 }).toMatchObject({ size: 0 });

		// release() (what destroy() calls) makes every pending phase a no-op:
		// freezes passes/rootsScanned even while edits keep committing.
		const frozen = await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.placeholderRepair.release();
			return { ...edytor.placeholderRepair.stats };
		});
		await page.keyboard.type('z');
		await page.waitForTimeout(1200);
		const after = await readRepairStats(page);
		expect(after.passes).toBe(frozen.passes);
		expect(after.rootsScanned).toBe(frozen.rootsScanned);
		expect(after.size).toBe(0);

		issues.assertClean();
	});

	test('60-keystroke burst — one bounded window, scoped scans only, drains idle', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await installPlaceholderScanCounter(page);
		await gotoEditorRoute(page, '/test/dom?scenario=basic&empty=first&placeholder=Start%20writing');

		await setSelectionByTextIndex(page, 1, 'note'.length);
		const before = await readPlaceholderScanCounts(page);

		await page.keyboard.type('x'.repeat(60));
		await expect.poll(() => readBlockTexts(page)).toEqual(['', `note${'x'.repeat(60)}`, 'tail']);

		const stats = await readRepairStats(page);
		const scans = await readPlaceholderScanCounts(page);
		const burstTotal = scans.total - before.total;

		console.log('U6 burst counters:', JSON.stringify({ stats, scans, burstTotal, commits: 60 }));

		// Old code: ~8 FULL-editor sweeps per commit ≈ 480 root-scoped qSA
		// calls for 60 commits. Coalesced: every root sweep rides the bounded
		// repair queue — domTextMutationObserver's per-flush safety net calls
		// `placeholderRepair.add(root)` instead of scanning synchronously, so
		// flush granularity (engine-dependent: ~1/keystroke on Firefox vs
		// ~6 keys/flush on Chromium) no longer multiplies root sweeps.
		// The invariant: every root scan happens inside a counted queue pass.
		expect(scans.root).toBeLessThanOrEqual(Math.max(1, stats.passes));
		expect(stats.windows).toBeLessThanOrEqual(4);
		expect(stats.passes).toBeLessThanOrEqual(30);
		expect(stats.rootsScanned).toBeLessThanOrEqual(120);
		expect(burstTotal).toBeLessThan(300);

		// Nothing stays pending past the last deferred retry.
		await page.waitForTimeout(1200);
		const drained = await readRepairStats(page);
		expect(drained.size).toBe(0);

		issues.assertClean();
	});
});
