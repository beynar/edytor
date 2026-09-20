import type { BrowserName, TestInfo } from '@playwright/test';

import { test } from './editorTest';

type BrowserProjectName = 'chromium' | 'firefox' | 'webkit' | 'mobile-chromium' | 'mobile-webkit';

type BrowserQuirk = {
	id: string;
	because: string;
};

type BrowserExpectedValue<T> = {
	value: T;
	quirk: BrowserQuirk;
};

const formatQuirk = ({ id, because }: BrowserQuirk) => `${id}: ${because}`;

export const skipUnlessBrowser = (
	browserName: BrowserName,
	supportedBrowsers: BrowserName[],
	quirk: BrowserQuirk
) => {
	test.skip(!supportedBrowsers.includes(browserName), formatQuirk(quirk));
};

export const skipUnlessProject = (
	testInfo: TestInfo,
	supportedProjects: BrowserProjectName[],
	quirk: BrowserQuirk
) => {
	test.skip(
		!supportedProjects.includes(testInfo.project.name as BrowserProjectName),
		formatQuirk(quirk)
	);
};

export const skipWhenCapabilityMissing = (isMissing: boolean, quirk: BrowserQuirk) => {
	test.skip(isMissing, formatQuirk(quirk));
};

export const expectedByBrowser = <T>(
	browserName: BrowserName,
	defaultValue: T,
	overrides: Partial<Record<BrowserName, BrowserExpectedValue<T>>>
) => overrides[browserName]?.value ?? defaultValue;
