import { expect } from 'vitest';

import { runFixtureEntries } from '../runner.js';
import type { FixtureModule, ParserFixture } from '../types.js';

const modules = import.meta.glob('./utilities/**/*.fixtures.ts', {
	eager: true
}) as Record<string, FixtureModule<ParserFixture>>;

await runFixtureEntries(modules, async ({ fixture }) => {
	if (!fixture.run) {
		throw new Error(`Utility fixture "${fixture.description}" is missing a run() implementation`);
	}

	const result = await fixture.run(fixture.input);

	if (fixture.output !== undefined) {
		expect(result).toEqual(fixture.output);
	}

	if (fixture.assert) {
		await fixture.assert({ result, input: fixture.input });
	}
});
