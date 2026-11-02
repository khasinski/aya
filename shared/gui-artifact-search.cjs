exports.artifactSearchText = function artifactSearchText(artifact) {
  const content = artifact.kind === 'html' ? artifact.html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')
    : artifact.kind === 'table' ? artifact.columns.join(' ') + ' ' + artifact.rows.flat().join(' ')
    : artifact.kind === 'metric' ? artifact.value + ' ' + artifact.description : artifact.path;
  return exports.normalizeArtifactSearch(artifact.title + ' ' + content);
};
exports.normalizeArtifactSearch = text => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
