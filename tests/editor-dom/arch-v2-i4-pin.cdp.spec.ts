/**
 * arch-v2 — checkpoint I4 rows, cdp lane: the IME pin on Chromium's real IME
 * path (`Input.imeSetComposition` / `Input.insertText`) with a peer in a
 * second browser context (plan §8.4 F-I10, F-I10b, F-I11, F-I12; §11.2 D-20;
 * §12 BI-6, BI-13). F-I15 lives in `ime-baseline.cdp.spec.ts`.
 *
 * The user's block `collab-b2` reads `be@ta` (a mention `m` at 2) for the
 * segment rows and `beta` for the D-20 rows.
 *
 * - F-I10 — composing in `ta` (after `@`); the peer inserts an atom before `@`
 *   → the IME's node keeps its identity; the commit lands after `@`.
 * - F-I10b — composing at `ta|`; the peer inserts a mention between `t` and
 *   `a` → the host text renders once while live; after the commit the atom
 *   renders once, in place.
 * - F-I11 — composing at `@|ta`; the peer deletes `@` → the IME's node
 *   survives until the session ends; the segments merge after the commit.
 * - F-I12 (D-20, commit first) — the peer deletes, retypes, re-parents or
 *   merges `beta` while the user composes at its end → the session commits
 *   what the IME shows before the change renders; a deleted block takes the
 *   text with it; nothing is duplicated on either replica. (b) the IME keeps
 *   composing after the forced commit → one more commit, never a duplicate.
 *
 * Expected values come from the plan rows, never from running the code.
 */
import {
	armSpy,
	expectConverged,
	installSpy,
	openIme,
	openImePeerPair,
	pinComposingNode,
	readPinnedNode,
	readSpy,
	type ImePeerPair
} from './cdp';
import { expect, test, type Page } from './editorTest';
import { setSelectionByTextIndex, trackPageIssues } from './helpers';

/** A row red on the reference (`arch-v2/ref-i4`); `CDP_SHOW_RED=1` runs it as a normal test. */
const knownRed = (row: string) =>
	test.fail(!process.env.CDP_SHOW_RED, `${row}: red on the reference — I4`);

/** Delay between two IME updates: a fast human typist on a real IME. */
const KEY_PACE_MS = 100;

type Part = { text?: string; type?: string; id?: string };
type Block = { type: string; content?: Part[]; children?: Block[] };

/** Root blocks as `type:text` (atoms as `@<id>`, nested children in braces). */
const readShape = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as Window & { __EDYTOR__?: { value: { children: Block[] } } })
			.__EDYTOR__;
		const walk = (block: Block): string => {
			const text = (block.content ?? []).map((part) => part.text ?? `@${part.id}`).join('');
			const kids = block.children?.length ? `{${block.children.map(walk).join(', ')}}` : '';
			return `${block.type}:${text}${kids}`;
		};
		return (edytor?.value.children ?? []).map(walk);
	});

/** A facade op on `page`; returns its status. */
const op = (page: Page, name: string, ...args: unknown[]) =>
	page.evaluate(
		({ name, args }) => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			return edytor.facade[name](...args).status as string;
		},
		{ name, args }
	);

const isComposing = (page: Page) =>
	page.evaluate(() => Boolean((window as Window & { __EDYTOR__?: any }).__EDYTOR__?.isComposing));

/** The DOM text of `collab-b2`'s text elements (atoms excluded). */
const hostTexts = (page: Page) =>
	page.evaluate(() =>
		Array.from(
			document.querySelectorAll('[data-edytor-id="collab-b2"] [data-edytor-text="true"]')
		).map((element) => (element.textContent ?? '').replace(/\u200B/g, ''))
	);
const hostAtoms = (page: Page) =>
	page.evaluate(
		() =>
			document.querySelectorAll('[data-edytor-id="collab-b2"] span[data-edytor-inline-block]')
				.length
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

/** `collab-b2` becomes `be@ta` on both replicas. */
const withAtom = async ({ user, peer }: ImePeerPair) => {
	expect(
		await op(user, 'insertInline', 'collab-b2', 2, { id: 'm', type: 'mention', data: {} })
	).toBe('applied');
	await expectConverged(user, peer);
	expect((await readShape(user))[1]).toBe('paragraph:be@mta');
};

/**
 * Compose `n` → `に` at text element `textIndex`, offset `offset`; `during`
 * runs after the first update (the peer's edit, awaited on the user's side).
 * Returns what the live session and the commit looked like.
 */
const compose = async (
	{ user }: ImePeerPair,
	textIndex: number,
	offset: number,
	during: () => Promise<void>,
	then?: (ime: Awaited<ReturnType<typeof openIme>>) => Promise<void>
) => {
	await setSelectionByTextIndex(user, textIndex, offset);
	const ime = await openIme(user);
	await installSpy(user);
	await armSpy(user);
	await ime.compose('n');
	await user.waitForTimeout(KEY_PACE_MS);
	await pinComposingNode(user, 'ime');
	await during();
	await user.waitForTimeout(KEY_PACE_MS);
	const live = {
		node: await readPinnedNode(user, 'ime'),
		texts: await hostTexts(user),
		atoms: await hostAtoms(user),
		selectionWrites: [] as string[]
	};
	if (then) await then(ime);
	else {
		await ime.compose('に');
		await user.waitForTimeout(KEY_PACE_MS);
		live.node = await readPinnedNode(user, 'ime', 'に');
		live.texts = await hostTexts(user);
		live.atoms = await hostAtoms(user);
		live.selectionWrites = (await readSpy(user)).selectionWrites;
		await ime.commit('に');
	}
	await ime.detach();
	const spy = await readSpy(user);
	return { live, spy };
};

/** The IME's node survived the live session and the IME extended one composition. */
const expectNodeKept = (observed: Awaited<ReturnType<typeof compose>>) => {
	expect.soft(observed.live.node, 'the IME node survives the live session').toMatchObject({
		connected: true,
		hostIntact: true,
		holdsText: true
	});
	expect.soft(observed.spy.compositionStarts, 'one composition, never restarted').toBe(1);
	expect.soft(observed.spy.compositionEnds, 'one commit').toBe(1);
	expect.soft(observed.live.selectionWrites, 'no DOM-selection write while live').toEqual([]);
};

test.describe('I4 — the pin freezes the host cell’s segment list (cdp)', () => {
	test('F-I10: a peer atom before `@` keeps the IME node; the commit lands after `@`', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) => {
			await withAtom(pair);
			// Text elements: alpha | be | ta | gamma — compose at `t|a`.
			const observed = await compose(pair, 2, 1, async () => {
				expect(
					await op(pair.peer, 'insertInline', 'collab-b2', 1, {
						id: 'p',
						type: 'mention',
						data: {}
					})
				).toBe('applied');
				await expect.poll(async () => (await readShape(pair.user))[1]).toContain('@p');
			});
			expectNodeKept(observed);
			await expectConverged(pair.user, pair.peer);
			expect((await readShape(pair.user))[1]).toBe('paragraph:b@pe@mtにa');
			await expect.poll(() => hostTexts(pair.user)).toEqual(['b', 'e', 'tにa']);
		});
	});

	test('F-I10b: a peer atom inside the host segment renders nothing twice (BI-13)', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) => {
			await withAtom(pair);
			// Compose at `ta|`; the peer inserts between `t` and `a` (offset 4).
			const observed = await compose(pair, 2, 2, async () => {
				expect(
					await op(pair.peer, 'insertInline', 'collab-b2', 4, {
						id: 'p',
						type: 'mention',
						data: {}
					})
				).toBe('applied');
				await expect.poll(async () => (await readShape(pair.user))[1]).toContain('@p');
			});
			expectNodeKept(observed);
			// While live: the host segment renders once, the peer's atom not yet.
			expect(observed.live.texts).toEqual(['be', 'taに']);
			expect(observed.live.atoms).toBe(1);
			await expectConverged(pair.user, pair.peer);
			expect((await readShape(pair.user))[1]).toBe('paragraph:be@mt@paに');
			await expect.poll(() => hostTexts(pair.user)).toEqual(['be', 't', 'aに']);
			expect(await hostAtoms(pair.user)).toBe(2);
		});
	});

	test('F-I11: a peer deletes `@` before the composing segment; segments merge after', async ({
		browser
	}, testInfo) => {
		await withPair(browser, testInfo, async (pair) => {
			await withAtom(pair);
			const observed = await compose(pair, 2, 0, async () => {
				expect(await op(pair.peer, 'removeInline', 'collab-b2', 'm')).toBe('applied');
				await expect.poll(async () => (await readShape(pair.user))[1]).not.toContain('@m');
			});
			expectNodeKept(observed);
			await expectConverged(pair.user, pair.peer);
			expect((await readShape(pair.user))[1]).toBe('paragraph:beにta');
			await expect.poll(() => hostTexts(pair.user)).toEqual(['beにta']);
			expect(await hostAtoms(pair.user)).toBe(0);
		});
	});
});

type Structural = {
	name: string;
	run: (peer: Page) => Promise<string>;
	/** The user's document once the change arrived (the forced commit included). */
	arrived: string[];
};

const structural: Structural[] = [
	{
		name: 'delete',
		run: (peer) => op(peer, 'deleteBlock', 'collab-b2'),
		arrived: ['paragraph:alpha', 'paragraph:gamma']
	},
	{
		name: 'retype',
		run: (peer) => op(peer, 'setBlockType', 'collab-b2', 'quote'),
		arrived: ['paragraph:alpha', 'quote:betan', 'paragraph:gamma']
	},
	{
		name: 're-parent',
		run: (peer) => op(peer, 'nestBlock', 'collab-b2', 'collab-b1'),
		arrived: ['paragraph:alpha{paragraph:betan}', 'paragraph:gamma']
	},
	{
		name: 'merge',
		run: (peer) => op(peer, 'mergeBackward', 'collab-b2'),
		arrived: ['paragraph:alphabetan', 'paragraph:gamma']
	}
];

test.describe('I4 — D-20: a peer’s structural change commits the live session first (cdp)', () => {
	for (const change of structural) {
		test(`F-I12 (a) ${change.name}: committed first, nothing duplicated`, async ({
			browser
		}, testInfo) => {
			knownRed(`F-I12 (a) ${change.name}`);
			await withPair(browser, testInfo, async (pair) => {
				// Compose at `beta|` (text element 1, offset 4).
				let composingAfter = true;
				await compose(
					pair,
					1,
					4,
					async () => {
						expect(await change.run(pair.peer)).toBe('applied');
						await expect.poll(() => readShape(pair.user)).toEqual(change.arrived);
						composingAfter = await isComposing(pair.user);
					},
					// The IME, unaware, commits what it shows.
					async (ime) => ime.commit('n')
				);
				expect(composingAfter, 'the session ended when the change arrived').toBe(false);
				await expectConverged(pair.user, pair.peer);
				await expect.poll(() => readShape(pair.user)).toEqual(change.arrived);
				expect(await readShape(pair.peer)).toEqual(change.arrived);
			});
		});
	}

	test('F-I12 (b) retype, then the IME keeps composing: one more commit, never a duplicate', async ({
		browser
	}, testInfo) => {
		knownRed('F-I12 (b)');
		await withPair(browser, testInfo, async (pair) => {
			await compose(
				pair,
				1,
				4,
				async () => {
					expect(await op(pair.peer, 'setBlockType', 'collab-b2', 'quote')).toBe('applied');
					await expect.poll(async () => (await readShape(pair.user))[1]).toBe('quote:betan');
				},
				async (ime) => {
					await ime.compose('に');
					await pair.user.waitForTimeout(KEY_PACE_MS);
					await ime.commit('に');
				}
			);
			await expectConverged(pair.user, pair.peer);
			await expect
				.poll(() => readShape(pair.user))
				.toEqual(['paragraph:alpha', 'quote:betaに', 'paragraph:gamma']);
		});
	});
});
