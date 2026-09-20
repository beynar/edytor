/**
 * U00 — durable yjs@13.6.30 binary fixtures.
 *
 * The binary artifacts under ./fixtures/legacy-v13 are the recorded baseline:
 * real Edytor-schema documents captured as v1 updates + state vectors. They are
 * persisted so later units (migration, provider port) can decode them without
 * regenerating, and so regeneration is reproducible from source.
 *
 * Regenerate deliberately with:
 *   REGENERATE_LEGACY_V13=1 pnpm exec vitest run src/tests/crdt/legacy-v13.test.ts
 * (or delete the fixture files — missing files are rebuilt on the next run).
 *
 * Assertions always run against the bytes on disk, never the in-memory
 * generation result, so committed fixtures are the contract under test.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	decodeFixtureValue,
	generateFixtures,
	LEGACY_V13_ENGINE,
	type LegacyFixture
} from './fixtures/legacy-v13/generate.js';
import { PendingLegacyUpdatesError } from '$lib/crdt/migration/legacy-schema.js';
import type { JSONDoc } from '$lib/utils/json.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/legacy-v13');

type FixtureSidecar = {
	name: string;
	description: string;
	engine: { yjs: string; lib0: string };
	format: 'yjs-update-v1';
	sourceClientId: number;
	files: { update: string; stateVector: string; pendingUpdate?: string };
	expected: JSONDoc;
	pending?: { expectedAfterPending: JSONDoc; description: string };
};

const paths = (name: string) => ({
	update: join(FIXTURE_DIR, `${name}.update.bin`),
	stateVector: join(FIXTURE_DIR, `${name}.state-vector.bin`),
	pendingUpdate: join(FIXTURE_DIR, `${name}.pending.update.bin`),
	sidecar: join(FIXTURE_DIR, `${name}.json`)
});

const writeFixtures = (fixtures: LegacyFixture[]) => {
	mkdirSync(FIXTURE_DIR, { recursive: true });
	for (const fixture of fixtures) {
		const file = paths(fixture.name);
		writeFileSync(file.update, fixture.update);
		writeFileSync(file.stateVector, fixture.stateVector);
		if (fixture.pending) {
			writeFileSync(file.pendingUpdate, fixture.pending.update);
		}
		const sidecar: FixtureSidecar = {
			name: fixture.name,
			description: fixture.description,
			engine: { ...LEGACY_V13_ENGINE },
			format: 'yjs-update-v1',
			sourceClientId: fixture.sourceClientId,
			files: {
				update: `${fixture.name}.update.bin`,
				stateVector: `${fixture.name}.state-vector.bin`,
				pendingUpdate: fixture.pending ? `${fixture.name}.pending.update.bin` : undefined
			},
			expected: fixture.expected,
			pending: fixture.pending
				? {
						expectedAfterPending: fixture.pending.expectedAfterPending,
						description: fixture.pending.description
					}
				: undefined
		};
		writeFileSync(file.sidecar, `${JSON.stringify(sidecar, null, '\t')}\n`);
	}
};

// Fixtures are generated in memory every run only to learn the manifest of
// expected names and to write missing files; assertions below read from disk.
const manifest = generateFixtures();
const missing = manifest.filter((fixture) => !existsSync(paths(fixture.name).sidecar));
if (missing.length || process.env.REGENERATE_LEGACY_V13) {
	writeFixtures(manifest);
}

const readFixture = (name: string) => {
	const file = paths(name);
	const sidecar = JSON.parse(readFileSync(file.sidecar, 'utf8')) as FixtureSidecar;
	return {
		sidecar,
		update: new Uint8Array(readFileSync(file.update)),
		stateVector: new Uint8Array(readFileSync(file.stateVector)),
		pendingUpdate: existsSync(file.pendingUpdate)
			? new Uint8Array(readFileSync(file.pendingUpdate))
			: undefined
	};
};

describe('legacy v13 binary fixtures (U00 baseline)', () => {
	it('covers the recorded fixture manifest and nothing else', () => {
		const onDisk = readdirSync(FIXTURE_DIR)
			.filter((file) => file.endsWith('.json'))
			.map((file) => file.replace(/\.json$/, ''))
			.sort();
		expect(onDisk).toEqual(manifest.map((fixture) => fixture.name).sort());
	});

	for (const { name } of manifest) {
		describe(name, () => {
			it('decodes the persisted update into the recorded logical content', () => {
				const { sidecar, update } = readFixture(name);
				expect(sidecar.engine).toEqual(LEGACY_V13_ENGINE);
				expect(update.byteLength).toBeGreaterThan(0);
				expect(decodeFixtureValue(update)).toEqual(sidecar.expected);
			});

			it('matches the persisted state vector after applying the update', () => {
				const { update, stateVector } = readFixture(name);
				const doc = new Y.Doc();
				Y.applyUpdate(doc, update);
				expect(Y.encodeStateVector(doc)).toEqual(stateVector);
				// The diff update against the doc's own vector must not introduce
				// any new state on a second replica. (It can still carry a few
				// delete-set bytes for tombstoned items, so a byte-length bound
				// would be wrong; state coverage is the invariant that matters.)
				const replica = new Y.Doc();
				Y.applyUpdate(replica, update);
				Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc, stateVector));
				expect(Y.encodeStateVector(replica)).toEqual(stateVector);
			});

			if (manifest.find((fixture) => fixture.name === name)?.pending) {
				it('applies the offline peer pending update after the base update', () => {
					const { sidecar, update, pendingUpdate } = readFixture(name);
					expect(pendingUpdate).toBeDefined();
					expect(decodeFixtureValue(update, pendingUpdate)).toEqual(
						sidecar.pending!.expectedAfterPending
					);
				});

				it('keeps the pending update incremental (does not decode alone)', () => {
					const { sidecar, pendingUpdate } = readFixture(name);
					expect(pendingUpdate).toBeDefined();
					// Pending-only application leaves dangling dependencies in the
					// store; the v14 legacy reader fails closed rather than
					// materializing a silently-truncated document (gate-2 contract).
					expect(() => decodeFixtureValue(pendingUpdate!)).toThrowError(PendingLegacyUpdatesError);
				});
			}
		});
	}
});
