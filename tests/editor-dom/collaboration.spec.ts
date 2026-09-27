import { expect, test } from './editorTest';
import { gotoEditorRoute, setSelectionByTextIndex, trackPageIssues } from './helpers';

test.describe('collaboration presence and persistence', () => {
	test('renders remote cursor state from awareness in the browser', async ({ page }) => {
		const issues = trackPageIssues(page);

		await gotoEditorRoute(page, '/test/dom?scenario=selection', { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 5);
		await expect
			.poll(() =>
				page.evaluate(() => {
					const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
					return Boolean(edytor?.awareness.getLocalState()?.selection);
				})
			)
			.toBe(true);

		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			if (!edytor) {
				throw new Error('Missing editor runtime');
			}
			const selection = edytor.awareness.getLocalState()?.selection;
			if (!selection) {
				throw new Error('Missing local awareness selection');
			}

			edytor.awareness.states.set(9001, {
				user: { name: 'Ada', color: '#dc2626' },
				selection
			});
			edytor.awareness.emit('change', [{ added: [9001], updated: [], removed: [] }, 'test']);
			edytor.awareness.emit('update', [{ added: [9001], updated: [], removed: [] }, 'test']);
		});

		const cursor = page.locator('[data-edytor-remote-cursor][data-client-id="9001"]');
		await expect(cursor).toBeVisible();
		await expect(page.locator('[data-edytor-remote-cursor-label]')).toHaveText('Ada');

		issues.assertClean();
	});

	test('reloads document content from IndexedDB persistence while offline', async ({ page }) => {
		await gotoEditorRoute(page, '/test/dom?scenario=basic', { requireRuntime: true });

		const value = await page.evaluate(async () => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			if (!edytor) {
				throw new Error('Missing editor runtime');
			}
			const collaboration = (window as Window & { __EDYTOR_COLLABORATION_TEST__?: any })
				.__EDYTOR_COLLABORATION_TEST__;
			if (!collaboration) {
				throw new Error('Missing collaboration test runtime');
			}
			const { IndexeddbPersistence, clearDocument, storeState } = collaboration;
			const name = `edytor-collaboration-reload-${Date.now()}-${Math.random()}`;
			await clearDocument(name);

			const Doc = edytor.doc.constructor;
			const firstDoc = new Doc();
			const firstProvider = new IndexeddbPersistence(name, firstDoc);
			await firstProvider.whenSynced;
			// v14: unified YNode roots via doc.get(key); text insert takes a string.
			firstDoc.get('note').insert(0, 'saved offline');
			await storeState(firstProvider);
			await firstProvider.destroy();

			const secondDoc = new Doc();
			const secondProvider = new IndexeddbPersistence(name, secondDoc);
			await secondProvider.whenSynced;
			const storedValue = secondDoc.get('note').toArray().join('');
			await secondProvider.destroy();
			await clearDocument(name);
			return storedValue;
		});

		expect(value).toBe('saved offline');
	});

	test('cleans up IndexedDB provider awareness on destroy', async ({ page }) => {
		await gotoEditorRoute(page, '/test/dom?scenario=basic', { requireRuntime: true });

		const didCleanup = await page.evaluate(async () => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			if (!edytor) {
				throw new Error('Missing editor runtime');
			}
			const collaboration = (window as Window & { __EDYTOR_COLLABORATION_TEST__?: any })
				.__EDYTOR_COLLABORATION_TEST__;
			if (!collaboration) {
				throw new Error('Missing collaboration test runtime');
			}
			const { IndexeddbPersistence, clearDocument } = collaboration;
			const name = `edytor-collaboration-awareness-${Date.now()}-${Math.random()}`;
			await clearDocument(name);

			const waitUntil = async (condition: () => boolean) => {
				const start = performance.now();
				while (performance.now() - start < 3000) {
					if (condition()) {
						return true;
					}
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				return false;
			};

			const Doc = edytor.doc.constructor;
			const firstDoc = new Doc();
			const secondDoc = new Doc();
			const firstProvider = new IndexeddbPersistence(name, firstDoc);
			const secondProvider = new IndexeddbPersistence(name, secondDoc);
			await Promise.all([firstProvider.whenSynced, secondProvider.whenSynced]);

			firstProvider.awareness.setLocalStateField('user', {
				name: 'Destroy me',
				color: '#2563eb'
			});
			const propagated = await waitUntil(() =>
				secondProvider.awareness.getStates().has(firstDoc.clientID)
			);
			await firstProvider.destroy();
			const removed = await waitUntil(
				() => !secondProvider.awareness.getStates().has(firstDoc.clientID)
			);
			await secondProvider.destroy();
			await clearDocument(name);

			return propagated && removed;
		});

		expect(didCleanup).toBe(true);
	});
	// arch-v2 F-T16 (browser half): the migration attempt is an origin-wide
	// lock. While one tab holds it, a second tab of the same origin reads
	// `pending` and `migrate({wait: false})` returns `busy` (runbook API, FP-12).
	test('a second tab sees a held migration as pending and busy', async ({ context }) => {
		const pageA = await context.newPage();
		const pageB = await context.newPage();
		await gotoEditorRoute(pageA, '/test/dom?scenario=basic', { requireRuntime: true });
		await gotoEditorRoute(pageB, '/test/dom?scenario=basic', { requireRuntime: true });
		const name = `edytor-ft16-${Date.now()}-${Math.random()}`;

		await pageA.evaluate((name) => {
			const w = window as Window & { __EDYTOR_COLLABORATION_TEST__?: any; __ft16?: any };
			const { migration } = w.__EDYTOR_COLLABORATION_TEST__;
			let release: () => void = () => {};
			const gate = new Promise<void>((r) => (release = r));
			let entered: () => void = () => {};
			const inside = new Promise<void>((r) => (entered = r));
			const done = migration.migrate(name, {
				onPhase: async (phase: string) => {
					if (phase === 'read') {
						entered();
						await gate;
					}
				}
			});
			w.__ft16 = { release, inside, done };
			return inside;
		}, name);

		const seen = await pageB.evaluate(async (name) => {
			const { migration } = (window as Window & { __EDYTOR_COLLABORATION_TEST__?: any })
				.__EDYTOR_COLLABORATION_TEST__;
			const status = (await migration.status(name)).status;
			const busy = (await migration.migrate(name, { wait: false })).status;
			return { status, busy };
		}, name);
		expect(seen).toEqual({ status: 'pending', busy: 'busy' });

		const finished = await pageA.evaluate(async () => {
			const w = window as Window & { __ft16?: any };
			w.__ft16.release();
			return (await w.__ft16.done).status;
		});
		expect(finished).toBe('active');
		const after = await pageB.evaluate(
			async (name) =>
				(
					await (
						window as Window & { __EDYTOR_COLLABORATION_TEST__?: any }
					).__EDYTOR_COLLABORATION_TEST__.migration.status(name)
				).status,
			name
		);
		expect(after).toBe('active');
		await pageA.close();
		await pageB.close();
	});
});
