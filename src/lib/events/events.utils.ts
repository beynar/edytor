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
