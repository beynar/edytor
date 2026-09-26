import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import {
	DST_SCHEMA_VERSION,
	generateDstSchedule,
	parseSeedList,
	type DstSchedule
} from './generator.js';
import {
	closeDstEngines,
	engineVersions,
	launchDstEngines,
	minimizeDstFailure,
	runDstSchedule
} from './runner.js';

type ReplayArtifact = {
	schedule?: DstSchedule;
	originalSchedule?: DstSchedule | Record<string, unknown>;
	minimized?: { schedule?: DstSchedule | Record<string, unknown> };
	environment?: { platform?: string };
};

const upgradeSchedule = (value: unknown, path: string, platform?: string): DstSchedule => {
	if (!value || typeof value !== 'object') {
		throw new Error(`DST_REPLAY: missing schedule in ${path}`);
	}
	let schedule = value as Record<string, unknown>;
	if (schedule.schemaVersion === 1 && Array.isArray(schedule.steps)) {
		schedule = {
			...(schedule as unknown as Omit<DstSchedule, 'schemaVersion' | 'steps'>),
			schemaVersion: 2,
			steps: schedule.steps.map((step) => {
				const legacy = step as { selection?: Record<string, unknown>; action?: unknown };
				if (!legacy.selection || typeof legacy.selection.mode !== 'string') {
					throw new Error(`DST_REPLAY: malformed v1 selection in ${path}`);
				}
				return {
					selection: { kind: 'text' as const, ...legacy.selection },
					action: legacy.action
				} as DstSchedule['steps'][number];
			})
		};
	}
	if (
		(schedule.schemaVersion === 2 || schedule.schemaVersion === 3) &&
		Array.isArray(schedule.steps)
	) {
		// v2 → v3 → v4 are additive at the action union level — steps replay
		// unchanged, only the version marker advances.
		schedule = {
			...(schedule as unknown as Omit<DstSchedule, 'schemaVersion'>),
			schemaVersion: 4
		};
	}
	if (schedule.schemaVersion === 4 && Array.isArray(schedule.steps)) {
		// v4 → v5: on darwin a `wordDelete` backward pressed Meta+Backspace
		// — the LINE-delete chord. Preserve the delivered chord by
		// rewriting the intent to `lineDelete`; forward (Alt+Delete) and
		// non-darwin backward (Alt+Backspace) were honest word deletes
		// already, so they keep the action they recorded.
		schedule = {
			...schedule,
			schemaVersion: DST_SCHEMA_VERSION,
			steps: schedule.steps.map((step) => {
				const action = (step as { action?: { kind?: string; direction?: string } }).action;
				if (
					platform === 'darwin' &&
					action?.kind === 'wordDelete' &&
					action.direction === 'backward'
				) {
					return {
						...(step as Record<string, unknown>),
						action: { kind: 'lineDelete', direction: 'backward' }
					};
				}
				return step;
			})
		};
	}
	if (schedule.schemaVersion === DST_SCHEMA_VERSION) {
		return schedule as unknown as DstSchedule;
	}
	throw new Error(`DST_REPLAY: unsupported schedule version in ${path}`);
};

const readReplaySchedule = (path: string): DstSchedule => {
	const artifact = JSON.parse(readFileSync(resolve(path), 'utf8')) as ReplayArtifact | DstSchedule;
	const schedule =
		'minimized' in artifact
			? (artifact.minimized?.schedule ?? artifact.schedule ?? artifact.originalSchedule)
			: artifact;
	// v4-era artifacts record the producing host at top level — the v4→v5
	// rewrite needs it to know which chord `wordDelete` actually pressed.
	const platform = 'environment' in artifact ? artifact.environment?.platform : undefined;
	return upgradeSchedule(schedule, path, platform);
};

// One full 40-step cycle by default — the generator's forced cycle is
// mod-40, so anything shorter never reaches the v3 input slots (18–35)
// or the v4 foreign-DOM mutation slots (36–39), leaving that whole
// surface dead in the default lane.
const stepCount = Number(process.env.DST_STEPS ?? 40);
if (!Number.isInteger(stepCount) || stepCount < 1) {
	throw new Error(`DST_STEPS must be a positive integer, received ${process.env.DST_STEPS}`);
}

const schedules = process.env.DST_REPLAY
	? [readReplaySchedule(process.env.DST_REPLAY)]
	: parseSeedList(process.env.DST_SEEDS).map((seed) => generateDstSchedule(seed, stepCount));

const sourceIdentityExcludedRoots = new Set([
	'.artifacts',
	'.svelte-kit',
	'build',
	'dist',
	'dist-ssr',
	'node_modules',
	'package',
	'playwright-report',
	'test-results'
]);

const sourceIdentity = () => {
	const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).length > 0;
	const paths = execFileSync(
		'git',
		['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
		{ encoding: 'utf8' }
	)
		.split('\0')
		.filter(Boolean)
		.filter(
			(path: string) => !path.split('/').some((segment) => sourceIdentityExcludedRoots.has(segment))
		)
		.sort();
	const content = createHash('sha256');
	for (const path of paths) {
		content.update(`${path.length}:${path}:`);
		if (!existsSync(path)) {
			content.update('missing');
			continue;
		}
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			content.update(`symlink:${readlinkSync(path)}`);
		} else if (stat.isFile()) {
			content.update(readFileSync(path));
		} else {
			content.update(`non-file:${stat.mode}`);
		}
	}
	return { commit, dirty, contentHash: content.digest('hex') };
};

const createFailurePath = (schedule: DstSchedule) => {
	const directory = resolve(process.env.DST_FAILURE_DIR ?? '.artifacts/editor-dst');
	mkdirSync(directory, { recursive: true });
	const shape = schedule.shape.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
	return join(directory, `${Date.now()}-seed-${schedule.seed}-${shape}.json`);
};

test.describe('deterministic browser input simulation', () => {
	let engines: Awaited<ReturnType<typeof launchDstEngines>> = [];

	test.beforeAll(async () => {
		engines = await launchDstEngines();
	});

	test.afterAll(async () => {
		await closeDstEngines(engines);
	});

	for (const schedule of schedules) {
		test(`seed ${schedule.seed}: ${schedule.shape} (${schedule.steps.length} steps)`, async ({
			baseURL
		}, testInfo) => {
			if (!baseURL) throw new Error('DST requires the configured preview baseURL');
			const result = await runDstSchedule(engines, baseURL, schedule);
			if (result.ok) {
				expect(Object.keys(result.finalSnapshots)).toEqual(['chromium', 'firefox', 'webkit']);
				return;
			}

			const artifactPath = createFailurePath(schedule);
			const artifactBase = {
				schemaVersion: DST_SCHEMA_VERSION,
				versions: { generator: DST_SCHEMA_VERSION, oracle: 5, fingerprint: 1 },
				source: sourceIdentity(),
				environment: {
					node: process.version,
					platform: process.platform,
					arch: process.arch
				},
				browserVersions: engineVersions(engines),
				failureFingerprint: result.failure.fingerprint,
				failure: result.failure,
				originalSchedule: schedule
			};
			writeFileSync(
				artifactPath,
				`${JSON.stringify(
					{
						...artifactBase,
						minimized: null,
						minimization: { status: 'pending', attempts: 0 }
					},
					null,
					2
				)}\n`
			);

			const minimized =
				process.env.DST_SHRINK === '0'
					? {
							schedule: {
								...schedule,
								steps: schedule.steps.slice(0, result.failure.stepIndex + 1)
							},
							attempts: 0,
							fingerprint: result.failure.fingerprint,
							termination: 'fixed-point' as const
						}
					: await minimizeDstFailure(engines, baseURL, schedule, result.failure);
			const artifact = {
				...artifactBase,
				minimized,
				minimization: {
					status: 'complete',
					attempts: minimized.attempts,
					termination: minimized.termination
				}
			};
			writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
			await testInfo.attach('dst-failure.json', {
				path: artifactPath,
				contentType: 'application/json'
			});

			throw new Error(
				`${result.failure.message}\n` +
					`seed=${schedule.seed} step=${result.failure.stepIndex} minimized=${minimized.schedule.steps.length} ` +
					`shrinkAttempts=${minimized.attempts}\n` +
					`artifact=${artifactPath}\n` +
					`Replay with DST_REPLAY=${artifactPath} pnpm test:dst`
			);
		});
	}
});
