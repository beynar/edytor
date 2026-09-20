import { expect } from 'vitest';

import { runFixtureEntries } from '../runner.js';
import type { FixtureModule, JsxFixture } from '../types.js';

const modules = import.meta.glob('./jsx/**/*.fixtures.tsx', {
	eager: true
}) as Record<string, FixtureModule<JsxFixture>>;

await runFixtureEntries(modules, async ({ fixture }) => {
	const result = fixture.run ? await fixture.run({ input: fixture.input }) : fixture.input.value;

	expect(result as object).toMatchObject(fixture.output as object);

	if (fixture.assert) {
		await fixture.assert({ input: fixture.input, result });
	}
});
