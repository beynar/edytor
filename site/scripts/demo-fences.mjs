#!/usr/bin/env node
/**
 * Copy each plugin demo's shown files into its page's fences:
 * `site/demos/<page>/<file>` (every file but `index.ts`) replaces the body
 * of the `check` fence titled `<file>` on `site/content/docs/plugins/<page>.mdx`.
 * The source is the file; the fence is what a reader copies, kept identical
 * (`src/tests/docs-onboarding.test.ts` fails when they differ).
 *
 *   node site/scripts/demo-fences.mjs           # every demo
 *   node site/scripts/demo-fences.mjs code      # one page
 *
 * A page needs the fence once, empty, with its title and `check`:
 * ```svelte title="CodeEditor.svelte" check
 * ```
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const site = path.join(import.meta.dirname, '..');
const demos = path.join(site, 'demos');
const only = process.argv.slice(2);
const folders = readdirSync(demos, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && (!only.length || only.includes(entry.name)))
	.map((entry) => entry.name);

let failed = false;
for (const name of folders) {
	const page = path.join(site, 'content/docs/plugins', `${name}.mdx`);
	let text = readFileSync(page, 'utf8');
	for (const file of readdirSync(path.join(demos, name))) {
		if (file === 'index.ts') continue;
		const source = readFileSync(path.join(demos, name, file), 'utf8').replace(/\n+$/, '');
		const title = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const fence = new RegExp(
			`^(\`{3,})(\\w+)([^\\n]*title="(?:[^"]*/)?${title}"[^\\n]*\\bcheck\\b[^\\n]*)\\n[\\s\\S]*?^\\1[ \\t]*$`,
			'm'
		);
		if (!fence.test(text)) {
			console.error(`${path.relative(site, page)}: no \`check\` fence titled "${file}"`);
			failed = true;
			continue;
		}
		text = text.replace(fence, (_, ticks, lang, meta) => `${ticks}${lang}${meta}\n${source}\n${ticks}`);
	}
	writeFileSync(page, text);
	console.log(`${path.relative(site, page)}: fences synced`);
}
process.exit(failed ? 1 : 0);
