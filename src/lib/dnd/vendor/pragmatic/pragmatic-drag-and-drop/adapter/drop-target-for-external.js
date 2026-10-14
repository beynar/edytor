import { adapter } from './external-adapter.js';
// eslint-disable-next-line @atlaskit/volt-strict-mode/no-multiple-exports
export function dropTargetForExternal(args) {
  // not removing unused events, just leaning on the type system
  return adapter.dropTarget(args);
}