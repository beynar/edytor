import { isAnAvailableType } from './is-an-available-type.js';

// eslint-disable-next-line @atlaskit/volt-strict-mode/no-multiple-exports
export function getAvailableTypes(transfer) {
  return Array.from(transfer.types).filter(type => isAnAvailableType({
    type,
    value: transfer.getData(type)
  }));
}