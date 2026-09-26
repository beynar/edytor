/** @jsxImportSource ../../jsx */
import { defineDomFixture, defineFixtures } from '../types.js';
import { dispatchDomBeforeInput, dispatchDomKeyDown, dragSelection } from '../../dom/test.utils.js';

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'toggles bold across multiple blocks and keeps the selection range',
		input: (
			<root>
				<paragraph>Alpha</paragraph>
				<paragraph>Beta</paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: async ({ edytor }) => {
			await dragSelection(edytor, [0, 0], 0, [1, 0], 4);
			return dispatchDomKeyDown(document, { key: 'b', code: 'KeyB', metaKey: true });
		},
		output: (
			<root>
				<paragraph>
					<bold>Alpha</bold>
				</paragraph>
				<paragraph>
					<bold>Beta</bold>
				</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 4,
			isCollapsed: false,
			isBlockSpanning: true
		},
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected multi-block bold toggle to prevent native behavior');
			}
		}
	}),
	defineDomFixture({
		description: 'routes native formatBold beforeinput through the mark operation',
		input: (
			<root>
				<paragraph>Al|pha</paragraph>
				<paragraph>Be|ta</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'formatBold' }),
		output: (
			<root>
				<paragraph>
					Al<bold>pha</bold>
				</paragraph>
				<paragraph>
					<bold>Be</bold>ta
				</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 2,
			yEnd: 2,
			isCollapsed: false,
			isBlockSpanning: true
		},
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected native formatBold to prevent browser formatting');
			}
		}
	}),
	defineDomFixture({
		description: 'routes native formatRemove beforeinput through mark removal',
		input: (
			<root>
				<paragraph>
					<bold>Al|pha</bold>
				</paragraph>
				<paragraph>
					<italic>Be|ta</italic>
				</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'formatRemove' }),
		output: (
			<root>
				<paragraph>
					<bold>Al</bold>pha
				</paragraph>
				<paragraph>
					Be<italic>ta</italic>
				</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 2,
			yEnd: 2,
			isCollapsed: false,
			isBlockSpanning: true
		},
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected native formatRemove to prevent browser formatting');
			}
		}
	}),
	defineDomFixture({
		description: 'adds italic across mixed existing marks without stripping the original bold text',
		input: (
			<root>
				<paragraph>
					<bold>Alpha</bold>
				</paragraph>
				<paragraph>Beta</paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: async ({ edytor }) => {
			await dragSelection(edytor, [0, 0], 0, [1, 0], 4);
			return dispatchDomKeyDown(document, { key: 'i', code: 'KeyI', metaKey: true });
		},
		output: (
			<root>
				<paragraph>
					<bold>
						<italic>Alpha</italic>
					</bold>
				</paragraph>
				<paragraph>
					<italic>Beta</italic>
				</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 4,
			isCollapsed: false,
			isBlockSpanning: true
		}
	}),
	defineDomFixture({
		description: 'does not corrupt inline mentions when a selection crosses the inline boundary',
		input: (
			<root>
				<paragraph>
					<mention />
					tail
				</paragraph>
				<paragraph>next</paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: async ({ edytor }) => {
			// Anchor at the mention↔tail boundary (tail@0): the selection starts
			// exactly where the inline atom ends. Offset 1 previously passed only
			// because a contentParts re-walk bug duplicated 'tail' into `texts`,
			// marking the full run regardless of the anchor.
			await dragSelection(edytor, [0, 2], 0, [1, 0], 2);
			return dispatchDomKeyDown(document, { key: 'b', code: 'KeyB', metaKey: true });
		},
		output: (
			<root>
				<paragraph>
					<mention />
					<bold>tail</bold>
				</paragraph>
				<paragraph>
					<bold>ne</bold>xt
				</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [1],
			isCollapsed: false,
			isBlockSpanning: true
		}
	})
]);
