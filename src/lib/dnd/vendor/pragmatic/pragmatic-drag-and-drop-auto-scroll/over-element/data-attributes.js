export const dataAttribute = 'data-auto-scrollable';
// eslint-disable-next-line @atlaskit/volt-strict-mode/no-multiple-exports
export const selector = `[${dataAttribute}="true"]`;

// eslint-disable-next-line @atlaskit/volt-strict-mode/no-multiple-exports
export function addScrollableAttribute(element) {
  element.setAttribute(dataAttribute, 'true');
  return () => element.removeAttribute(dataAttribute);
}