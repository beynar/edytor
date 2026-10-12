import { combine } from '../../pragmatic-drag-and-drop/public-utils/combine.js';
import { once } from '../../pragmatic-drag-and-drop/public-utils/once.js';
import { getScheduler } from '../shared/scheduler.js';
import { addScrollableAttribute } from './data-attributes.js';
import { tryScroll } from './try-scroll.js';
export function makeApi({
  monitor
}) {
  const elementRegistry = new Map();
  const windowRegistry = new Set();
  function autoScroll(args) {
    // Warn during development if trying to add auto scroll to an element
    // that is not scrollable.
    // Note: this can produce a false positive when a scroll container is not
    // scrollable initially, but becomes scrollable during a drag.
    // I thought of adding the warning as I think it would be a more common pitfall
    // to accidentally register auto scrolling on the wrong element
    // If requested, we could provide a mechanism to opt out of this warning
    if (process.env.NODE_ENV !== 'production') {
      const {
        overflowX,
        overflowY
      } = window.getComputedStyle(args.element);
      const isScrollable = overflowX === 'auto' || overflowX === 'scroll' || overflowY === 'auto' || overflowY === 'scroll';
      if (!isScrollable) {
        // eslint-disable-next-line no-console
        console.warn('Auto scrolling has been attached to an element that appears not to be scrollable', {
          element: args.element,
          overflowX,
          overflowY
        });
      }
    }

    // Warn if there is an existing registration
    if (process.env.NODE_ENV !== 'production') {
      const existing = elementRegistry.get(args.element);
      if (existing) {
        // eslint-disable-next-line no-console
        console.warn('You have already registered autoScrolling on the same element', {
          existing,
          proposed: args
        });
      }
    }
    elementRegistry.set(args.element, args);
    const cleanup = combine(addScrollableAttribute(args.element), () => elementRegistry.delete(args.element));
    return once(cleanup);
  }
  function autoScrollWindow(args = {}) {
    // Putting `args` in a unique object so that
    // each call will create a unique entry, even if a consumer
    // shares the `args` object between calls.
    // Just being safe here.
    const unique = {
      ...args
    };
    windowRegistry.add(unique);
    function cleanup() {
      windowRegistry.delete(unique);
    }
    return once(cleanup);
  }
  function findEntry(element) {
    var _elementRegistry$get;
    return (_elementRegistry$get = elementRegistry.get(element)) !== null && _elementRegistry$get !== void 0 ? _elementRegistry$get : null;
  }
  function getWindowScrollEntries() {
    return Array.from(windowRegistry);
  }
  function onFrame({
    latestArgs,
    underUsersPointer,
    timeSinceLastFrame
  }) {
    tryScroll({
      input: latestArgs.location.current.input,
      source: latestArgs.source,
      findEntry,
      underUsersPointer,
      timeSinceLastFrame,
      getWindowScrollEntries
    });
  }
  getScheduler(monitor).onFrame(onFrame);
  return {
    autoScroll,
    autoScrollWindow
  };
}