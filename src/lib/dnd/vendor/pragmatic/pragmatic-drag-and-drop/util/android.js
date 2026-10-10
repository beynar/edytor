import { once } from '../public-utils/once.js';

// Using `once` as the value won't change in a browser

export const isAndroid = once(function isAndroid() {
  return navigator.userAgent.toLocaleLowerCase().includes('android');
});

// eslint-disable-next-line @atlaskit/volt-strict-mode/no-multiple-exports
export const androidFallbackText = 'pdnd:android-fallback';