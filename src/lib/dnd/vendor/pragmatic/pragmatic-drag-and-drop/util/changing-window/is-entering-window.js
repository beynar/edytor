import { isFirefox } from '../is-firefox.js';
import { isSafari } from '../is-safari.js';
import { isEnteringWindowInSafari } from './is-entering-window-in-safari.js';
import { isFromAnotherWindow } from './is-from-another-window.js';
export function isEnteringWindow({
  dragEnter
}) {
  const {
    type,
    relatedTarget
  } = dragEnter;
  if (type !== 'dragenter') {
    return false;
  }
  if (isSafari()) {
    return isEnteringWindowInSafari({
      dragEnter
    });
  }

  // standard check
  if (relatedTarget == null) {
    return true;
  }

  /**
   * 🦊 Exception: `iframe` in Firefox (`125.0`)
   *
   * Case 1: parent `window` → child `iframe`
   * `relatedTarget` is the `iframe` element in the parent `window`
   * (foreign element)
   *
   * Case 2: child `iframe` → parent `window`
   * `relatedTarget` is an element inside the child `iframe`
   * (foreign element)
   */

  if (isFirefox()) {
    return isFromAnotherWindow(relatedTarget);
  }

  /**
   * 🌏 Exception: `iframe` in Chrome (`124.0`)
   *
   * Case 1: parent `window` → child `iframe`
   * `relatedTarget` is `null` *(standard check)*
   *
   * Case 2: child `iframe` → parent `window`
   * `relatedTarget` is the `iframe` element in the parent `window`
   */

  // Case 2
  // Using `instanceof` check as the element will be in the same `window`
  return relatedTarget instanceof HTMLIFrameElement;
}