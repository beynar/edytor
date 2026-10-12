/**
 * Onboarding truth (WU-18, DOC-03/07/08/11/14): what a newcomer reads first
 * must hold. The room's internals live in one table every server page links;
 * the platform page names what the browser lanes run; a getting-started
 * route renders an editable editor on the server; the doc examples a reader
 * copies are type-checked (`pnpm check:docs`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
			.exec(read('src/lib/cloudflare/room/scheduler.ts'))![1]!
			.match(/'(\w+)'/g)!
			.map((task) => task.slice(1, -1));
		expect(tasks).toEqual(
			expect.arrayContaining(['save', 'history', 'purge', 'retention', 'forward', 'expiry'])
		);
		const tables = [
			...[
				...read('src/lib/cloudflare/room/context.ts').matchAll(/^\t+\w+: `\$\{prefix\}(\w+)`/gm)
			].map(([, table]) => table!),
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
		// `attachRoom` installs `alarm` whatever the options (a move or a socket's
		// expiry can always schedule a task): the page says so, with no condition.
		expect(room).not.toContain("handlers.push('alarm')");
		expect(room).toMatch(/'webSocketError',\s*'alarm'\s*\]/);
		expect(page).toContain('installs an `alarm` handler for you when your class has none, always');
		expect(page).not.toContain('no `onSave`, no `history` and `purgeAfterDays: false`');
		expect(page).not.toMatch(/`onSave` keeps its own backoff/);
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

	it('the supported browsers are Baseline 2024, and the package uses no feature newer than them (DOC-11)', () => {
		// The supported floor: Chrome and Edge, Firefox, Safari (Chrome on Android is Chrome's).
		const BASELINE = [120, 125, 17.4] as const;
		// Each feature's first version (MDN), and how the shipped code spells it. None may
		// need more than the floor; the page names each one the code uses.
		const FEATURES = [
			{ name: '`Intl.Segmenter`', use: /\bIntl\.Segmenter\b/, floor: [87, 125, 14.1] },
			{ name: '`String.prototype.toWellFormed`', use: /\.toWellFormed\(/, floor: [111, 119, 16.4] },
			{ name: 'lookbehind', use: /\(\?<[!=]/, floor: [62, 78, 16.4] },
			{ name: '`Array.prototype.toSorted`', use: /\.toSorted\(/, floor: [110, 115, 16] },
			{ name: '`toReversed`', use: /\.toReversed\(/, floor: [110, 115, 16] },
			{ name: '`ResizeObserver`', use: /\bnew ResizeObserver\(/, floor: [64, 69, 13.1] },
			{ name: '`Element.checkVisibility`', use: /\.checkVisibility\(/, floor: [105, 106, 17.4] },
			{ name: '`color-mix()`', use: /color-mix\(/, floor: [111, 113, 16.2] },
			{ name: 'container queries', use: /@container\b/, floor: [105, 110, 16] },
			{ name: 'unprefixed `mask`', use: /(?<![-\w])mask:/, floor: [120, 53, 15.4] },
			{ name: '`:has()`', use: /:has\(/, floor: [105, 121, 15.4] },
			{ name: '`Object.groupBy`', use: /\b(?:Object|Map)\.groupBy\(/, floor: [117, 119, 17.4] },
			{
				name: '`Promise.withResolvers`',
				use: /\bPromise\.withResolvers\(/,
				floor: [119, 121, 17.4]
			},
			{ name: '`Array.fromAsync`', use: /\bArray\.fromAsync\(/, floor: [121, 115, 16.4] },
			{
				name: 'set methods',
				use: /\.(?:union|intersection|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/,
				floor: [122, 127, 17]
			},
			{
				name: 'iterator helpers',
				use: /\bIterator\.from\(|\.(?:values|keys|entries)\(\)\.(?:map|filter|take|drop|flatMap|reduce|toArray|some|every|find)\(/,
				floor: [122, 131, 18.4]
			}
		] as const;
		const sources = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) return sources(path);
				return /\.(?:ts|js|svelte|css)$/.test(entry.name) && !entry.name.endsWith('.d.ts')
					? [readFileSync(path, 'utf8')]
					: [];
			});
		const shipped = sources(join(root, 'src/lib')).join('\n');
		const used = FEATURES.filter((feature) => feature.use.test(shipped));
		for (const feature of used)
			for (const engine of [0, 1, 2])
				expect(feature.floor[engine], feature.name).toBeLessThanOrEqual(BASELINE[engine]);
		const [chrome, firefox, safari] = BASELINE.map(String);
		const page = read('site/content/docs/reference/platform-support.mdx');
		for (const feature of used) expect(page, feature.name).toContain(feature.name);
		expect(page).toContain(`| Chrome, Edge | ${chrome} |`);
		expect(page).toContain(`| Firefox | ${firefox} |`);
		expect(page).toContain(`| Safari, iOS | ${safari} |`);
		expect(page).toContain(`| Chrome on Android | ${chrome} |`);
		for (const path of [
			'site/content/docs/getting-started/index.mdx',
			'site/content/docs/reference/migration.mdx'
		])
			expect(read(path), path).toContain(`Chrome and Edge ${chrome}, Firefox ${firefox}`);
		expect(read('site/content/docs/getting-started/index.mdx')).toContain(`Safari ${safari}`);
	});

	it('an editable editor server-renders, and only a room waits for the browser (DOC-03)', () => {
		// The getting-started pages mount `<Edytor>` in any route without a guard:
		// `ssr-editable.test.ts` renders it on the server. A route that renders an
		// editor connected to a room mounts it after hydration or turns SSR off.
		expect(existsSync(join(root, 'src/tests/ssr-editable.test.ts'))).toBe(true);
		for (const path of pages(join(root, 'site/content/docs/getting-started'))) {
			const blocks = fences(readFileSync(path, 'utf8'));
			const ssrOff = blocks.some(
				(block) => /\+page\.ts/.test(block.meta) && /export const ssr = false/.test(block.code)
			);
			for (const block of blocks) {
				if (block.lang !== 'svelte' || !/src\/routes\//.test(block.meta)) continue;
				const connected = [...block.code.matchAll(/<Edytor\b[^>]*>/g)].some(
					([tag]) => /\b(?:room|sync)\b/.test(tag) && !/\bsnapshot\b/.test(tag)
				);
				if (!connected) continue;
				const mounted = /onMount/.test(block.code) && /\{#if \w+\}/.test(block.code);
				expect(mounted || ssrOff, `${relative(root, path)}: ${block.meta}`).toBe(true);
			}
		}
		const quickStart = read('site/content/docs/getting-started/quick-start.mdx');
		expect(quickStart).toContain('renders on the server and hydrates');
		expect(quickStart).not.toMatch(/onMount|ssr = false/);
	});

	it('the quick start adds one plugin from the package, and the ready-made menus have their own page', () => {
		const quickStart = read('site/content/docs/getting-started/quick-start.mdx');
		// No copied chrome, no recipe: the quick start imports from `edytor` only.
		expect(quickStart).not.toMatch(/degit|\$lib\/chrome|sed -i/);
		expect(quickStart).toContain('](/docs/customization/ready-made-menus)');
		const readme = read('README.md');
		expect(readme).not.toMatch(/degit|\$lib\/chrome/);
		expect(readme).toContain('/docs/customization/ready-made-menus');
		// The page's recipe is the copy `check:docs` makes before it checks the
		// page's `$lib/chrome/…` fence: `src/routes/chrome` into `src/lib/chrome`,
		// its `$lib/index.js` imports naming `edytor`.
		const page = read('site/content/docs/customization/ready-made-menus.mdx');
		expect(page).toContain('npx degit beynar/edytor/src/routes/chrome src/lib/chrome');
		expect(page).toContain(
			"sed -i.bak 's#\\$lib/index\\.js#edytor#' src/lib/chrome/*.ts src/lib/chrome/*.svelte"
		);
		expect(page).toContain('](https://github.com/beynar/edytor/tree/master/src/routes/chrome)');
		const checker = read('scripts/check-docs.mjs');
		expect(checker).toMatch(/readdirSync\(path\.join\(ROOT, 'src\/routes\/chrome'\)\)/);
		expect(checker).toMatch(/'\$lib\/index\.js',\s*'edytor'/);
		const checkedFence = fences(page).find((block) => checked(block.meta));
		expect(checkedFence?.code).toMatch(/from '\$lib\/chrome\/plugins'/);
		for (const name of checkedFence!.code.match(/\b\w+Plugin\b/g) ?? [])
			expect(read('src/routes/chrome/plugins.ts'), name).toMatch(
				new RegExp(`export const ${name}\\b`)
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
		// The handles a snippet reads (`edytor`, `block`…) are declared for fragments only:
		// a component or module that reads one undeclared fails as it would in an app.
		const declarations = read('scripts/doc-examples/app.d.ts');
		expect(declarations).not.toMatch(/\bconst \w+:/);
		expect(read('scripts/doc-examples/fragments.d.ts')).toMatch(/\bconst edytor:/);
		const script = read('scripts/check-docs.mjs');
		expect(script.match(/'fragments\.d\.ts'/g)).toHaveLength(1);
		expect(script).toContain('tsconfig.fragments.json');
	});

	it("a plugin page's live demo runs the code the page shows, byte for byte", () => {
		const demos = join(root, 'site/demos');
		const folders = readdirSync(demos, { withFileTypes: true }).filter((entry) =>
			entry.isDirectory()
		);
		expect(folders.length).toBeGreaterThan(0);
		const titleOf = (meta: string) =>
			/title="([^"]+)"/.exec(meta)?.[1] ??
			meta.split(/\s+/).find((token) => token && token !== 'check');
		for (const { name } of folders) {
			// A plugin's page, or another page that names the demo (Ready-made menus).
			const page = relative(
				root,
				docs.find((path) =>
					readFileSync(path, 'utf8').includes(`<PluginDemo plugin="${name}" />`)
				) ?? join(root, `site/content/docs/plugins/${name}.mdx`)
			);
			const text = read(page);
			expect(text, page).toContain(`<PluginDemo plugin="${name}" />`);
			const index = read(`site/demos/${name}/index.ts`);
			if (/^\s*custom:/m.test(index))
				expect(text, page).toContain(`<PluginDemo plugin="${name}" variant="custom" />`);
			// Every file but `index.ts` is code a reader copies: a checked fence titled with its name.
			const shown = fences(text).filter((block) => checked(block.meta));
			for (const file of readdirSync(join(demos, name))) {
				if (file === 'index.ts') continue;
				const fence = shown.find((block) => titleOf(block.meta)?.split('/').pop() === file);
				expect(fence, `${page} shows site/demos/${name}/${file} in a check fence`).toBeDefined();
				expect(fence!.code.trimEnd(), `${page}: ${file}`).toBe(
					read(`site/demos/${name}/${file}`).trimEnd()
				);
			}
		}
		// A page names only a demo that exists.
		for (const path of docs)
			for (const [, name] of readFileSync(path, 'utf8').matchAll(/<PluginDemo plugin="([^"]+)"/g))
				expect(
					folders.some((folder) => folder.name === name),
					`${relative(root, path)}: site/demos/${name}/`
				).toBe(true);
	});
});
