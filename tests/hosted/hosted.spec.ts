/**
 * Hosted lane: two or three real browser contexts editing ONE document
 * through the room Durable Object (tests/do/room.ts) hosted by Miniflare,
 * over real WebSockets — no relay, no BroadcastChannel (each context has
 * its own storage and the websocket provider has no BC leg).
 *
 * Each page mounts `/test/dom?scenario=collab&collabws=<room>&wsserver=…`:
 * the production `Edytor` on a real `WebsocketProvider` (dialing
 * `ws://127.0.0.1:4195/rooms/<room>`) plus IndexedDB persistence
 * (`edytor-collabws-<room>`). The `collab` scenario seeds three blocks
 * with deterministic ids: `collab-b1` "alpha", `collab-b2` "beta",
 * `collab-b3` "gamma".
 *
 * Expectations are literal, hand-authored from the edits each test makes.
 */
import {
	chromium,
	expect,
	firefox,
	test,
	webkit,
	type Browser,
	type BrowserContext,
	type Page
} from '@playwright/test';
import {
	gotoEditorRoute,
	readJsonByTestId,
	waitForEditorReady,
	setSelectionByTextIndex,
	trackPageIssues
} from '../editor-dom/helpers';

const HOSTED_ORIGIN = 'http://127.0.0.1:4195';
const WS_SERVER = 'ws://127.0.0.1:4195/rooms';

type JSONDocValue = { children: Array<Record<string, unknown>> };

/** Reconnect noise while the room is unreachable (Chromium/WebKit console, Firefox pageerror). */
const WS_NOISE = [/ws:\/\/127\.0\.0\.1:4195\//];

const roomName = (slug: string, project: string) =>
	`${project}-${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

type Peer = { context: BrowserContext; page: Page };

const openPeer = async (browser: Browser, room: string, baseURL: string | undefined) => {
	const context = await browser.newContext({ baseURL });
	const page = await context.newPage();
	await gotoEditorRoute(page, peerPath(room), { requireRuntime: true });
	await expectProvider(page, { wsconnected: true, synced: true });
	// A dev-server full reload (vite reacting to `.svelte-kit/generated`
	// being rewritten by a concurrent `svelte-kit sync`/build) swaps the
	// page's document and client id mid-test; record it so a failure says so.
	page.on('framenavigated', (frame) => {
		if (frame === page.mainFrame()) unexpectedNavigations.push(frame.url());
	});
	return { context, page } satisfies Peer;
};

/** Main-frame navigations after a peer mounted (reset per test; specs' own reloads included). */
let unexpectedNavigations: string[] = [];

const peerPath = (room: string) =>
	`/test/dom?scenario=collab&collabws=${room}&wsserver=${encodeURIComponent(WS_SERVER)}&wsbackoff=400`;

const readValue = (page: Page) => readJsonByTestId<JSONDocValue>(page, 'value');

const blockText = (block: Record<string, unknown>) =>
	((block.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('');

const readTexts = async (page: Page) => (await readValue(page)).children.map(blockText);
const readIds = async (page: Page) => (await readValue(page)).children.map((block) => block.id);

/** Poll until every page serializes the identical document; returns its block texts. */
const expectConverged = async (pages: Page[], timeout = 15_000) => {
	await expect
		.poll(
			async () => {
				const values = await Promise.all(pages.map((page) => readValue(page)));
				return values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]));
			},
			{ timeout }
		)
		.toBe(true);
	return readTexts(pages[0]);
};

type ProviderState = {
	wsconnected: boolean;
	synced: boolean;
	/** Provider status transitions since {@link watchStatus} (`[]` if not watched / reloaded). */
	statuses: string[];
};

const providerState = (page: Page) =>
	page.evaluate(() => {
		const w = window as any;
		const provider = w.__EDYTOR_COLLAB__?.provider;
		// Not mounted yet (e.g. right after a reload): not connected.
		if (!provider) return { wsconnected: false, synced: false, statuses: [] } as ProviderState;
		return {
			wsconnected: Boolean(provider.wsconnected),
			synced: Boolean(provider.synced),
			statuses: [...((w.__HOSTED_STATUS__ as string[] | undefined) ?? [])]
		} as ProviderState;
	});

const expectProvider = (page: Page, expected: Partial<ProviderState>, timeout = 15_000) =>
	expect.poll(() => providerState(page), { timeout }).toMatchObject(expected);

/**
 * Record the provider's status transitions from now on. The record lives on
 * `window`, so a page reload (which would also fake a "reconnect") wipes it:
 * `watching()` tells the two apart.
 */
const watchStatus = (page: Page) =>
	page.evaluate(() => {
		const w = window as any;
		w.__HOSTED_STATUS__ = [];
		w.__EDYTOR_COLLAB__.provider.on('status', (event: { status: string }) =>
			w.__HOSTED_STATUS__.push(event.status)
		);
	});

const watching = (page: Page) =>
	page.evaluate(() => Array.isArray((window as any).__HOSTED_STATUS__));

const setOnline = (page: Page, online: boolean) =>
	page.evaluate((on) => {
		const provider = (window as any).__EDYTOR_COLLAB__.provider;
		if (on) provider.connect();
		else provider.disconnect();
	}, online);

const insertViaFacade = (page: Page, blockId: string, offset: number, text: string) =>
	page.evaluate(
		({ blockId, offset, text }) => {
			const edytor = (window as any).__EDYTOR__;
			if (!edytor) throw new Error('Missing editor runtime');
			return edytor.facade.insertText(blockId, offset, text);
		},
		{ blockId, offset, text }
	);

const clientIdOf = (page: Page) =>
	page.evaluate(() => (window as any).__EDYTOR__.doc.clientID as number);

const remoteCursor = (page: Page, clientId: number) =>
	page.locator(`[data-edytor-remote-cursor][data-client-id="${clientId}"]`);

/** Test-only hook: evict the room's Durable Object (memory gone). */
const evictRoom = async (room: string, sockets: 'hibernate' | 'close' = 'hibernate') => {
	const response = await fetch(`${HOSTED_ORIGIN}/rooms/${room}/evict?sockets=${sockets}`, {
		method: 'POST'
	});
	return (await response.json()) as { evicted: boolean; webSockets?: string; error?: string };
};

const occurrences = (texts: string[], marker: string) => texts.join('\n').split(marker).length - 1;

const SEED = ['alpha', 'beta', 'gamma'];
const IDS = ['collab-b1', 'collab-b2', 'collab-b3'];

test.describe('hosted room Durable Object — real browsers over real WebSockets', () => {
	let peers: Peer[] = [];

	test.afterEach(async ({}, testInfo) => {
		await Promise.all(peers.map((peer) => peer.context.close()));
		peers = [];
		if (testInfo.status !== testInfo.expectedStatus && unexpectedNavigations.length > 0) {
			testInfo.annotations.push({
				type: 'page-navigations',
				description: `peer pages navigated mid-test (dev-server reload?): ${unexpectedNavigations.join(', ')}`
			});
		}
		unexpectedNavigations = [];
	});

	test('three contexts type into one document and converge; a late joiner loads it from the room', async ({
		browser
	}, testInfo) => {
		const room = roomName('converge', testInfo.project.name);
		const baseURL = testInfo.project.use.baseURL;
		const a = await openPeer(browser, room, baseURL);
		const b = await openPeer(browser, room, baseURL);
		const c = await openPeer(browser, room, baseURL);
		peers = [a, b, c];
		const issues = peers.map((peer) => trackPageIssues(peer.page));
		expect(await expectConverged(peers.map((p) => p.page))).toEqual(SEED);
		expect(await readIds(a.page)).toEqual(IDS);

		// Real keyboard typing in A and B, a facade edit in C — concurrently.
		await setSelectionByTextIndex(a.page, 0, 'alpha'.length);
		await setSelectionByTextIndex(b.page, 2, 'gamma'.length);
		await Promise.all([
			a.page.keyboard.type('-A'),
			b.page.keyboard.type('-B'),
			insertViaFacade(c.page, 'collab-b2', 0, 'C>')
		]);
		const expected = ['alpha-A', 'C>beta', 'gamma-B'];
		expect(await expectConverged(peers.map((p) => p.page))).toEqual(expected);

		// Same block, both ends, typed.
		await setSelectionByTextIndex(a.page, 1, 0);
		await setSelectionByTextIndex(c.page, 1, 'C>beta'.length);
		await Promise.all([a.page.keyboard.type('[a]'), c.page.keyboard.type('[c]')]);
		const final = ['alpha-A', '[a]C>beta[c]', 'gamma-B'];
		expect(await expectConverged(peers.map((p) => p.page))).toEqual(final);

		// A late joiner (fresh storage) gets the document from the room.
		const d = await openPeer(browser, room, baseURL);
		peers.push(d);
		expect(await expectConverged([a.page, d.page])).toEqual(final);
		expect(await readIds(d.page)).toEqual(IDS);
		for (const issue of issues) issue.assertClean();
	});

	test('three engines in one room: Chromium, Firefox and WebKit type into one document and converge', async ({}, testInfo) => {
		// One cross-engine room is enough: run it from the chromium project only.
		test.skip(testInfo.project.name !== 'chromium', 'cross-engine row runs once');
		const room = roomName('engines', 'x');
		const baseURL = testInfo.project.use.baseURL;
		const browsers = await Promise.all([chromium.launch(), firefox.launch(), webkit.launch()]);
		try {
			const [c, f, w] = await Promise.all(browsers.map((b) => openPeer(b, room, baseURL)));
			peers = [c, f, w];
			const pages = peers.map((p) => p.page);
			expect(await expectConverged(pages)).toEqual(SEED);
			await setSelectionByTextIndex(c.page, 0, 'alpha'.length);
			await setSelectionByTextIndex(f.page, 1, 'beta'.length);
			await setSelectionByTextIndex(w.page, 2, 'gamma'.length);
			await Promise.all([
				c.page.keyboard.type(' chromium'),
				f.page.keyboard.type(' firefox'),
				w.page.keyboard.type(' webkit')
			]);
			expect(await expectConverged(pages)).toEqual([
				'alpha chromium',
				'beta firefox',
				'gamma webkit'
			]);
			// Same block, one insertion per engine at its start, concurrently.
			await Promise.all(pages.map((page, i) => insertViaFacade(page, 'collab-b1', 0, `${i}`)));
			const [first] = await expectConverged(pages);
			expect([...first.slice(0, 3)].sort().join('')).toBe('012');
			expect(first.slice(3)).toBe('alpha chromium');
		} finally {
			await Promise.all(peers.map((peer) => peer.context.close()));
			peers = [];
			await Promise.all(browsers.map((b) => b.close()));
		}
	});

	test('offline replay: a disconnected peer edits, others edit, reconnect and reload converge exactly once', async ({
		browser
	}, testInfo) => {
		const room = roomName('offline', testInfo.project.name);
		const baseURL = testInfo.project.use.baseURL;
		const a = await openPeer(browser, room, baseURL);
		const b = await openPeer(browser, room, baseURL);
		const c = await openPeer(browser, room, baseURL);
		peers = [a, b, c];
		const issues = [b, c].map((peer) => trackPageIssues(peer.page));
		await expectConverged(peers.map((p) => p.page));

		// ── 1 · provider disconnect → edit → connect ──────────────────────
		await setOnline(a.page, false);
		await expectProvider(a.page, { wsconnected: false });
		await setSelectionByTextIndex(a.page, 0, 'alpha'.length);
		await a.page.keyboard.type('+off1');
		await insertViaFacade(b.page, 'collab-b3', 0, 'B1>');
		await insertViaFacade(c.page, 'collab-b2', 4, '+C1');
		await a.page.waitForTimeout(400);
		// Nothing crossed while A was offline.
		expect(await readTexts(a.page)).toEqual(['alpha+off1', 'beta', 'gamma']);
		expect(await expectConverged([b.page, c.page])).toEqual(['alpha', 'beta+C1', 'B1>gamma']);

		await setOnline(a.page, true);
		await expectProvider(a.page, { wsconnected: true, synced: true });
		const afterReconnect = ['alpha+off1', 'beta+C1', 'B1>gamma'];
		expect(await expectConverged(peers.map((p) => p.page))).toEqual(afterReconnect);

		// ── 2 · offline edit survives a RELOAD through IndexedDB ──────────
		await setOnline(a.page, false);
		await expectProvider(a.page, { wsconnected: false });
		await insertViaFacade(a.page, 'collab-b1', 0, 'off2>');
		await insertViaFacade(b.page, 'collab-b2', 0, 'B2>');
		expect(await readTexts(a.page)).toEqual(['off2>alpha+off1', 'beta+C1', 'B1>gamma']);
		// Let the IndexedDB write land, then reload: the offline edit exists
		// only in A's IndexedDB — the room never saw it.
		await a.page.waitForTimeout(500);
		expect(await readTexts(c.page)).toEqual(['alpha+off1', 'B2>beta+C1', 'B1>gamma']);
		await a.page.reload({ waitUntil: 'domcontentloaded' });
		await waitForEditorReady(a.page, { requireRuntime: true });
		await expectProvider(a.page, { wsconnected: true, synced: true });

		const final = ['off2>alpha+off1', 'B2>beta+C1', 'B1>gamma'];
		const texts = await expectConverged(peers.map((p) => p.page));
		expect(texts).toEqual(final);
		expect(await readIds(a.page)).toEqual(IDS);
		for (const marker of ['off1', 'off2>', 'B1>', 'B2>', '+C1']) {
			expect(occurrences(texts, marker), marker).toBe(1);
		}
		for (const issue of issues) issue.assertClean();
	});

	test('providers reconnect after the server closes every socket', async ({
		browser
	}, testInfo) => {
		const room = roomName('server-close', testInfo.project.name);
		const baseURL = testInfo.project.use.baseURL;
		const a = await openPeer(browser, room, baseURL);
		const b = await openPeer(browser, room, baseURL);
		peers = [a, b];
		const issues = peers.map((peer) =>
			trackPageIssues(peer.page, { ignoreConsoleErrors: WS_NOISE, ignorePageErrors: WS_NOISE })
		);
		await expectConverged([a.page, b.page]);
		await Promise.all([watchStatus(a.page), watchStatus(b.page)]);

		// Server-side close: the object is evicted AND its sockets closed;
		// each provider sees the close and dials again on its own.
		expect(await evictRoom(room, 'close')).toEqual({ evicted: true, webSockets: 'close' });
		for (const page of [a.page, b.page]) {
			await expect
				.poll(async () => (await providerState(page)).statuses)
				.toEqual(['disconnected', 'connecting', 'connected']);
			await expectProvider(page, { wsconnected: true, synced: true });
			expect(await watching(page), 'the page was not reloaded').toBe(true);
		}

		await insertViaFacade(a.page, 'collab-b1', 5, '!');
		await setSelectionByTextIndex(b.page, 2, 0);
		await b.page.keyboard.type('>>');
		expect(await expectConverged([a.page, b.page])).toEqual(['alpha!', 'beta', '>>gamma']);
		for (const issue of issues) issue.assertClean();
	});

	test('presence: a peer caret reaches the others and disappears when the peer closes', async ({
		browser
	}, testInfo) => {
		const room = roomName('presence', testInfo.project.name);
		const baseURL = testInfo.project.use.baseURL;
		const a = await openPeer(browser, room, baseURL);
		const b = await openPeer(browser, room, baseURL);
		const c = await openPeer(browser, room, baseURL);
		peers = [a, b, c];
		await expectConverged(peers.map((p) => p.page));

		const idB = await clientIdOf(b.page);
		await setSelectionByTextIndex(b.page, 1, 2);
		await expect(remoteCursor(a.page, idB).first()).toBeVisible();
		await expect(remoteCursor(c.page, idB).first()).toBeVisible();

		// A joiner receives the present peers from the room.
		const d = await openPeer(browser, room, baseURL);
		peers.push(d);
		await expect(remoteCursor(d.page, idB).first()).toBeVisible();

		// B's page goes away WITHOUT its beforeunload goodbye (page.close()
		// skips beforeunload): the room announces the departure itself.
		await b.page.close();
		await expect(remoteCursor(a.page, idB)).toHaveCount(0);
		await expect(remoteCursor(c.page, idB)).toHaveCount(0);
		await expect(remoteCursor(d.page, idB)).toHaveCount(0);
	});

	test('eviction: sockets survive, late edits and a late joiner converge from storage, a closed peer is removed', async ({
		browser
	}, testInfo) => {
		const room = roomName('evict', testInfo.project.name);
		const baseURL = testInfo.project.use.baseURL;
		const a = await openPeer(browser, room, baseURL);
		const b = await openPeer(browser, room, baseURL);
		const c = await openPeer(browser, room, baseURL);
		peers = [a, b, c];
		const issues = [a, c].map((peer) => trackPageIssues(peer.page));
		await expectConverged(peers.map((p) => p.page));
		await Promise.all(peers.map((peer) => watchStatus(peer.page)));

		await insertViaFacade(a.page, 'collab-b1', 0, 'pre>');
		expect(await expectConverged(peers.map((p) => p.page))).toEqual(['pre>alpha', 'beta', 'gamma']);
		const idB = await clientIdOf(b.page);
		await setSelectionByTextIndex(b.page, 2, 1);
		await expect(remoteCursor(a.page, idB).first()).toBeVisible();

		// Evict: the object's memory (doc, presence table) is gone; the
		// hibernatable sockets and their attachments stay.
		expect(await evictRoom(room)).toEqual({ evicted: true, webSockets: 'hibernate' });

		// Edits after the wake: the woken object restored from SQLite.
		await setSelectionByTextIndex(c.page, 1, 'beta'.length);
		await c.page.keyboard.type('+late');
		await insertViaFacade(a.page, 'collab-b3', 5, '!');
		expect(await expectConverged(peers.map((p) => p.page))).toEqual([
			'pre>alpha',
			'beta+late',
			'gamma!'
		]);
		// No socket was dropped: no provider saw a status change.
		for (const peer of peers) {
			expect(await watching(peer.page), 'the page was not reloaded').toBe(true);
			expect((await providerState(peer.page)).statuses).toEqual([]);
		}

		// Evict again, then B leaves without a goodbye: the departure comes
		// from B's socket attachment, read by a freshly woken instance.
		expect(await evictRoom(room)).toEqual({ evicted: true, webSockets: 'hibernate' });
		await b.page.close();
		await expect(remoteCursor(a.page, idB)).toHaveCount(0);
		await expect(remoteCursor(c.page, idB)).toHaveCount(0);

		// Everyone leaves; the object is evicted; a late joiner loads the
		// document from storage alone.
		await a.context.close();
		await c.context.close();
		await b.context.close();
		peers = [];
		await evictRoom(room);
		const d = await openPeer(browser, room, baseURL);
		peers = [d];
		expect(await readTexts(d.page)).toEqual(['pre>alpha', 'beta+late', 'gamma!']);
		expect(await readIds(d.page)).toEqual(IDS);
		for (const issue of issues) issue.assertClean();
	});
});
