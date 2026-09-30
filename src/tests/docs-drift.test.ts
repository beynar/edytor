/**
 * Documentation drift guard (UW-44). Behavior rules live once, in the site
 * (`customization/hotkeys#enter-and-backspace-by-role`); the README and
 * AGENTS.md link to it. These phrases are the known fan-out misses: each one
 * is a rule or fact that changed while a copy kept the old wording.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { JSONDoc } from '$lib/utils/json.js';
import { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { validRoomId } from '$lib/crdt/providers/room.js';

const root = join(import.meta.dirname, '../..');

const files = (dir: string, extension = /\.mdx?$/): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? files(path, extension) : extension.test(entry.name) ? [path] : [];
	});

const docs = [
	join(root, 'README.md'),
	join(root, 'AGENTS.md'),
	...files(join(root, 'site/content/docs')),
	// The landing page is documentation too: its Copy install button is the
	// first command a reader runs (XW-05).
	...files(join(root, 'site/pages'), /\.astro$/)
];

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
	version: string;
};
/** A page's text; an Astro page's `${version}` is the package version it renders. */
const pageText = (path: string) => {
	const text = readFileSync(path, 'utf8');
	return path.endsWith('.astro') ? text.replaceAll('${version}', version) : text;
};

const stale: [phrase: string | RegExp, why: string][] = [
	['another list item', 'Enter ends a run under a continuing kind, not only a list item'],
	['serverUrl/roomName are required', 'createWebsocketSync takes { server, room }'],
	['Prism', 'the code plugin highlights with TanStack Highlight'],
	['mention-and-image', 'the mention plugin is not exported; link targets moved'],
	['14003', 'the generation word is 14004 (schema generation 4)'],
	['0.0.x', 'the package is a 0.1.0-next pre-release'],
	[
		/\b(?:npm i|npm install|pnpm add|yarn add|bun add) edytor(?![@\w/.-])/,
		'a bare `edytor` installs the incompatible 0.0.11 from npm; install `edytor@next`'
	],
	['through the `Keymap`', 'the Keymap class is not exported; bindings go through `hotKeys`'],
	[
		'registered to whoever delivers them first',
		'a dial owns its own client id; relayed ids stay unowned (NW-01)'
	],
	[
		"a write under another user's client id",
		"the room strips content under another user's id and keeps the socket open (NW-01)"
	],
	['refuses updates under another user', 'the room strips those updates; it does not refuse them'],
	[
		/\.\.\.semanticsOf\(|build a table with `semanticsOf` and spread it/,
		'a top-level spread replaces the bundled roles; merge `roles`, `rendersContent` and `defaultChild` one by one'
	],
	[
		/also makes what `body` runs one step|`dispatcher\.run\(kind, body\)` \(also a prevention scope\) or/,
		'`run` only groups synchronous commands within the capture window; `transact` is the one-step guarantee (FW-13)'
	],
	[
		/`1008` or `4xxx` close, after which/,
		'`4401` is retried: only `1008` and the other `4xxx` codes are terminal (FW-15)'
	],
	[
		'converts the block holding the selection',
		'a kind command converts every selected or touched block; a replacing kind only the start block (XW-16)'
	],
	[
		/when converting replaces the block's content and children|conversion into this kind replaces the block's/,
		'a replacing kind converts only a block that holds nothing; after content it is inserted after the block (XW-16, DR-docs-6)'
	],
	[
		'Mod+Shift+↑/↓ and Shift+↑/↓ move the focus',
		'the default arrow move plugin claims Mod+Shift+↑/↓ to move a movable block (DR-docs-7)'
	],
	[
		'badge.fury.io/js/edytor',
		"npm's latest is the incompatible 0.0.11 until the pre-release is published (DR-docs-8)"
	],
	[
		'Install the URL your lockfile names again',
		'`pnpm add` of the same URL keeps the pinned hash and fails again; remove the package first (DR-docs-3)'
	],
	[
		'bound to the user who first wrote under it',
		'a client id belongs to the user whose socket dials or binds it; relayed ids stay unowned (NW-01)'
	],
	[
		/split\(['"]\/['"]\)\.pop\(\)|\.slice\(["']\/rooms\/["']\.length\)/,
		'route `/rooms/<id>` by a match and decode the id, as the quick start: the client dials the room name percent-encoded (DR-docs-2, YW-05)'
	]
];

const has = (text: string, phrase: string | RegExp) =>
	typeof phrase === 'string' ? text.includes(phrase) : phrase.test(text);

const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sources(path);
		return /\.(ts|js|svelte)$/.test(entry.name) ? [path] : [];
	});

describe('docs drift', () => {
	it.each(stale)('no doc says "%s" (%s)', (phrase) => {
		const hits = docs
			.filter((path) => has(pageText(path), phrase))
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});

	it('while the version is a pre-release, every install names the tarball the site hosts (FW-03)', () => {
		if (!version.includes('-')) return;
		const config = readFileSync(join(root, 'site/blume.config.ts'), 'utf8');
		const site = /cloudflare\(\{\s*site:\s*["']([^"']+)["']/.exec(config)?.[1];
		expect(site).toBeTruthy();
		const hosted = `${site}/edytor-${version}.tgz`;
		const lines = (path: string) =>
			pageText(path)
				.split('\n')
				.map((line) => [`${relative(root, path)}: ${line.trim()}`, line] as const);
		// Every install of edytor: the hosted tarball, a local build of it, or the tag.
		const installs = docs
			.flatMap(lines)
			.filter(([, line]) =>
				/\b(?:npm i|npm install|pnpm add|yarn add|bun add) \S*edytor/.test(line)
			);
		const allowed = [hosted, `../edytor/edytor-${version}.tgz`, 'edytor@next'];
		expect(installs.filter(([, line]) => !allowed.some((target) => line.includes(target)))).toEqual(
			[]
		);
		// The branch is not on the remote: the README, the install page and the
		// server quick start give the hosted tarball, which needs no clone.
		for (const page of [
			'README.md',
			'site/content/docs/getting-started/index.mdx',
			'site/content/docs/server/quick-start.mdx',
			// The landing page's Copy install button (XW-05).
			'site/pages/_home/Hero.astro'
		])
			expect(pageText(join(root, page)), page).toContain(`pnpm add ${hosted}`);
		// The site serves public/ at its root: the pack stages the tarball there
		// under the documented name, beside every version it served before
		// (XW-15, DR-docs-1; the behavior is pinned in 'the hosted tarballs').
		const pack = readFileSync(join(root, 'site/scripts/pack-edytor.sh'), 'utf8');
		expect(pack).toMatch(/sh site\/scripts\/stage-tarballs\.sh "\$@"/);
		expect(readFileSync(join(root, 'site/scripts/stage-tarballs.sh'), 'utf8')).toMatch(
			/cp site\/vendor\/edytor\.tgz "site\/public\/edytor-\$VERSION\.tgz"/
		);
		expect(servedVersions()).toContain(version);
		// The deploy packs with the guard, targets the account the room uses
		// (several accounts are logged in) and smokes the live URLs (XW-04).
		const deploy = JSON.parse(readFileSync(join(root, 'site/package.json'), 'utf8')).scripts
			.deploy as string;
		const account = /"account_id":\s*"(\w+)"/.exec(
			readFileSync(join(root, 'site/room/wrangler.jsonc'), 'utf8')
		)?.[1];
		expect(account).toBeTruthy();
		const smoke = readFileSync(join(root, 'site/scripts/smoke.sh'), 'utf8');
		for (const path of [
			'/edytor-$VERSION.tgz',
			'/docs/reference/troubleshooting',
			'/docs/getting-started'
		])
			expect(smoke, path).toContain(path);
		// Every tarball a lockfile may pin still answers after the deploy.
		expect(smoke).toContain('served-versions.txt');
		expect(smoke).toMatch(/"\$SITE\/edytor-\$v\.tgz"/);
		// The demo room answers, and a WebSocket dial of a closed day's room from
		// the docs origin gets a 4404 close, which only the current build sends:
		// a plain GET answers 404 on every build (XW-04, DR-docs-4). The deploy
		// redeploys the room, which runs the same packed edytor/cloudflare.
		for (const path of ['/health', 'site/islands/LiveEditor.svelte'])
			expect(smoke, path).toContain(path);
		expect(smoke).toMatch(
			/node site\/scripts\/probe-room\.mjs "\$WSS\/demo-2019-01-01\?guest=smoke-probe-1" "\$SITE" 4404/
		);
		// The site's live editor and the room bundle the edytor pnpm installed,
		// not vendor/edytor.tgz: both reinstall the new pack and are checked
		// before the build (YW-15), and the smoke check checks them again.
		expect(deploy.split(' && ')).toEqual([
			'sh scripts/pack-edytor.sh --deploy',
			'pnpm install',
			'pnpm --dir room install',
			'sh scripts/installed-edytor.sh',
			'blume build',
			`CLOUDFLARE_ACCOUNT_ID=${account} wrangler deploy`,
			'pnpm --dir room run deploy',
			'sh scripts/smoke.sh'
		]);
		expect(smoke).toContain('sh site/scripts/installed-edytor.sh');
		// While `master` holds 0.0.11, a link into its tree is a 404 or old code (DR-docs-5).
		if (/holds 0\.0\.11/.test(config)) {
			const links = docs.filter((path) =>
				/github\.com\/beynar\/edytor\/(?:tree|blob)\//.test(readFileSync(path, 'utf8'))
			);
			expect(links.map((path) => relative(root, path))).toEqual([]);
		}
		// A clone of master builds 0.0.11: any clone line must name its branch.
		const clones = docs
			.flatMap(lines)
			.filter(([, line]) => /git clone .*github\.com\/beynar\/edytor/.test(line));
		expect(clones.filter(([, line]) => !/ -b \S+/.test(line))).toEqual([]);
		const tarballs = docs.flatMap((path) =>
			[...pageText(path).matchAll(/edytor-[\w.<>-]+\.tgz/g)].map(([name]) => name)
		);
		expect(tarballs.filter((name) => name !== `edytor-${version}.tgz`)).toEqual([]);
		// "Edit this page" links built on master would 404.
		expect(config).not.toMatch(/branch:\s*["']master["']/);
	});

	it('every pre-release version a doc names is the package version (YW-14)', () => {
		// A bump must reach the prose too ("a pre-release (`0.1.0-next.N`)"),
		// not only the tarball names checked above. (The engine's own
		// `14.0.0-rc.N` is another package.)
		// Except the migration page's upgrade notes between pre-releases,
		// which may name any version the site served (ZW-15).
		const upgrades = /\n## Upgrading between pre-releases\n[\s\S]*?(?=\n## )/;
		const migration = join(root, 'site/content/docs/reference/migration.mdx');
		const notes = upgrades.exec(pageText(migration))?.[0] ?? '';
		expect(notes).toMatch(/### From 0\.1\.0-next\.0\n/);
		const named = (text: string) =>
			[...text.matchAll(/\b\d+\.\d+\.\d+-next\.\d+\b/g)].map(([mention]) => mention);
		expect(named(notes).filter((mention) => !servedVersions().includes(mention))).toEqual([]);
		const mentions = docs.flatMap((path) => {
			const text = pageText(path);
			return named(path === migration ? text.replace(upgrades, '') : text).map(
				(mention) => `${relative(root, path)}: ${mention}`
			);
		});
		expect(mentions.length).toBeGreaterThan(0);
		expect(mentions.filter((mention) => !mention.endsWith(`: ${version}`))).toEqual([]);
	});

	it('every Worker snippet decodes the room id as the quick start does (YW-05)', () => {
		// The provider percent-encodes the room id; a bare decode throws a
		// URIError (HTTP 500, a 1006 redialed forever) on a malformed one.
		const decode = [
			'try {',
			'documentId = decodeURIComponent(match[1]);',
			'} catch {',
			/return closedSocket\(4400, ["']invalid document id["']\);/
		];
		const routes = docs.filter((path) => pageText(path).includes('decodeURIComponent('));
		expect(routes.map((path) => relative(root, path))).toEqual(
			expect.arrayContaining([
				'site/content/docs/server/quick-start.mdx',
				'site/pages/_home/CodePreview.astro'
			])
		);
		for (const path of routes) {
			const lines = pageText(path)
				.split('\n')
				.map((line) => line.trim());
			const at = lines.findIndex((line) => line === 'try {');
			expect(at, relative(root, path)).toBeGreaterThan(-1);
			decode.forEach((line, i) =>
				expect(lines[at + i], relative(root, path)).toMatch(
					typeof line === 'string'
						? new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
						: line
				)
			);
			expect(pageText(path), relative(root, path)).not.toMatch(
				/decodeURIComponent\(match\[1\]\)\s*[,)]/
			);
		}
		// The demo room the landing's editor dials decodes the same way.
		expect(readFileSync(join(root, 'site/room/src/worker.ts'), 'utf8')).toMatch(
			/try \{\s*return decodeURIComponent\(encoded\);\s*\} catch \{\s*return null;/
		);
	});

	it('every page that says a room id may hold any character names the `.`/`..` exception (ZW-10)', () => {
		for (const page of [
			'collaboration/websocket.mdx',
			'server/authorization.mdx',
			'reference/limitations.mdx',
			'editor/edytor-component.mdx'
		])
			expect(pageText(join(root, 'site/content/docs', page)), page).toMatch(
				/`\.`(?: and | or |, )`\.\.`/
			);
	});

	it('every statement of the room-id rule names each id validRoomId refuses (AW-11)', () => {
		// The refused ids, pinned against the validator: a title cut mid-emoji
		// (`title.slice(0, 40)`) leaves a lone surrogate.
		expect(['', '.', '..', 'x'.repeat(257), 'a\uD83D'].filter(validRoomId)).toEqual([]);
		expect(['x'.repeat(256), '...', '%2E', 'a😀', 'a/b\\c?d#e%f\tg'].every(validRoomId)).toBe(true);
		const rule = /`\.`(?: and | or |, |\/)`\.\.`/;
		const statements = [
			...docs.flatMap((path) =>
				pageText(path)
					.split('\n')
					.map((line, i) => [`${relative(root, path)}:${i + 1}`, line] as const)
			),
			// The docstrings of the code that enforces it.
			...[
				'src/lib/crdt/providers/room.ts',
				'src/lib/crdt/providers/websocket.ts',
				'src/lib/crdt/providers/index.ts',
				'src/lib/cloudflare/routeDocumentSocket.ts',
				'src/lib/components/Edytor.svelte'
			].flatMap((path) =>
				[...readFileSync(join(root, path), 'utf8').matchAll(/\/\*\*[\s\S]*?\*\//g)].map(
					([comment]) => [path, comment] as const
				)
			)
		].filter(([, text]) => rule.test(text));
		expect(statements.length).toBeGreaterThan(10);
		expect(
			statements
				.filter(([, text]) => !/lone surrogate/.test(text) || !/256/.test(text))
				.map(([at]) => at)
		).toEqual([]);
	});

	it('the 0.1.0-next.0 note names exactly the ids its raw dial broke (AW-10)', () => {
		// 0.1.0-next.0 dialed `<server>/<room>?replica=…` with the id unencoded;
		// the quick start's Worker decodes the segment its route matches. Every
		// non-ASCII character is escaped alike by the URL and encodeURIComponent,
		// and a lone surrogate is refused now (validRoomId), so the BMP covers it.
		const route = /^\/rooms\/([^/]+)$/;
		const segment = (id: string) =>
			route.exec(new URL(`wss://rooms.test/rooms/${id}?replica=1`).pathname)?.[1] ?? null;
		const decoded = (id: string) => {
			try {
				return decodeURIComponent(segment(id) ?? '');
			} catch {
				return null;
			}
		};
		const lost: string[] = [];
		const moved: string[] = [];
		for (let code = 0; code < 0x10000; code++) {
			const char = String.fromCharCode(code);
			const id = `a${char}b`;
			if (!validRoomId(id)) continue;
			if (decoded(id) !== id) lost.push(char);
			else if (segment(id) !== encodeURIComponent(id)) moved.push(char);
		}
		// The URL strips tab, LF and CR; the note names them in words.
		expect(lost.filter((char) => char < ' ')).toEqual(['\t', '\n', '\r']);
		const listed = (text: string, lead: string) => {
			const at = text.indexOf(lead);
			expect(at, lead).toBeGreaterThan(-1);
			const list = /^(?:`[^`]+`(?:, | or |))+/.exec(text.slice(at + lead.length))?.[0] ?? '';
			// A table cell escapes `|` even inside code.
			return [...list.matchAll(/`([^`]+)`/g)].map(([, c]) => c.replace(/^\\\|$/, '|')).sort();
		};
		const migration = pageText(join(root, 'site/content/docs/reference/migration.mdx'));
		const troubleshooting = pageText(join(root, 'site/content/docs/reference/troubleshooting.mdx'));
		expect(migration.includes(', a tab or a line break'), 'the note names tab and newline').toBe(
			true
		);
		expect(listed(migration, 'to the same room unless it holds ')).toEqual(
			lost.filter((char) => char >= ' ').sort()
		);
		for (const [text, lead] of [
			[migration, 'sends an id holding '],
			[troubleshooting, 'so an id holding ']
		])
			expect(listed(text, lead), lead).toEqual(moved.sort());
	});

	it('the attachDocument pages list every method the document and the room expose (ZW-16)', () => {
		const source = readFileSync(join(root, 'src/lib/cloudflare/DocumentRoom.ts'), 'utf8');
		const methods = (name: string) => {
			const body = new RegExp(`\\nexport (?:abstract )?class ${name}\\b[\\s\\S]*?\\n\\}\\n`).exec(
				source
			)![0];
			const handlers = /^(?:fetch|alarm|webSocket\w+)$/;
			return [...body.matchAll(/^\t(?:async )?(\w+)(?:<\w+>)?\(/gm)]
				.map(([, method]) => method)
				.filter((method) => method !== 'constructor' && !handlers.test(method));
		};
		const extending = pageText(join(root, 'site/content/docs/server/extending.mdx'));
		const attached = /^- \*\*Return value\.\*\* .*$/m.exec(extending)![0];
		expect(methods('AttachedDocument')).toEqual(
			expect.arrayContaining(['transact', 'compact', 'dropWaitingDeletes', 'reset', 'owns'])
		);
		for (const method of methods('AttachedDocument'))
			expect(attached, method).toContain(`\`${method}`);
		const own = /^Bind and migrate the subclass .*$/m.exec(extending)![0];
		for (const method of ['transact', 'read', 'compact', 'dropWaitingDeletes', 'reset'])
			expect(methods('DocumentRoom'), method).toContain(method);
		for (const method of methods('DocumentRoom').filter((m) => m !== 'records'))
			expect(own, method).toContain(`\`${method}\``);
		const migration = pageText(join(root, 'site/content/docs/reference/migration.mdx'));
		const entry = /`AttachedDocument` \(what `attachDocument` returns[^)]*\)/.exec(migration)![0];
		for (const method of ['transact', 'read', 'compact', 'dropWaitingDeletes', 'reset'])
			expect(entry, method).toContain(`\`${method}\``);
	});

	it('every `edytor.<member>` a doc names exists, unless the doc says it is gone (SW8-docs-1)', () => {
		const source = readFileSync(join(root, 'src/lib/edytor.svelte.ts'), 'utf8');
		const member = (name: string) =>
			new RegExp(`^\\t(?:readonly |get |set |static )*${name}\\b\\s*[=:(!?<]`, 'm').test(source);
		const gone = /removed|is gone|are gone|no longer|replaced|→/;
		const stale = docs.flatMap((path) =>
			pageText(path)
				// One claim per clause: `edytor.a` is X; `edytor.b` is removed.
				.split(/;\s|\.\s|\n/)
				.flatMap((clause) =>
					[...clause.matchAll(/(?<![\w/.-])edytor\.(?!(?:sh|svelte|tgz)\b)(\w+)/g)]
						.filter(([, name]) => !member(name!) && !gone.test(clause))
						.map(([mention]) => `${relative(root, path)}: ${mention}`)
				)
		);
		expect(stale).toEqual([]);
	});

	it('the canonical migration list names every prop, sync option and payload hook added since 0.0.11 (FW-15)', () => {
		const migration = readFileSync(join(root, 'site/content/docs/reference/migration.mdx'), 'utf8');
		const read = (path: string) => readFileSync(join(root, path), 'utf8');
		/** The `name?:` keys of the type literal that starts at `start`. */
		const keys = (source: string, start: string) => {
			const body = source.slice(source.indexOf(start));
			const block = body.slice(0, body.search(/^\t?};/m));
			const depth = /^(\t+)\w+\??:/m.exec(block)?.[1] ?? '\t';
			return [...block.matchAll(new RegExp(`^${depth}(\\w+)\\??:`, 'gm'))].map(([, key]) => key);
		};
		// <Edytor> props 0.0.11 already had.
		const old = new Set(
			'plugins class edytor doc awareness readonly hotKeys onChange onSelectionChange value placeholder sync'.split(
				' '
			)
		);
		const props = keys(read('src/lib/components/Edytor.svelte'), 'export type EdytorProps').filter(
			(key) => !old.has(key)
		);
		const providers = read('src/lib/crdt/providers/index.ts');
		const options = keys(providers, 'export type WebsocketSyncOptions');
		const payload = keys(providers, 'export type EdytorSyncPayload').filter(
			(key) => !['doc', 'awareness', 'synced'].includes(key)
		);
		expect(props).toContain('onSyncExpired');
		expect(options).toContain('connectTimeout');
		expect(payload).toContain('holdBound');
		// Block definition keys 0.0.11 did not have (YW-16).
		const oldDefinition = new Set(
			'snippet void island transformText onFocus onBlur onSelect onDeselect normalizeContent normalizeChildren'.split(
				' '
			)
		);
		const definition = keys(read('src/lib/plugins.ts'), 'export type BlockDefinition = {').filter(
			(key) => !oldDefinition.has(key)
		);
		expect(definition).toContain('lines');
		// Provider getters y-websocket did not have (`saved`, `readOnly`, …).
		const getters = [...read('src/lib/crdt/providers/websocket.ts').matchAll(/^\t\tget (\w+)\(/gm)]
			.map(([, name]) => name!)
			.filter((name) => !['url', 'synced'].includes(name));
		expect(getters).toContain('readOnly');
		// Everything `edytor/cloudflare` exports is new (YW-16).
		const cloudflare = [
			...read('src/lib/cloudflare/index.ts').matchAll(/^\t(?:type )?(\w+),?$/gm)
		].map(([, name]) => name!);
		expect(cloudflare).toContain('MAX_WAITING_DELETES');
		const missing = [
			...props,
			...options,
			...payload,
			...definition,
			...getters,
			...cloudflare
		].filter((key) => !new RegExp(`[\`.]${key}\\b`).test(migration));
		expect(missing).toEqual([]);
		// The facade's range ops take what the view hides (YW-16).
		for (const op of ['deleteRange', 'replaceRange', 'insertFlow'])
			expect(migration, op).toMatch(new RegExp(`\`(?:prepare\\.)?${op}\\([^)\`]*view\\?\\)\``));
		// Close codes a client reacts to, and the provider events that report them.
		for (const term of [
			'`4400`',
			'`4401`',
			'`4403`',
			'`4409`',
			'`1011`',
			'`closedSocket',
			'`expired`',
			'`unreachable`'
		])
			expect(migration, term).toContain(term);
		// The room page lists every close a dial can receive (XW-17).
		const room = read('site/content/docs/server/room.mdx');
		for (const term of [
			'`4400`',
			'`4401`',
			'`4403`',
			'`4409`',
			'`1008`',
			'`1011`',
			'`closedSocket'
		])
			expect(room, term).toContain(term);
		// The entry-point row names every function `edytor/cloudflare` documents.
		const row = read('site/content/docs/getting-started/entry-points.mdx')
			.split('\n')
			.find((line) => line.startsWith('| `edytor/cloudflare`'));
		for (const name of [
			'DocumentRoom',
			'attachDocument',
			'routeDocumentSocket',
			'requestedReplica',
			'closedSocket'
		])
			expect(row, name).toContain(`\`${name}\``);
		// Only 4401 among the 4xxx codes is retried.
		expect(migration).not.toMatch(/`1008` or `4xxx` close,/);
	});

	it("the server quick start's demo-room excerpt is the deployed Worker's code (XW-18)", () => {
		const page = readFileSync(join(root, 'site/content/docs/server/quick-start.mdx'), 'utf8');
		const excerpt = /```ts site\/room\/src\/worker\.ts\n([\s\S]*?)```/.exec(page)?.[1];
		expect(excerpt).toBeTruthy();
		const source = new Set(
			readFileSync(join(root, 'site/room/src/worker.ts'), 'utf8')
				.split('\n')
				.map((line) => line.trim())
		);
		const lines = excerpt!
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
		expect(lines.filter((line) => !source.has(line))).toEqual([]);
	});

	it('the operations page has a payload row for every dispatched operation', () => {
		const page = readFileSync(join(root, 'site/content/docs/plugins/operations.mdx'), 'utf8');
		const names = new Set(
			['src/lib/block', 'src/lib/text']
				.flatMap((dir) => sources(join(root, dir)))
				.concat(join(root, 'src/lib/edytor.svelte.ts'))
				.flatMap((path) => [...readFileSync(path, 'utf8').matchAll(/\bbatch\(\s*'(\w+)'/g)])
				.map(([, name]) => name)
				// Normalization runs inside the command that requested it; hooks never see it.
				.filter((name) => !name.startsWith('normalize'))
		);
		expect(names.size).toBeGreaterThan(20);
		const rows = page.split('\n').filter((line) => line.startsWith('| `'));
		expect([...names].filter((name) => !rows.some((row) => row.includes(`\`${name}\``)))).toEqual(
			[]
		);
	});

	it('no source comment tells a reader to spread semantics (FW-14)', () => {
		// An IDE hover is documentation too: a top-level spread of two configs
		// keeps only the last `roles` and drops the bundled void/island rows.
		const hits = sources(join(root, 'src/lib'))
			.filter((path) => /spread it to extend|\.\.\.semanticsOf\(/i.test(readFileSync(path, 'utf8')))
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});

	it('no source comment says a replacing conversion replaces the content (XW-16, DR-docs-6)', () => {
		const hits = sources(join(root, 'src/lib'))
			.filter((path) =>
				/conversion into this kind replaces the\s+(?:\*\s+)?block's/.test(
					readFileSync(path, 'utf8')
				)
			)
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});

	it('troubleshooting gives an integrity recovery that works (DR-docs-3)', () => {
		// Checked against pnpm 10.32 and npm 11.19 with the bytes swapped under a
		// URL: `pnpm add` of the same URL keeps the pinned hash and fails again;
		// removing the package first works with both.
		const page = readFileSync(
			join(root, 'site/content/docs/reference/troubleshooting.mdx'),
			'utf8'
		);
		const row = page.split('\n').find((line) => line.includes('ERR_PNPM_TARBALL_INTEGRITY'));
		expect(row).toContain('`pnpm remove edytor && pnpm add <that URL>`');
		expect(row).toContain('`npm uninstall edytor && npm install <that URL>`');
	});

	it('no source comment cites a README section (the README is a landing page)', () => {
		const hits = sources(join(root, 'src/lib'))
			.filter((path) => readFileSync(path, 'utf8').includes('README'))
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});
});

/** The versions the site has served, from `site/scripts/served-versions.txt`. */
function servedVersions() {
	return readFileSync(join(root, 'site/scripts/served-versions.txt'), 'utf8')
		.split('\n')
		.map((line) => line.replace(/#.*/, '').trim())
		.filter(Boolean);
}

/**
 * The hosted tarball URL is permanent (getting-started#install): a lockfile
 * pins its integrity, so a deploy neither changes the bytes under a served
 * version (XW-15) nor drops an earlier version (DR-docs-1). These run
 * `stage-tarballs.sh` in a scratch checkout against a local stand-in for the
 * live site.
 */
describe('the hosted tarballs (site/scripts/stage-tarballs.sh)', () => {
	const run = promisify(execFile);

	async function stage(options: {
		version: string;
		served: string[];
		packed: string;
		live: Record<string, string | number>;
		local?: Record<string, string>;
		force?: boolean;
	}) {
		const checkout = mkdtempSync(join(tmpdir(), 'edytor-stage-'));
		mkdirSync(join(checkout, 'site/scripts'), { recursive: true });
		mkdirSync(join(checkout, 'site/vendor'));
		mkdirSync(join(checkout, 'site/public'));
		copyFileSync(
			join(root, 'site/scripts/stage-tarballs.sh'),
			join(checkout, 'site/scripts/stage-tarballs.sh')
		);
		writeFileSync(join(checkout, 'package.json'), JSON.stringify({ version: options.version }));
		writeFileSync(
			join(checkout, 'site/scripts/served-versions.txt'),
			`# served\n${options.served.join('\n')}\n`
		);
		writeFileSync(join(checkout, 'site/vendor/edytor.tgz'), options.packed);
		for (const [name, bytes] of Object.entries(options.local ?? {}))
			writeFileSync(join(checkout, 'site/public', name), bytes);
		const server = createServer((request, response) => {
			const body = options.live[request.url ?? ''];
			if (typeof body === 'string') return response.end(body);
			response.statusCode = body ?? 404;
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			const result = await run('sh', ['site/scripts/stage-tarballs.sh', '--deploy'], {
				cwd: checkout,
				env: { ...process.env, SITE: site, FORCE: options.force ? '1' : '' }
			}).then(
				() => 'staged',
				(error: { stderr: string }) => `refused: ${error.stderr}`
			);
			const publicDir = join(checkout, 'site/public');
			const served = Object.fromEntries(
				readdirSync(publicDir)
					.sort()
					.map((name) => [name, readFileSync(join(publicDir, name), 'utf8')])
			);
			return { result, served };
		} finally {
			server.close();
			rmSync(checkout, { recursive: true, force: true });
		}
	}

	it('a bump keeps serving the earlier version, with its live bytes', async () => {
		const { result, served } = await stage({
			version: '0.1.0-next.1',
			served: ['0.1.0-next.0', '0.1.0-next.1'],
			packed: 'new build',
			live: { '/edytor-0.1.0-next.0.tgz': 'next.0 bytes' },
			// A fresh clone has no local copy; a stale one differs from the live bytes.
			local: { 'edytor-0.1.0-next.0.tgz': 'a local rebuild' }
		});
		expect(result).toBe('staged');
		expect(served).toEqual({
			'edytor-0.1.0-next.0.tgz': 'next.0 bytes',
			'edytor-0.1.0-next.1.tgz': 'new build'
		});
	});

	it('a fresh clone downloads the earlier versions it does not have', async () => {
		const { result, served } = await stage({
			version: '0.1.0-next.2',
			served: ['0.1.0-next.0', '0.1.0-next.1', '0.1.0-next.2'],
			packed: 'new build',
			live: { '/edytor-0.1.0-next.0.tgz': 'zero', '/edytor-0.1.0-next.1.tgz': 'one' }
		});
		expect(result).toBe('staged');
		expect(served).toEqual({
			'edytor-0.1.0-next.0.tgz': 'zero',
			'edytor-0.1.0-next.1.tgz': 'one',
			'edytor-0.1.0-next.2.tgz': 'new build'
		});
	});

	it('new bytes under a served version are refused, and nothing is staged', async () => {
		const { result, served } = await stage({
			version: '0.1.0-next.0',
			served: ['0.1.0-next.0'],
			packed: 'new build',
			live: { '/edytor-0.1.0-next.0.tgz': 'next.0 bytes' },
			local: { 'edytor-0.1.0-next.0.tgz': 'next.0 bytes' }
		});
		expect(result).toMatch(/^refused: .*already serves different bytes/);
		expect(served).toEqual({ 'edytor-0.1.0-next.0.tgz': 'next.0 bytes' });
	});

	it('the same bytes redeploy', async () => {
		const { result, served } = await stage({
			version: '0.1.0-next.0',
			served: ['0.1.0-next.0'],
			packed: 'next.0 bytes',
			live: { '/edytor-0.1.0-next.0.tgz': 'next.0 bytes' }
		});
		expect(result).toBe('staged');
		expect(served).toEqual({ 'edytor-0.1.0-next.0.tgz': 'next.0 bytes' });
	});

	it('an earlier version the site cannot serve right now refuses the deploy', async () => {
		const { result, served } = await stage({
			version: '0.1.0-next.1',
			served: ['0.1.0-next.0', '0.1.0-next.1'],
			packed: 'new build',
			live: { '/edytor-0.1.0-next.0.tgz': 503 }
		});
		expect(result).toMatch(/^refused: .*edytor-0\.1\.0-next\.0\.tgz/);
		expect(served).toEqual({});
	});

	it('a version missing from served-versions.txt is refused (the next deploy would drop it)', async () => {
		const { result } = await stage({
			version: '0.1.0-next.1',
			served: ['0.1.0-next.0'],
			packed: 'new build',
			live: { '/edytor-0.1.0-next.0.tgz': 'zero' }
		});
		expect(result).toMatch(/^refused: .*served-versions\.txt/);
	});

	it('a tarball of an unlisted version is not deployed', async () => {
		const { result, served } = await stage({
			version: '0.1.0-next.0',
			served: ['0.1.0-next.0'],
			packed: 'next.0 bytes',
			live: {},
			local: { 'edytor-0.0.99-dev.tgz': 'dev' }
		});
		expect(result).toBe('staged');
		expect(served).toEqual({ 'edytor-0.1.0-next.0.tgz': 'next.0 bytes' });
	});

	it('FORCE=1 replaces the bytes under a served version', async () => {
		const { result, served } = await stage({
			version: '0.1.0-next.0',
			served: ['0.1.0-next.0'],
			packed: 'new build',
			live: { '/edytor-0.1.0-next.0.tgz': 'next.0 bytes' },
			force: true
		});
		expect(result).toBe('staged');
		expect(served).toEqual({ 'edytor-0.1.0-next.0.tgz': 'new build' });
	});

	it('every served version is still listed', () => {
		expect(existsSync(join(root, 'site/scripts/served-versions.txt'))).toBe(true);
		expect(servedVersions()).toEqual(expect.arrayContaining(['0.1.0-next.0', '0.1.0-next.1']));
	});
});

/**
 * The site's live editor and the demo room bundle the edytor pnpm installed
 * from `site/vendor/edytor.tgz` at their last install, not the tarball itself
 * (YW-15). `installed-edytor.sh` refuses unless both installs hold the packed
 * bytes; pnpm records their integrity in `node_modules/.pnpm/lock.yaml`.
 */
describe('the installed edytor (site/scripts/installed-edytor.sh)', () => {
	const run = promisify(execFile);
	const integrity = (bytes: string) =>
		`sha512-${createHash('sha512').update(bytes).digest('base64')}`;
	const lock = (bytes: string, tarball: string) =>
		`packages:\n\n  edytor@${tarball}:\n    resolution: {integrity: ${integrity(bytes)}, tarball: ${tarball}}\n    version: 0.1.0-next.1\n`;

	async function check(installed: { site?: string; room?: string }) {
		const checkout = mkdtempSync(join(tmpdir(), 'edytor-installed-'));
		mkdirSync(join(checkout, 'site/scripts'), { recursive: true });
		mkdirSync(join(checkout, 'site/vendor'));
		copyFileSync(
			join(root, 'site/scripts/installed-edytor.sh'),
			join(checkout, 'site/scripts/installed-edytor.sh')
		);
		writeFileSync(join(checkout, 'site/vendor/edytor.tgz'), 'new build');
		for (const [dir, bytes, tarball] of [
			['site', installed.site, 'file:vendor/edytor.tgz'],
			['site/room', installed.room, 'file:../vendor/edytor.tgz']
		] as const) {
			if (bytes === undefined) continue;
			mkdirSync(join(checkout, dir, 'node_modules/.pnpm'), { recursive: true });
			writeFileSync(join(checkout, dir, 'node_modules/.pnpm/lock.yaml'), lock(bytes, tarball));
		}
		try {
			return await run('sh', ['site/scripts/installed-edytor.sh'], { cwd: checkout }).then(
				() => 'passed',
				(error: { stderr: string }) => `refused: ${error.stderr.trim()}`
			);
		} finally {
			rmSync(checkout, { recursive: true, force: true });
		}
	}

	it('passes when the site and the room installed the packed bytes', async () => {
		expect(await check({ site: 'new build', room: 'new build' })).toBe('passed');
	});

	it('refuses a site that still bundles an earlier pack', async () => {
		expect(await check({ site: 'old build', room: 'new build' })).toMatch(
			/^refused: .*site\b.*pnpm install/
		);
	});

	it('refuses a room that still bundles an earlier pack', async () => {
		expect(await check({ site: 'new build', room: 'old build' })).toMatch(
			/^refused: .*room.*pnpm --dir room install/
		);
	});

	it('refuses an install that never happened', async () => {
		expect(await check({ site: 'new build' })).toMatch(/^refused: .*room/);
	});
});

/**
 * Claims the docs make about behavior, pinned where a reader would act on
 * them. Expected values are the documented ones (`editor/commands`).
 */
/**
 * The smoke check's demo-room probe (DR-docs-4): it dials like the landing
 * page's editor, with the docs Origin, and passes only on the expected close
 * code. A stand-in room answers the upgrade the way each build did.
 */
describe('the demo-room probe (site/scripts/probe-room.mjs)', () => {
	const run = promisify(execFile);

	async function probe(answer: { status: number } | { close: number }) {
		let origin: string | undefined;
		const server = createServer((_, response) => {
			response.statusCode = 404;
			response.end();
		});
		server.on('upgrade', (request, socket) => {
			origin = request.headers.origin;
			if ('status' in answer) {
				socket.end(`HTTP/1.1 ${answer.status} Not Found\r\nContent-Length: 0\r\n\r\n`);
				return;
			}
			const accept = createHash('sha1')
				.update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
				.digest('base64');
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
					`Sec-WebSocket-Accept: ${accept}\r\n\r\n`
			);
			const reason = Buffer.from('unknown room');
			socket.end(
				Buffer.concat([
					Buffer.from([0x88, 2 + reason.length, answer.close >> 8, answer.close & 0xff]),
					reason
				])
			);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/rooms/demo-2019-01-01?guest=smoke-probe-1`;
		try {
			const result = await run(
				'node',
				['site/scripts/probe-room.mjs', url, 'https://docs.example', '4404'],
				{ cwd: root }
			).then(
				() => 'passed',
				(error: { stderr: string }) => `failed: ${error.stderr.trim()}`
			);
			return { result, origin };
		} finally {
			server.close();
		}
	}

	it('passes on a 4404 close, and dials with the docs Origin', async () => {
		expect(await probe({ close: 4404 })).toEqual({
			result: 'passed',
			origin: 'https://docs.example'
		});
	});

	it('fails on an HTTP 404 at the upgrade (a build before closedSocket)', async () => {
		expect((await probe({ status: 404 })).result).toMatch(/^failed: .*1006.*4404/);
	});

	it('fails on another close code', async () => {
		expect((await probe({ close: 4403 })).result).toMatch(/^failed: .*4403.*4404/);
	});
});

describe('documented command results (editor/commands)', () => {
	const value: JSONDoc = {
		children: ['a', 'b', 'c', 'd'].map((id) => ({
			id,
			type: 'paragraph',
			content: [{ text: id }]
		}))
	};
	const view = (plugins: Plugin[] = []) =>
		new Edytor({ value: structuredClone(value), plugins: [...plugins, richTextPlugin] });
	const ids = (edytor: Edytor) => edytor.root!.children.map((block) => block.id);

	it('a creating command answers null when the document refuses, undefined when it never ran', () => {
		const edytor = view();
		const a = edytor.idToBlock.get('a')!;
		// The document refuses a reused id.
		expect(a.insertBlockAfter({ block: { id: 'b', type: 'paragraph' } })).toBeNull();
		expect(edytor.dispatcher.last?.status).toBe('refused');
		edytor.readonly = true;
		expect(a.insertBlockAfter({ block: { type: 'paragraph' } })).toBeUndefined();
		expect(edytor.dispatcher.last?.status).toBe('refused');
		const vetoed = view([
			() => ({
				onBeforeOperation: ({ operation, prevent }) => operation === 'insertBlockAfter' && prevent()
			})
		]);
		expect(
			vetoed.idToBlock.get('a')!.insertBlockAfter({ block: { type: 'paragraph' } })
		).toBeUndefined();
		expect(vetoed.dispatcher.last?.status).toBe('refused');
		expect(ids(vetoed)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('a direction move keeps document order; a target move keeps the order given', () => {
		const edytor = view();
		const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => edytor.idToBlock.get(id)!);
		edytor.moveBlocks({ blocks: [c!, b!], direction: 'up' });
		expect(ids(edytor)).toEqual(['b', 'c', 'a', 'd']);
		edytor.moveBlocks({ blocks: [a!, b!], target: d!, position: 'after' });
		expect(ids(edytor)).toEqual(['c', 'd', 'a', 'b']);
		edytor.moveBlocks({ blocks: [b!, a!], target: c!, position: 'before' });
		expect(ids(edytor)).toEqual(['b', 'a', 'c', 'd']);
	});

	it('a refused move sets `dispatcher.last`, as every command does (SW8-docs-2)', () => {
		const edytor = view();
		const [a, b] = ['a', 'b'].map((id) => edytor.idToBlock.get(id)!);
		edytor.moveBlocks({ blocks: [b!], direction: 'up' });
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'moveBlock', status: 'applied' });
		// No previous sibling to nest under: the move is structurally refused.
		expect(edytor.moveBlocks({ blocks: [b!], direction: 'in' })).toEqual([]);
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'moveBlock', status: 'refused' });
		edytor.moveBlocks({ blocks: [a!, b!], direction: 'down' });
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'moveBlocks', status: 'applied' });
		edytor.readonly = true;
		expect(edytor.moveBlocks({ blocks: [a!, b!], direction: 'up' })).toEqual([]);
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'moveBlocks', status: 'refused' });
		expect(ids(edytor)).toEqual(['c', 'b', 'a', 'd']);
	});
});
