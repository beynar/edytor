export function getPercentageInRange({
  startOfRange,
  endOfRange,
  value
}) {
  // checking inputs
  const isValid = startOfRange < endOfRange;
  if (!isValid) {
    return 0;
  }
  if (value < startOfRange) {
    return 0;
  }
  if (value > endOfRange) {
    return 1;
  }
  const range = endOfRange - startOfRange;
  return (value - startOfRange) / range;
}