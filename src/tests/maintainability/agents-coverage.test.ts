/**
 * `scripts/agents-coverage.mjs` compares an earlier single-file AGENTS.md
 * with the guide (`AGENTS.md` and `docs/agents/*.md`): every identifier and
 * rule fragment kept, none doubled, formatting and ticket ids set aside.
 * These rows hold it to finding a lost rule, a lost identifier and a rule
 * kept twice, and to ignoring what is only formatting.
 */
import { describe, expect, test } from 'vitest';
import { coverage } from '../../../scripts/agents-coverage.mjs';

const OLD = [
	'# Guide',
	'',
	'- **Seeds.** A seed is written under a writer id hashed from the value (H13), in a band below 2^26; live writers are uint53, so a seed never displaces a live block.',
	'- Anchors are `DocAnchor = {b, a}` and the seam of a vanished endpoint is `seam(doc, dead, displayable)` in its own module.'
].join('\n');

describe('agents-coverage', () => {
	test('a restructure that moves, re-bullets and drops ticket ids loses nothing', () => {
		const guide = [
			'# Overview\n\nSee the topic files.',
			'# Data model\n\n- Seeds:\n  - A seed is written under a writer id hashed from the value, in a band below 2^26\n  - live writers are uint53, so a seed never displaces a live block.\n- Anchors are `DocAnchor = {b, a}` and the seam of a vanished endpoint is `seam(doc, dead, displayable)` in its own module.'
		];
		expect(coverage(OLD, guide)).toEqual({ missingIds: [], missing: [], doubled: [] });
	});

	test('a lost rule and a lost identifier are reported', () => {
		const guide = ['# Data model\n\n- Seeds: live writers are uint53.'];
		const { missingIds, missing } = coverage(OLD, guide);
		expect(missingIds).toEqual(['DocAnchor = {b, a}', 'seam(doc, dead, displayable)']);
		expect(missing).toContain('a seed is written under a writer id hashed from the value');
	});

	test('a rule kept in two files is reported', () => {
		const rule =
			'Anchors are `DocAnchor = {b, a}` and the seam of a vanished endpoint is `seam(doc, dead, displayable)` in its own module.';
		const guide = [
			`# Overview\n\n${rule}`,
			`# Data model\n\n- A seed is written under a writer id hashed from the value, in a band below 2^26; live writers are uint53, so a seed never displaces a live block.\n- ${rule}`
		];
		expect(coverage(OLD, guide).doubled).toEqual([
			'anchors are `docanchor = {b a}` and the seam of a vanished endpoint is `seam doc dead displayable ` in its own module'
		]);
	});
});
