import { expectNativeSelection, renderDomEdytor } from '../../dom/test.utils.js';
import { expectSelection } from '../../test.utils.js';
import { runFixtureEntries } from '../runner.js';
import type { DomFixture, FixtureModule } from '../types.js';

const modules = import.meta.glob('./**/*.fixtures.tsx', {
	eager: true
}) as Record<string, FixtureModule<DomFixture>>;

await runFixtureEntries(modules, async ({ fixture }) => {
	const rendered = await renderDomEdytor(fixture.input, {
		plugins: fixture.plugins,
		readonly: fixture.readonly,
		placeholder: fixture.placeholder,
		translate: fixture.translate,
		spellcheck: fixture.spellcheck,
		autocorrect: fixture.autocorrect,
		autocomplete: fixture.autocomplete,
		autocapitalize: fixture.autocapitalize,
		inputmode: fixture.inputmode,
		enterkeyhint: fixture.enterkeyhint,
		doc: fixture.doc,
		awareness: fixture.awareness,
		sync: fixture.sync,
		value: fixture.value,
		autoSelectFixture: fixture.autoSelectFixture,
		onChange: fixture.onChange,
		onSelectionChange: fixture.onSelectionChange
	});

	const result = await fixture.run(rendered);

	if (fixture.output) {
		rendered.expect(fixture.output);
	}

	if (fixture.expectSelection) {
		expectSelection(rendered.edytor, fixture.expectSelection);
	}

	if (fixture.expectNativeSelection) {
		expectNativeSelection(fixture.expectNativeSelection);
	}

	if (fixture.assert) {
		await fixture.assert({ ...rendered, result });
	}
});
