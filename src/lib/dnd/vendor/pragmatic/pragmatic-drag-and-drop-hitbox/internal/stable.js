import { isShallowEqual } from './isShallowEqual.js';
/**
 * Used to store a stable object, which returns a new object only if one of the values has changed
 */
// eslint-disable-next-line @atlaskit/volt-strict-mode/no-multiple-exports
export function stable(isEqual = isShallowEqual) {
  let cache = null;
  return value => {
    if (cache && isEqual(cache.value, value)) {
      return cache.value;
    }
    cache = {
      value
    };
    return cache.value;
  };
}