import { createTestEdytor, expectBlockInvariantSnapshot } from '../../test.utils.js';
import { runFixtureEntries } from '../runner.js';
import type { FixtureModule, ModelTransformFixture } from '../types.js';

const modules = import.meta.glob('./normalization/**/*.fixtures.tsx', {
	eager: true
}) as Record<string, FixtureModule<ModelTransformFixture>>;

await runFixtureEntries(modules, async ({ fixture }) => {
	const { edytor, expect } = createTestEdytor(fixture.input, {
		plugins: fixture.plugins,
		readonly: fixture.readonly,
		value: fixture.value
	});

	const result = await fixture.run({ edytor });

	expectBlockInvariantSnapshot(edytor);

	if (fixture.output) {
		expect(fixture.output);
	}

	if (fixture.expectSelection) {
		throw new Error('Normalization fixtures should not assert selection state');
	}

	if (fixture.assert) {
		await fixture.assert({ edytor, result });
	}
});
