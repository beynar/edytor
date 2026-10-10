import { isSafari } from '../is-safari.js';
import { symbols } from './count-events-for-safari.js';

// eslint-disable-next-line @atlaskit/volt-strict-mode/no-multiple-exports
export function isLeavingWindowInSafari({
  dragLeave
}) {
  if (!isSafari()) {
    return false;
  }
  return dragLeave.hasOwnProperty(symbols.isLeavingWindow);
}