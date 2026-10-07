/**
 * Onboarding truth (WU-18, DOC-03/07/08/11/14): what a newcomer reads first
 * must hold. The room's internals live in one table every server page links;
 * the platform page names what the browser lanes run; a getting-started
 * route never server-renders an editable editor; the doc examples a reader
 * copies are type-checked (`pnpm check:docs`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const pages = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? pages(path) : entry.name.endsWith('.mdx') ? [path] : [];
	});
const docs = pages(join(root, 'site/content/docs'));

/** Every fenced block of a page: its language, its meta and its code. */
const fences = (text: string) =>
	[...text.matchAll(/^(\s*)(`{3,})(\w*)[ \t]*(.*)\n([\s\S]*?)^\1\2[ \t]*$/gm)].map(
		([, , , lang, meta, code]) => ({ lang: lang!, meta: meta!, code: code! })
	);
const checked = (meta: string) => /(?:^|\s)check(?:\s|$)/.test(meta);

const INTERNALS = 'site/content/docs/server/internals.mdx';

describe('onboarding truth (WU-18)', () => {
	it('the room internals page names every alarm task and every storage table (DOC-07)', () => {
		const room = read('src/lib/cloudflare/DocumentRoom.ts');
		const tasks = /const TASKS: readonly Task\[\] = \[([^\]]*)\]/
			.exec(room)![1]!
			.match(/'(\w+)'/g)!
			.map((task) => task.slice(1, -1));
		expect(tasks).toEqual(
			expect.arrayContaining(['save', 'history', 'purge', 'retention', 'forward'])
		);
		const tables = [
			...[...room.matchAll(/Table = `\$\{prefix\}(\w+)`/g)].map(([, table]) => table!),
			.../`\$\{tablePrefix\}(\w+)`/.exec(read('src/lib/cloudflare/history.ts'))!.slice(1)
		];
		expect(tables).toEqual(
			expect.arrayContaining([
				'rows',
				'replicas',
				'meta',
				'epochs',
				'restore',
				'moves',
				'late',
				'history'
			])
		);
		const page = read(INTERNALS);
		for (const task of tasks) expect(page, task).toContain(`| \`${task}\``);
		for (const table of tables) {
			expect(page, table).toContain(`\`${table}\``);
			expect(page, table).toContain(`\`edytor_${table}\``);
		}
		// The `meta` keys the room writes.
		for (const key of ['due.<task>', 'updated', 'purged'])
			expect(page, key).toContain(`\`${key}\``);
	});

	it('the server pages link the internals table instead of keeping their own count (DOC-07)', () => {
		for (const path of [
			'site/content/docs/server/room.mdx',
			'site/content/docs/server/history.mdx',
			'site/content/docs/server/moves.mdx',
			'site/content/docs/server/extending.mdx'
		])
			expect(read(path), path).toContain('](/docs/server/internals');
		expect(read('site/content/docs/server/meta.ts')).toContain('"internals"');
		const counts = docs
			.filter((path) =>
				/\b(?:runs (?:two|three|four) tasks|three more tables|document's two tables)\b/.test(
					readFileSync(path, 'utf8')
				)
			)
			.map((path) => relative(root, path));
		expect(counts).toEqual([]);
	});

	it('no page says the version history lives in KV: it is in the store you choose (DOC-08)', () => {
		// The migration page records what each release shipped, KV-only history included.
		const hits = docs
			.filter((path) => !path.endsWith('reference/migration.mdx'))
			.filter((path) =>
				/in your KV namespace|A version history in KV|history in KV/.test(
					readFileSync(path, 'utf8')
				)
			)
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});

	it('the platform support page is in the sidebar and names every engine and device the browser lanes run (DOC-11)', () => {
		expect(read('site/content/docs/reference/meta.ts')).toContain('"platform-support"');
		const page = read('site/content/docs/reference/platform-support.mdx');
		const config = read('playwright.config.ts');
		const devices = [...config.matchAll(/devices\['([^']+)'\]/g)].map(([, device]) => device!);
		expect(devices).toEqual(expect.arrayContaining(['Desktop Chrome', 'Pixel 5', 'iPhone 13']));
		for (const device of devices) expect(page, device).toContain(device);
		// The engine versions the lanes run: the installed Playwright's browsers.
		const require = createRequire(import.meta.url);
		const core = require.resolve('playwright-core/package.json', {
			paths: [require.resolve('@playwright/test/package.json')]
		});
		const { browsers } = JSON.parse(readFileSync(join(core, '../browsers.json'), 'utf8')) as {
			browsers: { name: string; browserVersion?: string }[];
		};
		for (const name of ['chromium', 'firefox', 'webkit']) {
			const version = browsers.find((browser) => browser.name === name)!.browserVersion!;
			expect(page, name).toContain(
				version
					.split('.')
					.slice(0, name === 'webkit' ? 2 : 1)
					.join('.')
			);
		}
		const playwright = (
			JSON.parse(read('package.json')) as { devDependencies: Record<string, string> }
		).devDependencies['@playwright/test']!.replace(/^\D+/, '');
		expect(page).toContain(`Playwright ${playwright.split('.').slice(0, 2).join('.')}`);
		// The Node floor is the package's `engines`.
		const node = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node;
		expect(page).toContain(`Node.js ${node.replace(/^\D+/, '').split('.')[0]}`);
	});

	it('a getting-started route never server-renders an editable editor (DOC-03)', () => {
		for (const path of pages(join(root, 'site/content/docs/getting-started'))) {
			const blocks = fences(readFileSync(path, 'utf8'));
			const ssrOff = blocks.some(
				(block) => /\+page\.ts/.test(block.meta) && /export const ssr = false/.test(block.code)
			);
			for (const block of blocks) {
				if (block.lang !== 'svelte' || !/src\/routes\//.test(block.meta)) continue;
				const editable = [...block.code.matchAll(/<Edytor\b[^>]*>/g)].some(
					([tag]) => !/\breadonly\b/.test(tag)
				);
				if (!editable) continue;
				const mounted = /onMount/.test(block.code) && /\{#if \w+\}/.test(block.code);
				expect(mounted || ssrOff, `${relative(root, path)}: ${block.meta}`).toBe(true);
			}
		}
		// The quick start says so where a reader copies the component.
		expect(read('site/content/docs/getting-started/quick-start.mdx')).toContain(
			'](/docs/getting-started/sveltekit#editable-editors-mount-after-hydration)'
		);
	});

	it('the docs type-check at least 150 examples, and every checked one can be checked (DOC-14)', () => {
		const all = docs.flatMap((path) =>
			fences(readFileSync(path, 'utf8')).map((block) => ({ path, ...block }))
		);
		const examples = all.filter((block) => checked(block.meta));
		expect(examples.length).toBeGreaterThanOrEqual(150);
		for (const { path, lang, meta, code } of examples) {
			const where = `${relative(root, path)}: ${meta}`;
			expect(['ts', 'svelte'], where).toContain(lang);
			// svelte-check reads a component's markup only under TypeScript.
			if (lang === 'svelte') expect(code, where).toMatch(/<script\b[^>]*\blang="ts"/);
		}
	});
});
