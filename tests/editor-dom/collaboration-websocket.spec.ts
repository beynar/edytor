import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test } from './editorTest';
import {
	gotoEditorRoute,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';
import { startOpaqueRelay, type OpaqueRelay } from './ws-relay';
import * as decoding from 'lib0-v14/decoding';
import { GENERATION } from '../../src/lib/crdt/protocols/envelope.js';

/**
 * Real-browser multi-client proof over an ACTUAL websocket transport.
 *
 * Topology: TWO INDEPENDENT browser contexts (separate storage, separate
 * BroadcastChannel domains — and the websocket provider has no
 * BroadcastChannel leg (D-24 G-e), so nothing but the socket can carry
 * updates). Each page mounts the
 * production `Edytor` component with
 * `?scenario=collab&collabws=<room>&wsserver=<relay>` which attaches a real
 * `WebsocketProvider` (`src/lib/crdt/providers/websocket.ts`) to its own v14
 * doc. Frames travel browser → TCP → the local opaque relay
 * (`tests/editor-dom/ws-relay.ts`: groups sockets per room, forwards binary
 * payloads verbatim — the documented supported topology) → TCP → browser.
 *
 * The relay's hold/release/permute/duplicates/latency/drop hooks are
 * DELIBERATE harness faults, not transport claims: TCP on a live connection
 * preserves order and never duplicates, so permuted/duplicated delivery is
 * relay-level replay that proves the v14 sync protocol converges under
 * adversarial delivery (idempotent update application + state-vector
 * re-handshake), not something TCP could produce on its own.
 *
 * Proven here: convergence with content+identity assertions, awareness /
 * remote caret, edits through a relay outage and reconnect, held/permuted/
 * duplicated/delayed delivery, selective local undo after remote edits, and
 * the WU1 ownership regressions (concurrent splits then left-edge typing,
 * empty-head split, concurrent structural move) through real sockets.
 */

type JSONDocValue = {
	type?: string;
	children: Array<Record<string, unknown>>;
};

const roomName = () => `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Mount a socket client with the library's default options. `resync` opts
 * into the periodic resync handshake — only the specs that inject harness
 * LOSS (dropped frames, which TCP cannot produce) need it; everything else
 * converges through the join rule alone (arch-v2 T2).
 */
const openSocketPage = async (page: Page, room: string, relay: OpaqueRelay, resync = false) => {
	await gotoEditorRoute(
		page,
		`/test/dom?scenario=collab&collabws=${room}&wsserver=${encodeURIComponent(relay.url)}` +
			`${resync ? '&wsresync=200' : ''}&wsbackoff=400`,
		{ requireRuntime: true }
	);
};

const readValue = (page: Page) => readJsonByTestId<JSONDocValue>(page, 'value');

const blockText = (block: Record<string, unknown>) =>
	((block.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('');

const readBlockTexts = async (page: Page) => (await readValue(page)).children.map(blockText);

const readBlockIds = async (page: Page) =>
	(await readValue(page)).children.map((block) => block.id);

/** Poll until both pages serialize the identical JSON document. */
const expectConverged = async (pageA: Page, pageB: Page, timeout = 15000) => {
	await expect
		.poll(
			async () => {
				const [a, b] = await Promise.all([readValue(pageA), readValue(pageB)]);
				return JSON.stringify(a) === JSON.stringify(b);
			},
			{ timeout }
		)
		.toBe(true);
	const [a, b] = await Promise.all([readValue(pageA), readValue(pageB)]);
	expect(a).toEqual(b);
	return a;
};

const getClientId = (page: Page) =>
	page.evaluate(() => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		if (!edytor) {
			throw new Error('Missing editor runtime');
		}
		return edytor.doc.clientID as number;
	});

const insertViaFacade = (page: Page, payload: { blockId: string; offset: number; text: string }) =>
	page.evaluate(({ blockId, offset, text }) => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		if (!edytor) {
			throw new Error('Missing editor runtime');
		}
		return edytor.facade.insertText(blockId, offset, text);
	}, payload);

const getCollabProvider = (page: Page) =>
	page.evaluate(() => {
		const collab = (window as Window & { __EDYTOR_COLLAB__?: { provider?: any } })
			.__EDYTOR_COLLAB__;
		if (!collab?.provider) {
			throw new Error('Missing collaboration provider');
		}
		return {
			wsconnected: collab.provider.wsconnected,
			// The cross-tab leg exists (on by default); separate contexts never share it.
			bcLeg: 'bcconnected' in collab.provider,
			synced: collab.provider.synced
		};
	});

const expectProviderState = (page: Page, expected: Record<string, unknown>, timeout = 10000) =>
	expect.poll(() => getCollabProvider(page), { timeout }).toMatchObject(expected);

type SocketClients = {
	contextA: BrowserContext;
	contextB: BrowserContext;
	pageA: Page;
	pageB: Page;
};

/** Two independent browser contexts — separate storage AND separate BC domains. */
const openClients = async (
	browser: Browser,
	relay: OpaqueRelay,
	room: string,
	testInfo: { project: { use: { baseURL?: string } } },
	resync = false
): Promise<SocketClients> => {
	const baseURL = testInfo.project.use.baseURL;
	const contextA = await browser.newContext({ baseURL });
	const contextB = await browser.newContext({ baseURL });
	const pageA = await contextA.newPage();
	const pageB = await contextB.newPage();
	await Promise.all([
		openSocketPage(pageA, room, relay, resync),
		openSocketPage(pageB, room, relay, resync)
	]);
	return { contextA, contextB, pageA, pageB };
};

/**
 * Noise the ws reconnect cycle legitimately produces while the relay is down.
 * Chromium/WebKit log a console error ("WebSocket connection to 'ws://…'
 * failed"); Firefox instead raises a pageerror ("Firefox can't establish a
 * connection to the server at ws://…"), so both channels need the pattern.
 */
const WS_RECONNECT_NOISE = [/ws:\/\/127\.0\.0\.1:\d+\//];

test.describe('multi-client collaboration over a real websocket relay', () => {
	test('the first client of a new room is ready after the readiness bound; a joiner converges (F-T6)', async ({
		browser
	}, testInfo) => {
		// arch-v2 T3, R13: alone behind an opaque relay the provider never
		// syncs (P6); with the library defaults the document decides once the
		// readiness bound elapses and seeds its value deterministically.
		const relay = await startOpaqueRelay();
		const room = roomName();
		const baseURL = testInfo.project.use.baseURL;
		const contextA = await browser.newContext({ baseURL });
		const contextB = await browser.newContext({ baseURL });
		try {
			const pageA = await contextA.newPage();
			await openSocketPage(pageA, room, relay);
			await expectProviderState(pageA, { wsconnected: true, synced: false });
			expect(await readBlockIds(pageA)).toEqual(['collab-b1', 'collab-b2', 'collab-b3']);

			const pageB = await contextB.newPage();
			await openSocketPage(pageB, room, relay);
			await expectProviderState(pageB, { wsconnected: true, synced: true });
			const converged = await expectConverged(pageA, pageB);
			expect(converged.children.map((block) => block.id)).toEqual([
				'collab-b1',
				'collab-b2',
				'collab-b3'
			]);
		} finally {
			await contextA.close();
			await contextB.close();
			await relay.close();
		}
	});

	test('converges two independent browser contexts over the socket transport', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		let clients: SocketClients | undefined;
		try {
			clients = await openClients(browser, relay, room, testInfo);
			const { pageA, pageB } = clients;
			const issuesA = trackPageIssues(pageA);
			const issuesB = trackPageIssues(pageB);

			// Both providers reached `synced` through the socket handshake —
			// separate browser contexts share no BroadcastChannel (the cross-tab leg
			// exists but reaches only this context's tabs), so there is no other path.
			await expectProviderState(pageA, { wsconnected: true, synced: true, bcLeg: true });
			await expectProviderState(pageB, { wsconnected: true, synced: true, bcLeg: true });

			// Deterministic same-id seed dedupes to exactly three blocks.
			const seed = await expectConverged(pageA, pageB);
			expect(seed.children.map((block) => block.id)).toEqual([
				'collab-b1',
				'collab-b2',
				'collab-b3'
			]);
			expect(await readBlockTexts(pageA)).toEqual(['alpha', 'beta', 'gamma']);

			// Concurrent real-keyboard typing in DIFFERENT blocks.
			await setSelectionByTextIndex(pageA, 0, 'alpha'.length);
			await setSelectionByTextIndex(pageB, 2, 'gamma'.length);
			await Promise.all([pageA.keyboard.type('-A'), pageB.keyboard.type('-B')]);
			await expectConverged(pageA, pageB);
			expect(await readBlockTexts(pageA)).toEqual(['alpha-A', 'beta', 'gamma-B']);
			expect(await readBlockTexts(pageB)).toEqual(['alpha-A', 'beta', 'gamma-B']);

			// Concurrent edits in the SAME block — both contributions survive.
			await setSelectionByTextIndex(pageA, 1, 0);
			await setSelectionByTextIndex(pageB, 1, 'beta'.length);
			await Promise.all([pageA.keyboard.type('L>'), pageB.keyboard.type('<R')]);
			const converged = await expectConverged(pageA, pageB);
			const middle = blockText(converged.children[1]);
			expect(middle).toContain('L>');
			expect(middle).toContain('beta');
			expect(middle).toContain('<R');

			// Every frame the relay forwarded carries this generation's
			// envelope: the first varuint is GENERATION (protocol × 1000 + schema,
			// derived from the build's constants).
			expect(relay.forwarded.length).toBeGreaterThan(0);
			expect(
				relay.forwarded.every(
					(frame) =>
						decoding.readVarUint(decoding.createDecoder(new Uint8Array(frame))) === GENERATION
				)
			).toBe(true);

			issuesA.assertClean();
			issuesB.assertClean();
		} finally {
			await clients?.contextA.close();
			await clients?.contextB.close();
			await relay.close();
		}
	});

	test('propagates awareness and renders the remote caret over the socket', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		let clients: SocketClients | undefined;
		try {
			clients = await openClients(browser, relay, room, testInfo);
			const { pageA, pageB } = clients;
			const issuesA = trackPageIssues(pageA);
			const issuesB = trackPageIssues(pageB);
			await expectConverged(pageA, pageB);

			const clientIdB = await getClientId(pageB);
			await setSelectionByTextIndex(pageB, 1, 3);

			// B's caret rides messageAwareness frames over the socket into A's DOM.
			const remoteCursor = pageA.locator(
				`[data-edytor-remote-cursor][data-client-id="${clientIdB}"]`
			);
			await expect(remoteCursor.first()).toBeVisible({ timeout: 10000 });

			await pageB.keyboard.type('xy');
			await expect(remoteCursor.first()).toBeVisible();
			await expectConverged(pageA, pageB);
			expect((await readBlockTexts(pageA))[1]).toContain('xy');

			issuesA.assertClean();
			issuesB.assertClean();
		} finally {
			await clients?.contextA.close();
			await clients?.contextB.close();
			await relay.close();
		}
	});

	test('a websocket-only peer that closes its tab drops its caret on the others (F-T9)', async ({
		browser
	}, testInfo) => {
		// arch-v2 §8.6 F-T9 (C13): the departure announcement is the room's,
		// so a socket-only peer announces it exactly as an IndexedDB /
		// BroadcastChannel peer does — well before the 30 s awareness expiry.
		const relay = await startOpaqueRelay();
		const room = roomName();
		let clients: SocketClients | undefined;
		try {
			clients = await openClients(browser, relay, room, testInfo);
			const { pageA, pageB } = clients;
			const issuesA = trackPageIssues(pageA);
			await expectConverged(pageA, pageB);

			const clientIdB = await getClientId(pageB);
			await setSelectionByTextIndex(pageB, 1, 3);
			const remoteCursor = pageA.locator(
				`[data-edytor-remote-cursor][data-client-id="${clientIdB}"]`
			);
			await expect(remoteCursor.first()).toBeVisible({ timeout: 10000 });

			// B closes its tab (the browser runs its unload handlers).
			await pageB.close({ runBeforeUnload: true });
			await expect(remoteCursor).toHaveCount(0, { timeout: 5000 });

			issuesA.assertClean();
		} finally {
			await clients?.contextA.close();
			await clients?.contextB.close();
			await relay.close();
		}
	});

	test('converges divergent edits after a socket kill and a relay restart', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		let clients: SocketClients | undefined;
		try {
			clients = await openClients(browser, relay, room, testInfo);
			const { pageA, pageB } = clients;
			const issuesA = trackPageIssues(pageA, {
				ignoreConsoleErrors: WS_RECONNECT_NOISE,
				ignorePageErrors: WS_RECONNECT_NOISE
			});
			const issuesB = trackPageIssues(pageB, {
				ignoreConsoleErrors: WS_RECONNECT_NOISE,
				ignorePageErrors: WS_RECONNECT_NOISE
			});
			await expectConverged(pageA, pageB);

			// ── Partition flavour 1: sever the sockets, relay stays alive ────
			// The kill is asserted at relay level (synchronous truth — polling
			// `wsconnected:false` in-page races the provider's ~100ms reconnect).
			relay.killRoom(room);
			expect(relay.socketCount(room)).toBe(0);

			// Providers reconnect on their own (relay is still up) and
			// re-handshake → converged without any test-side rewire.
			await expectProviderState(pageA, { wsconnected: true, synced: true });
			await expectProviderState(pageB, { wsconnected: true, synced: true });
			await expectConverged(pageA, pageB);

			// ── Partition flavour 2: kill the whole relay, edit offline ──────
			await relay.stop();
			await expectProviderState(pageA, { wsconnected: false });
			await expectProviderState(pageB, { wsconnected: false });

			await insertViaFacade(pageA, { blockId: 'collab-b1', offset: 0, text: 'PA>' });
			await insertViaFacade(pageB, { blockId: 'collab-b3', offset: 0, text: 'PB>' });

			// While the relay is down the edits stay local — no transport exists.
			await pageA.waitForTimeout(400);
			expect((await readBlockTexts(pageA))[0]).toBe('PA>alpha');
			expect((await readBlockTexts(pageB))[0]).toBe('alpha');
			expect((await readBlockTexts(pageB))[2]).toBe('PB>gamma');

			// Relay restart on the same port → backoff reconnect →
			// SyncStep1/2 handshake replays → both partition edits merge.
			await relay.start();
			await expectProviderState(pageA, { wsconnected: true, synced: true });
			await expectProviderState(pageB, { wsconnected: true, synced: true });

			const converged = await expectConverged(pageA, pageB);
			const texts = converged.children.map(blockText);
			expect(texts[0]).toBe('PA>alpha');
			expect(texts[2]).toBe('PB>gamma');
			expect(converged.children.map((block) => block.id)).toEqual([
				'collab-b1',
				'collab-b2',
				'collab-b3'
			]);

			issuesA.assertClean();
			issuesB.assertClean();
		} finally {
			await clients?.contextA.close();
			await clients?.contextB.close();
			await relay.close();
		}
	});

	test('two tabs of one browser sync over the BroadcastChannel while the server is down (cross-tab by default)', async ({
		browser
	}) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		const context = await browser.newContext();
		try {
			const pageA = await context.newPage();
			const pageB = await context.newPage();
			const issuesA = trackPageIssues(pageA, {
				ignoreConsoleErrors: WS_RECONNECT_NOISE,
				ignorePageErrors: WS_RECONNECT_NOISE
			});
			const issuesB = trackPageIssues(pageB, {
				ignoreConsoleErrors: WS_RECONNECT_NOISE,
				ignorePageErrors: WS_RECONNECT_NOISE
			});
			await openSocketPage(pageA, room, relay);
			await openSocketPage(pageB, room, relay);
			await expectConverged(pageA, pageB);

			// The server goes away: the tabs still reach each other.
			await relay.stop();
			await expectProviderState(pageA, { wsconnected: false });
			await expectProviderState(pageB, { wsconnected: false });
			await insertViaFacade(pageA, { blockId: 'collab-b1', offset: 0, text: 'TA>' });
			await insertViaFacade(pageB, { blockId: 'collab-b3', offset: 0, text: 'TB>' });
			const offline = await expectConverged(pageA, pageB);
			expect(offline.children.map(blockText)[0]).toBe('TA>alpha');
			expect(offline.children.map(blockText)[2]).toBe('TB>gamma');

			// Back online: both reconnect and the server holds both tabs' edits.
			await relay.start();
			await expectProviderState(pageA, { wsconnected: true, synced: true });
			await expectProviderState(pageB, { wsconnected: true, synced: true });
			const pageC = await (await browser.newContext()).newPage();
			await openSocketPage(pageC, room, relay);
			const joined = await expectConverged(pageA, pageC);
			expect(joined.children.map(blockText)[0]).toBe('TA>alpha');
			expect(joined.children.map(blockText)[2]).toBe('TB>gamma');
			await pageC.context().close();

			issuesA.assertClean();
			issuesB.assertClean();
		} finally {
			await context.close();
			await relay.close();
		}
	});

	test('createWebsocketSync keeps offline edits by default: a reload while offline shows them, a fresh client gets them once back online', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		const baseURL = testInfo.project.use.baseURL;
		// The library factory (`wssync=factory`): the socket plus its default local store.
		const path =
			`/test/dom?scenario=collab&collabws=${room}&wsserver=${encodeURIComponent(relay.url)}` +
			`&wsbackoff=400&wssync=factory`;
		const contextA = await browser.newContext({ baseURL });
		const contextB = await browser.newContext({ baseURL });
		try {
			const pageA = await contextA.newPage();
			const issuesA = trackPageIssues(pageA, {
				ignoreConsoleErrors: WS_RECONNECT_NOISE,
				ignorePageErrors: WS_RECONNECT_NOISE
			});
			await gotoEditorRoute(pageA, path, { requireRuntime: true });
			expect(await readBlockTexts(pageA)).toEqual(['alpha', 'beta', 'gamma']);
			await expect.poll(() => relay.socketCount(room)).toBe(1);

			// The server goes away; the edit exists only in this browser.
			await relay.stop();
			await insertViaFacade(pageA, { blockId: 'collab-b1', offset: 0, text: 'OFF>' });
			await pageA.waitForTimeout(300); // let the IndexedDB write land
			await pageA.reload({ waitUntil: 'domcontentloaded' });
			await waitForEditorReady(pageA, { requireRuntime: true });
			expect(await readBlockTexts(pageA)).toEqual(['OFF>alpha', 'beta', 'gamma']);
			expect(relay.socketCount(room)).toBe(0);

			// Back online: the reloaded page redials and a fresh client in another
			// context (its own empty store) converges to include the edit.
			await relay.start();
			await expect.poll(() => relay.socketCount(room)).toBe(1);
			const pageB = await contextB.newPage();
			const issuesB = trackPageIssues(pageB);
			await gotoEditorRoute(pageB, path, { requireRuntime: true });
			const converged = await expectConverged(pageA, pageB);
			expect(converged.children.map(blockText)).toEqual(['OFF>alpha', 'beta', 'gamma']);
			expect(converged.children.map((block) => block.id)).toEqual([
				'collab-b1',
				'collab-b2',
				'collab-b3'
			]);
			issuesA.assertClean();
			issuesB.assertClean();
		} finally {
			await contextA.close();
			await contextB.close();
			await relay.close();
		}
	});

	test('converges under held, permuted, duplicated, delayed and dropped delivery', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		let clients: SocketClients | undefined;
		try {
			clients = await openClients(browser, relay, room, testInfo, true);
			const { pageA, pageB } = clients;
			const issuesA = trackPageIssues(pageA);
			const issuesB = trackPageIssues(pageB);
			await expectConverged(pageA, pageB);

			// ── Held delivery: both sides' frames buffer at the relay ────────
			// (this is what makes the two edits genuinely concurrent — nothing
			// crosses while held, unlike a live TCP connection).
			relay.hold(room);
			await insertViaFacade(pageA, { blockId: 'collab-b1', offset: 0, text: 'PA>' });
			await insertViaFacade(pageB, { blockId: 'collab-b3', offset: 0, text: 'PB>' });
			await pageA.waitForTimeout(300);
			expect(relay.pendingCount(room)).toBeGreaterThanOrEqual(2);
			expect((await readBlockTexts(pageA))[2]).toBe('gamma');
			expect((await readBlockTexts(pageB))[0]).toBe('alpha');

			// Deliberate harness replay: the held batch is delivered PERMUTED
			// and DUPLICATED — order-insensitive, idempotent application must
			// still converge to the same content. (TCP itself never does this
			// on a live connection — this is the harness-fault distinction.)
			relay.release(room, { permute: true, duplicates: 2 });
			const converged = await expectConverged(pageA, pageB);
			const texts = converged.children.map(blockText);
			expect(texts[0]).toBe('PA>alpha');
			expect(texts[2]).toBe('PB>gamma');

			// ── Delayed delivery: every forwarded frame waits at the relay ───
			relay.setLatency(room, 150);
			await insertViaFacade(pageA, { blockId: 'collab-b2', offset: 0, text: 'DA>' });
			await insertViaFacade(pageB, { blockId: 'collab-b2', offset: 'beta'.length, text: '<DB' });
			const delayed = await expectConverged(pageA, pageB);
			const middle = blockText(delayed.children[1]);
			expect(middle).toContain('DA>');
			expect(middle).toContain('beta');
			expect(middle).toContain('<DB');
			relay.setLatency(room, 0);

			// ── Deliberate loss: the next forwarded frames never arrive ──────
			// (a harness fault — TCP can't silently drop mid-connection; the
			// provider's periodic resync handshake is what heals the gap).
			relay.dropNext(room, 2);
			await insertViaFacade(pageA, { blockId: 'collab-b1', offset: 'PA>alpha'.length, text: '-L' });
			const healed = await expectConverged(pageA, pageB, 20000);
			expect(blockText(healed.children[0])).toBe('PA>alpha-L');

			issuesA.assertClean();
			issuesB.assertClean();
		} finally {
			await clients?.contextA.close();
			await clients?.contextB.close();
			await relay.close();
		}
	});

	test('local undo removes only the local edit after remote edits over the socket', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		let clients: SocketClients | undefined;
		try {
			clients = await openClients(browser, relay, room, testInfo);
			const { pageA, pageB } = clients;
			const issuesA = trackPageIssues(pageA);
			const issuesB = trackPageIssues(pageB);
			await expectConverged(pageA, pageB);

			await insertViaFacade(pageA, { blockId: 'collab-b1', offset: 'alpha'.length, text: '-A' });
			await expectConverged(pageA, pageB);
			await insertViaFacade(pageB, { blockId: 'collab-b1', offset: 'alpha-A'.length, text: '-B' });
			await expectConverged(pageA, pageB);
			expect((await readBlockTexts(pageA))[0]).toBe('alpha-A-B');

			// A's undo removes only '-A' — B's remote '-B' survives and the
			// undo inverse itself travels the socket to converge B.
			await pageA.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.undoManager.undo();
			});
			await expectConverged(pageA, pageB);
			expect((await readBlockTexts(pageA))[0]).toBe('alpha-B');
			expect((await readBlockTexts(pageB))[0]).toBe('alpha-B');

			issuesA.assertClean();
			issuesB.assertClean();
		} finally {
			await clients?.contextA.close();
			await clients?.contextB.close();
			await relay.close();
		}
	});

	test('preserves ownership through concurrent splits and a concurrent move over the socket', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		let clients: SocketClients | undefined;
		try {
			clients = await openClients(browser, relay, room, testInfo);
			const { pageA, pageB } = clients;
			const issuesA = trackPageIssues(pageA);
			const issuesB = trackPageIssues(pageB);
			await expectConverged(pageA, pageB);

			// Give collab-b2 a deterministic 14-char text the splits can carve.
			await insertViaFacade(pageA, { blockId: 'collab-b2', offset: 0, text: 'abcdefghij' });
			await expectConverged(pageA, pageB);
			expect((await readBlockTexts(pageA))[1]).toBe('abcdefghijbeta');

			// ── WU1 defect A through real sockets: CONCURRENT splits of the ──
			// same text at different anchors, held then released → collab-b2
			// keeps 'abc', early owns 'defgh', late owns 'ijbeta'.
			relay.hold(room);
			await pageA.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.facade.splitBlock('collab-b2', 3, 'early');
			});
			await pageB.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.facade.splitBlock('collab-b2', 8, 'late');
			});
			relay.release(room);

			const split = await expectConverged(pageA, pageB);
			const byId = new Map(split.children.map((block) => [block.id, blockText(block)]));
			expect(byId.get('collab-b2')).toBe('abc');
			expect(byId.get('early')).toBe('defgh');
			expect(byId.get('late')).toBe('ijbeta');

			// Left-edge insert into the mid partition: the pre-fix defect stole
			// late's atoms (early='Xdefghijbeta', late=''). Required: early='Xdefgh',
			// late='ijbeta' — asserted as ownership AND content on both replicas.
			await insertViaFacade(pageA, { blockId: 'early', offset: 0, text: 'X' });
			const owned = await expectConverged(pageA, pageB);
			const ownedById = new Map(owned.children.map((block) => [block.id, blockText(block)]));
			expect(ownedById.get('collab-b2')).toBe('abc');
			expect(ownedById.get('early')).toBe('Xdefgh');
			expect(ownedById.get('late')).toBe('ijbeta');
			expect(await readBlockIds(pageB)).toEqual(owned.children.map((block) => block.id));

			// ── WU1 defect B through real sockets: split at 0 leaves an EMPTY ─
			// head; typing into it must fill the head, not append to the tail.
			await pageA.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.facade.insertBlock(
					{ parent: null, index: Number.MAX_SAFE_INTEGER },
					{ id: 'wb', type: 'paragraph' }
				);
				edytor.facade.insertText('wb', 0, 'abcdefghij');
			});
			await expectConverged(pageA, pageB);
			await pageB.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.facade.splitBlock('wb', 0, 'wbtail');
				edytor.facade.insertText('wb', 0, 'Z');
			});
			const headTail = await expectConverged(pageA, pageB);
			const headTailById = new Map(headTail.children.map((block) => [block.id, blockText(block)]));
			expect(headTailById.get('wb')).toBe('Z');
			expect(headTailById.get('wbtail')).toBe('abcdefghij');

			// ── Structural move concurrent with remote typing (the 80s-freeze ─
			// regression class): held → A moves collab-b3 to root index 0 while
			// B types into it → released → same id, both edits, moved position.
			relay.hold(room);
			await pageA.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.facade.moveBlocks(['collab-b3'], { parent: null, index: 0 });
			});
			await pageB.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.facade.insertText('collab-b3', 0, 'M>');
			});
			relay.release(room);

			const moved = await expectConverged(pageA, pageB);
			expect(moved.children[0].id).toBe('collab-b3');
			expect(blockText(moved.children[0])).toBe('M>gamma');

			issuesA.assertClean();
			issuesB.assertClean();
		} finally {
			await clients?.contextA.close();
			await clients?.contextB.close();
			await relay.close();
		}
	});

	test('a refused IndexedDB hydration never reports sync success or seeds the fixture', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		const dbName = `edytor-collabws-${room}`;
		const context = await browser.newContext({
			baseURL: testInfo.project.use.baseURL
		});
		const page = await context.newPage();
		try {
			// Seed the persistence store with a schema-refused document BEFORE
			// the collabws mount — the IndexeddbPersistence branch must refuse
			// it at hydration. The pre-fix route ran `whenSynced.then(fireSynced,
			// fireSynced)`: the REJECTION also called fireSynced, so a refused
			// store still seeded the pending doc from the fixture and reported
			// a successful sync.
			await gotoEditorRoute(page, '/test/dom?scenario=basic', { requireRuntime: true });
			await page.evaluate(async (name) => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				const runtime = (window as Window & { __EDYTOR_COLLABORATION_TEST__?: any })
					.__EDYTOR_COLLABORATION_TEST__;
				if (!edytor || !runtime) {
					throw new Error('Missing runtimes');
				}
				await runtime.clearDocument(name);
				const Doc = edytor.doc.constructor;
				const bad = new Doc();
				bad.transact(() => {
					bad.get('meta').setAttr('v', 99);
					bad.get('meta').setAttr('schema', 'edytor');
				});
				await runtime.seedDocument(name, bad);
			}, dbName);

			// No waitForEditorReady — a refused mount renders nothing; the
			// whole point is that synced stays false and no blocks appear.
			await page.goto(
				`/test/dom?scenario=collab&collabws=${room}&wsserver=${encodeURIComponent(relay.url)}` +
					`&wsbackoff=400`,
				{ waitUntil: 'domcontentloaded' }
			);

			// The refusal must surface through the failure channel…
			await expect
				.poll(() =>
					page.evaluate(
						() =>
							(window as Window & { __EDYTOR_SYNC_ERROR__?: { name?: string } })
								.__EDYTOR_SYNC_ERROR__?.name ?? null
					)
				)
				.toBe('SchemaMismatchError');

			// …and never through the readiness path — the pending document
			// must not seed from the fixture even after the ws handshake
			// fires provider 'synced' (fireSynced waits for the local store).
			await expect
				.poll(() =>
					page.evaluate(() => {
						const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
						return Boolean(edytor?.synced);
					})
				)
				.toBe(false);
			await expect(page.locator('[data-edytor-block="true"]')).toHaveCount(0);

			await page.evaluate(async (name) => {
				const runtime = (window as Window & { __EDYTOR_COLLABORATION_TEST__?: any })
					.__EDYTOR_COLLABORATION_TEST__;
				await runtime.clearDocument(name);
			}, dbName);
		} finally {
			await context.close();
			await relay.close();
		}
	});

	test('a remote merge of the caret block re-anchors the caret onto live content', async ({
		browser
	}, testInfo) => {
		test.setTimeout(60_000);
		const relay = await startOpaqueRelay();
		const room = roomName();
		const { contextA, contextB, pageA, pageB } = await openClients(browser, relay, room, testInfo);
		trackPageIssues(pageA, testInfo);
		trackPageIssues(pageB, testInfo);
		try {
			await expectConverged(pageA, pageB);

			const probeCaret = () =>
				pageA.evaluate(() => {
					const state = (window as Window & { __EDYTOR__?: any }).__EDYTOR__?.selection?.state;
					return {
						blockId: state?.startText?.parent?.id ?? state?.startBlock?.id ?? null,
						textLive: state?.startText?.isInDocument ?? null,
						yStart: state?.yStart ?? null
					};
				});

			// A parks a caret inside 'beta'; its text wrapper is captured so a
			// late caret write can target the wrapper after the remote kill.
			await setSelectionByTextIndex(pageA, 1, 2);
			expect((await probeCaret()).blockId).toBe('collab-b2');
			await pageA.evaluate(() => {
				const w = window as Window & { __EDYTOR__?: any; __DEAD__?: unknown };
				w.__DEAD__ = w.__EDYTOR__?.selection?.state?.startText ?? null;
			});

			// B merges b2 into b1 — A's caret block dies remotely.
			await setSelectionByTextIndex(pageB, 1, 0);
			await pageB.keyboard.press('Backspace');
			await expectConverged(pageA, pageB);

			const recovered = await probeCaret();
			expect(recovered).toMatchObject({ blockId: 'collab-b1', textLive: true });

			// The deferred-write path the collab DST caught: a caret write
			// landing after its target died remotely must re-resolve through
			// the dead text's claimed atoms, never commit dead state.
			const deadWrite = await pageA.evaluate(async () => {
				const edytor = (window as Window & { __EDYTOR__?: any; __DEAD__?: any }).__EDYTOR__;
				const deadText = (window as Window & { __DEAD__?: any }).__DEAD__;
				if (!deadText || deadText.isInDocument) {
					return { error: 'captured text was not killed by the merge' };
				}
				await edytor.selection.setAtTextOffset(deadText, 2);
				const state = edytor.selection.state;
				return {
					wroteDead: state.startText?.isInDocument === false,
					blockId: state.startText?.parent?.id ?? state.startBlock?.id ?? null
				};
			});
			expect(deadWrite).toMatchObject({ wroteDead: false, blockId: 'collab-b1' });

			// And the recovered caret is usable — typing lands on live content.
			await pageA.keyboard.type('X');
			await expectConverged(pageA, pageB);
			expect((await readBlockTexts(pageA))[0]).toContain('X');
		} finally {
			await contextA.close();
			await contextB.close();
			await relay.close();
		}
	});
});
