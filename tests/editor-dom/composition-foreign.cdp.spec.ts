import {
	expectConverged,
	openIme,
	openImePeerPair,
	peerInsertText,
	readBlockText,
	readBlockTexts,
	type ImePeerPair
} from './cdp';
import { expect, test, type Page } from './editorTest';
import { expectSelection, setSelectionByTextIndex, trackPageIssues } from './helpers';
import { assertTruth } from '../truthCheck';

/**
 * A composition replaces only its own preview (independent review of
 * 2026-09-29; `session/composition`), through Chromium's real IME path with a
 * peer in a second browser context. A peer's text that lands inside the live
 * preview is foreign and stays; the committed text takes the place of the
 * preview's first live unit, so foreign text before that unit stays before it
 * and foreign text after it follows it; the caret lands after the committed
 * text. Expected values come from that rule, never from running the code.
 *
 * The user composes `にほん` at `alpha|` (seed `alpha | beta | gamma`), the
 * peer edits block `collab-b1` while the session lives, then the IME commits
 * `日本`.
 */

/** Delay between two IME calls: a human IME pace. */
const KEY_PACE_MS = 100;

const peerDeleteText = (peer: Page, blockId: string, offset: number, length: number) =>
	peer.evaluate(
		({ blockId, offset, length }) => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			if (!edytor?.facade) throw new Error('Missing edytor facade');
			return edytor.facade.deleteText(blockId, offset, length);
		},
		{ blockId, offset, length }
	);

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

/** Compose `にほん` at `alpha|`, run the peer's `edit` once the user shows `seen`, commit `日本`. */
const composeAround = async (
	{ user, peer }: ImePeerPair,
	edit: () => Promise<unknown>,
	seen: string
) => {
	await setSelectionByTextIndex(user, 0, 5); // alpha|
	const ime = await openIme(user);
	for (const step of ['n', 'に', 'にほ', 'にほん']) {
		await ime.compose(step);
		await user.waitForTimeout(KEY_PACE_MS);
	}
	await expect.poll(() => readBlockText(peer, 0)).toBe('alphaにほん');
	await edit();
	await expect.poll(() => readBlockText(user, 0)).toBe(seen);
	await ime.commit('日本');
	await user.waitForTimeout(KEY_PACE_MS);
	await ime.detach();
};

const expectOutcome = async (pair: ImePeerPair, first: string, caret: number) => {
	await expectConverged(pair.user, pair.peer);
	expect(await readBlockTexts(pair.user)).toEqual([first, 'beta', 'gamma']);
	await expectSelection(pair.user, {
		startBlockPath: [0],
		endBlockPath: [0],
		yStart: caret,
		yEnd: caret,
		isCollapsed: true
	});
	await assertTruth(pair.user, 'user');
	await assertTruth(pair.peer, 'peer');
};

test.describe('cdp IME — a peer edits inside the live preview', () => {
	test('a peer insert inside the preview follows the committed text', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) => {
			await composeAround(
				pair,
				() => peerInsertText(pair.peer, 'collab-b1', 6, 'X'),
				'alphaにXほん'
			);
			await expectOutcome(pair, 'alpha日本X', 'alpha日本'.length);
		});
	});

	test('a peer insert at the preview start stays before the committed text', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) => {
			await composeAround(
				pair,
				() => peerInsertText(pair.peer, 'collab-b1', 5, 'X'),
				'alphaXにほん'
			);
			await expectOutcome(pair, 'alphaX日本', 'alphaX日本'.length);
		});
	});

	test('a peer insert at the preview end stays after the committed text', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) => {
			await composeAround(
				pair,
				() => peerInsertText(pair.peer, 'collab-b1', 8, 'X'),
				'alphaにほんX'
			);
			await expectOutcome(pair, 'alpha日本X', 'alpha日本'.length);
		});
	});

	test('a peer delete inside the preview: the commit replaces what is left of it', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) => {
			await composeAround(pair, () => peerDeleteText(pair.peer, 'collab-b1', 6, 1), 'alphaにん');
			await expectOutcome(pair, 'alpha日本', 'alpha日本'.length);
		});
	});
});
