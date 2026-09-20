import { describe, it } from 'vitest';

import type { FixtureModule } from './types.js';

type FixtureEntry<TFixture> = {
	path: string;
	fixture: TFixture;
	index: number;
};

const humanizePath = (path: string) => {
	return path
		.replace(/^\.\/|^\//, '')
		.replace(/^src\/tests\/fixtures\//, '')
		.replace(/^Users\/arnaud\/code\/edytor\//, '')
		.replace(/\.fixtures?\.[^.]+$/, '')
		.replace(/\.(ts|tsx|js|jsx)$/, '')
		.replace(/\/index$/, '')
		.replace(/-/g, ' ');
};

export const collectFixtureEntries = <TFixture>(
	modules: Record<string, FixtureModule<TFixture>>
): FixtureEntry<TFixture>[] => {
	return Object.entries(modules)
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([path, module]) => {
			const fixtures = module.fixtures ?? (module.fixture ? [module.fixture] : []);
			const allFixtures = fixtures.length > 0 ? fixtures : module.default ? [module.default] : [];

			return allFixtures.map((fixture, index) => ({
				path,
				fixture,
				index
			}));
		});
};

export const runFixtureEntries = async <
	TFixture extends { description: string; only?: boolean; skip?: boolean }
>(
	modules: Record<string, FixtureModule<TFixture>>,
	runFixture: (entry: FixtureEntry<TFixture>) => Promise<void> | void
) => {
	const entries = collectFixtureEntries(modules);
	const groups = new Map<string, FixtureEntry<TFixture>[]>();

	for (const entry of entries) {
		const key = humanizePath(entry.path);
		const group = groups.get(key) ?? [];
		group.push(entry);
		groups.set(key, group);
	}

	for (const [groupName, groupEntries] of groups) {
		describe(groupName, () => {
			for (const entry of groupEntries) {
				const testMethod = entry.fixture.only ? it.only : entry.fixture.skip ? it.skip : it;
				testMethod(entry.fixture.description, async () => {
					await runFixture(entry);
				});
			}
		});
	}
};
