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
 *   checkpoint, so the checkpoint that fixes them flips them.
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
/** Longer than the engine's 500 ms undo capture window and the 750 ms composition idle. */
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
	const liveDom = await readDomText(page, options.textIndex);
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

/**
 * The composition-restart half is not V4's: with no selection write left
 * (V4), Chromium still restarts the composition because the host text node is
 * rewritten under the IME after the first update (the render writes the
 * preview — at the host's end mid-word, identical text at the end — and a
 * rewrite resets the caret: §1.1 text-writer fact). The IME-node pin owns it.
 */
const RESTART = 'F-S12 restart half (I3 pin: the render rewrites the IME node)';

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
		knownRed(`${RESTART} / §1.3 IME-node row`);
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
		knownRed('F-I16(d) (I3)');
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
		await expect.poll(() => readDomText(page, 0)).toBe('');
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
		knownRed('F-I15 (I4)');
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
		knownRed('F-I16(a) (I3)');
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
		knownRed(`${RESTART} / §1.3 IME-node row`);
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
		knownRed(RESTART);
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
		knownRed(RESTART);
		await withPair(browser, testInfo, async (pair) => {
			const observed = await drivePeerOtherBlock(pair);
			expectSessionContract(observed, 'alphaに');
		});
	});

	test('an 850 ms idle composition survives a peer edit in another block (F-I6)', async ({
		browser
	}, testInfo) => {
		knownRed('F-I6 (I3, R7)');
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
