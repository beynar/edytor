import { isSafari } from '../is-safari.js';
import { symbols } from './count-events-for-safari.js';
export function isEnteringWindowInSafari({
  dragEnter
}) {
  if (!isSafari()) {
    return false;
  }
  return dragEnter.hasOwnProperty(symbols.isEnteringWindow);
}