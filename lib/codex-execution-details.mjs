// Only whitelisted execution fields enter saved history. Redaction is best-effort:
// arbitrary unlabeled secrets cannot be identified reliably.
export const EXECUTION_TEXT_LIMIT = 32768;
export const EXECUTION_RAW_LIMIT = 65536;
export function redactExecutionText(input, apiKey = '') {
  let text = typeof input === 'string' ? input : '';
  if (apiKey) text = text.split(apiKey).join('[redacted]');
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, '[redacted]')
    // AgentCloud credentials are 32 random bytes encoded as 43 base64url characters.
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, '[redacted]')
    .replace(/(--(?:[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*|credential)(?:[ \t]+|=))(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;}\r\n]+)/gi, '$1[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:["']?)(?:Bearer|Basic)\s+[^\s"'\r\n]+/gi, '$1[redacted]')
    .replace(/(\b(?:[A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*|credential)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;}\r\n]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
}
export function executionDetails(value, previous = {}, apiKey = '') {
  const result = { ...previous, type: value.type, status: typeof value.status === 'string' && ['inProgress','completed','failed','declined'].includes(value.status) ? value.status : previous.status || 'unknown' };
  if (value.truncated === true) result.truncated = true;
  let budget = EXECUTION_TEXT_LIMIT;
  function text(value, limit = EXECUTION_TEXT_LIMIT) {
    const clean = redactExecutionText(value, apiKey);
    const size = Math.min(limit, budget);
    if (clean.length > size) result.truncated = true;
    budget -= Math.min(clean.length, size);
    return clean.slice(0, size);
  }
  if (result.type === 'commandExecution') {
    for (const field of ['command', 'cwd']) {
      const input = typeof value[field] === 'string' ? value[field] : previous[field];
      if (typeof input === 'string') result[field] = text(input, field === 'command' ? 8192 : 2048);
    }
    for (const field of ['exitCode', 'durationMs']) if (value[field] === null || (Number.isSafeInteger(value[field]) && (field === 'exitCode' || value[field] >= 0))) result[field] = value[field];
    const output = typeof value.aggregatedOutput === 'string' ? value.aggregatedOutput : previous.output;
    if (typeof output === 'string') result.output = text(output);
  } else {
    const changes = Array.isArray(value.changes) ? value.changes : previous.changes;
    if (Array.isArray(changes)) {
      if (changes.length > 100) result.truncated = true;
      result.changes = changes.slice(0, 100).filter(change => change && typeof change.path === 'string').map(change => {
        const kind = typeof change.kind === 'object' ? change.kind?.type : change.kind;
        const movePath = change.movePath ?? change.kind?.move_path ?? change.kind?.movePath;
        return { path: text(change.path, 2048), kind: ['add','delete','update'].includes(kind) ? kind : 'unknown',
          ...(typeof movePath === 'string' ? { movePath: text(movePath, 2048) } : {}), diff: text(change.diff) };
      });
    }
    const output = typeof value.aggregatedOutput === 'string' ? value.aggregatedOutput : previous.output;
    if (typeof output === 'string') result.output = text(output);
  }
  return result;
}
