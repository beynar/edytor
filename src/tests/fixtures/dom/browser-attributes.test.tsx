/** @jsxImportSource ../../jsx */
/**
 * Browser-input attribute pass-through on the editable root.
 *
 * The root owns the virtual keyboard on mobile: `inputmode` picks the
 * keyboard layout and `enterkeyhint` labels the action key. They are
 * optional pass-through props — when unset the attributes must be absent
 * (not a guessed default) so the UA keeps its own choice. This file also
 * pins the existing defaults the audit relies on: `autocapitalize="none"`
 * (the iOS programmatic-focus autocapitalization guard), `translate`,
 * `spellcheck`, `autocorrect`, `autocomplete`.
 */
import { describe, expect, test } from 'vitest';
import { renderDomEdytor } from '../../dom/test.utils.js';

describe('editable root browser attributes', () => {
	test('sets default guard attributes and leaves inputmode/enterkeyhint absent', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>hello</paragraph>
			</root>
		);

		expect(editor.getAttribute('autocapitalize')).toBe('none');
		expect(editor.getAttribute('translate')).toBe('no');
		expect(editor.getAttribute('spellcheck')).toBe('true');
		expect(editor.getAttribute('autocorrect')).toBe('off');
		expect(editor.getAttribute('autocomplete')).toBe('off');
		expect(editor.hasAttribute('inputmode')).toBe(false);
		expect(editor.hasAttribute('enterkeyhint')).toBe(false);
	});

	test('forwards inputmode and enterkeyhint to the editable root', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>hello</paragraph>
			</root>,
			{ inputmode: 'email', enterkeyhint: 'send' }
		);

		expect(editor.getAttribute('inputmode')).toBe('email');
		expect(editor.getAttribute('enterkeyhint')).toBe('send');
	});
});
