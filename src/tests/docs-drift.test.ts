/**
 * Documentation drift guard (UW-44). Behavior rules live once, in the site
 * (`customization/hotkeys#enter-and-backspace-by-role`); the README and
 * the contributor guide (AGENTS.md and `docs/agents/*.md`) link to it. These phrases are the known fan-out misses: each one
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
import { CLOSE, validRoomId } from '$lib/crdt/providers/room.js';

const root = join(import.meta.dirname, '../..');

const files = (dir: string, extension = /\.mdx?$/): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? files(path, extension) : extension.test(entry.name) ? [path] : [];
	});

/** The contributor guide: the overview, then its topic files. */
const guideFiles = [join(root, 'AGENTS.md'), ...files(join(root, 'docs/agents'))];
const guide = () => guideFiles.map((path) => readFileSync(path, 'utf8')).join('\n\n');

const docs = [
	join(root, 'README.md'),
	...guideFiles,
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
	['not on npm yet', 'the pre-release is on npm under `next`'],
	['Until the pre-release is published', 'the pre-release is on npm under `next`'],
	['still holds 0.0.11', 'GitHub master holds the current source'],
	[
		/alone is a rich text editor[^.]*markdown shortcuts/,
		'markdown shortcuts need markdownShortcutsPlugin'
	],
	['serverUrl/roomName are required', 'createWebsocketSync takes { server, room }'],
	['Prism', 'the code plugin highlights with TanStack Highlight'],
	['mention-and-image', 'the mention plugin is not exported; link targets moved'],
	['14003', 'the generation word is 14004 (schema generation 4)'],
	['0.0.x', 'the package is a 0.1.0-next pre-release'],
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
	],
	[
		/typing, Enter or a paste/,
		'Enter over a block selection removes nothing, so it never runs onDeleteSelectedBlocks (DR-behavior-3)'
	],
	[
		/Shift\+Enter\/composition|Enter over selected text blocks/,
		'Enter and Shift+Enter over a block selection remove nothing and never ask keepsSelectedBlocks (EW-10)'
	],
	[
		/is `new Y\.Doc\(\)` (?:followed by|\+) `Y\.applyUpdate|`new Y\.Doc\(options\)` on the bound engine\. \||const doc = new Y\.Doc\(\);\s*Y\.applyUpdate/,
		"a bare `new Y.Doc()` lacks edytor's keep-replaced rule: a document that integrates edytor content is `bindCrdt(Y).createDoc()`"
	],
	[
		/\(a list, a code block\)/,
		'a code block is an island: never removed with its lines; an emptied list goes but is not named (EW-08)'
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
	// The site build is strict: a page whose front matter is not valid YAML is
	// left out and fails the deploy. A plain scalar cannot hold ': ' (or open
	// with a YAML indicator); such a value is quoted.
	it('every page front matter is valid YAML (a value holding ": " is quoted)', () => {
		const bad = docs
			.filter((path) => path.endsWith('.mdx'))
			.flatMap((path) => {
				const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, 'utf8'))?.[1] ?? '';
				return front
					.split('\n')
					.map((line) => /^(\w+):\s+(.*)$/.exec(line))
					.filter((match): match is RegExpExecArray => match !== null)
					.filter(
						([, , value]) =>
							!/^["'[{|>]/.test(value!) && (/: /.test(value!) || /^[@`%&*!]/.test(value!))
					)
					.map(([line]) => `${relative(root, path)}: ${line}`);
			});
		expect(bad).toEqual([]);
	});
	it('the package carries the license the README badge names (MIT)', () => {
		const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
			license?: string;
		};
		expect(pkg.license).toBe('MIT');
		expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toMatch(/^MIT License/);
		expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('License-MIT');
	});

	it.each(stale)('no doc says "%s" (%s)', (phrase) => {
		const hits = docs
			.filter((path) => has(pageText(path), phrase))
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});

	it('every install names the npm tag the version is published under: `edytor@next` for a -next pre-release, a bare `edytor` from the release candidate on (FW-03)', () => {
		const channel = /-next\./.test(version) ? 'edytor@next' : 'edytor';
		const config = readFileSync(join(root, 'site/blume.config.ts'), 'utf8');
		const site = /cloudflare\(\{\s*site:\s*["']([^"']+)["']/.exec(config)?.[1];
		expect(site).toBeTruthy();
		const hosted = `${site}/edytor-${version}.tgz`;
		const lines = (path: string) =>
			pageText(path)
				.split('\n')
				.map((line) => [`${relative(root, path)}: ${line.trim()}`, line] as const);
		// Every install of edytor: the npm tag, or a local build of the tarball.
		// The changelog's history names the installs of its time.
		const changelog = join(root, 'site/content/docs/reference/migration.mdx');
		const installs = docs
			.filter((path) => path !== changelog)
			.flatMap(lines)
			.filter(([, line]) =>
				/\b(?:npm i|npm install|pnpm add|yarn add|bun add) \S*edytor/.test(line)
			);
		const named = (line: string) =>
			line.includes(`../edytor/edytor-${version}.tgz`) ||
			(channel === 'edytor@next'
				? line.includes('edytor@next')
				: /\b(?:npm i|npm install|pnpm add|yarn add|bun add) edytor(?![@\w/.-])/.test(line));
		expect(installs.filter(([, line]) => !named(line))).toEqual([]);
		// CI publishes a -next pre-release under `next` (a bare `edytor` was the
		// old 0.0.11 then), a release candidate and a release under `latest`:
		// the README, the install page, the server quick start and the landing
		// page give the install that gets this version.
		for (const page of [
			'README.md',
			'site/content/docs/getting-started/index.mdx',
			'site/content/docs/server/quick-start.mdx',
			// The landing page's Copy install button (XW-05).
			'site/pages/_home/Hero.astro'
		])
			expect(pageText(join(root, page)), page).toMatch(
				channel === 'edytor@next' ? /pnpm add edytor@next/ : /pnpm add edytor(?![@\w/.-])/
			);
		// The site still serves every tarball it served (lockfiles pin those URLs).
		expect(hosted).toContain('/edytor-');
		// The site serves public/ at its root: the pack stages the tarball there
		// under the documented name, beside every version it served before
		// (XW-15, DR-docs-1; the behavior is pinned in 'the hosted tarballs').
		const pack = readFileSync(join(root, 'site/scripts/pack-edytor.sh'), 'utf8');
		expect(pack).toMatch(/sh site\/scripts\/stage-tarballs\.sh "\$@"/);
		expect(readFileSync(join(root, 'site/scripts/stage-tarballs.sh'), 'utf8')).toMatch(
			/cp "\$\{CURRENT:-site\/vendor\/edytor\.tgz\}" "site\/public\/edytor-\$VERSION\.tgz"/
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
			// Not frozen: the fresh pack's hash differs from the lockfiles' (CI too).
			'pnpm install --no-frozen-lockfile',
			'pnpm --dir room install --no-frozen-lockfile',
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
		// "From x" lists what a user of x meets on upgrading to this version,
		// so x is never the version that ships those changes (DW-06).
		const from = [...notes.matchAll(/### From (\S+)\n/g)].map(([, v]) => v);
		expect(from).not.toContain(version);
		// This package's pre-releases and release candidates (0.x, 1.x).
		const named = (text: string) =>
			[...text.matchAll(/\b[01]\.\d+\.\d+-(?:next|rc)\.\d+\b/g)].map(([mention]) => mention);
		// A version tagged but never served (unserved-versions.txt) may be named too.
		const unserved = readFileSync(join(root, 'site/scripts/unserved-versions.txt'), 'utf8')
			.split('\n')
			.filter((line) => line && !line.startsWith('#'));
		expect(unserved.filter((v) => servedVersions().includes(v))).toEqual([]);
		expect(
			named(notes).filter(
				(mention) => !servedVersions().includes(mention) && !unserved.includes(mention)
			)
		).toEqual([]);
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
		// `lost`: a decoding Worker never routed the old dial to the id. On a
		// Worker that routes on the raw segment, the old dial reached the id
		// itself unless the URL rewrote it (`rawLost`), and an upgraded client
		// reaches another name when encodeURIComponent escapes what the URL
		// kept (`rawMoved`, `%` included: `50%off` against `50%25off`).
		const lost: string[] = [];
		const rawLost: string[] = [];
		const rawMoved: string[] = [];
		for (let code = 0; code < 0x10000; code++) {
			const char = String.fromCharCode(code);
			const id = `a${char}b`;
			if (!validRoomId(id)) continue;
			if (decoded(id) !== id) lost.push(char);
			const raw = segment(id);
			const upgraded = segment(encodeURIComponent(id));
			if (raw === id && upgraded !== id) rawMoved.push(char);
			else if (raw !== id && raw !== upgraded) rawLost.push(char);
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
		expect(rawLost.filter((char) => char < ' ')).toEqual(['\t', '\n', '\r']);
		expect(listed(troubleshooting, 'An id holding ')).toEqual(
			rawLost.filter((char) => char >= ' ').sort()
		);
		for (const [text, lead] of [
			[migration, 'sends an id holding '],
			[troubleshooting, 'so an id holding ']
		])
			expect(listed(text, lead), lead).toEqual(rawMoved.sort());
	});

	it('the attachRoom pages list every method the document and the room expose (ZW-16)', () => {
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
		const entry = /`AttachedDocument` \(what `attachRoom` returns[^)]*\)/.exec(migration)![0];
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
			'attachRoom',
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

	it("the demo's actor id is the user id its room authorizes (room.attribution.trust)", () => {
		// Another id would have the room rebind its replica and refuse its
		// profile as another user's at every page load.
		const worker = readFileSync(join(root, 'site/room/src/worker.ts'), 'utf8');
		const page = readFileSync(join(root, 'site/islands/LiveEditor.svelte'), 'utf8');
		const userId = /userId: (`[^`]*`|\w+)/.exec(worker)?.[1];
		expect(userId).toBe('`guest:${guest}`');
		expect(page).toMatch(/const actor = \{ id: `guest:\$\{guest\}`/);
		const quickStart = readFileSync(join(root, 'site/content/docs/server/quick-start.mdx'), 'utf8');
		expect(quickStart).toMatch(/actor id `guest:<id>`/);
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

	it('every 4403 row and user-id rule names each identity routeDocumentSocket refuses (BW-07)', () => {
		// The refusal, pinned against the source: a missing identity, a userId
		// that is not a string, empty, over 256 characters or with a lone
		// surrogate, an invalid replica, and an `expiresAt` that is not a
		// finite number (WU-06). A new clause must reach the docs.
		const source = readFileSync(join(root, 'src/lib/cloudflare/routeDocumentSocket.ts'), 'utf8');
		const refusal =
			/if \(\n\t\t!identity \|\|([\s\S]*?)\) \{\n\t\treturn refuse\(CLOSE\.denied/.exec(
				source
			)?.[1];
		expect(refusal?.split('||').map((clause) => clause.replace(/\/\/.*|\s+/g, ' ').trim())).toEqual(
			[
				"typeof identity.userId !== 'string'",
				'!identity.userId',
				'identity.userId.length > 256',
				'/\\p{Cs}/u.test(identity.userId)',
				'(replica !== null && parseReplica(replica) === null)',
				'(expiresAt !== null && !Number.isFinite(expiresAt))'
			]
		);
		const rows = docs.flatMap((path) =>
			pageText(path)
				.split('\n')
				.map((line, i) => [`${relative(root, path)}:${i + 1}`, line] as const)
				.filter(([, line]) => line.startsWith('|') && line.includes('`4403`'))
				.filter(([, line]) => line.includes('document access denied'))
		);
		expect(rows.length).toBeGreaterThanOrEqual(3);
		const causes = [/`null`/, /empty/, /256/, /lone surrogate/, /`replica`/, /`expiresAt`/];
		expect(
			rows.filter(([, line]) => causes.some((cause) => !cause.test(line))).map(([at]) => at)
		).toEqual([]);
		// Every page that states the user-id length rule names the surrogate rule too.
		const userRule = docs.flatMap((path) =>
			pageText(path)
				.split('\n')
				.map((line, i) => [`${relative(root, path)}:${i + 1}`, line] as const)
				.filter(([, line]) => /user ids? (?:are|is) 1 to 256|`userId`.*1 to 256/.test(line))
		);
		expect(userRule.length).toBeGreaterThanOrEqual(2);
		expect(
			userRule
				.filter(([, line]) => !/user ids?[^.]*lone surrogate|`userId`.*lone surrogate/.test(line))
				.map(([at]) => at)
		).toEqual([]);
	});

	it('every view type the document API pages name is exported from edytor/crdt/edytor (BW-08)', () => {
		// tests/packed-consumer/smoke-types.ts type-checks the import itself.
		const section = (page: string, heading?: string) => {
			const text = pageText(join(root, 'site/content/docs', page));
			if (!heading) return text;
			const from = text.indexOf(heading);
			const to = text.indexOf('\n#', from + heading.length);
			return text.slice(from, to < 0 ? undefined : to);
		};
		const named = (text: string) => [...text.matchAll(/`(\w+View)`/g)].map(([, name]) => name);
		const exported = readFileSync(join(root, 'src/lib/crdt/index.ts'), 'utf8');
		const pages = [
			section('reference/migration.mdx', '### Document and CRDT API'),
			section('reference/document-api.mdx')
		];
		expect(pages.flatMap(named)).toEqual(expect.arrayContaining(['RangeView', 'FlowView']));
		for (const name of pages.flatMap(named))
			expect(exported, name).toMatch(new RegExp(`type ${name}\\b`));
	});

	it("the guide names each Playwright config's port variable (SW11-docs-1)", () => {
		const agents = guide();
		for (const config of [
			'playwright.config.ts',
			'playwright.arch.config.ts',
			'playwright.dst.config.ts'
		]) {
			// The arch config is a per-worktree local file (not in a fresh clone, CI).
			if (!existsSync(join(root, config))) continue;
			const port = /process\.env\.(\w+_PORT)/.exec(readFileSync(join(root, config), 'utf8'))?.[1];
			expect(port, config).toBeDefined();
			expect(agents, config).toMatch(
				new RegExp(`\`${config.replaceAll('.', '\\.')}\` takes \`${port}\``)
			);
		}
	});

	it('no source comment cites a README section (the README is a landing page)', () => {
		const hits = sources(join(root, 'src/lib'))
			.filter((path) => readFileSync(path, 'utf8').includes('README'))
			.map((path) => relative(root, path));
		expect(hits).toEqual([]);
	});

	/**
	 * The text-order promise covers one source-ranked gesture per peer
	 * between syncs, on the client-id pairs the sweeps run; inserts beside
	 * a block, several gestures before a sync and moves take plain ranks
	 * (`order-scope.test.ts` pins them). Wave 13 widened the wording past
	 * the code (EW-05, EW-11); every page that states the promise names
	 * what it leaves out.
	 */
	it('no ordering promise reaches past the source-ranked gestures (EW-05, EW-11)', () => {
		const contract = join(root, 'docs/editor-delete-contract.md');
		const overreach = [
			/every client-id assignment/i,
			/several (?:edits|gestures|per peer)[^.]*keep the text/i,
			/also with several per peer/i,
			/every (?:insert and move|sibling rank a document operation mints)/i,
			/(?:inserts?|Duplicate|moves?)[^.]{0,80}ranked by (?:where it goes|source)/i,
			// Typing counts by position, not time: after one's split point it is a residual.
			/typed or deleted before the gesture/i,
			/text edits before (?:a split|it)\b/i
		];
		for (const phrase of overreach) {
			const hits = [...docs, contract, ...sources(join(root, 'src/lib/crdt'))]
				.filter((path) => has(pageText(path), phrase))
				.map((path) => relative(root, path));
			expect(hits, String(phrase)).toEqual([]);
		}
		const read = (path: string) => readFileSync(join(root, path), 'utf8');
		const section = read('site/content/docs/collaboration/concurrent-editing.mdx').split(
			'## Which races keep the text order'
		)[1];
		const notClaimed = read('docs/editor-delete-contract.md').split('- Not claimed')[1];
		for (const [page, text, names] of [
			[
				'concurrent-editing',
				section,
				[
					'Enter</kbd> at the start or end',
					'callout or quote with nested lines',
					'Duplicate',
					'+ button',
					'paste of whole blocks',
					'over selected blocks',
					'Several gestures',
					'Turn into over several blocks',
					'group of adjacent items',
					'drag'
				]
			],
			[
				'contract',
				notClaimed,
				[
					'insertBlockBefore',
					'prepareSplitKeepingChildren',
					'duplicateBlock',
					'`whole`',
					'`replace`',
					'several structural',
					'Turn into over several blocks',
					'`moveRoots`'
				]
			],
			[
				'document-api',
				read('site/content/docs/reference/document-api.mdx'),
				[
					'`insertBlock(s)`',
					'`duplicateBlock`',
					'`whole`',
					'`replace`s blocks',
					'several structural calls',
					'Turn into over several blocks',
					'per run of adjacent blocks',
					'`nestBlock`'
				]
			]
		] as const)
			for (const name of [...names, 'Alt+↑', 'Mod+Shift+↑', 'Move up', 'Tab'])
				expect(text, `${page} names ${name}`).toContain(name);
	});

	/**
	 * FX-12: the handle's Alt+← is the outdent (`unNestBlocks`), which is
	 * ranked; only Alt+↑/↓/→ are moves. FX-09, FX-10: the split residuals
	 * name an earlier nested line's outdent, and a deletion after one's own
	 * split point, wherever they are listed.
	 */
	it('the ordering residuals and moves are named exactly (FX-09, FX-10, FX-12)', () => {
		const read = (path: string) => readFileSync(join(root, path), 'utf8');
		const pages = {
			site: read('site/content/docs/collaboration/concurrent-editing.mdx'),
			contract: read('docs/editor-delete-contract.md'),
			api: read('site/content/docs/reference/document-api.mdx'),
			scope: read('src/tests/crdt/arch-v2/order-scope.test.ts')
		};
		for (const [page, text] of Object.entries(pages)) {
			expect(text, `${page}: Alt+arrows`).not.toMatch(/Alt\+arrows/);
			if (page !== 'scope')
				expect(text, `${page}: Alt+←`).toMatch(/Alt\+←(?:<\/kbd>)? is the outdent/);
		}
		for (const page of ['site', 'contract'] as const)
			expect(pages[page], `${page}: R3 adoption`).toMatch(/earlier nested line/);
		expect(pages.site).not.toMatch(/text (?:Alice )?typed after/);
		expect(pages.site).toContain('typed or deleted after her own split point');
		expect(pages.api).toContain("typed or deleted after one's own split point");
		// DR-rest-2: one `unNestBlocks` call keeps the order over ADJACENT siblings only.
		for (const page of ['contract', 'api'] as const) {
			expect(pages[page], `${page}: unNestBlocks scope`).not.toMatch(
				/`unNestBlocks` over several is one plan/
			);
			expect(pages[page], `${page}: unNestBlocks scope`).toMatch(
				/`unNestBlocks` over adjacent siblings is one plan/
			);
			expect(pages[page], `${page}: non-adjacent`).toMatch(/non-adjacent/);
		}
	});

	/**
	 * DR-rest-1, DR-rest-3: every `transact` (document, editor, facade, room)
	 * is one transaction, not a rollback; the room's rebuild after a failed
	 * append replaces `doc` and `facade`, and its own edit is not resent.
	 */
	it('every transact page says a throw keeps the writes made before it (DR-rest-1, DR-rest-3)', () => {
		const read = (path: string) => readFileSync(join(root, `site/content/docs/${path}`), 'utf8');
		const extending = read('server/extending.mdx');
		const room = read('server/room.mdx');
		expect(extending).not.toMatch(/all or nothing: if `fn` throws|rolled back/);
		expect(extending).toContain('one transaction, not a rollback');
		expect(extending).toContain('replaces `doc` and `facade`');
		expect(read('reference/document-api.mdx')).toContain(
			'a throw from `fn` does not undo the writes made before it'
		);
		expect(read('collaboration/documents.mdx')).toContain(
			'A throw from `fn` does not undo the writes made before it'
		);
		expect(read('concepts/editor-instance.mdx')).toContain(
			'A throw from `fn` does not undo the changes made before it'
		);
		expect(room).toMatch(/resends the edit\. If the append of the room's own edit fails/);
		expect(room).toContain('nothing resends it');
		expect(guide()).not.toMatch(/all or nothing: a throw/);
	});

	it('the editor transact normalizes the writes a throw keeps (GX-07)', () => {
		const read = (path: string) => readFileSync(join(root, `site/content/docs/${path}`), 'utf8');
		expect(read('concepts/editor-instance.mdx')).toContain(
			'does not undo the changes made before it; normalization still runs on them'
		);
		expect(read('editor/commands.mdx')).toContain(
			'a throw from `fn` keeps the writes made before it, and normalization still runs on them'
		);
	});

	it('moveBlocks in/out moves runs; one unNestBlocks call gathers (GX-05)', () => {
		const read = (path: string) => readFileSync(join(root, `site/content/docs/${path}`), 'utf8');
		expect(read('editor/commands.mdx')).toContain(
			'siblings that have another block between them move as separate runs of adjacent siblings'
		);
		const api = read('reference/document-api.mdx');
		expect(api).toContain("`unNestBlocks(['a', 'c'])` on a list `a` to `e` reads `b a c d e`");
		expect(api).not.toMatch(/as `edytor\.moveBlocks` with `direction: 'out'` allows/);
	});

	it('the block-selection navigation names only the Ctrl keys it binds (GX-06)', () => {
		const read = (path: string) => readFileSync(join(root, `site/content/docs/${path}`), 'utf8');
		const selection = read('editor/selection.mdx');
		expect(selection).not.toContain('the macOS <kbd>Ctrl</kbd> keys) read a block selection');
		expect(selection).toContain(
			'(<kbd>Ctrl</kbd>+<kbd>A</kbd>/<kbd>E</kbd> have no <kbd>Shift</kbd> variant)'
		);
		expect(read('customization/hotkeys.mdx')).not.toContain(
			"(a list's items, a code block's lines, never a divider)"
		);
	});

	it('a selected list stands for its subtree through selectedMembers; an edge divider is left out (HX-02, HX-07, HX-08)', () => {
		const read = (path: string) => readFileSync(join(root, `site/content/docs/${path}`), 'utf8');
		const members = 'a selected list or code block with';
		expect(read('editor/commands.mdx')).toContain(
			'edytor.deleteBlocks({ blocks: edytor.selection.selectedMembers });'
		);
		expect(read('plugins/block-handles.mdx')).toContain(
			"await edytor.runCommand('block.heading2');"
		);
		for (const page of [
			'editor/clipboard.mdx',
			'plugins/writing-plugins.mdx',
			'editor/selection.mdx'
		])
			expect(read(page)).toContain(members);
		expect(read('plugins/writing-plugins.mdx')).not.toContain(
			'It names the selected blocks that go'
		);
		expect(read('plugins/block-menu.mdx')).toContain(
			'A list or a code block is one block to the menu'
		);
		expect(read('editor/selection.mdx')).toContain(
			'A divider that starts or ends the document has no line beyond it, so it is left out'
		);
	});

	it('the guide names every file that writes the DOM selection, and the contract names park (GX-10)', () => {
		const lib = join(root, 'src/lib');
		const writers = files(lib, /\.(ts|svelte)$/)
			.filter((path) => !path.includes('/vendor/'))
			.filter((path) =>
				/\.(removeAllRanges|addRange|setBaseAndExtent)\(|clearDomSelection\(/.test(
					readFileSync(path, 'utf8')
				)
			)
			.map((path) => relative(lib, path));
		expect(writers.length).toBeGreaterThan(1);
		const agents = guide();
		const exceptions = agents.split('**DOM selection exceptions.**')[1]!.split('\n')[0]!;
		for (const path of writers)
			if (path !== 'surface/projector.svelte.ts') expect(exceptions, path).toContain(`\`${path}\``);
		expect(exceptions).toContain('`park`');
		const contract = readFileSync(join(root, 'docs/editor-delete-contract.md'), 'utf8');
		const ownership = contract.split('## Selection ownership and lifecycle')[1]!.split('\n## ')[0]!;
		expect(ownership).toContain('`park`');
		expect(ownership).toContain('`selection/domSelection.ts`');
		const row = contract.split('\n').find((line) => line.startsWith('| DOM-selection write'));
		expect(row).toContain('`park`');
	});

	it('the store name and the failed direct room write are described as they behave (GX-08, GX-09)', () => {
		const read = (path: string) => readFileSync(join(root, `site/content/docs/${path}`), 'utf8');
		expect(read('collaboration/persistence.mdx')).toContain(
			'trailing slashes are removed from `server` in both'
		);
		const extending = read('server/extending.mdx');
		expect(extending).not.toContain('a failed append is only noticed');
		expect(extending).toContain('a later write through a freshly read `facade` or `doc` is stored');
	});

	it('wave 17: room reads mid-frame, nested room transact, and paste placement (HX-04/05/06/09/10/11/12)', () => {
		const read = (path: string) => readFileSync(join(root, path), 'utf8');
		const docs = (path: string) => read(`site/content/docs/${path}`);
		const extending = docs('server/extending.mdx');
		expect(extending).toContain("a `doc.on('afterAllTransactions')` listener may read the room");
		expect(extending).toContain("comes from the room's own `transact`");
		expect(extending).toContain('Only a `transact` called inside `fn` itself joins.');
		expect(extending).toContain('a `transact` there is a change of its own and is stored');
		expect(extending).not.toContain('(outside a transaction and its change events)');
		expect(guide()).toContain('only a call inside `fn` joins');
		const clipboard = docs('editor/clipboard.mdx');
		expect(clipboard).not.toContain('since it shows no text line of its own');
		expect(clipboard).not.toContain('and it replaces an empty block');
		expect(clipboard).toContain('**List items from HTML**');
		expect(clipboard).toContain('after a divider or an image, the empty line stays for the caret');
		expect(clipboard).toContain(
			'what follows the first pasted line becomes its first nested lines'
		);
		// DR-rest-1: an empty header keeps its kind; the first line gives it text only.
		expect(clipboard).toContain('which keeps its kind and takes the text only');
		expect(clipboard).toContain("it keeps its kind and takes the first pasted line's text only");
		const api = docs('reference/document-api.mdx');
		expect(api).toContain('is placed as a block and never joined');
		expect(api).toContain('At the end of a block `view.header(id)` names');
		expect(api).toContain('over selected code lines (`{ replace }`)');
		expect(api).toContain("an `insertFlow` at a block's start whose first line stands apart");
		expect(docs('collaboration/concurrent-editing.mdx')).toContain(
			'a paste at the start of a line whose first pasted line is a list'
		);
		const contract = read('docs/editor-delete-contract.md');
		expect(contract).toContain('### `flow.header`');
		expect(contract).toContain('is a void (a divider, an image');
		expect(contract).toContain('`callout "H" > [divider, "", body]`');
		expect(contract).toContain('except a header whose body shows (`flow.header`)');
		expect(api).toContain("with no text, it takes a joining first line's text but not its kind");
		expect(api).toContain('every line when the first stands apart');
	});

	it('a subscriber defers its room write, a throwing subscriber is logged, and the pinned store keeps its token refresh (DR-rest)', () => {
		const read = (path: string) => readFileSync(join(root, `site/content/docs/${path}`), 'utf8');
		const extending = read('server/extending.mdx');
		expect(extending).not.toContain('may read the room or call `transact`');
		expect(extending).toContain('throws without writing');
		expect(extending).toContain('queueMicrotask(() => this.transact(');
		expect(read('reference/document-api.mdx')).toContain(
			'A callback that throws is logged; the other callbacks and the document carry on.'
		);
		const pinned = read('reference/migration.mdx')
			.split('\n')
			.find((line) => line.includes('persistName: `edytor:${actor.id}@'));
		expect(pinned).toContain('onExpired');
		expect(pinned).toContain('`onSyncExpired` does not apply');
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
		keepLive?: boolean;
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
				env: {
					...process.env,
					SITE: site,
					FORCE: options.force ? '1' : '',
					KEEP_LIVE: options.keepLive ? '1' : ''
				}
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

	it('with KEEP_LIVE (the CI deploy), a served version keeps its live bytes', async () => {
		const { result, served } = await stage({
			version: '0.1.0-next.0',
			served: ['0.1.0-next.0'],
			packed: 'a rebuild on another machine',
			live: { '/edytor-0.1.0-next.0.tgz': 'next.0 bytes' },
			keepLive: true
		});
		expect(result).toBe('staged');
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

/**
 * Readability (WU-19, DOC-09, DOC-10). A page leads with the common case and
 * keeps its edge cases in tables, callouts or an "Edge cases" section; a
 * paragraph long enough to be a wall of text is a list or a table waiting to
 * happen. The changelog is written for users: per release, what breaks, what
 * is new and what was fixed, never a ticket, a contract row or a file of the
 * repository. Importing v13 documents is a guide of its own.
 */
describe('docs readability (WU-19)', () => {
	const site = files(join(root, 'site/content/docs'));
	const read = (path: string) => readFileSync(join(root, 'site/content/docs', path), 'utf8');
	const CHANGELOG = 'reference/migration.mdx';
	const IMPORT = 'reference/v13-import.mdx';

	/** The lines of a page outside fenced code and table rows, with their numbers. */
	const prose = (text: string) => {
		let fence: string | null = null;
		return text.split('\n').flatMap((line, i) => {
			const open = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
			if (fence) {
				if (open && line.trim() === fence) fence = null;
				return [];
			}
			if (open) {
				fence = open;
				return [];
			}
			return /^\s*\|/.test(line) ? [] : [[i + 1, line] as const];
		});
	};

	it('no prose line of the site docs is over 1,200 characters (tables and code aside)', () => {
		const long = site.flatMap((path) =>
			prose(readFileSync(path, 'utf8'))
				.filter(([, line]) => line.length > 1200)
				.map(([at, line]) => `${relative(root, path)}:${at} (${line.length})`)
		);
		expect(long).toEqual([]);
	});

	it('the changelog and the v13 import guide name no ticket, contract row or repository path', () => {
		// The ticket grammar `pnpm check:api` rejects in public JSDoc
		// (`scripts/api-report.mjs`), function keys (`Alt+F10`) and Cloudflare's
		// R2 aside.
		const ticket =
			/\b(?!UTF-|ES20|R2\b(?!-)|D1[\s*]+(?:database|binding)\b)(?:[A-Z]{1,3}\d{1,3}[a-z]?|[A-Z]{1,3}-\d{1,3}[a-z]?|[A-Z]{2}\d?-[a-z]+-\d+)\b|§\s?\d+(?:\.\d+)*/g;
		// The contract rows' namespaces (`del.blocks.promote`, `room.compact.*`).
		const row =
			/^(?:(?:del|flow|sel|hist|layout|order|room|net|conc|merge|mark|link)(?:\.[\w*-]+)+|doc\.(?:empty|hydrate)\b.*|data\.(?:atomic|retype)\b.*|id\.same\b.*|code\.language\b.*|crdt\.doc\b.*|[\w.]+\.\*)$/;
		const hits = [CHANGELOG, IMPORT].flatMap((page) =>
			prose(read(page)).flatMap(([at, line]) => {
				const text = line.replace(/<kbd>[^<]*<\/kbd>|\+F\d{1,2}\b/g, '');
				const found = [
					...[...text.matchAll(ticket)].map(([code]) => code),
					...[...text.matchAll(/fork patch|contract row/gi)].map(([phrase]) => phrase),
					...[...text.matchAll(/`([^`]+)`/g)]
						.map(([, code]) => code!)
						.filter(
							(code) =>
								row.test(code) ||
								/^(?:src|site|docs|tests|scripts|\.github)\//.test(code) ||
								/^[\w-]+\/[\w./-]+\.(?:ts|js|svelte|md|mdx)$/.test(code)
						)
				];
				return found.map((what) => `${page}:${at}: ${what}`);
			})
		);
		expect(hits).toEqual([]);
	});

	it('every changelog release lists its changes as breaking, new or fixed', () => {
		const notes = /\n## Upgrading between pre-releases\n([\s\S]*?)(?=\n## )/.exec(
			read(CHANGELOG)
		)![1]!;
		const releases = notes.split(/\n(?=### )/).filter((part) => part.startsWith('### From '));
		expect(releases.length).toBeGreaterThan(30);
		const LABELS = ['#### Breaking changes', '#### New', '#### Fixed'];
		for (const release of releases) {
			const [heading, ...body] = release.split('\n');
			const labels = body.filter((line) => line.startsWith('#### '));
			// Only those three, in that order, each at most once.
			const order = labels.map((label) => LABELS.indexOf(label));
			expect(order, heading).not.toContain(-1);
			expect(order, heading).toEqual([...new Set(order)].sort());
			// Nothing but a lead paragraph before the first label (a release
			// that changed nothing has that paragraph alone).
			const lead = body
				.slice(0, labels.length ? body.indexOf(labels[0]!) : undefined)
				.filter((line) => line.trim());
			expect(
				lead.filter((line) => /^\s*(?:- |\d+\. )/.test(line)),
				heading
			).toEqual([]);
		}
		// Changes not yet released wait under "Unreleased", right after the heading.
		expect(notes.trimStart()).toMatch(/^### Unreleased\n/);
	});

	it('the v13 import guide is a page of its own, in the reference sidebar', () => {
		const guide = read(IMPORT);
		expect(guide).toContain('migration.migrate(name)');
		expect(guide).toContain('`rolledback`');
		expect(read('reference/meta.ts')).toMatch(/"migration",\s*"v13-import"/);
		expect(read(CHANGELOG)).not.toContain('## Importing v13 documents');
		const stale = site
			.filter((path) => readFileSync(path, 'utf8').includes('migration#importing-v13-documents'))
			.map((path) => relative(root, path));
		expect(stale).toEqual([]);
	});

	it('concurrent editing states each rule with an Alice and Bob table', () => {
		const page = read('collaboration/concurrent-editing.mdx');
		const sections = page.split(/\n(?=## )/).slice(1);
		expect(sections.length).toBeGreaterThan(8);
		const tableless = sections
			.filter((section) => !/^\|[^\n]*\bAlice\b[^\n]*\|[^\n]*\bBob\b[^\n]*\|$/m.test(section))
			.map((section) => section.split('\n')[0]);
		// The closing note on versions is no race.
		expect(tableless).toEqual(['## Mixed versions']);
	});

	/** The body of a page's section, from its heading to the next of its level or above. */
	const section = (page: string, heading: string) => {
		const text = read(page);
		const at = text.indexOf(`\n${heading}\n`);
		expect(at, `${page}: ${heading}`).toBeGreaterThan(-1);
		const level = heading.split(' ')[0]!.length;
		const rest = text.slice(at + heading.length + 2);
		const end = rest.search(new RegExp(`\\n#{1,${level}} `));
		return end === -1 ? rest : rest.slice(0, end);
	};
	/** The cells of a table row. */
	const cells = (row: string) =>
		row
			.trim()
			.replace(/^\||\|$/g, '')
			.split(/(?<!\\)\|/)
			.map((cell) => cell.trim());

	it('the saved state keeps each rule where it applies, as the provider counts it', () => {
		const page = 'collaboration/websocket.mdx';
		const counts = section(page, '### What counts');
		const deletes = section(page, '### Deletes');
		// Any edit of a block whose last change a restore lost waits, typing
		// included: it is no rule of deletes.
		expect(counts).toMatch(/Any edit of such a block, typing included, stays unsaved/);
		expect(deletes).not.toMatch(/last change/);
		// The cap counts only deletes of content the room does not hold.
		const rows = deletes.split('\n').filter((line) => /^\| (?!---|A delete of)/.test(line));
		const capped = rows.filter((row) => row.includes('MAX_WAITING_DELETES'));
		expect(capped).toHaveLength(1);
		expect(cells(capped[0]!)[0]).toMatch(/^Content the room does not hold yet/);
		// A delete in an update that wrote another actor's content is never
		// tracked (`OwnWrites.track`), so it never holds `saved` false.
		const foreign = rows.filter((row) => /another actor's content/.test(cells(row)[0]!));
		expect(foreign).toHaveLength(1);
		expect(cells(foreign[0]!)[1]).toMatch(/not counted at all, so it never holds `saved` false/);
		// The factory paragraph belongs to Connect, not to the room ids.
		const connect = section(page, '## Connect');
		expect(connect.indexOf('The props build a `createWebsocketSync`')).toBeGreaterThan(-1);
		expect(connect.indexOf('The props build a `createWebsocketSync`')).toBeLessThan(
			connect.indexOf('### Room ids')
		);
	});

	it("the changelog's close-code table names every code the provider reads", () => {
		const table = read(CHANGELOG).split('**Close codes**')[1]!.split('\n\n')[1]!;
		const rows = new Map(
			table
				.split('\n')
				.slice(2)
				.map((row) => cells(row))
				.map(([code, ...rest]) => [code!.replace(/`/g, ''), rest.join(' | ')] as const)
		);
		for (const code of Object.values(CLOSE)) expect(rows.has(String(code)), `${code}`).toBe(true);
		expect(rows.get('4403')).toMatch(/invalid identity/);
		expect(rows.get('4403')).toMatch(/allowedOrigins/);
		expect(rows.get('4403')).toMatch(/closeUser/);
		for (const reason of ['generation', 'replica', 'schema', 'malformed', 'identity', 'container'])
			expect(rows.get('1008'), reason).toContain(`(\`${reason}\`)`);
	});

	it('the closed-toggle selection table leaves no key unanswered', () => {
		const table = section('customization/hotkeys.mdx', '### Selection')
			.split('A text selection never reaches a closed toggle')[1]!
			.split('\n\n')[1]!;
		const rows = table.split('\n').slice(2);
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows)
			expect(
				cells(row).filter((cell) => !cell),
				row
			).toEqual([]);
		expect(read('customization/hotkeys.mdx')).toMatch(
			/ends at the end of a closed toggle's header, every key that removes it/
		);
	});

	it('no callout holds a table, and a page says a thing once', () => {
		const inCallout = site.flatMap((path) => {
			let open = false;
			return readFileSync(path, 'utf8')
				.split('\n')
				.flatMap((line, i) => {
					if (/^:::\w/.test(line)) open = true;
					else if (line.trim() === ':::') open = false;
					else if (open && /^\s*\|/.test(line)) return [`${relative(root, path)}:${i + 1}`];
					return [];
				});
		});
		expect(inCallout).toEqual([]);
		expect(read('server/extending.mdx').match(/your own RPC methods/g)).toHaveLength(1);
	});

	it('concurrent editing lists each race in one table', () => {
		// A race is its people's gestures: rows naming the same quoted texts
		// and calls in the Alice and Bob cells are the same race.
		const page = read('collaboration/concurrent-editing.mdx');
		const seen = new Map<string, string>();
		const twice: string[] = [];
		for (const block of page.split('\n\n')) {
			const lines = block.split('\n').filter((line) => line.startsWith('|'));
			if (lines.length < 3) continue;
			const head = cells(lines[0]!);
			const alice = head.indexOf('Alice');
			const bob = head.indexOf('Bob');
			if (alice < 0 || bob < 0) continue;
			for (const row of lines.slice(2)) {
				const parts = cells(row);
				if (/^\d+$/.test(parts[0]!)) continue; // a numbered story, not a race
				const quoted = [
					...new Set(
						[...`${parts[alice]} ${parts[bob]}`.matchAll(/"([^"]+)"|`([^`]+)`/g)].map(
							([, text, code]) => text ?? `\`${code}\``
						)
					)
				]
					.sort()
					.join('|');
				if (!quoted) continue;
				if (seen.has(quoted)) twice.push(`${seen.get(quoted)} / ${parts[0]}`);
				else seen.set(quoted, parts[0]!);
			}
		}
		expect(twice).toEqual([]);
	});

	it('the changelog files what asks apps to act under breaking changes', () => {
		const notes = /\n## Upgrading between pre-releases\n([\s\S]*?)(?=\n## )/.exec(
			read(CHANGELOG)
		)![1]!;
		const asks = /\bIf your own\b|\bA test that\b|\bTests that\b|\bdrop it\b/;
		const filed = notes.split(/\n(?=### )/).flatMap((release) =>
			release
				.split(/\n(?=#### )/)
				.filter((part) => part.startsWith('#### New'))
				.flatMap((part) =>
					part
						.split('\n')
						.filter((line) => asks.test(line))
						.map((line) => `${release.split('\n')[0]}: ${line.slice(0, 80)}`)
				)
		);
		expect(filed).toEqual([]);
	});

	it('the README names the changelog and the v13 import guide', () => {
		const readme = readFileSync(join(root, 'README.md'), 'utf8');
		expect(readme).toContain('https://edytor.dev/docs/reference/v13-import');
		expect(readme).toMatch(/\[changelog\]\(https:\/\/edytor\.dev\/docs\/reference\/migration\)/);
	});
});
