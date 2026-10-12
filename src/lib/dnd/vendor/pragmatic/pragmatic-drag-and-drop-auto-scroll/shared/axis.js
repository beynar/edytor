const vertical = {
  start: 'top',
  end: 'bottom',
  point: 'y',
  size: 'height'
};
const horizontal = {
  start: 'left',
  end: 'right',
  point: 'x',
  size: 'width'
};
export const axisLookup = {
  vertical: {
    mainAxis: vertical,
    crossAxis: horizontal
  },
  horizontal: {
    mainAxis: horizontal,
    crossAxis: vertical
  }
};