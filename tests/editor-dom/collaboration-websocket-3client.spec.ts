import type { Browser, BrowserContext, Page } from '@playwright/test';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import * as Y from '../../src/lib/crdt/vendor/yjs/src/index.js';
// This build's frame word (protocol × 1000 + schema) — derived, never pinned.
import { GENERATION } from '../../src/lib/crdt/protocols/envelope.js';
import { expect, test } from './editorTest';
import { gotoEditorRoute, readJsonByTestId, trackPageIssues, waitForEditorReady } from './helpers';
import { startOpaqueRelay, type OpaqueRelay } from './ws-relay';

/**
 * THREE-client real-browser proof over the actual websocket transport —
 * the hardening-Unit-6 extension of `collaboration-websocket.spec.ts`
 * (which covers two independent contexts).
 *
 * Topology: THREE INDEPENDENT browser contexts (separate storage, separate
 * BroadcastChannel domains — and the websocket provider has no
 * BroadcastChannel leg (D-24 G-e), so nothing but the socket can carry
 * updates). Each page
 * mounts the production `Edytor` component with
 * `?scenario=collab&collabws=<room>&wsserver=<relay>` and attaches a real
 * `WebsocketProvider` to its own v14 doc. Frames travel browser → TCP →
 * the local opaque relay (`tests/editor-dom/ws-relay.ts` — the reference
 * implementation of the ONLY supported server topology: room grouping +
 * verbatim binary forwarding, no envelope decoding) → TCP → browsers.
 *
 * The relay's hold/release/permute/duplicates/latency/drop hooks are
 * DELIBERATE harness faults, not transport claims: TCP on a live
 * connection preserves order and never duplicates, so permuted/duplicated
 * delivery is relay-level replay proving the v14 sync protocol converges
 * under adversarial delivery (idempotent update application + state-vector
 * re-handshake), not something TCP could produce on its own.
 *
 * Assertions are SEMANTIC, not just convergence: exact `blockText`/`marks`
 * content per replica, block-identity ownership of split/moved content,
 * provider `synced`/`wsconnected` honesty (including a refused-schema
 * handshake producing NO false sync claim), and selective-undo scoping.
 *
 * The last test drives a ROGUE room member from the Playwright worker: a
 * raw Node `WebSocket` speaking the real v14 envelope but answering
 * SyncStep1 with a SyncStep2 carrying an unsupported application schema
 * (`meta.v = 99`, deterministic LWW winner via max clientID — same recipe
 * as `src/tests/crdt/providers/schema-boundary.test.ts`). Over a real
 * socket this proves the staging boundary refuses the payload AND emits
 * no false `synced`, then that a clean peer joining the room heals the
 * refused client.
 */

type JSONDocValue = {
	type?: string;
	children: Array<Record<string, unknown>>;
};

type ContentPart = { text?: string; marks?: Record<string, unknown>; type?: string };

const roomName = () => `ws3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

const contentParts = (block: Record<string, unknown>) =>
	((block.content ?? []) as ContentPart[]).filter((part) => part.text !== undefined);

const blockText = (block: Record<string, unknown>) =>
	contentParts(block)
		.map((part) => part.text ?? '')
		.join('');

/** `[{text, marks}]` runs — marks normalized to `null` when absent. */
const textRuns = (block: Record<string, unknown>) =>
	contentParts(block).map((part) => ({ text: part.text ?? '', marks: part.marks ?? null }));

const readBlockTexts = async (page: Page) => (await readValue(page)).children.map(blockText);

const readBlockIds = async (page: Page) =>
	(await readValue(page)).children.map((block) => block.id);

/** Poll until all three pages serialize the identical JSON document. */
const expectConverged3 = async (pageA: Page, pageB: Page, pageC: Page, timeout = 15000) => {
	await expect
		.poll(
			async () => {
				const [a, b, c] = await Promise.all([readValue(pageA), readValue(pageB), readValue(pageC)]);
				const sa = JSON.stringify(a);
				return sa === JSON.stringify(b) && sa === JSON.stringify(c);
			},
			{ timeout }
		)
		.toBe(true);
	const [a, b, c] = await Promise.all([readValue(pageA), readValue(pageB), readValue(pageC)]);
	expect(b).toEqual(a);
	expect(c).toEqual(a);
	return a;
};

const insertViaFacade = (
	page: Page,
	payload: { blockId: string; offset: number; text: string; marks?: Record<string, unknown> }
) =>
	page.evaluate(({ blockId, offset, text, marks }) => {
		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
		if (!edytor) {
			throw new Error('Missing editor runtime');
		}
		return edytor.facade.insertText(blockId, offset, text, marks);
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
			// No BroadcastChannel leg (D-24 G-e).
			bcLeg: 'bcconnected' in collab.provider,
			synced: collab.provider.synced
		};
	});

const expectProviderState = (page: Page, expected: Record<string, unknown>, timeout = 10000) =>
	expect.poll(() => getCollabProvider(page), { timeout }).toMatchObject(expected);

/** `provider.disconnect()`/`connect()` — a provider-level single-client partition. */
const setProviderConnected = (page: Page, connected: boolean) =>
	page.evaluate((next) => {
		const collab = (window as Window & { __EDYTOR_COLLAB__?: { provider?: any } })
			.__EDYTOR_COLLAB__;
		if (!collab?.provider) {
			throw new Error('Missing collaboration provider');
		}
		if (next) {
			collab.provider.connect();
		} else {
			collab.provider.disconnect();
		}
	}, connected);

type SocketClients3 = {
	contextA?: BrowserContext;
	contextB?: BrowserContext;
	contextC?: BrowserContext;
	pageA?: Page;
	pageB?: Page;
	pageC?: Page;
};

/** Three independent browser contexts — separate storage AND BC domains. */
const openClients3 = async (
	browser: Browser,
	relay: OpaqueRelay,
	room: string,
	testInfo: { project: { use: { baseURL?: string } } },
	resync = false
): Promise<Required<SocketClients3>> => {
	const baseURL = testInfo.project.use.baseURL;
	const contextA = await browser.newContext({ baseURL });
	const contextB = await browser.newContext({ baseURL });
	const contextC = await browser.newContext({ baseURL });
	const pageA = await contextA.newPage();
	const pageB = await contextB.newPage();
	const pageC = await contextC.newPage();
	await Promise.all([
		openSocketPage(pageA, room, relay, resync),
		openSocketPage(pageB, room, relay, resync),
		openSocketPage(pageC, room, relay, resync)
	]);
	return { contextA, contextB, contextC, pageA, pageB, pageC };
};

const closeClients3 = async (clients: SocketClients3 | undefined) => {
	await clients?.contextA?.close();
	await clients?.contextB?.close();
	await clients?.contextC?.close();
};

/**
 * A rogue room member driven from the Playwright worker: a raw Node
 * `WebSocket` that speaks this generation's envelope (`varuint GENERATION |
 * type | payload` — a same-generation writer) but answers every SyncStep1
 * with a SyncStep2 carrying a forged unsupported-schema stamp (`meta.v = 99` plus marker block
 * `evil-v99`). `clientID = MAX_SAFE_INTEGER` makes the rogue's `meta.v`
 * write win the map-attr LWW merge deterministically — the same recipe as
 * `schema-boundary.test.ts`'s `makeV99Update`. Relayed verbatim like any
 * other member's frames — the refusal under test is the receiving
 * provider's inbound refusal of a foreign stamp (R13, D-2), not transport.
 */
const startRoguePeer = async (relay: OpaqueRelay, room: string) => {
	const rogue = new Y.Doc();
	rogue.clientID = Number.MAX_SAFE_INTEGER;
	rogue.transact(() => rogue.get('meta').setAttr('v', 99));
	const marker = new Y.Node('block');
	marker.setAttr('id', 'evil-v99');
	marker.setAttr('type', 'paragraph');
	rogue.get('blocks').setAttr('evil-v99', marker);
	const rogueState = Y.encodeStateAsUpdate(rogue);
	rogue.destroy();

	// SyncStep2 frame: envelope(GENERATION) | messageSync(0) | subtype SyncStep2(1)
	// | varuint8array(update) — the wire shape `sync.writeSyncStep2` emits.
	const syncStep2Frame = (update: Uint8Array) => {
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, GENERATION);
		encoding.writeVarUint(encoder, 0);
		encoding.writeVarUint(encoder, 1);
		encoding.writeVarUint8Array(encoder, update);
		return encoding.toUint8Array(encoder);
	};

	const ws = new WebSocket(`${relay.url}/${room}`);
	ws.binaryType = 'arraybuffer';
	let replies = 0;
	const opened = new Promise<void>((resolve, reject) => {
		ws.addEventListener('open', () => resolve(), { once: true });
		ws.addEventListener('error', () => reject(new Error('rogue websocket failed to open')), {
			once: true
		});
	});
	ws.addEventListener('message', (event) => {
		try {
			const buffer = new Uint8Array(event.data as ArrayBuffer);
			const decoder = decoding.createDecoder(buffer);
			const version = decoding.readVarUint(decoder);
			const messageType = decoding.readVarUint(decoder);
			if (version !== GENERATION || messageType !== 0) return;
			if (decoding.readVarUint(decoder) !== 0) return; // SyncStep1 only
			ws.send(syncStep2Frame(rogueState));
			replies++;
		} catch {
			// Malformed inbound frame — not ours to handle; ignore.
		}
	});
	await opened;
	return {
		replies: () => replies,
		close: () => ws.close()
	};
};

test.describe('three-client collaboration over a real websocket relay', () => {
	test('converges a concurrent split, marked edit, and move across three contexts', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		let clients: SocketClients3 | undefined;
		try {
			clients = await openClients3(browser, relay, room, testInfo);
			const { pageA, pageB, pageC } = clients;
			const issuesA = trackPageIssues(pageA);
			const issuesB = trackPageIssues(pageB);
			const issuesC = trackPageIssues(pageC);

			// All three providers reached `synced` through the socket handshake —
			// separate browser contexts share no BroadcastChannel (the cross-tab leg
			// exists but reaches only this context's tabs), so there is no other path.
			for (const page of [pageA, pageB, pageC]) {
				await expectProviderState(page, { wsconnected: true, synced: true, bcLeg: true });
			}
			expect(relay.socketCount(room)).toBe(3);

			const seed = await expectConverged3(pageA, pageB, pageC);
			expect(seed.children.map((block) => block.id)).toEqual([
				'collab-b1',
				'collab-b2',
				'collab-b3'
			]);

			// ── Genuinely concurrent ops: the relay holds ALL room frames ────
			// while each client applies only its own op locally.
			relay.hold(room);
			await pageA.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.facade.splitBlock('collab-b2', 2, 'splitA');
			});
			await pageB.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.facade.insertText('collab-b3', 'gamma'.length, '-B', { bold: true });
			});
			await pageC.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.facade.moveBlocks(['collab-b1'], { parent: null, index: Number.MAX_SAFE_INTEGER });
			});
			await pageA.waitForTimeout(300);
			expect(relay.pendingCount(room)).toBeGreaterThanOrEqual(3);

			// Divergence check — each replica saw only its own op.
			expect(await readBlockIds(pageA)).toEqual(['collab-b1', 'collab-b2', 'splitA', 'collab-b3']);
			expect((await readBlockTexts(pageB))[2]).toBe('gamma-B');
			expect(await readBlockIds(pageB)).toEqual(['collab-b1', 'collab-b2', 'collab-b3']);
			expect((await readBlockIds(pageC)).at(-1)).toBe('collab-b1');
			expect((await readBlockTexts(pageC))[0]).toBe('beta');

			// ── Release → merge ─────────────────────────────────────────────
			relay.release(room);
			const converged = await expectConverged3(pageA, pageB, pageC);

			// SEMANTIC assertions — not just "all equal":
			// ownership: the concurrent split partitioned 'beta' into
			// collab-b2='be' + splitA='ta' as separate block identities;
			// the moved block kept id AND content; the marked insert kept its mark.
			expect(converged.children.map((block) => block.id)).toEqual([
				'collab-b2',
				'splitA',
				'collab-b3',
				'collab-b1'
			]);
			const byId = new Map(converged.children.map((block) => [block.id, block]));
			expect(blockText(byId.get('collab-b2')!)).toBe('be');
			expect(blockText(byId.get('splitA')!)).toBe('ta');
			expect(textRuns(byId.get('collab-b3')!)).toEqual([
				{ text: 'gamma', marks: null },
				{ text: '-B', marks: { bold: true } }
			]);
			expect(blockText(byId.get('collab-b1')!)).toBe('alpha');

			// The identical assertions hold when read per-replica — content is
			// not merely equal, it is the same semantic document everywhere.
			for (const page of [pageA, pageB, pageC]) {
				expect(await readBlockTexts(page)).toEqual(['be', 'ta', 'gamma-B', 'alpha']);
				expect(await readBlockIds(page)).toEqual(['collab-b2', 'splitA', 'collab-b3', 'collab-b1']);
			}

			issuesA.assertClean();
			issuesB.assertClean();
			issuesC.assertClean();
		} finally {
			await closeClients3(clients);
			await relay.close();
		}
	});

	test('converges divergent edits after a one-client partition, reconnect and reload', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		let clients: SocketClients3 | undefined;
		try {
			clients = await openClients3(browser, relay, room, testInfo);
			const { pageA, pageB, pageC } = clients;
			const issuesA = trackPageIssues(pageA);
			const issuesB = trackPageIssues(pageB);
			const issuesC = trackPageIssues(pageC);
			await expectConverged3(pageA, pageB, pageC);

			// ── Partition C only: provider-level disconnect keeps the relay ──
			// alive for A↔B while C's socket is closed (deterministic — unlike
			// a socket kill, `disconnect()` sets shouldConnect=false so there is
			// no auto-reconnect racing the offline edit).
			await setProviderConnected(pageC, false);
			await expectProviderState(pageC, { wsconnected: false, synced: false });
			expect(relay.socketCount(room)).toBe(2);
			await expectProviderState(pageA, { wsconnected: true, synced: true });
			await expectProviderState(pageB, { wsconnected: true, synced: true });

			// Concurrent edits on both sides of the partition:
			// A edits b1's text, B marks b2's whole text italic, C (offline)
			// inserts into b3.
			await insertViaFacade(pageA, { blockId: 'collab-b1', offset: 'alpha'.length, text: '-A' });
			await pageB.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.facade.formatRange('collab-b2', 0, 'beta'.length, { italic: true });
			});
			await insertViaFacade(pageC, { blockId: 'collab-b3', offset: 0, text: 'C>' });

			// A and B keep syncing with each other; C's edit stays local to C
			// and A/B's edits never reach it — verified semantically per side.
			await expect
				.poll(async () => {
					const [a, b] = await Promise.all([readBlockTexts(pageA), readBlockTexts(pageB)]);
					return JSON.stringify(a) === JSON.stringify(b);
				})
				.toBe(true);
			expect(await readBlockTexts(pageA)).toEqual(['alpha-A', 'beta', 'gamma']);
			expect(await readBlockTexts(pageB)).toEqual(['alpha-A', 'beta', 'gamma']);
			expect(textRuns((await readValue(pageA)).children[1])).toEqual([
				{ text: 'beta', marks: { italic: true } }
			]);
			expect(await readBlockTexts(pageC)).toEqual(['alpha', 'beta', 'C>gamma']);
			expect(textRuns((await readValue(pageC)).children[1])).toEqual([
				{ text: 'beta', marks: null }
			]);

			// ── Reconnect: connect() re-opens the socket → SyncStep1/2 ──────
			// re-handshake merges both partition halves.
			await setProviderConnected(pageC, true);
			await expectProviderState(pageC, { wsconnected: true, synced: true });

			const converged = await expectConverged3(pageA, pageB, pageC);
			const texts = converged.children.map(blockText);
			expect(texts).toEqual(['alpha-A', 'beta', 'C>gamma']);
			expect(textRuns(converged.children[1])).toEqual([{ text: 'beta', marks: { italic: true } }]);

			// ── Reload heals over the socket alone (no IndexedDB on this ─────
			// route): C remounts with a fresh empty doc, re-handshakes, and
			// receives the full room state — marks included — via SyncStep2.
			await pageC.reload({ waitUntil: 'domcontentloaded' });
			await waitForEditorReady(pageC, { requireRuntime: true });
			const reloaded = await expectConverged3(pageA, pageB, pageC);
			expect(reloaded.children.map(blockText)).toEqual(['alpha-A', 'beta', 'C>gamma']);
			expect(textRuns(reloaded.children[1])).toEqual([{ text: 'beta', marks: { italic: true } }]);

			issuesA.assertClean();
			issuesB.assertClean();
			issuesC.assertClean();
		} finally {
			await closeClients3(clients);
			await relay.close();
		}
	});

	test('converges under permuted, duplicated, delayed and dropped delivery to three clients', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		let clients: SocketClients3 | undefined;
		try {
			clients = await openClients3(browser, relay, room, testInfo, true);
			const { pageA, pageB, pageC } = clients;
			const issuesA = trackPageIssues(pageA);
			const issuesB = trackPageIssues(pageB);
			const issuesC = trackPageIssues(pageC);
			await expectConverged3(pageA, pageB, pageC);

			// ── Held delivery: all three clients' frames buffer at the relay ─
			// (nothing crosses while held — genuine three-way concurrency).
			relay.hold(room);
			await insertViaFacade(pageA, { blockId: 'collab-b1', offset: 0, text: 'A>' });
			await insertViaFacade(pageB, {
				blockId: 'collab-b2',
				offset: 'beta'.length,
				text: '<B',
				marks: { italic: true }
			});
			await insertViaFacade(pageC, {
				blockId: 'collab-b3',
				offset: 0,
				text: 'C>',
				marks: { code: true }
			});
			await pageA.waitForTimeout(300);
			expect(relay.pendingCount(room)).toBeGreaterThanOrEqual(3);
			expect((await readBlockTexts(pageA)).slice(1)).toEqual(['beta', 'gamma']);
			expect((await readBlockTexts(pageB))[0]).toBe('alpha');
			expect((await readBlockTexts(pageC))[0]).toBe('alpha');

			// Deliberate harness replay to all three members: the held batch is
			// delivered PERMUTED and TRIPLICATED — order-insensitive, idempotent
			// application must still converge to the same semantic content.
			// (TCP itself never does this on a live connection — this is the
			// harness-fault distinction, not a transport claim.)
			relay.release(room, { permute: true, duplicates: 3 });
			const converged = await expectConverged3(pageA, pageB, pageC);
			expect(converged.children.map(blockText)).toEqual(['A>alpha', 'beta<B', 'C>gamma']);
			expect(textRuns(converged.children[1])).toEqual([
				{ text: 'beta', marks: null },
				{ text: '<B', marks: { italic: true } }
			]);
			expect(textRuns(converged.children[2])).toEqual([
				{ text: 'C>', marks: { code: true } },
				{ text: 'gamma', marks: null }
			]);

			// ── Deliberate loss: an inbound frame is dropped to BOTH other ───
			// members (dropBudget is consumed per inbound message, so one
			// dropped frame reaches neither B nor C); the provider's periodic
			// resync handshake heals the gap.
			relay.dropNext(room, 1);
			await insertViaFacade(pageA, {
				blockId: 'collab-b1',
				offset: 'A>alpha'.length,
				text: '-L'
			});
			const healed = await expectConverged3(pageA, pageB, pageC, 20000);
			expect(blockText(healed.children[0])).toBe('A>alpha-L');

			// ── Delayed delivery: every forwarded frame waits at the relay ───
			relay.setLatency(room, 60);
			await insertViaFacade(pageB, { blockId: 'collab-b3', offset: 'C>gamma'.length, text: '!' });
			const delayed = await expectConverged3(pageA, pageB, pageC, 20000);
			expect(blockText(delayed.children[2])).toBe('C>gamma!');
			relay.setLatency(room, 0);

			issuesA.assertClean();
			issuesB.assertClean();
			issuesC.assertClean();
		} finally {
			await closeClients3(clients);
			await relay.close();
		}
	});

	test('selective undo removes only the undoing client’s edits across three clients', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		let clients: SocketClients3 | undefined;
		try {
			clients = await openClients3(browser, relay, room, testInfo);
			const { pageA, pageB, pageC } = clients;
			const issuesA = trackPageIssues(pageA);
			const issuesB = trackPageIssues(pageB);
			const issuesC = trackPageIssues(pageC);
			await expectConverged3(pageA, pageB, pageC);

			// One local transaction per client — each page's undo stack holds
			// only its own edits (remote updates carry the provider origin and
			// are filtered out of capture).
			await insertViaFacade(pageA, { blockId: 'collab-b1', offset: 'alpha'.length, text: '-A' });
			await expectConverged3(pageA, pageB, pageC);
			await insertViaFacade(pageB, {
				blockId: 'collab-b3',
				offset: 'gamma'.length,
				text: '-B',
				marks: { bold: true }
			});
			await expectConverged3(pageA, pageB, pageC);
			await insertViaFacade(pageC, { blockId: 'collab-b2', offset: 'beta'.length, text: '-C' });
			const seeded = await expectConverged3(pageA, pageB, pageC);
			expect(seeded.children.map(blockText)).toEqual(['alpha-A', 'beta-C', 'gamma-B']);

			// A's undo removes only '-A' — B's marked '-B' and C's '-C' survive,
			// and the undo inverse itself travels the socket to converge all
			// three replicas semantically (marks included).
			await pageA.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.undoManager.undo();
			});
			const afterUndoA = await expectConverged3(pageA, pageB, pageC);
			expect(afterUndoA.children.map(blockText)).toEqual(['alpha', 'beta-C', 'gamma-B']);
			expect(textRuns(afterUndoA.children[2])).toEqual([
				{ text: 'gamma', marks: null },
				{ text: '-B', marks: { bold: true } }
			]);

			// B's undo removes its marked '-B' — the mark dies with the run it
			// was attached to; A's reverted state and C's '-C' are untouched.
			await pageB.evaluate(() => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				edytor.undoManager.undo();
			});
			const afterUndoB = await expectConverged3(pageA, pageB, pageC);
			expect(afterUndoB.children.map(blockText)).toEqual(['alpha', 'beta-C', 'gamma']);
			expect(textRuns(afterUndoB.children[2])).toEqual([{ text: 'gamma', marks: null }]);
			// Adjacent unmarked runs coalesce in serialization — 'beta-C' is a
			// single markless run.
			expect(textRuns(afterUndoB.children[1])).toEqual([{ text: 'beta-C', marks: null }]);

			issuesA.assertClean();
			issuesB.assertClean();
			issuesC.assertClean();
		} finally {
			await closeClients3(clients);
			await relay.close();
		}
	});

	test('a refused schema handshake claims no sync, then recovers when a clean peer joins', async ({
		browser
	}, testInfo) => {
		const relay = await startOpaqueRelay();
		const room = roomName();
		let clients: SocketClients3 | undefined;
		let rogue: Awaited<ReturnType<typeof startRoguePeer>> | undefined;
		try {
			// The rogue member joins FIRST so it answers the joining client's
			// SyncStep1 with a v99 SyncStep2 before any clean peer can.
			rogue = await startRoguePeer(relay, room);
			expect(relay.socketCount(room)).toBe(1);

			const baseURL = testInfo.project.use.baseURL;
			const contextA = await browser.newContext({ baseURL });
			const pageA = await contextA.newPage();
			clients = { contextA, pageA };
			const issuesA = trackPageIssues(pageA);

			// Plain navigation — the refused client never reaches `synced`, so
			// `waitForEditorReady`'s block-visibility gate would time out by
			// design. The provider exists right after mount, before any sync.
			await pageA.goto(
				`/test/dom?scenario=collab&collabws=${room}&wsserver=${encodeURIComponent(relay.url)}` +
					`&wsresync=200&wsbackoff=400`,
				{ waitUntil: 'domcontentloaded' }
			);
			await expect
				.poll(() =>
					pageA.evaluate(() =>
						Boolean((window as Window & { __EDYTOR_COLLAB__?: unknown }).__EDYTOR_COLLAB__)
					)
				)
				.toBe(true);

			// Capture the refusal signals emitted on the provider.
			await pageA.evaluate(() => {
				const w = window as Window & {
					__EDYTOR_COLLAB__?: { provider?: any };
					__WS_ERRORS__?: { mismatches: any[]; messageErrors: string[] };
				};
				w.__WS_ERRORS__ = { mismatches: [], messageErrors: [] };
				w.__EDYTOR_COLLAB__!.provider.on('schema-mismatch', (detail: any) =>
					w.__WS_ERRORS__!.mismatches.push(detail)
				);
				w.__EDYTOR_COLLAB__!.provider.on('message-error', (error: unknown) =>
					w.__WS_ERRORS__!.messageErrors.push(String((error as Error)?.message ?? error))
				);
			});
			const readErrors = () =>
				pageA.evaluate(
					() =>
						(window as Window & { __WS_ERRORS__?: { mismatches: any[]; messageErrors: string[] } })
							.__WS_ERRORS__ ?? { mismatches: [], messageErrors: [] }
				);

			// The rogue answers each SyncStep1 (initial + every 200 ms resync)
			// with the v99 SyncStep2 — each is staged, refused, and signaled.
			await expect.poll(() => rogue!.replies(), { timeout: 10000 }).toBeGreaterThan(0);
			await expect
				.poll(async () => (await readErrors()).mismatches.length, { timeout: 10000 })
				.toBeGreaterThan(0);
			const errors = await readErrors();
			expect(
				errors.mismatches.some(
					(detail) => detail?.problem?.kind === 'unsupported' && detail?.problem?.version === 99
				)
			).toBe(true);
			expect(errors.messageErrors.some((m) => m.includes('unsupported schema version 99'))).toBe(
				true
			);

			// No false synced: a full second of refused handshakes (≥4 resync
			// cycles) leaves provider.synced false and never admits the marker
			// block. The document is not held hostage by a member it cannot
			// hear: R13 (arch-v2 T3) — an empty document decides once every
			// provider settled OR its readiness bound elapsed, so A is ready
			// with its own deterministic seed of the fixture.
			await pageA.waitForTimeout(1000);
			expect(await getCollabProvider(pageA)).toMatchObject({ wsconnected: true, synced: false });
			await expect
				.poll(() =>
					pageA.evaluate(() =>
						Boolean((window as Window & { __EDYTOR__?: any }).__EDYTOR__?.synced)
					)
				)
				.toBe(true);
			expect(JSON.stringify(await readValue(pageA))).not.toContain('evil-v99');

			// Recovery: clean peers join the same room — their SyncStep2 replies
			// stage clean, apply, and legitimately flip `synced` on A.
			const contextB = await browser.newContext({ baseURL });
			const contextC = await browser.newContext({ baseURL });
			clients.contextB = contextB;
			clients.contextC = contextC;
			const pageB = await contextB.newPage();
			const pageC = await contextC.newPage();
			clients.pageB = pageB;
			clients.pageC = pageC;
			const issuesB = trackPageIssues(pageB);
			const issuesC = trackPageIssues(pageC);
			await Promise.all([openSocketPage(pageB, room, relay), openSocketPage(pageC, room, relay)]);

			await expectProviderState(pageA, { wsconnected: true, synced: true }, 15000);
			const converged = await expectConverged3(pageA, pageB, pageC);
			expect(converged.children.map((block) => block.id)).toEqual([
				'collab-b1',
				'collab-b2',
				'collab-b3'
			]);
			expect(JSON.stringify(converged)).not.toContain('evil-v99');

			issuesA.assertClean();
			issuesB.assertClean();
			issuesC.assertClean();
		} finally {
			rogue?.close();
			await closeClients3(clients);
			await relay.close();
		}
	});
});
