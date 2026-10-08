/**
 * Localization: the chrome's words come from the label dictionary
 * (`src/lib/labels.ts`), never from a literal in a component or a plugin.
 *
 * - `labelsWith` replaces the entries given, and a nested group's entries
 *   without its others;
 * - no `.svelte` file of the library writes a word in its markup (a text
 *   node, or an `aria-label`, `title`, `placeholder`, `alt` or `label`
 *   attribute), and no plugin names a row, a preset or a hint with a literal.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { englishLabels, keywordsOf, labelsWith, type Labels } from '$lib/labels.js';
import { fr } from './fixtures/labels.fr.js';

const LIB = join(process.cwd(), 'src/lib');

/** Not chrome a view ships: the reference mention plugin (unexported), the vendored engine, the room. */
const SKIPPED = ['plugins/mention/', 'crdt/', 'cloudflare/'];

const files = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});

const library = files(LIB)
	.map((path) => ({ path, name: relative(LIB, path) }))
	.filter(({ name }) => !SKIPPED.some((skip) => name.startsWith(skip)));

/** A word: two letters in a row (a glyph such as `A`, `⋮⋮` or `↑` is not one). */
const WORD = /[A-Za-zÀ-ÿ]{2}/;
/** Glyphs that read as letters: the find bar's match-case button. */
const GLYPHS = new Set(['Aa']);

/** Key names a handler in the markup compares `event.key` with. */
const KEYS = /^(Enter|Escape|Backspace|Delete|Tab|Home|End|Arrow\w+)$/;

/**
 * A component's markup, without its script, style and comments, its
 * `{…}` expressions blanked; and the capitalized string literals those
 * expressions held (a fallback such as `?? 'Text'`), key names aside.
 */
const markupOf = (source: string) => {
	let markup = source
		.replace(/<script[\s\S]*?<\/script>/g, '')
		.replace(/<style[\s\S]*?<\/style>/g, '')
		.replace(/<!--[\s\S]*?-->/g, '');
	const literals: string[] = [];
	for (let previous = ''; previous !== markup; ) {
		previous = markup;
		markup = markup.replace(/\{[^{}]*\}/g, (expression) => {
			for (const [, literal] of expression.matchAll(/['"`]([A-Z][a-z][^'"`]*)['"`]/g))
				if (!KEYS.test(literal!)) literals.push(literal!);
			return '';
		});
	}
	return { markup, literals };
};

describe('labelsWith', () => {
	it('replaces the entries given and keeps the others', () => {
		const toolbar = labelsWith('toolbar', { link: 'Lien' });
		expect(toolbar.link).toBe('Lien');
		expect(toolbar.bar).toBe(englishLabels.toolbar.bar);
	});

	it('replaces one entry of a nested group without the others', () => {
		const richText = labelsWith('richText', { placeholders: { quote: 'Citation vide' } });
		expect(richText.placeholders.quote).toBe('Citation vide');
		expect(richText.placeholders.list).toBe('List');
		expect(richText.placeholders.heading(2)).toBe('Heading 2');
		const slash = labelsWith('slashMenu', { groups: { Media: 'Médias' } });
		expect(slash.groups).toEqual({
			'Basic blocks': 'Basic blocks',
			'Advanced blocks': 'Advanced blocks',
			Media: 'Médias',
			Layout: 'Layout'
		});
	});

	it('answers English without overrides', () => {
		expect(labelsWith('find', undefined)).toBe(englishLabels.find);
	});

	it('the English dictionary is frozen, its nested groups too: no app edits every view', () => {
		expect(Object.isFrozen(englishLabels)).toBe(true);
		expect(Object.isFrozen(englishLabels.toolbar.colors)).toBe(true);
		expect(Object.isFrozen(englishLabels.media.file)).toBe(true);
	});

	it('a complete dictionary has every section and entry of the English one', () => {
		const shape = (labels: Labels) =>
			Object.fromEntries(
				Object.entries(labels).map(([section, entries]) => [
					section,
					Object.keys(entries as object).sort()
				])
			);
		expect(shape(fr)).toEqual(shape(englishLabels));
	});
});

describe('keywordsOf', () => {
	it("a command's localized keywords replace its defaults; others keep theirs", () => {
		expect(keywordsOf('block.heading1', ['h1', 'title'], { 'block.heading1': ['titre'] })).toEqual([
			'titre'
		]);
		expect(keywordsOf('block.quote', ['quote'], { 'block.heading1': ['titre'] })).toEqual([
			'quote'
		]);
		expect(keywordsOf('block.quote', undefined, undefined)).toBeUndefined();
	});
});

describe('no hard-coded chrome words', () => {
	it('no component writes a word in its markup', () => {
		const found: string[] = [];
		for (const { path, name } of library.filter(({ name }) => name.endsWith('.svelte'))) {
			const { markup, literals } = markupOf(readFileSync(path, 'utf8'));
			for (const literal of literals) found.push(`${name}: {'${literal}'}`);
			for (const [, attribute, value] of markup.matchAll(
				/\s(aria-label|title|placeholder|alt|label)="([^"]*)"/g
			))
				if (WORD.test(value!)) found.push(`${name}: ${attribute}="${value}"`);
			for (const [, text] of markup.matchAll(/>([^<>]+)</g)) {
				const words = text!.trim();
				if (WORD.test(words) && !GLYPHS.has(words)) found.push(`${name}: >${words}<`);
			}
		}
		expect(found).toEqual([]);
	});

	it('no plugin names a row, a preset, a hint or a placeholder with a literal (group names are keys)', () => {
		const found: string[] = [];
		for (const { path, name } of library.filter(
			({ name }) =>
				(name.startsWith('plugins/') || name.startsWith('session/') || name === 'kinds.ts') &&
				// Language names (the picker's labels, overridable by `labels.languages`), icons.
				!name.endsWith('code/languages.ts') &&
				!name.endsWith('plugins/icons.ts')
		)) {
			const source = readFileSync(path, 'utf8');
			for (const [line] of source.matchAll(
				/(label|hint|title|placeholder)\s*[:=]\s*(['"`])[A-Za-z][^'"`]*\2.*$/gm
			))
				if (WORD.test(line!)) found.push(`${name}: ${line!.trim()}`);
			// A sentence built around a value (`Moved ${what} up`, `${n} columns`); the
			// session's others are developer warnings.
			if (name.startsWith('session/') && !name.endsWith('announcer.svelte.ts')) continue;
			for (const [line] of source.matchAll(
				/`(?:[A-Z][a-z]+ [^`]*\$\{|[^`]*\$\{[^}]*\} [a-z]{2,}[^`]*`).*$/gm
			))
				found.push(`${name}: ${line!.trim()}`);
		}
		expect(found).toEqual([]);
	});
});

describe('the localization page', () => {
	it('shows the French dictionary these rows read, as it is (check:docs types it as Labels)', () => {
		const page = readFileSync(
			join(process.cwd(), 'site/content/docs/customization/localization.mdx'),
			'utf8'
		);
		const block = /```ts title="src\/lib\/fr\.ts" check\n([\s\S]*?)```/.exec(page)?.[1];
		const fixture = readFileSync(join(process.cwd(), 'src/tests/fixtures/labels.fr.ts'), 'utf8');
		const body = (source: string) => source.slice(source.indexOf('const octets')).trim();
		expect(block && body(block)).toBe(body(fixture));
	});
});
