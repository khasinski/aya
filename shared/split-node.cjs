exports.MAX_SPLIT_LEAVES = 25;
exports.MAX_SPLIT_DEPTH = 24;
function isSplitNode(value, depth = 0) {
  if (depth > exports.MAX_SPLIT_DEPTH || !value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) return false;
  if (value.kind === 'leaf') return value.terminalId === null || typeof value.terminalId === 'string';
  return value.kind === 'split' && ['row', 'column'].includes(value.direction) && typeof value.ratio === 'number' && Number.isFinite(value.ratio) && value.ratio > 0 && value.ratio < 1 && isSplitNode(value.first, depth + 1) && isSplitNode(value.second, depth + 1);
}
exports.isSplitNode = isSplitNode;
