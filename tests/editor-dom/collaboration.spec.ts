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
			edytor.refreshRemotePresence();
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
});
