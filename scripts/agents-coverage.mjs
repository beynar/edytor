#!/usr/bin/env node
/**
 * Did a restructure of the contributor guide lose anything?
 * (`node scripts/agents-coverage.mjs <old AGENTS.md>`)
 *
 * The guide is `AGENTS.md` (the overview) and `docs/agents/*.md` (the
 * topic files). Given an earlier single-file `AGENTS.md`, this script
 * checks that the guide still holds all of it, each rule once:
 *
 * - every backticked identifier of the old file is backticked somewhere in
 *   the guide;
 * - every rule fragment of the old file (its prose split at sentence and
 *   clause punctuation, fragments of four words or more) is in the guide,
 *   compared after the formatting is set aside (Markdown markers, bullets,
 *   table pipes, case, spacing) and after the ticket ids are set aside on
 *   both sides (`scripts/ticket-ids.mjs`'s `CODE`: the guide names contract
 *   rows and fork patches `YPn` instead);
 * - no fragment of eight words or more is in the guide more often than in
 *   the old file (a rule kept twice).
 *
 * `REMOVED` lists what a change took out on purpose (a retired alias) and
 * `REWORDED` the wording a change replaced, each with its reason: they are
 * part of the review, so keep them short and say why. It prints what is
 * missing or doubled and exits non-zero when anything is.
 *
 * Get the old file from git: `git show <rev>:AGENTS.md > /tmp/agents.md`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE } from './ticket-ids.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Taken out on purpose: a fragment or identifier containing one of these, and why. */
const REMOVED = [
	['`KVLike` is wrapped, deprecated', 'a bare KV namespace is no history store any more'],
	['are deprecated aliases of `server`', 'serverUrl/roomName are gone'],
	['Deprecated aliases live one release', 'the aliases it listed are gone'],
	['`hotKeys` (the `hotkeys` option)', 'the hotKeys alias is gone'],
	["the room's `attachDocument` (`attachRoom`)", 'the attachDocument alias is gone'],
	['`moveBlocks` (`moveBlocksBetweenRooms`)', 'the cross-room moveBlocks alias is gone']
];
/** Replaced wording: an old fragment, the guide's, and why. */
const REWORDED = [
	[
		'(see the anchor contract below)',
		'(see the anchor contract in [selection-and-input.md](selection-and-input.md#selection-contracts-that-must-not-regress))',
		'the anchor contract is in another topic file'
	],
	['Block handles and the block menu:', '## Block handles and the block menu', 'a heading'],
	[
		'`docs/crdt-v14-text-ownership-adr.md` and the plan §2.1 have the details',
		'`docs/crdt-v14-text-ownership-adr.md` has the details',
		'the plan is archived'
	],
	['clears the D-20 baseline', 'clears the re-placement baseline', 'ticket id to prose'],
	[
		'or D-20 when a commit re-places',
		'or the re-placement end when a commit re-places',
		'ticket id to prose'
	],
	["**D-25:** a block's own text", "**Strict regions:** a block's own text", 'ticket id to prose'],
	['**BI2-5 lint**', '**Host-writer lint**', 'ticket id to prose'],
	['BI2-5 host writers', 'host writers', 'ticket id to prose'],
	['since arch-v2 D12', 'since architecture v2', 'ticket id to prose'],
	[
		"Text typed at the caret that a plugin's rule replaces (`inputRules`: first match",
		'Input rules (`inputRules`): first match',
		'the owners table keeps the fact, the topic file its details'
	],
	[
		"`colorAttributes` (the one reading: the core's block element",
		"`colorAttributes` is the one reading (the core's block element",
		'the owners table keeps the fact, the topic file its details'
	],
	[
		"and `setBlockColor` (the one write, the block menu's Color",
		"and `setBlockColor` the one write (the block menu's Color",
		'the owners table keeps the fact, the topic file its details'
	]
];

/** Files this change moved or renamed: an old path, its new one. */
const RENAMED = [
	['docs/architecture-v2/', 'docs/archive/architecture-v2/'],
	['children-container-20260930.test.tsx', 'children-container.test.tsx'],
	['drag-preview-20260930.test.tsx', 'drag-preview.test.tsx'],
	['labels-20261008.test.ts', 'labels.test.ts']
];

export const guideFiles = () => [
	path.join(ROOT, 'AGENTS.md'),
	...readdirSync(path.join(ROOT, 'docs/agents'))
		.filter((name) => name.endsWith('.md'))
		.sort()
		.map((name) => path.join(ROOT, 'docs/agents', name))
];

const ID = `(?:${CODE.source})`;
const LIST = `${ID}(?:(?:, |; |/| and | )${ID})*`;
/** Ticket ids and fork patch names set aside, with the brackets and separators they leave. */
const withoutIds = (text) =>
	text
		.replace(new RegExp(` ?\\((?:fork patch )?${LIST}\\)`, 'g'), '')
		.replace(new RegExp(`\\((?:fork patch )?${LIST}(?:, |; |: )`, 'g'), '(')
		.replace(new RegExp(`(?:, |; )(?:fork patch )?${LIST}\\)`, 'g'), ')')
		.replace(new RegExp(`(?:fork patch )?${ID}`, 'g'), ' ');

/** Formatting set aside: Markdown markers, bullets, pipes, case, spacing. */
const normalized = (text) =>
	withoutIds(text)
		.replace(/\*\*/g, '')
		.replace(/^\s*(?:[-*]|#+|\d+\.)\s+/gm, '')
		.replace(/^\|?[\s|:-]+\|?$/gm, '')
		.replace(/\|/g, '. ')
		.replace(/\s+/g, ' ')
		.toLowerCase()
		.trim();

/** Rule fragments: split at sentence and clause punctuation, never inside inline code. */
const fragments = (text, minWords) =>
	normalized(text)
		.replace(/`[^`]*`/g, (code) => code.replace(/[.;:,()[\]]/g, ' ').replace(/\s+/g, ' '))
		.split(/[.;:,()[\]—]|\s-\s/)
		.map((f) => f.trim())
		.filter((f) => f.split(' ').filter(Boolean).length >= minWords);

const identifiers = (text) => new Set([...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));

const count = (haystack, needle) => {
	let n = 0;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) n++;
	return n;
};

export const coverage = (oldText, guide = guideFiles().map((f) => readFileSync(f, 'utf8'))) => {
	let old = oldText;
	for (const [from, to] of [...REWORDED, ...RENAMED]) old = old.split(from).join(to);
	const newText = guide.join('\n\n');
	const removed = (s) =>
		REMOVED.some(
			([needle]) => normalized(needle).length > 0 && normalized(s).includes(normalized(needle))
		);
	const removedLine = (line) => REMOVED.some(([needle]) => line.includes(needle));
	const keptOld = old
		.split('\n')
		.map((line) => {
			let l = line;
			for (const [needle] of REMOVED) l = l.split(needle).join(' ');
			return l;
		})
		.join('\n');
	const have = identifiers(newText);
	const missingIds = [...identifiers(keptOld)].filter(
		(id) => !have.has(id) && !removedLine(`\`${id}\``)
	);
	const flat = (text) =>
		normalized(text).replace(/`[^`]*`/g, (code) =>
			code.replace(/[.;:,()[\]]/g, ' ').replace(/\s+/g, ' ')
		);
	const hay = flat(newText);
	const oldHay = flat(keptOld);
	const missing = [...new Set(fragments(keptOld, 4))].filter(
		(f) => !hay.includes(f) && !removed(f)
	);
	const doubled = [...new Set(fragments(newText, 8))].filter(
		(f) => count(hay, f) > Math.max(1, count(oldHay, f))
	);
	return { missingIds, missing, doubled };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const file = process.argv[2];
	if (!file) {
		console.error('usage: node scripts/agents-coverage.mjs <old AGENTS.md>');
		process.exit(2);
	}
	const { missingIds, missing, doubled } = coverage(readFileSync(file, 'utf8'));
	for (const id of missingIds) console.log(`missing identifier: \`${id}\``);
	for (const f of missing) console.log(`missing: ${f}`);
	for (const f of doubled) console.log(`doubled: ${f}`);
	const old = readFileSync(file, 'utf8');
	console.log(
		`agents-coverage: ${identifiers(old).size} identifiers, ${new Set(fragments(old, 4)).size} rule fragments checked against ${guideFiles().length} files; ${missingIds.length} identifiers and ${missing.length} fragments missing, ${doubled.length} doubled`
	);
	if (missingIds.length || missing.length || doubled.length) process.exit(1);
}
