import {
	armSpy,
	expectConverged,
	installSpy,
	openIme,
	openImePeerPair,
	peerInsertText,
	pinComposingNode,
	readBlockContent,
	readBlockText,
	readBlockTexts,
	readDomSelection,
	readDomText,
	readPinnedNode,
	readSpy,
	samePinnedNode,
	type Ime,
	type ImePeerPair
} from './cdp';
import { expect, test, type Page } from './editorTest';
import {
	expectSelection,
	getPlaceholderLocators,
	modKey,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/**
 * cdp lane baseline (architecture v2 plan §8 "Lanes", §9.3 G0, BI-10).
 *
 * Characterization of the core IME scenarios the plan later gates, driven
 * through Chromium's real IME path (`Input.imeSetComposition` /
 * `Input.insertText`) with a second browser context as the peer. Expected
 * values come from the contracts — the plan's §1.3 IME rows and §8 rows
 * (F-I6, F-I8, F-I15, F-I16, F-S12, F-O2), the `composition.spec` /
 * `composition-remote-lock.spec` / `composition-cancellation.spec`
 * assertions, and `docs/editor-delete-contract.md` — never from running the
 * code.
 *
 * Each scenario is driven once per test by a `drive*` function and checked
 * twice:
 * - `outcome` — what the user is left with after the session (model, DOM,
 *   caret, replicas). A regression guard.
 * - `session` — what the plan's rows claim about the live session (the IME
 *   node survives, the preview renders once at the caret, the composition is
 *   not restarted, no DOM-selection write while it lives) or about undo.
 *   Rows today's code fails are `test.fail` with the row id and the gating
 *   checkpoint, so the checkpoint that fixes them flips them. I3 flipped
 *   F-I6, F-I16 (a, b, d), F-I17 and the F-S12 session contracts: the
 *   session writes no DOM selection while it lives and keeps the host's
 *   render frozen while the browser shows the preview. I4 flipped F-I15:
 *   the empty block's filler and its text share one node (BI-15).
 *
 * Updates are sent at a human IME pace (`KEY_PACE_MS`) — back-to-back CDP
 * calls finish before any deferred editor write and hide it (the smoke
 * tests in `ime-mobile-smoke.cdp.spec.ts` keep that zero-gap shape).
 */

/**
 * Mark a scenario today's code fails, with its §8 row and gating checkpoint.
 * `CDP_SHOW_RED=1` runs it as a normal test to print the failures.
 */
const knownRed = (row: string) =>
	test.fail(!process.env.CDP_SHOW_RED, `${row}: red today — see ledger "Infra: cdp lane"`);

/** Delay between two IME updates: a fast human typist on a real IME. */
const KEY_PACE_MS = 100;
/** Longer than the engine's 500 ms undo capture window (and the 750 ms idle cancel I3 deleted). */
const IME_GAP_MS = 1000;

type PinnedAfter = Awaited<ReturnType<typeof readPinnedNode>>;

type SessionObservation = {
	/** DOM text of the host while the session is live, after the last update. */
	liveDom: string | null;
	/** The IME's node, read while live and after the commit. */
	liveNode: PinnedAfter;
	nodeAfterCommit: PinnedAfter;
	/** The node the first update wrote into is the node that existed before it. */
	previewInExistingNode: boolean;
	/** Selection mutators called while the session lived. */
	selectionWrites: string[];
	compositionStarts: number;
	compositionEnds: number;
	allTrusted: boolean;
};

/**
 * Compose `steps` at the current caret of text element `textIndex` at
 * `KEY_PACE_MS`, run `during` after the first update, then commit `commit`. Observations are read from the page, never asserted here.
 */
const composeObserved = async (
	page: Page,
	ime: Ime,
	options: {
		textIndex: number;
		steps: string[];
		commit: string;
		committedHostText: string;
		during?: () => Promise<void>;
	}
): Promise<SessionObservation> => {
	await installSpy(page);
	await pinComposingNode(page, 'before', options.textIndex);
	await armSpy(page);
	const [first, ...rest] = options.steps;
	await ime.compose(first);
	await page.waitForTimeout(KEY_PACE_MS);
	await pinComposingNode(page, 'preview');
	// Runs while the session is live, before the next update — which must
	// extend the same composition (F-S12).
	await options.during?.();
	for (const step of rest) {
		await ime.compose(step);
		await page.waitForTimeout(KEY_PACE_MS);
	}
	// The empty filler shares the IME's node (BI-15): it is not content.
	const liveDom = (await readDomText(page, options.textIndex))?.replace(/\u200B/g, '') ?? null;
	const liveNode = await readPinnedNode(page, 'preview', options.steps[options.steps.length - 1]);
	const live = await readSpy(page);
	const previewInExistingNode = await samePinnedNode(page, 'before', 'preview');
	await ime.commit(options.commit);
	await expect.poll(() => readDomText(page, options.textIndex)).toBe(options.committedHostText);
	const done = await readSpy(page);
	return {
		liveDom,
		liveNode,
		nodeAfterCommit: await readPinnedNode(page, 'preview', options.commit),
		previewInExistingNode,
		selectionWrites: live.selectionWrites,
		compositionStarts: done.compositionStarts,
		compositionEnds: done.compositionEnds,
		allTrusted: done.allTrusted
	};
};

/**
 * The session contract every live composition owes (plan §1.3 "The IME's
 * node is not re-rendered by our renders; the commit replaces exactly the
 * preview, once", F-S12 / BI-2 "no DOM-selection write while the session
 * lives; the next imeSetComposition extends the same composition").
 */
/**
 * F-S12's display half (BI-2, V4): the projector never writes the DOM
 * selection while a composition session owns a host — the session's end
 * catches up. Green since V4, in every scenario.
 */
const expectNoSelectionWrite = (observed: SessionObservation) =>
	expect(observed.selectionWrites, 'no DOM-selection write while the session lives').toEqual([]);

const expectSessionContract = (observed: SessionObservation, liveDom: string) => {
	expect.soft(observed.liveDom, 'the preview renders once, at the caret').toBe(liveDom);
	expect
		.soft(observed.selectionWrites, 'no DOM-selection write while the session lives')
		.toEqual([]);
	expect.soft(observed.compositionStarts, 'one composition, never restarted').toBe(1);
	expect.soft(observed.compositionEnds, 'one commit').toBe(1);
	expect
		.soft(observed.previewInExistingNode, 'the IME writes into the existing text node')
		.toBe(true);
	expect.soft(observed.liveNode, 'the IME node survives the live session').toMatchObject({
		connected: true,
		hostIntact: true,
		holdsText: true
	});
	expect.soft(observed.nodeAfterCommit, 'the IME node shows the committed text').toMatchObject({
		connected: true,
		hostIntact: true,
		holdsText: true
	});
};

// ---------------------------------------------------------------------------
// Single editor
// ---------------------------------------------------------------------------

const driveMidWord = async (page: Page) => {
	await page.goto('/test/dom?scenario=basic');
	await waitForEditorReady(page, { requireRuntime: true });
	await setSelectionByTextIndex(page, 1, 2); // no|te
	const ime = await openIme(page);
	const observed = await composeObserved(page, ime, {
		textIndex: 1,
		steps: ['ｋ', 'か'],
		commit: 'か',
		committedHostText: 'noかte'
	});
	await ime.detach();
	return observed;
};

const driveEmptyBlock = async (page: Page) => {
	await page.goto('/test/dom?scenario=basic&empty=first&placeholder=Start%20writing');
	await waitForEditorReady(page, { requireRuntime: true });
	await setSelectionByTextIndex(page, 0, 0);
	await expect(getPlaceholderLocators(page)).toHaveCount(1);
	const placeholders: number[] = [];
	const ime = await openIme(page);
	const observed = await composeObserved(page, ime, {
		textIndex: 0,
		steps: ['ｓ', 'す'],
		commit: 'す',
		committedHostText: 'す',
		during: async () => {
			placeholders.push(await getPlaceholderLocators(page).count());
		}
	});
	await ime.detach();
	return { observed, placeholdersDuring: placeholders };
};

const driveBold = async (page: Page) => {
	await page.goto('/test/dom?scenario=marks');
	await waitForEditorReady(page, { requireRuntime: true });
	await setSelectionByTextIndex(page, 0, 2); // Al|pha (bold) + " beta"
	const ime = await openIme(page);
	const observed = await composeObserved(page, ime, {
		textIndex: 0,
		steps: ['^', 'ê'],
		commit: 'ê',
		committedHostText: 'Alêpha beta'
	});
	await ime.detach();
	return observed;
};

test.describe('cdp IME baseline — single editor', () => {
	test('mid-word: outcome — the commit lands in place with the caret after it', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const observed = await driveMidWord(page);
		expect(observed.allTrusted).toBe(true);
		await expect.poll(() => readBlockText(page, 1)).toBe('noかte');
		await expect.poll(() => readDomText(page, 1)).toBe('noかte');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});
		expect(await readDomSelection(page)).toMatchObject({
			focusTextIndex: 1,
			focusOffset: 3,
			isCollapsed: true
		});
		issues.assertClean();
	});

	test('mid-word: no DOM-selection write while the session lives (F-S12, BI-2)', async ({
		page
	}) => {
		expectNoSelectionWrite(await driveMidWord(page));
	});

	test('mid-word: session contract (F-S12, §1.3 IME node)', async ({ page }) => {
		const observed = await driveMidWord(page);
		expectSessionContract(observed, 'noかte');
	});

	test('cancel: outcome — a canceled preview commits nothing', async ({ page }) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page, { requireRuntime: true });
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('a');
		await expect.poll(() => readBlockText(page, 0)).toBe('a');

		const ime = await openIme(page);
		await ime.compose('に');
		await page.waitForTimeout(KEY_PACE_MS);
		await ime.cancel();
		await ime.detach();

		// composition-cancellation.spec:63 / the ported CDP cancel smoke.
		await expect.poll(() => readBlockText(page, 0)).toBe('a');
		await expect.poll(() => readDomText(page, 0)).toBe('a');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});
		issues.assertClean();
	});

	test('cancel after 1 s, then undo: the previous step is undone, no preview resurrects (F-I16d)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=basic&empty=first');
		await waitForEditorReady(page, { requireRuntime: true });
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('a');
		await expect.poll(() => readBlockText(page, 0)).toBe('a');
		await page.waitForTimeout(650);

		const ime = await openIme(page);
		await ime.compose('に');
		await page.waitForTimeout(IME_GAP_MS);
		await ime.cancel();
		await ime.detach();
		await expect.poll(() => readBlockText(page, 0)).toBe('a');

		// composition-cancellation.spec:360 — undo/redo walk the typed step only.
		await page.keyboard.press(`${modKey}+Z`);
		await expect.poll(() => readBlockText(page, 0)).toBe('');
		// The empty text's filler is the renderer's, not text.
		await expect.poll(async () => (await readDomText(page, 0))?.replace(/\u200B/g, '')).toBe('');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});
		await page.keyboard.press(`${modKey}+Shift+Z`);
		await expect.poll(() => readBlockText(page, 0)).toBe('a');
		await expect.poll(() => readDomText(page, 0)).toBe('a');
		issues.assertClean();
	});

	test('empty block: outcome — placeholder hidden while composing, commit lands in the block', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const { placeholdersDuring, observed } = await driveEmptyBlock(page);
		expect(observed.allTrusted).toBe(true);
		// composition.spec:288 — no placeholder while the IME composes.
		expect(placeholdersDuring).toEqual([0]);
		await expect(getPlaceholderLocators(page)).toHaveCount(0);
		expect(await readBlockTexts(page)).toEqual(['す', 'note', 'tail']);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});
		issues.assertClean();
	});

	test('empty block: session contract — the host text node is kept (F-I15, BI-15)', async ({
		page
	}) => {
		const { observed } = await driveEmptyBlock(page);
		expectSessionContract(observed, 'す');
	});

	test('empty block: no DOM-selection write while the session lives (F-S12, BI-2)', async ({
		page
	}) => {
		expectNoSelectionWrite((await driveEmptyBlock(page)).observed);
	});

	test('undo right after an IME commit removes exactly the composed text (F-I16a, §1.3 COMP-02)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 1, 4); // note|

		const ime = await openIme(page);
		await ime.composeSteps(['に', 'にほ', 'にほん'], IME_GAP_MS);
		await page.waitForTimeout(IME_GAP_MS);
		await ime.commit('日本');
		await ime.detach();
		await expect.poll(() => readBlockText(page, 1)).toBe('note日本');

		await page.keyboard.press(`${modKey}+Z`);
		await expect.poll(() => readBlockText(page, 1)).toBe('note');
		await expect.poll(() => readDomText(page, 1)).toBe('note');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});
		await page.keyboard.press(`${modKey}+Shift+Z`);
		await expect.poll(() => readBlockText(page, 1)).toBe('note日本');
		await expect.poll(() => readDomText(page, 1)).toBe('note日本');
		issues.assertClean();
	});

	test('undo right after an equal-text IME commit removes exactly the composed text (F-I16b)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 1, 4); // note|

		const ime = await openIme(page);
		await ime.composeSteps(['ㅎ', '하', '한'], IME_GAP_MS);
		await page.waitForTimeout(IME_GAP_MS);
		await ime.commit('한');
		await ime.detach();
		await expect.poll(() => readBlockText(page, 1)).toBe('note한');

		await page.keyboard.press(`${modKey}+Z`);
		await expect.poll(() => readBlockText(page, 1)).toBe('note');
		await expect.poll(() => readDomText(page, 1)).toBe('note');
		await page.keyboard.press(`${modKey}+Shift+Z`);
		await expect.poll(() => readBlockText(page, 1)).toBe('note한');
		await expect.poll(() => readDomText(page, 1)).toBe('note한');
		issues.assertClean();
	});

	test('a 10 s pause leaves the session live; it commits once (F-I17, BI-4)', async ({ page }) => {
		test.setTimeout(45_000);
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 1, 4); // note|

		const ime = await openIme(page);
		await ime.compose('に');
		await pinComposingNode(page, 'preview');
		await page.waitForTimeout(10_000);
		expect(await readBlockText(page, 1)).toBe('noteに');
		expect(await readDomText(page, 1)).toBe('noteに');
		expect(await readPinnedNode(page, 'preview', 'noteに')).toMatchObject({
			connected: true,
			hostIntact: true,
			holdsText: true
		});

		await ime.commit('に');
		await ime.detach();
		await expect.poll(() => readBlockText(page, 1)).toBe('noteに');
		await expect.poll(() => readDomText(page, 1)).toBe('noteに');
		issues.assertClean();
	});

	test('undo after composing over a selected word restores the word and the selection (F-I16c, COMP-02)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=basic');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 1, 0, 1, 4); // [note]

		const ime = await openIme(page);
		await ime.compose('に');
		await page.waitForTimeout(KEY_PACE_MS);
		await ime.commit('に');
		await ime.detach();
		await expect.poll(() => readBlockText(page, 1)).toBe('に');
		await expect.poll(() => readDomText(page, 1)).toBe('に');

		await page.keyboard.press(`${modKey}+Z`);
		await expect.poll(() => readBlockText(page, 1)).toBe('note');
		await expect.poll(() => readDomText(page, 1)).toBe('note');
		await expectSelection(page, {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 4,
			isCollapsed: false
		});
		issues.assertClean();
	});

	test('bold mark: outcome — the composed text joins the bold run (composition.spec:1821)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		expect((await driveBold(page)).allTrusted).toBe(true);
		await expect
			.poll(() => readBlockContent(page, 0))
			.toEqual([{ text: 'Alêpha', marks: { bold: true } }, { text: ' beta' }]);
		await expect(page.locator('[data-edytor-mark="bold"]')).toHaveText('Alêpha');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		});
		issues.assertClean();
	});

	test('bold mark: no DOM-selection write while the session lives (F-S12, BI-2)', async ({
		page
	}) => {
		expectNoSelectionWrite(await driveBold(page));
	});

	test('bold mark: session contract (F-S12, §1.3 IME node)', async ({ page }) => {
		const observed = await driveBold(page);
		expectSessionContract(observed, 'Alêpha beta');
	});
});

// ---------------------------------------------------------------------------
// With a peer in a second browser context
// ---------------------------------------------------------------------------

const withPair = async (
	browser: Parameters<typeof openImePeerPair>[0],
	testInfo: Parameters<typeof openImePeerPair>[1],
	body: (pair: ImePeerPair) => Promise<void>
) => {
	const pair = await openImePeerPair(browser, testInfo);
	try {
		const issuesUser = trackPageIssues(pair.user);
		const issuesPeer = trackPageIssues(pair.peer);
		await body(pair);
		issuesUser.assertClean();
		issuesPeer.assertClean();
	} finally {
		await pair.close();
	}
};

/** User composes at `beta|`; the peer inserts `R` at 0 of the same block mid-session. */
const drivePeerSameBlock = async ({ user, peer }: ImePeerPair) => {
	await setSelectionByTextIndex(user, 1, 4); // beta|
	const ime = await openIme(user);
	const observed = await composeObserved(user, ime, {
		textIndex: 1,
		steps: ['n', 'に'],
		commit: 'に',
		committedHostText: 'Rbetaに',
		during: async () => {
			await peerInsertText(peer, 'collab-b2', 0, 'R');
			await expect.poll(async () => (await readBlockText(user, 1)).startsWith('R')).toBe(true);
		}
	});
	await ime.detach();
	return observed;
};

/** User composes at `alpha|`; the peer inserts `P` at 0 of `gamma` mid-session. */
const drivePeerOtherBlock = async ({ user, peer }: ImePeerPair) => {
	await setSelectionByTextIndex(user, 0, 5); // alpha|
	const ime = await openIme(user);
	const observed = await composeObserved(user, ime, {
		textIndex: 0,
		steps: ['n', 'に'],
		commit: 'に',
		committedHostText: 'alphaに',
		during: async () => {
			await peerInsertText(peer, 'collab-b3', 0, 'P');
			await expect.poll(() => readDomText(user, 2)).toBe('Pgamma');
		}
	});
	await ime.detach();
	return observed;
};

test.describe('cdp IME baseline — with a peer in a second browser context', () => {
	test('peer insert before the region, SAME block: outcome — one commit at the shifted region (F-I8)', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) => {
			expect((await drivePeerSameBlock(pair)).allTrusted).toBe(true);
			const converged = await expectConverged(pair.user, pair.peer);
			expect(
				converged.children.map((block) =>
					(block.content ?? []).map((part) => part.text ?? '').join('')
				)
			).toEqual(['alpha', 'Rbetaに', 'gamma']);
			await expectSelection(pair.user, {
				startBlockPath: [1],
				endBlockPath: [1],
				yStart: 'Rbetaに'.length,
				yEnd: 'Rbetaに'.length,
				isCollapsed: true
			});
		});
	});

	test('peer insert before the region, SAME block: no DOM-selection write while the session lives (F-S12, BI-2)', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) =>
			expectNoSelectionWrite(await drivePeerSameBlock(pair))
		);
	});

	test('peer insert before the region, SAME block: session contract (F-S12)', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) => {
			const observed = await drivePeerSameBlock(pair);
			// composition-remote-lock: the DOM the IME owns is not rewritten by
			// the remote insert; the catch-up display happens at session end.
			expectSessionContract(observed, 'betaに');
		});
	});

	test('peer insert in ANOTHER block: outcome — both edits stand', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) => {
			expect((await drivePeerOtherBlock(pair)).allTrusted).toBe(true);
			await expectConverged(pair.user, pair.peer);
			expect(await readBlockTexts(pair.user)).toEqual(['alphaに', 'beta', 'Pgamma']);
			await expectSelection(pair.user, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: 'alphaに'.length,
				yEnd: 'alphaに'.length,
				isCollapsed: true
			});
		});
	});

	test('peer insert in ANOTHER block: no DOM-selection write while the session lives (F-S12, BI-2)', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) =>
			expectNoSelectionWrite(await drivePeerOtherBlock(pair))
		);
	});

	test('peer insert in ANOTHER block: session contract (composition-remote-lock, F-S12)', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) => {
			const observed = await drivePeerOtherBlock(pair);
			expectSessionContract(observed, 'alphaに');
		});
	});

	test('an 850 ms idle composition survives a peer edit in another block (F-I6)', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async ({ user, peer }) => {
			await setSelectionByTextIndex(user, 0, 5); // alpha|
			const ime = await openIme(user);
			await ime.compose('に');
			await pinComposingNode(user, 'preview');
			await user.waitForTimeout(850);
			await peerInsertText(peer, 'collab-b3', 0, 'P');
			await expect.poll(() => readBlockText(user, 2)).toBe('Pgamma');

			// The composition stays live, the preview intact, the host not remounted.
			expect(await readPinnedNode(user, 'preview', 'alphaに')).toMatchObject({
				connected: true,
				hostIntact: true,
				holdsText: true
			});
			expect(await readDomText(user, 0)).toBe('alphaに');

			await ime.commit('に');
			await ime.detach();
			await expectConverged(user, peer);
			expect(await readBlockTexts(user)).toEqual(['alphaに', 'beta', 'Pgamma']);
			await expect.poll(() => readDomText(user, 0)).toBe('alphaに');
		});
	});
});

// ---------------------------------------------------------------------------
// Composition over a block selection (EW-01)
// ---------------------------------------------------------------------------

/**
 * A block selection shows no DOM range, so the IME has no caret of its own:
 * the session must write only where the selection's replacement leaves it.
 * Expected (selection.mdx "Typing, a composition or a paste replaces the
 * selected blocks", hand-authored): the selected blocks give way to one
 * paragraph holding the committed text, no other block changes, and one
 * undo restores the blocks.
 */
const composeOverBlocks = async (
	page: Page,
	select: () => Promise<void>,
	expected: string[],
	prepare?: () => Promise<void>
) => {
	const issues = trackPageIssues(page);
	await page.goto('/test/dom?scenario=divider');
	await waitForEditorReady(page, { requireRuntime: true });
	await prepare?.();
	const before = await readBlockTexts(page);
	await select();
	await expect
		.poll(() => page.evaluate(() => (window as any).__EDYTOR__.selection.selectedBlocks.size))
		.toBeGreaterThan(0);
	const ime = await openIme(page);
	await ime.compose('に');
	await page.waitForTimeout(KEY_PACE_MS);
	await ime.compose('にほ');
	await page.waitForTimeout(KEY_PACE_MS);
	await ime.commit('日本');
	await ime.detach();
	await expect.poll(() => readBlockTexts(page)).toEqual(expected);
	const at = expected.indexOf('日本');
	await expect.poll(() => readDomText(page, at === 0 ? 0 : 1)).toBe('日本');
	await expectSelection(page, { yStart: 2, yEnd: 2, isCollapsed: true });
	// Nothing else reached the document: a moment later it still holds only that.
	await page.waitForTimeout(300);
	expect(await readBlockTexts(page)).toEqual(expected);
	await page.keyboard.press(`${modKey}+Z`);
	await expect.poll(() => readBlockTexts(page)).toEqual(before);
	issues.assertClean();
};

test.describe('cdp IME — composition over a block selection (EW-01)', () => {
	test('over the block Mod+A twice selects: the block gives way to the composed text', async ({
		page
	}) => {
		await composeOverBlocks(page, async () => {
			await setSelectionByTextIndex(page, 1, 3); // aft|er divider
			await page.keyboard.press(`${modKey}+A`);
			await page.keyboard.press(`${modKey}+A`);
		}, ['before divider', '', '日本']);
	});

	test('over every block (Mod+A three times): one paragraph holds the composed text', async ({
		page
	}) => {
		await composeOverBlocks(page, async () => {
			await setSelectionByTextIndex(page, 1, 3);
			await page.keyboard.press(`${modKey}+A`);
			await page.keyboard.press(`${modKey}+A`);
			await page.keyboard.press(`${modKey}+A`);
		}, ['日本']);
	});

	test('over a divider Backspace selected: the composed text takes its place', async ({ page }) => {
		await composeOverBlocks(page, async () => {
			await setSelectionByTextIndex(page, 1, 0); // |after divider
			await page.keyboard.press('Backspace');
		}, ['before divider', '日本', 'after divider']);
	});

	test('a plugin that keeps the blocks refuses the composition: nothing is written anywhere', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=divider');
		await waitForEditorReady(page, { requireRuntime: true });
		await page.evaluate(() =>
			(window as any).__EDYTOR__.plugins.push({
				onDeleteSelectedBlocks: ({ prevent }: { prevent: () => void }) => prevent()
			})
		);
		await setSelectionByTextIndex(page, 1, 0); // |after divider
		await page.keyboard.press('Backspace');
		await expect
			.poll(() => page.evaluate(() => (window as any).__EDYTOR__.selection.selectedBlocks.size))
			.toBe(1);
		const ime = await openIme(page);
		await ime.compose('に');
		await page.waitForTimeout(KEY_PACE_MS);
		await ime.commit('日');
		await ime.detach();
		await page.waitForTimeout(300);
		expect(await readBlockTexts(page)).toEqual(['before divider', '', 'after divider']);
		await expect.poll(() => readDomText(page, 0)).toBe('before divider');
		await expect.poll(() => readDomText(page, 1)).toBe('after divider');
		issues.assertClean();
	});

	test('over a selected inline atom: the composed text takes its place, no other line changes', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await page.goto('/test/dom?scenario=inline');
		await waitForEditorReady(page, { requireRuntime: true });
		const before = await readBlockContent(page, 1);
		await setSelectionByTextIndex(page, 2, 5); // lead |@ end
		await page.keyboard.press('Shift+ArrowRight');
		await expect
			.poll(() =>
				page.evaluate(() => (window as any).__EDYTOR__.selection.selectedInlineBlock.size)
			)
			.toBe(1);
		const ime = await openIme(page);
		await ime.compose('に');
		await page.waitForTimeout(KEY_PACE_MS);
		await ime.commit('日本');
		await ime.detach();
		await expect.poll(() => readBlockTexts(page)).toEqual(['tail', 'lead 日本 end']);
		await expect.poll(() => readDomText(page, 2)).toBe('lead 日本 end');
		await expectSelection(page, { yStart: 7, yEnd: 7, isCollapsed: true });
		await page.keyboard.press(`${modKey}+Z`);
		await expect.poll(() => readBlockContent(page, 1)).toEqual(before);
		expect(await readBlockTexts(page)).toEqual(['tail', 'lead  end']);
		issues.assertClean();
	});

	test('over a void Shift+↓ selected: the composed text takes its place', async ({ page }) => {
		await composeOverBlocks(page, async () => {
			await setSelectionByTextIndex(page, 0, 'before divider'.length);
			await page.keyboard.press('Shift+ArrowDown');
		}, ['before divider', '日本', 'after divider']);
	});
});

/**
 * An ordinary composition at the end of the first line, then past the tail
 * and the undo capture window: the next session starts after one ended
 * (DR-behavior-1 — a stale D-20 baseline ended it at its start).
 */
const composeEarlier = (page: Page) => async () => {
	await setSelectionByTextIndex(page, 0, 'before divider'.length);
	const ime = await openIme(page);
	await ime.compose('ｋ');
	await page.waitForTimeout(KEY_PACE_MS);
	await ime.commit('か');
	await ime.detach();
	await expect.poll(() => readDomText(page, 0)).toBe('before dividerか');
	await page.waitForTimeout(IME_GAP_MS);
};

test.describe('cdp IME — composition over a block selection after an earlier composition (DR-behavior-1)', () => {
	test('over a divider Backspace selected: the composed text takes its place', async ({ page }) => {
		await composeOverBlocks(
			page,
			async () => {
				await setSelectionByTextIndex(page, 1, 0); // |after divider
				await page.keyboard.press('Backspace');
			},
			['before dividerか', '日本', 'after divider'],
			composeEarlier(page)
		);
		// The block renders again: typed text shows on screen.
		await page.keyboard.press(`${modKey}+Shift+Z`);
		await expect
			.poll(() => readBlockTexts(page))
			.toEqual(['before dividerか', '日本', 'after divider']);
		await setSelectionByTextIndex(page, 1, 2);
		await page.keyboard.type('Z');
		await expect
			.poll(() => readBlockTexts(page))
			.toEqual(['before dividerか', '日本Z', 'after divider']);
		await expect.poll(() => readDomText(page, 1)).toBe('日本Z');
	});

	test('over every block (Mod+A three times): one paragraph holds the composed text', async ({
		page
	}) => {
		await composeOverBlocks(
			page,
			async () => {
				await setSelectionByTextIndex(page, 1, 3);
				await page.keyboard.press(`${modKey}+A`);
				await page.keyboard.press(`${modKey}+A`);
				await page.keyboard.press(`${modKey}+A`);
			},
			['日本'],
			composeEarlier(page)
		);
	});
});

// ---------------------------------------------------------------------------
// Composition over a text range (SW14-ime-1)
// ---------------------------------------------------------------------------

/**
 * The IME replaces the DOM range itself. The render must not touch the
 * host before the first preview: a write then collapses the IME's range to
 * the node's start, so the preview showed before the untouched text
 * (`にfirst` for `f[irs]t`) and, over a range across blocks, a cancel left
 * the line empty on screen while the document held its text. Expected
 * (hand-authored): what the screen shows equals the document at every step.
 */
const threeLines = async (page: Page) => {
	const doc = {
		children: ['first', 'second', 'last'].map((text) => ({
			type: 'paragraph',
			content: [{ text }]
		}))
	};
	await page.goto(
		`/test/dom?${new URLSearchParams({ scenario: 'dst', dst: JSON.stringify(doc) })}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
};
const domTexts = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('[data-edytor-text="true"]')].map((element) =>
			(element.textContent ?? '').replace(/\u200B/g, '')
		)
	);

test.describe('cdp IME — composition over a text range (SW14-ime-1)', () => {
	test('over a word: the live preview replaces the word on screen', async ({ page }) => {
		const issues = trackPageIssues(page);
		await threeLines(page);
		await setSelectionByTextIndex(page, 0, 1, 0, 4); // f[irs]t
		const ime = await openIme(page);
		await ime.compose('に');
		await page.waitForTimeout(KEY_PACE_MS);
		expect(await readBlockTexts(page)).toEqual(['fにt', 'second', 'last']);
		expect(await domTexts(page)).toEqual(['fにt', 'second', 'last']);
		await ime.commit('日');
		await ime.detach();
		await expect.poll(() => readBlockTexts(page)).toEqual(['f日t', 'second', 'last']);
		await expect.poll(() => domTexts(page)).toEqual(['f日t', 'second', 'last']);
		issues.assertClean();
	});

	test('canceled over a range across blocks: the screen shows what the document holds', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await threeLines(page);
		await setSelectionByTextIndex(page, 0, 2, 2, 2); // fi[rst … la]st
		const ime = await openIme(page);
		await ime.compose('に');
		await page.waitForTimeout(KEY_PACE_MS);
		await ime.cancel();
		await ime.detach();
		await expect.poll(() => readBlockTexts(page)).toEqual(['fist']);
		await expect.poll(() => domTexts(page)).toEqual(['fist']);
		await page.keyboard.type('X');
		await expect.poll(() => readBlockTexts(page)).toEqual(['fiXst']);
		await expect.poll(() => domTexts(page)).toEqual(['fiXst']);
		issues.assertClean();
	});

	test('live over a range across blocks: the text after the range stays on screen (FX-08)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await threeLines(page);
		await setSelectionByTextIndex(page, 0, 2, 2, 2); // fi[rst … la]st
		const ime = await openIme(page);
		for (const step of ['に', 'にほ']) {
			await ime.compose(step);
			await page.waitForTimeout(KEY_PACE_MS);
			expect(await readBlockTexts(page)).toEqual([`fi${step}st`]);
			expect(await domTexts(page)).toEqual([`fi${step}st`]);
		}
		await ime.commit('日本');
		await ime.detach();
		await expect.poll(() => readBlockTexts(page)).toEqual(['fi日本st']);
		await expect.poll(() => domTexts(page)).toEqual(['fi日本st']);
		issues.assertClean();
	});

	test('live over a range across blocks: the atom and text after the range stay on screen (FX-08)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const doc = {
			children: [
				{ type: 'paragraph', content: [{ text: 'first' }] },
				{
					type: 'paragraph',
					content: [{ text: 'last' }, { type: 'mention', data: {} }, { text: 'end' }]
				}
			]
		};
		await page.goto(
			`/test/dom?${new URLSearchParams({ scenario: 'dst', dst: JSON.stringify(doc) })}`
		);
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 2, 1, 2); // fi[rst … la]st
		const ime = await openIme(page);
		const line = () =>
			page.evaluate(() =>
				(document.querySelector('[data-edytor-block]')?.textContent ?? '').replace(/\u200B/g, '')
			);
		const mention = await page.evaluate(
			() => document.querySelector('[data-edytor-inline-block]')?.textContent ?? ''
		);
		for (const step of ['に', 'にほ']) {
			await ime.compose(step);
			await page.waitForTimeout(KEY_PACE_MS);
			expect((await line()).trim()).toBe(`fi${step}st${mention}end`);
		}
		await ime.commit('日本');
		await ime.detach();
		await expect.poll(async () => (await line()).trim()).toBe(`fi日本st${mention}end`);
		issues.assertClean();
	});

	test('live over a range inside one block across an atom: the text after it stays on screen (GX-04)', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const doc = {
			children: [
				{
					type: 'paragraph',
					content: [
						{ text: 'first' },
						{ type: 'mention', data: {} },
						{ text: 'last' },
						{ type: 'mention', data: {} },
						{ text: 'end' }
					]
				}
			]
		};
		await page.goto(
			`/test/dom?${new URLSearchParams({ scenario: 'dst', dst: JSON.stringify(doc) })}`
		);
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 2, 1, 2); // fi[rst @ la]st
		const ime = await openIme(page);
		const line = () =>
			page.evaluate(() =>
				(document.querySelector('[data-edytor-block]')?.textContent ?? '').replace(/\u200B/g, '')
			);
		// The atom after the range stays; its text follows it.
		const mention = await page.evaluate(
			() => document.querySelectorAll('[data-edytor-inline-block]')[1]?.textContent ?? ''
		);
		for (const step of ['に', 'にほ']) {
			await ime.compose(step);
			await page.waitForTimeout(KEY_PACE_MS);
			expect((await line()).trim()).toBe(`fi${step}st${mention}end`);
		}
		await ime.commit('日本');
		await ime.detach();
		await expect.poll(async () => (await line()).trim()).toBe(`fi日本st${mention}end`);
		issues.assertClean();
	});
});
