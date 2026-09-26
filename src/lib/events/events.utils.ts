import type { Text } from '$lib/text/text.svelte.js';

export const isAndroidChromeBrowser = () => {
	if (typeof navigator === 'undefined') {
		return false;
	}

	const userAgent = navigator.userAgent;
	return (
		/Android/i.test(userAgent) &&
		/\bChrome\//i.test(userAgent) &&
		!/(Edg|OPR|SamsungBrowser)/i.test(userAgent)
	);
};

export const getTextPath = (text: Text) => {
	const index = text.parent.content.findIndex((part) => part === text);
	return [...text.parent.path, index === -1 ? text.index : index];
};
