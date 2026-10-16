// Portable handoff contract. Copies in the plugin bin directories are checked in tests.
export const CONTEXT_LIMITS = { history: 80_000, details: 30_000, entries: 200 };
const ID = /^[A-Za-z0-9:_-]{1,100}$/;

/** Undefined is the legacy handoff. Invalid structured input is rejected, never silently ignored. */
export function readContext(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.history) || typeof value.details !== 'string'
    || value.details.length > CONTEXT_LIMITS.details
    || (value.omitted !== undefined && typeof value.omitted !== 'boolean')) throw new Error('Invalid Visual context. Expected history and details (at most 30000 characters).');
  const ids = new Set();
  const history = value.history.map(entry => {
    if (!entry || typeof entry.id !== 'string' || !ID.test(entry.id) || ids.has(entry.id)
      || typeof entry.request !== 'string' || !entry.request.trim() || entry.request.length > 8000
      || typeof entry.summary !== 'string' || !entry.summary.trim() || entry.summary.length > 8000
      || (entry.relatedTo !== undefined && (!Array.isArray(entry.relatedTo) || entry.relatedTo.some(id => typeof id !== 'string' || !ID.test(id))))) {
      throw new Error('Invalid Visual history entry. Use unique ids, request/summary text (at most 8000 characters each), and optional relatedTo ids.');
    }
    ids.add(entry.id);
    return { id: entry.id, request: entry.request, summary: entry.summary, ...(entry.relatedTo?.length ? { relatedTo: [...new Set(entry.relatedTo)] } : {}) };
  });
  // Missing links are allowed only when the sender explicitly marked earlier context omitted.
  if (!value.omitted && history.some(entry => entry.relatedTo?.some(id => !ids.has(id)))) throw new Error('Visual history references an unknown relatedTo id.');
  let omitted = value.omitted === true;
  const sizes = history.map(entry => JSON.stringify(entry).length);
  let start = 0;
  let size = 2 + sizes.reduce((sum, length) => sum + length, 0) + Math.max(0, history.length - 1);
  while (start < history.length && (history.length - start > CONTEXT_LIMITS.entries || size > CONTEXT_LIMITS.history)) {
    size -= sizes[start] + (history.length - start > 1 ? 1 : 0);
    start++;
    omitted = true;
  }
  return { history: history.slice(start), details: value.details, omitted };
}

export function historyText(context) {
  return (context.omitted ? '[Earlier history omitted to fit the context budget.]\n' : '')
    + context.history.map(entry => `Request [${entry.id}]: ${entry.request}\nSummary: ${entry.summary}`).join('\n\n');
}

export const CONTEXT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    history: { type: 'array', description: 'Chronological user requests and factual outcomes. relatedTo links corrections or constraints to affected requests.', items: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, request: { type: 'string' }, summary: { type: 'string' }, relatedTo: { type: 'array', items: { type: 'string' } } },
      required: ['id', 'request', 'summary'],
    } },
    details: { type: 'string', description: 'Verified supporting facts, useful excerpts, and uncertainties for the current Visual request; at most 30000 characters.' },
    omitted: { type: 'boolean', description: 'True when some earlier session history is unavailable or omitted.' },
  },
  required: ['history', 'details'],
};
