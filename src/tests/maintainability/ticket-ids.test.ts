/**
 * Comments in `src/lib` say what they mean: a contract row
 * (`del.range.whole-doc`, `layout.single`, `room.quota`, …) or plain
 * prose, never a plan, review or checkpoint id a reader who was not there
 * cannot look up (`scripts/ticket-ids.mjs`). The vendored fork's patches
 * are named `YP1` … `YP14` (UPSTREAM.md), apart from any plan number.
 */
import { describe, expect, test } from 'vitest';
import { findTicketIds, guides, ticketIdsIn } from '../../../scripts/ticket-ids.mjs';

type Finding = { line: number; codes: string[] };
const scan = (file: string, text: string): Finding[] => ticketIdsIn(file, text);
const codes = (file: string, text: string): string[] => scan(file, text).flatMap((f) => f.codes);

describe('ticket ids in src/lib comments', () => {
	test('no comment of src/lib names a ticket id', () => {
		const findings = findTicketIds() as (Finding & { file: string })[];
		expect(
			findings.map(({ file, line, codes }) => `${file}:${line} ${codes.join(' ')}`),
			'name the contract row, or say what is meant (`node scripts/ticket-ids.mjs`)'
		).toEqual([]);
	});

	test('no prose line of AGENTS.md or docs/agents names a ticket id', () => {
		const findings = findTicketIds(guides()) as (Finding & { file: string })[];
		expect(
			findings.map(({ file, line, codes }) => `${file}:${line} ${codes.join(' ')}`),
			'name the contract row, or say what is meant'
		).toEqual([]);
	});

	test('a guide is read as prose: inline code and code blocks may name anything', () => {
		expect(
			codes('a.md', 'The `wave7-x.test.tsx` row (U1).\n\n```bash\npnpm t # H7\n```\nFX-02 here')
		).toEqual(['U1', 'FX-02']);
	});

	test('the scanner reads every comment form of every source kind', () => {
		expect(codes('a.ts', '// see U1\n/** H7: the purge */\nconst x = 1; /* FX-02 */')).toEqual([
			'U1',
			'H7',
			'FX-02'
		]);
		expect(codes('a.js', 'const re = /U1/; // DR-props-2\n')).toEqual(['DR-props-2']);
		expect(
			codes(
				'A.svelte',
				'<script lang="ts">\n\t// D-20\n</script>\n<!-- WU-12 -->\n<p>R4</p>\n<style>\n\t/* §2.4 */\n</style>\n'
			)
		).toEqual(['D-20', 'WU-12', '§2.4']);
		expect(codes('a.css', '/* F-S14 and P2.7 */\n.r4 { color: red; }')).toEqual(['F-S14', 'P2.7']);
	});

	test('code, strings and markup text are not comments', () => {
		expect(codes('a.ts', "const U1 = 'H7';\nconst s = `FX-02 // R4`;\n")).toEqual([]);
		expect(codes('A.svelte', '<script>\n\tconst a = "U1";\n</script>\n<p>H7 R4</p>\n')).toEqual([]);
	});

	test('contract rows, fork patches and the names of what things are pass', () => {
		expect(
			codes(
				'a.ts',
				[
					'// `del.range.whole-doc`, `layout.single`, `room.purge.*`',
					'// fork patch YP11, YP14 (UPSTREAM.md)',
					'// UTF-16 offsets, ES2022, V8, a V1 update, C0 controls, FNV-1a',
					'// an R2 bucket, a D1 database, Alt+F10'
				].join('\n')
			)
		).toEqual([]);
	});

	test('a finding names its line', () => {
		expect(scan('a.ts', '// fine\n\n/**\n * the U5 fix\n */')).toEqual([
			{ line: 4, codes: ['U5'] }
		]);
	});
});
