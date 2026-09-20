import { expect } from 'vitest';

import { findCursorPosition } from '../../test.utils.js';
import { runFixtureEntries } from '../runner.js';
import type { CursorFixture, FixtureModule } from '../types.js';

const modules = import.meta.glob('./cursor/**/*.fixtures.tsx', {
	eager: true
}) as Record<string, FixtureModule<CursorFixture>>;

await runFixtureEntries(modules, async ({ fixture }) => {
	const value = structuredClone(fixture.input.value);
	const result = fixture.run ? await fixture.run({ value }) : findCursorPosition(value);

	expect(result).toEqual(fixture.output);

	if (fixture.assert) {
		await fixture.assert({ value, result });
	}
});
