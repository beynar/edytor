import { honeyPotDataAttribute } from './honey-pot-data-attribute.js';
export function isHoneyPotElement(target) {
  return target instanceof Element && target.hasAttribute(honeyPotDataAttribute);
}