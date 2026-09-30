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
import { execFileSync } from 'node:child_process';

import {
	chromium,
	firefox,
	webkit,
	expect,
	test,
	type Browser,
	type BrowserType
} from '@playwright/test';

import {
	COLLAB_SCHEMA_VERSION,
	generateCollabSchedule,
	type CollabSchedule
} from './collab-generator.js';
import { minimizeCollabFailure, runCollabSchedule } from './collab-runner.js';
import { parseSeedList } from './generator.js';

/**
 * Generated collaboration DST — a seeded schedule of trusted browser
 * actions across 2–3 independent browser CONTEXTS sharing one websocket
 * room through the local opaque relay. Unlike `editor-dst.spec.ts`
 * (independent documents per engine, browser-input consistency), this
 * suite tests MULTI-USER editing: genuine concurrency under held,
 * permuted, duplicated, dropped, delayed and partitioned delivery, then
 * exact full-state convergence (block ids, structure, text, marks,
 * attribution, lineage) checked against a Node-side reference document
 * built from per-peer captured updates — so a universally lost edit
 * cannot pass as "converged".
 *
 * Env knobs:
 *   COLLAB_DST_SEEDS=1,2,5-8   seeds (default: 1-6,9 — seed 9 is the list shape)
 *   COLLAB_DST_STEPS=40        edit/net step budget per seed (default 30)
 *   COLLAB_DST_PEERS=2|3       room size (default 3)
 *   COLLAB_DST_ENGINE=firefox  engine for the whole run (default chromium)
 *   COLLAB_DST_REPLAY=<path>   replay one saved artifact's schedule
 *   COLLAB_DST_SHRINK=0        skip failure minimization
 *   COLLAB_DST_FAILURE_DIR     artifact directory
 */

const ENGINE_TYPES: Record<string, BrowserType> = { chromium, firefox, webkit };
const engineName = process.env.COLLAB_DST_ENGINE ?? 'chromium';
const browserType = ENGINE_TYPES[engineName];
if (!browserType) {
	throw new Error(
		`COLLAB_DST_ENGINE must be one of ${Object.keys(ENGINE_TYPES).join(', ')}, got "${engineName}"`
	);
}

const stepCount = Number(process.env.COLLAB_DST_STEPS ?? 30);
if (!Number.isInteger(stepCount) || stepCount < 1) {
	throw new Error(
		`COLLAB_DST_STEPS must be a positive integer, got "${process.env.COLLAB_DST_STEPS}"`
	);
}

const peerCount = Number(process.env.COLLAB_DST_PEERS ?? 3);
if (peerCount !== 2 && peerCount !== 3) {
	throw new Error(`COLLAB_DST_PEERS must be 2 or 3, got "${process.env.COLLAB_DST_PEERS}"`);
}

const lineageDepth = Number(process.env.COLLAB_DST_LINEAGE ?? 5);
if (!Number.isInteger(lineageDepth) || lineageDepth < 0) {
	throw new Error(
		`COLLAB_DST_LINEAGE must be a non-negative integer, got "${process.env.COLLAB_DST_LINEAGE}"`
	);
}

type ReplayArtifact = {
	schedule?: CollabSchedule;
	originalSchedule?: CollabSchedule | Record<string, unknown>;
	minimized?: { schedule?: CollabSchedule | Record<string, unknown> };
};

const readReplaySchedule = (path: string): CollabSchedule => {
	const artifact = JSON.parse(readFileSync(resolve(path), 'utf8')) as
		| ReplayArtifact
		| CollabSchedule;
	const schedule =
		'minimized' in artifact
			? (artifact.minimized?.schedule ?? artifact.schedule ?? artifact.originalSchedule)
			: artifact;
	if (
		!schedule ||
		typeof schedule !== 'object' ||
		!Array.isArray((schedule as CollabSchedule).steps)
	) {
		throw new Error(`COLLAB_DST_REPLAY: missing schedule steps in ${path}`);
	}
	return schedule as CollabSchedule;
};

const schedules = process.env.COLLAB_DST_REPLAY
	? [readReplaySchedule(process.env.COLLAB_DST_REPLAY)]
	: parseSeedList(process.env.COLLAB_DST_SEEDS ?? '1-6,9').map((seed) =>
			generateCollabSchedule(seed, stepCount, peerCount, lineageDepth)
		);

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
		.filter((path) => !path.split('/').some((segment) => sourceIdentityExcludedRoots.has(segment)))
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

const createFailurePath = (schedule: CollabSchedule) => {
	const directory = resolve(process.env.COLLAB_DST_FAILURE_DIR ?? '.artifacts/editor-collab-dst');
	mkdirSync(directory, { recursive: true });
	const shape = schedule.shape.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
	return join(directory, `${Date.now()}-seed-${schedule.seed}-${shape}.json`);
};

/**
 * Schedule-shape invariant: every held-delivery window must contain
 * edits from AT LEAST TWO distinct peers — and the first two blind edits
 * must be `type` actions, not random possibly-no-op kinds. Distinct peer
 * actions alone do not guarantee concurrent authored updates; the runner
 * independently asserts both own-client clocks advanced (`held-episode-
 * starved`), so this test only needs to pin the generator's shape.
 */
test('held episodes always collect ≥2 distinct editing peers', () => {
	for (let seed = 1; seed <= 128; seed++) {
		for (const peers of [2, 3]) {
			const schedule = generateCollabSchedule(seed, 60, peers);
			const heldPeers = new Set<number>();
			const pinnedKinds: string[] = [];
			let held = false;
			for (const step of schedule.steps) {
				if (step.kind === 'net' && step.op.kind === 'hold') {
					held = true;
					heldPeers.clear();
					pinnedKinds.length = 0;
					continue;
				}
				if (held && step.kind === 'edit') {
					heldPeers.add(step.peer);
					if (pinnedKinds.length < 2) pinnedKinds.push(step.action.kind);
				}
				if (step.kind === 'net' && step.op.kind === 'release') {
					expect(
						heldPeers.size,
						`seed ${seed} peers ${peers}: hold window saw ${heldPeers.size} editing peer(s)`
					).toBeGreaterThanOrEqual(2);
					expect(
						pinnedKinds,
						`seed ${seed} peers ${peers}: pinned blind edits must be authored kinds`
					).toEqual(['type', 'type']);
					held = false;
				}
			}
		}
	}
});

test.describe(`generated collaboration DST (${engineName}, ${peerCount} peers)`, () => {
	let browser: Browser;

	test.beforeAll(async () => {
		browser = await browserType.launch();
	});

	test.afterAll(async () => {
		await browser.close();
	});

	for (const schedule of schedules) {
		test(`seed ${schedule.seed}: ${schedule.shape} (${schedule.steps.length} steps)`, async ({
			baseURL
		}, testInfo) => {
			if (!baseURL) throw new Error('collab DST requires the configured preview baseURL');
			const result = await runCollabSchedule(browser, baseURL, schedule);
			if (result.ok) {
				if (schedule.steps.some((step) => step.kind === 'edit')) {
					expect(result.ledger.filter((entry) => entry.updateB64).length).toBeGreaterThan(0);
				}
				return;
			}

			const artifactPath = createFailurePath(schedule);
			const artifactBase = {
				schemaVersion: COLLAB_SCHEMA_VERSION,
				versions: { generator: 1, runner: 1, fingerprint: 1 },
				source: sourceIdentity(),
				environment: {
					node: process.version,
					platform: process.platform,
					arch: process.arch
				},
				engine: engineName,
				browserVersion: browser.version(),
				failureFingerprint: result.failure.fingerprint,
				failure: result.failure,
				ledger: result.failure.ledger,
				originalSchedule: schedule
			};
			writeFileSync(
				artifactPath,
				`${JSON.stringify({ ...artifactBase, minimized: null, minimization: { status: 'pending' } }, null, 2)}\n`
			);

			const minimized =
				process.env.COLLAB_DST_SHRINK === '0'
					? {
							schedule: {
								...schedule,
								steps: schedule.steps.slice(0, result.failure.stepIndex + 1)
							},
							attempts: 0,
							fingerprint: result.failure.fingerprint,
							termination: 'fixed-point' as const
						}
					: await minimizeCollabFailure(browser, baseURL, schedule, result.failure);
			writeFileSync(
				artifactPath,
				`${JSON.stringify(
					{
						...artifactBase,
						minimized,
						minimization: {
							status: 'complete',
							attempts: minimized.attempts,
							termination: minimized.termination
						}
					},
					null,
					2
				)}\n`
			);
			await testInfo.attach('collab-dst-failure.json', {
				path: artifactPath,
				contentType: 'application/json'
			});

			throw new Error(
				`${result.failure.message}\n` +
					`seed=${schedule.seed} step=${result.failure.stepIndex} code=${result.failure.code} ` +
					`minimized=${minimized.schedule.steps.length} shrinkAttempts=${minimized.attempts}\n` +
					`artifact=${artifactPath}\n` +
					`Replay with COLLAB_DST_REPLAY=${artifactPath} pnpm test:dst`
			);
		});
	}
});
