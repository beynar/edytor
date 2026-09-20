import { createOperationEdytor, expectOperationResult, expectSelection } from '../../test.utils.js';
import type { OperationResultExpectation } from '../../test.utils.js';
import { runFixtureEntries } from '../runner.js';
import type { FixtureModule, ModelOperationFixture } from '../types.js';

const modules = import.meta.glob('./history/**/*.fixtures.tsx', {
	eager: true
}) as Record<string, FixtureModule<ModelOperationFixture>>;

await runFixtureEntries(modules, async ({ fixture }) => {
	const { edytor, expect } = createOperationEdytor(fixture.input, {
		plugins: fixture.plugins,
		readonly: fixture.readonly,
		value: fixture.value
	});

	const result = await fixture.run({ edytor });

	if (fixture.result) {
		expectOperationResult(
			result as Parameters<typeof expectOperationResult>[0],
			fixture.result as OperationResultExpectation
		);
	}

	if (fixture.output) {
		expect(fixture.output);
	}

	if (fixture.expectSelection) {
		expectSelection(edytor, fixture.expectSelection);
	}

	if (fixture.assert) {
		await fixture.assert({ edytor, result });
	}
});
