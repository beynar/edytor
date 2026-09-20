import { expect, test, type Page } from './editorTest';
import {
	gotoEditorRoute,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/**
 * Real-browser multi-client proof for the vendored v14 CRDT stack.
 *
 * Topology: two pages in the same browser context, each mounting the real
 * `Edytor` component with `?collab=<room>`. Each page attaches a real
 * `IndexeddbPersistence` provider to its own v14 doc — that provider is the
 * production stack: IndexedDB persistence plus BroadcastChannel cross-context
 * sync on the db-name channel (no external relay, no server).
 *
 * Proven here: concurrent convergence (different + same block), remote caret
 * presence via awareness, selective local undo, cold IndexedDB reload with
 * re-sync, schema-gate refusal of a mismatched document, interleaved stress,
 * and partition/reconnect.
 */

type JSONDocValue = {
	type?: string;
	children: Array<Record<string, unknown>>;
};

const roomName = () => `proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const openCollabPage = async (page: Page, room: string) => {
	await gotoEditorRoute(page, `/test/dom?scenario=collab&collab=${room}`, {
		requireRuntime: true
	});
};

const readValue = (page: Page) => readJsonByTestId<JSONDocValue>(page, 'value');

const readBlockTexts = async (page: Page) =>
	(await readValue(page)).children.map((block) =>
		((block.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('')
	);

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
			bcconnected: collab.provider.bcconnected,
			synced: collab.provider.synced
		};
	});

const setBcConnected = (page: Page, connected: boolean) =>
	page.evaluate((next) => {
		const collab = (window as Window & { __EDYTOR_COLLAB__?: { provider?: any } })
			.__EDYTOR_COLLAB__;
		if (!collab?.provider) {
			throw new Error('Missing collaboration provider');
		}
		if (next) {
			collab.provider.connectBc();
		} else {
			collab.provider.disconnectBc();
		}
	}, connected);

const flushPersistedState = (page: Page) =>
	page.evaluate(async () => {
		const collab = (window as Window & { __EDYTOR_COLLAB__?: { provider?: any } })
			.__EDYTOR_COLLAB__;
		const runtime = (window as Window & { __EDYTOR_COLLABORATION_TEST__?: any })
			.__EDYTOR_COLLABORATION_TEST__;
		if (!collab?.provider || !runtime) {
			throw new Error('Missing collaboration runtime');
		}
		await runtime.storeState(collab.provider);
	});

test.describe('multi-client collaboration over the real provider stack', () => {
	test('converges concurrent edits in different blocks and in the same block', async ({
		context
	}) => {
		const pageA = await context.newPage();
		const pageB = await context.newPage();
		const issuesA = trackPageIssues(pageA);
		const issuesB = trackPageIssues(pageB);
		const room = roomName();

		await openCollabPage(pageA, room);
		await openCollabPage(pageB, room);

		// Deterministic same-id seed dedupes to exactly three blocks on both sides.
		const seed = await expectConverged(pageA, pageB);
		expect(seed.children).toHaveLength(3);
		expect(await readBlockTexts(pageA)).toEqual(['alpha', 'beta', 'gamma']);

		// ── Concurrent typing in DIFFERENT blocks ────────────────────────────
		await setSelectionByTextIndex(pageA, 0, 'alpha'.length);
		await setSelectionByTextIndex(pageB, 2, 'gamma'.length);
		await Promise.all([pageA.keyboard.type('-A'), pageB.keyboard.type('-B')]);

		await expectConverged(pageA, pageB);
		await expect.poll(() => readBlockTexts(pageA)).toEqual(['alpha-A', 'beta', 'gamma-B']);
		expect(await readBlockTexts(pageB)).toEqual(['alpha-A', 'beta', 'gamma-B']);

		// ── Concurrent edits in the SAME block ───────────────────────────────
		await setSelectionByTextIndex(pageA, 1, 0);
		await setSelectionByTextIndex(pageB, 1, 'beta'.length);
		await Promise.all([pageA.keyboard.type('L>'), pageB.keyboard.type('<R')]);

		const converged = await expectConverged(pageA, pageB);
		const middleBlockText = ((converged.children[1].content ?? []) as Array<{ text?: string }>)
			.map((part) => part.text ?? '')
			.join('');
		expect(middleBlockText).toContain('L>');
		expect(middleBlockText).toContain('beta');
		expect(middleBlockText).toContain('<R');

		issuesA.assertClean();
		issuesB.assertClean();
	});

	test('renders the remote caret while the remote client edits', async ({ context }) => {
		const pageA = await context.newPage();
		const pageB = await context.newPage();
		const issuesA = trackPageIssues(pageA);
		const issuesB = trackPageIssues(pageB);
		const room = roomName();

		await openCollabPage(pageA, room);
		await openCollabPage(pageB, room);
		await expectConverged(pageA, pageB);

		const clientIdB = await getClientId(pageB);
		await setSelectionByTextIndex(pageB, 1, 3);

		// B's selection rides awareness over the provider's BroadcastChannel —
		// A must render B's caret element for that client id.
		const remoteCursor = pageA.locator(
			`[data-edytor-remote-cursor][data-client-id="${clientIdB}"]`
		);
		await expect(remoteCursor.first()).toBeVisible({ timeout: 10000 });

		// The caret keeps tracking remote edits.
		await pageB.keyboard.type('xy');
		await expect(remoteCursor.first()).toBeVisible();
		await expectConverged(pageA, pageB);

		issuesA.assertClean();
		issuesB.assertClean();
	});

	test('local undo removes only the local edit and preserves remote text', async ({ context }) => {
		const pageA = await context.newPage();
		const pageB = await context.newPage();
		const issuesA = trackPageIssues(pageA);
		const issuesB = trackPageIssues(pageB);
		const room = roomName();

		await openCollabPage(pageA, room);
		await openCollabPage(pageB, room);
		await expectConverged(pageA, pageB);

		// One local transaction on each side inside the same block.
		await insertViaFacade(pageA, { blockId: 'collab-b1', offset: 'alpha'.length, text: '-A' });
		await expectConverged(pageA, pageB);
		await insertViaFacade(pageB, { blockId: 'collab-b1', offset: 'alpha-A'.length, text: '-B' });
		await expectConverged(pageA, pageB);
		expect((await readBlockTexts(pageA))[0]).toBe('alpha-A-B');

		// A's undo must remove only '-A' — B's remote '-B' survives and the
		// result converges on both sides.
		await pageA.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			edytor.undoManager.undo();
		});
		await expectConverged(pageA, pageB);
		expect((await readBlockTexts(pageA))[0]).toBe('alpha-B');
		expect((await readBlockTexts(pageB))[0]).toBe('alpha-B');

		issuesA.assertClean();
		issuesB.assertClean();
	});

	test('restores document content from IndexedDB after a cold reload and re-syncs', async ({
		context
	}) => {
		const pageA = await context.newPage();
		const pageB = await context.newPage();
		const issuesA = trackPageIssues(pageA);
		const issuesB = trackPageIssues(pageB);
		const room = roomName();

		await openCollabPage(pageA, room);
		await openCollabPage(pageB, room);
		await expectConverged(pageA, pageB);

		await setSelectionByTextIndex(pageA, 0, 'alpha'.length);
		await pageA.keyboard.type('-persisted');
		await expectConverged(pageA, pageB);
		await flushPersistedState(pageA);

		// Cold reload: the editor must re-mount from IndexedDB (not the fixture)
		// and re-join the BroadcastChannel room.
		await pageA.reload({ waitUntil: 'domcontentloaded' });
		await waitForEditorReady(pageA, { requireRuntime: true });

		expect((await readBlockTexts(pageA))[0]).toBe('alpha-persisted');
		await expectConverged(pageA, pageB);

		// Bidirectional liveness after reload — A edits reach B and vice versa.
		await insertViaFacade(pageA, { blockId: 'collab-b2', offset: 0, text: 'A>' });
		await insertViaFacade(pageB, { blockId: 'collab-b2', offset: 0, text: 'B>' });
		const after = await expectConverged(pageA, pageB);
		const middle = ((after.children[1].content ?? []) as Array<{ text?: string }>)
			.map((part) => part.text ?? '')
			.join('');
		expect(middle).toContain('A>');
		expect(middle).toContain('B>');

		issuesA.assertClean();
		issuesB.assertClean();
	});

	test('refuses a mismatched-schema document through the real component', async ({ context }) => {
		const page = await context.newPage();
		const issues = trackPageIssues(page);
		const room = roomName();
		const dbName = `edytor-collab-${room}`;

		// Hand-craft a persisted doc claiming an unsupported schema version,
		// then mount the real editor against the same IndexedDB room.
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
			const provider = new runtime.IndexeddbPersistence(name, bad);
			await provider.whenSynced;
			bad.transact(() => {
				bad.get('meta').setAttr('v', 99);
				bad.get('meta').setAttr('schema', 'edytor');
			});
			await runtime.storeState(provider);
			await provider.destroy();
		}, dbName);

		await page.goto(`/test/dom?scenario=collab&collab=${room}`, {
			waitUntil: 'domcontentloaded'
		});

		// The schema gate must reject the doc inside edytor.sync — the editor
		// stays unsynced, renders no blocks, and reports the refusal.
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						(window as Window & { __EDYTOR_SYNC_ERROR__?: { name?: string } }).__EDYTOR_SYNC_ERROR__
							?.name ?? null
				)
			)
			.toBe('SchemaMismatchError');
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

		issues.assertClean();
	});

	test('converges after interleaved stress edits across both clients', async ({ context }) => {
		const pageA = await context.newPage();
		const pageB = await context.newPage();
		const issuesA = trackPageIssues(pageA);
		const issuesB = trackPageIssues(pageB);
		const room = roomName();

		await openCollabPage(pageA, room);
		await openCollabPage(pageB, room);
		await expectConverged(pageA, pageB);

		// BroadcastChannel delivery cannot be delayed, so concurrency is driven
		// by running both sides' op batches at once — every op is its own
		// transaction, so updates interleave on the wire mid-batch.
		const rounds = 30;
		await Promise.all([
			pageA.evaluate((count) => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				const blocks = ['collab-b1', 'collab-b2', 'collab-b3'];
				for (let i = 0; i < count; i++) {
					edytor.facade.insertText(blocks[i % blocks.length], 0, `a${i}`);
				}
			}, rounds),
			pageB.evaluate((count) => {
				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
				const blocks = ['collab-b1', 'collab-b2', 'collab-b3'];
				for (let i = 0; i < count; i++) {
					if (i % 3 === 0) {
						// Occasional structural op interleaved with text inserts.
						edytor.facade.moveBlocks(['collab-b3'], {
							parent: null,
							index: i % 4
						});
					} else {
						edytor.facade.insertText(blocks[(i * 2 + 1) % blocks.length], 0, `b${i}`);
					}
				}
			}, rounds)
		]);

		const converged = await expectConverged(pageA, pageB, 20000);
		expect(converged.children.length).toBeGreaterThanOrEqual(3);
		// Every A marker survived the interleaving somewhere in the tree.
		const serialized = JSON.stringify(converged);
		for (let i = 0; i < rounds; i++) {
			expect(serialized).toContain(`a${i}`);
		}

		issuesA.assertClean();
		issuesB.assertClean();
	});

	test('converges divergent edits after a partition and reconnect', async ({ context }) => {
		const pageA = await context.newPage();
		const pageB = await context.newPage();
		const issuesA = trackPageIssues(pageA);
		const issuesB = trackPageIssues(pageB);
		const room = roomName();

		await openCollabPage(pageA, room);
		await openCollabPage(pageB, room);
		await expectConverged(pageA, pageB);

		// Partition both sides: BC unsubscribed → no update exchange.
		await setBcConnected(pageA, false);
		await setBcConnected(pageB, false);
		expect(await getCollabProvider(pageA)).toMatchObject({ bcconnected: false });
		expect(await getCollabProvider(pageB)).toMatchObject({ bcconnected: false });

		await insertViaFacade(pageA, { blockId: 'collab-b1', offset: 0, text: 'PA>' });
		await insertViaFacade(pageB, { blockId: 'collab-b3', offset: 0, text: 'PB>' });

		// While partitioned the edits stay local.
		await pageA.waitForTimeout(300);
		expect((await readBlockTexts(pageA))[0]).toBe('PA>alpha');
		expect((await readBlockTexts(pageB))[0]).toBe('alpha');
		expect((await readBlockTexts(pageB))[2]).toBe('PB>gamma');

		// Reconnect: connectBc re-runs sync step 1 + 2 → both sides merge.
		await setBcConnected(pageA, true);
		await setBcConnected(pageB, true);

		const converged = await expectConverged(pageA, pageB);
		const texts = converged.children.map((block) =>
			((block.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('')
		);
		expect(texts[0]).toBe('PA>alpha');
		expect(texts[2]).toBe('PB>gamma');

		issuesA.assertClean();
		issuesB.assertClean();
	});
});
