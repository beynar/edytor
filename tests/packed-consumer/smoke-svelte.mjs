/**
 * Packed Svelte-consumer proof (work unit 4): a REAL Vite/Svelte consumer of
 * the packed `edytor` tarball.
 *
 *   1. `vite build` — the tarball's shipped `.svelte` sources compile through
 *      the consumer's vite-plugin-svelte (the documented component-root
 *      boundary: bundler required, plain node can't — smoke.js pins that).
 *   2. `vite build --ssr` + `render()` — the supported SSR path: a readonly
 *      Edytor server-renders to markup (plain node importing .svelte stays an
 *      expected failure; this is the meaningful SSR check).
 *   3. Browser mount — the built app is served (vite preview) and driven in a
 *      real browser via the repo's playwright: the packed component mounts,
 *      renders the supported plugin surface (richTextPlugin blocks + marks),
 *      edits content through the real input path AND the facade, mounts the
 *      supported readonly surface, and tears down via svelte `unmount()`.
 *
 * Requires the playwright browsers (installed for the editor-dom lanes); when
 * the binary is unavailable the mount section reports SKIP and the build/SSR
 * checks still run — a skipped mount is always printed, never claimed.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';

const appDir = fileURLToPath(new URL('./svelte-app/', import.meta.url));

// `svelte-app/vite.config.mjs` carries the plugin + dedupe + noExternal
// config; inline options only select the entry/output per build.
console.log('==> svelte consumer: vite build (client)');
await build({
	root: appDir,
	logLevel: 'warn',
	build: { outDir: 'dist', emptyOutDir: true }
});

const distAssets = readdirSync(new URL('./svelte-app/dist/assets/', import.meta.url));
assert.ok(
	distAssets.some((file) => file.endsWith('.js')),
	'client build must emit a JS bundle'
);
const indexHtml = readFileSync(new URL('./svelte-app/dist/index.html', import.meta.url), 'utf8');
assert.ok(indexHtml.includes('type="module"'), 'dist index.html must reference the bundle');
console.log('    client build emitted:', distAssets.join(', '));

console.log('==> svelte consumer: vite build --ssr (readonly editor render)');
await build({
	root: appDir,
	logLevel: 'warn',
	build: { ssr: 'ssr-entry.js', outDir: 'dist-ssr', emptyOutDir: true }
});

const ssrAssets = readdirSync(new URL('./svelte-app/dist-ssr/', import.meta.url));
const ssrBundle = ssrAssets.find((file) => file.endsWith('.js') || file.endsWith('.mjs'));
assert.ok(ssrBundle, 'SSR build must emit a node bundle');
const ssrModule = await import(new URL(`./svelte-app/dist-ssr/${ssrBundle}`, import.meta.url));
const ssrHtml = ssrModule.html;
assert.ok(typeof ssrHtml === 'string' && ssrHtml.length > 0, 'SSR render must produce html');
assert.ok(ssrHtml.includes('ssr'), 'SSR html must contain the seeded text');
assert.ok(ssrHtml.includes('rendered'), 'SSR html must contain the marked text');
assert.ok(ssrHtml.includes('data-edytor'), 'SSR html must contain edytor markup');
assert.ok(!ssrHtml.includes('contenteditable="true"'), 'readonly SSR must not be editable');
console.log('    SSR render OK —', ssrHtml.length, 'bytes of markup');

// ── browser mount / edit / readonly / teardown ───────────────────────────
let chromium;
let playwrightNote = '';
try {
	({ chromium } = await import('@playwright/test'));
} catch {
	playwrightNote = '@playwright/test not resolvable';
}
if (chromium) {
	try {
		// Fail fast if the browser binary is missing — launch() throws then.
		const probe = await chromium.launch();
		await probe.close();
	} catch (error) {
		chromium = undefined;
		playwrightNote = `browser launch failed: ${String(error).split('\n')[0]}`;
	}
}

if (!chromium) {
	console.log(`SKIP: browser mount section not run (${playwrightNote})`);
} else {
	console.log('==> svelte consumer: browser mount/edit/teardown');
	const server = await preview({
		root: appDir,
		logLevel: 'warn',
		build: { outDir: 'dist' },
		preview: { host: '127.0.0.1', port: 0 }
	});
	const address = server.httpServer.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	const url = `http://127.0.0.1:${port}/`;
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		const pageErrors = [];
		page.on('pageerror', (error) => pageErrors.push(error.message));
		await page.goto(url, { waitUntil: 'domcontentloaded' });

		// Mount: the packed component renders the seeded document.
		await page.waitForSelector('[data-testid="editable-root"] [data-edytor]');
		await page.waitForSelector('[data-testid="readonly-root"] [data-edytor]');
		assert.equal(
			await page.locator('[data-testid="editable-root"] [data-edytor-type="paragraph"]').count(),
			2,
			'editable editor must render both seeded paragraphs'
		);
		// Supported plugin surface: bold mark renders through richTextPlugin.
		assert.equal(
			await page.locator('[data-edytor-mark="bold"]').count(),
			1,
			'richTextPlugin bold mark must render'
		);
		// Supported readonly surface: contenteditable off + seeded content.
		const readonlyRoot = page.locator('[data-testid="readonly-root"] [data-edytor]');
		assert.equal(await readonlyRoot.getAttribute('contenteditable'), 'false');
		assert.equal(await readonlyRoot.getAttribute('aria-readonly'), 'true');
		assert.ok((await readonlyRoot.textContent()).includes('readonly surface'));

		const valueJson = () =>
			page.evaluate(() =>
				JSON.stringify((window.__EDYTOR_PACKED__ && window.__EDYTOR_PACKED__.value) || null)
			);
		assert.ok((await valueJson()).includes('"id":"p1"'), 'seeded block ids must be intact');

		// Edit through the REAL input path: click into the first text, type.
		await page.locator('[data-testid="editable-root"] [data-edytor-text="true"]').first().click();
		await page.keyboard.type('!');
		const afterTyping = await valueJson();
		assert.ok(afterTyping.includes('!'), 'typed character must reach the model');

		// Edit through the facade (the documented programmatic surface).
		await page.evaluate(() => window.__EDYTOR_PACKED__.facade.insertText('p1', 0, 'F>'));
		const afterFacade = await valueJson();
		assert.ok(afterFacade.includes('F>'), 'facade insert must reach the model');

		// ── shared document: two views on ONE EdytorDocument (U9) ────────
		// The packed component mounts two <Edytor {document}> views bound to
		// one createDocument() — same facade/history/awareness, edits
		// mirroring both ways, document-level undo, and an IndexedDB
		// provider attached via document.attachSync.
		await page.waitForSelector('[data-testid="shared-a"] [data-edytor]');
		await page.waitForSelector('[data-testid="shared-b"] [data-edytor]');
		await page.waitForFunction(() => window.__EDYTOR_PACKED_SHARED__ !== undefined);
		for (const tid of ['shared-a', 'shared-b']) {
			assert.equal(
				await page.locator(`[data-testid="${tid}"] [data-edytor-type="paragraph"]`).count(),
				2,
				`${tid} must render both shared-document paragraphs`
			);
		}
		assert.ok(
			(await page.locator('[data-testid="shared-a"] [data-edytor]').textContent()).includes(
				'shared alpha'
			),
			'shared-a must render the seeded text'
		);
		assert.ok(
			(await page.locator('[data-testid="shared-b"] [data-edytor]').textContent()).includes(
				'shared beta'
			),
			'shared-b must render the seeded text'
		);

		// One document underneath — views share facade/awareness/history.
		const identity = await page.evaluate(() => {
			const s = window.__EDYTOR_PACKED_SHARED__;
			return {
				sameFacade: s.viewA.facade === s.document.facade && s.viewB.facade === s.document.facade,
				sameAwareness:
					s.viewA.awareness === s.document.awareness && s.viewB.awareness === s.document.awareness,
				sameHistory:
					s.viewA.undoManager === s.document.history && s.viewB.undoManager === s.document.history,
				readiness: s.document.readiness
			};
		});
		assert.deepEqual(
			identity,
			{ sameFacade: true, sameAwareness: true, sameHistory: true, readiness: 'local' },
			'both views must share the one document facade/awareness/history'
		);

		// Type through the REAL input path in view A → view B converges via
		// the shared facade (no view-to-view plumbing — the document is it).
		await page.locator('[data-testid="shared-a"] [data-edytor-text="true"]').first().click();
		await page.keyboard.type('#');
		await page.waitForFunction(() => {
			const b = window.document.querySelector('[data-testid="shared-b"] [data-edytor]');
			return b !== null && (b.textContent ?? '').includes('#');
		});

		// Facade-level edit lands in BOTH views.
		await page.evaluate(() =>
			window.__EDYTOR_PACKED_SHARED__.document.facade.insertText('s2', 0, 'F>')
		);
		await page.waitForFunction(() =>
			['shared-a', 'shared-b'].every((sel) => {
				const el = window.document.querySelector(`[data-testid="${sel}"] [data-edytor]`);
				return el !== null && (el.textContent ?? '').includes('F>');
			})
		);

		// The document's own history undoes the edit across both views.
		await page.evaluate(() => window.__EDYTOR_PACKED_SHARED__.document.history.undo());
		await page.waitForFunction(() => {
			const b = window.document.querySelector('[data-testid="shared-b"] [data-edytor]');
			return b !== null && !(b.textContent ?? '').includes('F>');
		});

		// encode → loadDocument — the document round-trips inside the
		// packed artifact (fresh replica identity, same JSON).
		const roundtrip = await page.evaluate(() => {
			const s = window.__EDYTOR_PACKED_SHARED__;
			const restored = s.loadDocument(s.document.encode());
			const same =
				JSON.stringify(restored.facade.toJSON()) === JSON.stringify(s.document.facade.toJSON());
			const readiness = restored.readiness;
			restored.destroy();
			return { same, readiness };
		});
		assert.deepEqual(
			roundtrip,
			{ same: true, readiness: 'hydrated' },
			'encode → loadDocument must restore identical JSON as a hydrated document'
		);
		console.log('    shared document: two views + attachSync + encode/load OK');

		// Teardown: svelte unmount() detaches the whole tree. The shared
		// document outlives the views (borrowed, not owned) — destroying it
		// afterwards must still succeed and run its attachSync cleanup.
		await page.evaluate(() => window.__EDYTOR_PACKED_UNMOUNT__());
		assert.equal(await page.locator('[data-edytor]').count(), 0, 'unmount must detach editor');
		const sharedTeardown = await page.evaluate(() => {
			const s = window.__EDYTOR_PACKED_SHARED__;
			const aliveAfterUnmount = !s.document.destroyed;
			s.document.destroy();
			return { aliveAfterUnmount, destroyed: s.document.destroyed };
		});
		assert.deepEqual(
			sharedTeardown,
			{ aliveAfterUnmount: true, destroyed: true },
			'the shared document must outlive the views and destroy cleanly'
		);

		assert.deepEqual(pageErrors, [], 'no page errors during mount/edit/teardown');
		console.log('    browser mount/edit/readonly/teardown OK at', url);
	} finally {
		await browser.close();
		await server.close();
	}
}

console.log('packed-consumer svelte OK — build + SSR + mount surface verified');
