/**
 * CI gate guard (WU-08, decision D9; WU-09, CC-05). The workflows are the
 * gate a pull request and a release go through, and CONTRIBUTING.md and
 * AGENTS.md describe them: these rows keep the three in step, and keep the
 * gate lanes free of what a shared runner cannot hold (a wall-clock bound,
 * a retry).
 *
 * - `ci.yml` runs on every push and pull request: the static checks and the
 *   unit, crdt, dom and room lanes always, Playwright Chromium sharded on a
 *   pull request (and when a caller or a manual run asks, `browsers`); its
 *   gate job needs every other job, and only the pull request run's is
 *   named `CI passed`, the one check branch protection requires (a push run
 *   on the same commit skips Chromium, so it must never report that name).
 * - `nightly.yml` runs Firefox, WebKit, the two mobile projects, CDP and DST.
 * - `publish.yml` publishes only after `ci.yml` passed on the tagged commit,
 *   and only its publish job may mint an OIDC token.
 * - No Playwright project retries; no gate test asserts a time it measured.
 *
 * Expected values come from the plan's WU-08/WU-09 scope and D9, not from
 * the workflow files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** The workflow's jobs, each as its own text block (two-space job keys under `jobs:`). */
const jobs = (workflow: string): Map<string, string> => {
	const body = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length);
	const out = new Map<string, string>();
	let name: string | null = null;
	let lines: string[] = [];
	for (const line of body.split('\n')) {
		const key = /^ {2}([\w-]+):\s*$/.exec(line);
		if (key) {
			if (name !== null) out.set(name, lines.join('\n'));
			name = key[1]!;
			lines = [];
		} else if (/^\S/.test(line)) break;
		else lines.push(line);
	}
	if (name !== null) out.set(name, lines.join('\n'));
	return out;
};

/** Every `run:` command of a job block (one-line form). */
const runs = (job: string) => [...job.matchAll(/^\s*- run: (.+)$/gm)].map((m) => m[1]!.trim());

const ci = read('.github/workflows/ci.yml');
const nightly = read('.github/workflows/nightly.yml');
const publish = read('.github/workflows/publish.yml');

/** The static checks and test lanes D9 puts on every push. */
const EVERY_PUSH = [
	'pnpm check',
	'pnpm lint',
	'pnpm check:worker',
	'pnpm check:docs',
	'pnpm test:typecheck',
	'pnpm test:dom:typecheck',
	'pnpm test:do:typecheck',
	'pnpm exec vitest --run',
	'pnpm test:crdt',
	'pnpm test:dom',
	'pnpm test:do'
];

describe('ci.yml — the gate on every push and pull request (D9)', () => {
	const on = ci.slice(ci.indexOf('\non:\n'), ci.indexOf('\njobs:\n'));
	/** The block of one trigger under `on:` (four-space keys below it). */
	const trigger = (event: string) => {
		const start = on.search(new RegExp(`^ {2}${event}:`, 'm'));
		if (start < 0) return null;
		const rest = on.slice(start).split('\n');
		const end = rest.findIndex((line, i) => i > 0 && /^ {0,2}\S/.test(line));
		return rest.slice(0, end < 0 ? undefined : end).join('\n');
	};

	it('runs on push and pull_request, and can be called (publish.yml)', () => {
		expect(trigger('push')).not.toBeNull();
		expect(trigger('pull_request')).not.toBeNull();
		expect(trigger('workflow_call')).not.toBeNull();
	});

	it('declares the browsers input for every trigger that can ask for Chromium', () => {
		for (const event of ['workflow_call', 'workflow_dispatch']) {
			const block = trigger(event);
			if (block === null) continue;
			expect(block, event).toMatch(/^ {6}browsers:\n(?: {8}.*\n)*? {8}type: boolean$/m);
		}
	});

	it('runs every static check and gate lane unconditionally', () => {
		const ran = new Map<string, string>();
		for (const [name, job] of jobs(ci)) for (const cmd of runs(job)) ran.set(cmd, name);
		for (const cmd of EVERY_PUSH) {
			const job = ran.get(cmd);
			expect(job, cmd).toBeDefined();
			expect(jobs(ci).get(job!)!, `${cmd} runs on every push`).not.toMatch(/^ {4}if:/m);
		}
	});

	it('runs Playwright Chromium sharded on a pull request only (or when a caller asks)', () => {
		const [name, job] = [...jobs(ci)].find(([, job]) =>
			runs(job).some((cmd) => cmd.includes('--project=chromium'))
		)!;
		expect(name).toBeDefined();
		expect(job).toMatch(/^ {4}if: github\.event_name == 'pull_request' \|\| inputs\.browsers$/m);
		expect(runs(job).join('\n')).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/\d/);
	});

	it("'CI passed' needs every other job and fails unless each succeeded or was skipped", () => {
		const all = jobs(ci);
		const [name, job] = [...all].find(([, job]) => /^ {4}name: .*CI passed/m.test(job))!;
		expect(job).toMatch(/^ {4}if: always\(\)$/m);
		const needs = /^ {4}needs: \[([^\]]*)\]$/m
			.exec(job)![1]!
			.split(',')
			.map((s) => s.trim());
		expect(needs.sort()).toEqual([...all.keys()].filter((k) => k !== name).sort());
		expect(job).toContain('success | skipped) ;;');
	});

	it("only the pull request run reports 'CI passed' (a push run skips Chromium)", () => {
		const gate = [...jobs(ci).values()].find((job) => /^ {4}name: .*CI passed/m.test(job))!;
		// Evaluated per event: `CI passed` for a pull request, `CI passed (<event>)` otherwise.
		expect(gate).toMatch(
			/^ {4}name: \$\{\{ github\.event_name == 'pull_request' && 'CI passed' \|\| format\('CI passed \(\{0\}\)', github\.event_name\) \}\}$/m
		);
		// No other job of any workflow takes the required name.
		for (const [file, workflow] of [
			['ci.yml', ci],
			['nightly.yml', nightly],
			['publish.yml', publish]
		] as const)
			for (const [id, job] of jobs(workflow))
				if (job !== gate) expect(job, `${file} ${id}`).not.toMatch(/^ {4}name: .*CI passed/m);
	});

	it('CONTRIBUTING.md names the check to require and every lane CI runs', () => {
		const contributing = read('CONTRIBUTING.md');
		expect(contributing).toContain('**`CI passed`**');
		for (const cmd of EVERY_PUSH) expect(contributing, cmd).toContain(cmd);
	});
});

describe('nightly.yml — the slow lanes (D9)', () => {
	it('runs Firefox, WebKit, both mobile projects, CDP and DST', () => {
		for (const project of ['firefox', 'webkit', 'mobile-chromium', 'mobile-webkit', 'cdp'])
			expect(nightly, project).toMatch(new RegExp(`^\\s+- project: ${project}$`, 'm'));
		expect(nightly).toContain('--project=${{ matrix.project }}');
		expect(nightly).toMatch(/^\s+- run: pnpm test:dst$/m);
		expect(nightly).toMatch(/^ {2}schedule:/m);
	});
});

describe('publish.yml — nothing ships without CI on the tagged commit', () => {
	it('calls ci.yml with the browsers and publishes only after it', () => {
		const all = jobs(publish);
		const gate = [...all].find(([, job]) => job.includes('uses: ./.github/workflows/ci.yml'));
		expect(gate).toBeDefined();
		expect(gate![1]).toMatch(/browsers: true/);
		const [, job] = [...all].find(([, job]) => job.includes('npm publish'))!;
		expect(job).toMatch(new RegExp(`^ {4}needs: ${gate![0]}$`, 'm'));
	});

	it('a -next.N pre-release goes under `next`; a release candidate and a release under `latest`', () => {
		const expression = /tag=\$\(node -p '([^']+)'\)/.exec(publish)?.[1];
		expect(expression).toBeDefined();
		const tagOf = (version: string) =>
			new Function('require', `return ${expression}`)(() => ({ version })) as string;
		expect(tagOf('0.1.0-next.44')).toBe('next');
		expect(tagOf('1.0.0-rc.1')).toBe('latest');
		expect(tagOf('1.0.0')).toBe('latest');
	});

	it('mints an OIDC token only in the publish job', () => {
		const top = publish.slice(0, publish.indexOf('\njobs:\n'));
		expect(top).not.toContain('id-token');
		for (const [, job] of jobs(publish))
			if (job.includes('id-token: write')) expect(job).toContain('npm publish');
	});
});

describe('gate lanes hold on a shared runner (CC-05)', () => {
	it('no Playwright project retries a failed row', () => {
		const configs = readdirSync(root).filter((f) => /^playwright.*\.config\.ts$/.test(f));
		expect(configs).toContain('playwright.config.ts');
		for (const config of configs) expect(read(config), config).not.toMatch(/\bretries\s*:/);
	});

	const sources = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return sources(path);
			return /\.(test|spec)\.(ts|tsx|js)$/.test(entry.name) ? [path] : [];
		});

	it('no gate test asserts a time it measured', () => {
		const offenders: string[] = [];
		for (const path of [...sources(join(root, 'src/tests')), ...sources(join(root, 'tests'))]) {
			const text = readFileSync(path, 'utf8');
			if (!/performance\.now\(\)|Date\.now\(\)/.test(text)) continue;
			// Names bound to a measured duration: `x = performance.now() - t0`,
			// `const [, x] = time(…)`, or a helper's `const x = time(…)` / `timeKey(…)`.
			const timed = new Set<string>(['ms', 'elapsed', 'took', 'duration']);
			for (const m of text.matchAll(
				/(?:const|let)?\s*(\w+)\s*=\s*(?:performance\.now\(\)|Date\.now\(\)|now\(\))\s*-/g
			))
				timed.add(m[1]!);
			for (const m of text.matchAll(/(?:const|let)\s*\[\s*\w*\s*,\s*(\w+)\s*\]\s*=\s*time\(/g))
				timed.add(m[1]!);
			for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?time\w*\(/g))
				timed.add(m[1]!);
			const subject = [...timed].join('|');
			const assert = new RegExp(
				`expect\\(\\s*(?:(?:${subject})\\b[^)]*|(?:performance|Date)\\.now\\(\\)[^)]*)\\)` +
					`\\s*\\.(?:not\\.)?toBeLessThan`,
				'g'
			);
			for (const m of text.matchAll(assert)) {
				const line = text.slice(0, m.index).split('\n').length;
				offenders.push(`${relative(root, path)}:${line} ${m[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
