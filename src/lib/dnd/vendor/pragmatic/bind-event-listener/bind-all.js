import { bind } from './bind.js';

function toOptions(value) {
  if (typeof value === 'undefined') {
    return undefined;
  }

  // Convert capture boolean format to options to object
  if (typeof value === 'boolean') {
    return {
      capture: value,
    };
  }

  // Already an object, don't need to convert it
  return value;
}

function getBinding(original, sharedOptions) {
  // No shared options, just return original binding
  if (sharedOptions == null) {
    return original;
  }

  const binding = {
    ...original,
    // Converting both options to object format for merging
    options: {
      ...toOptions(sharedOptions),
      // Giving individual binding option precedence
      ...toOptions(original.options),
    },
  };
  return binding;
}

export function bindAll(target, bindings, sharedOptions) {
  const unbinds = bindings.map((original) => {
    const binding = getBinding(original, sharedOptions);
    return bind(target, binding);
  });

  return function unbindAll() {
    unbinds.forEach((unbind) => unbind());
  };
}
