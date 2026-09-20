import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
	return {
		scenario: url.searchParams.get('scenario') ?? 'basic',
		empty: url.searchParams.get('empty'),
		collab: url.searchParams.get('collab'),
		readonly: url.searchParams.get('readonly') === 'true',
		dynamicReadonly: url.searchParams.get('dynamicReadonly') === 'true',
		placeholder: url.searchParams.get('placeholder') ?? undefined,
		enterHotkey: url.searchParams.get('enterHotkey') === 'true',
		backspaceHotkey: url.searchParams.get('backspaceHotkey') === 'true',
		altGraphHotkey: url.searchParams.get('altGraphHotkey') === 'true',
		deadKeyHotkey: url.searchParams.get('deadKeyHotkey') === 'true',
		handles: url.searchParams.get('handles') === 'true',
		secondary: url.searchParams.get('secondary') === 'true',
		dir: url.searchParams.get('dir') === 'rtl' ? 'rtl' : 'ltr',
		translate:
			url.searchParams.get('translate') === 'yes'
				? 'yes'
				: url.searchParams.get('translate') === 'no'
					? 'no'
					: undefined,
		spellcheck:
			url.searchParams.get('spellcheck') === 'false'
				? false
				: url.searchParams.get('spellcheck') === 'true'
					? true
					: undefined,
		autocorrect:
			url.searchParams.get('autocorrect') === 'on'
				? 'on'
				: url.searchParams.get('autocorrect') === 'off'
					? 'off'
					: undefined,
		autocomplete:
			url.searchParams.get('autocomplete') === 'on'
				? 'on'
				: url.searchParams.get('autocomplete') === 'off'
					? 'off'
					: undefined,
		autocapitalize: url.searchParams.get('autocapitalize') ?? undefined
	};
};
