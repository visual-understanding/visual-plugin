#!/usr/bin/env node
// visual-bridge: links a running Claude Code session to a Visual chat. Dependency-free, Node >= 22.
//
//   start --prompt <text> [--brief <file>] [--session <id>] [--cwd <dir>] [--new]   pair, open the browser, leave a daemon running;
//                                  run again in the same session, it continues in that session's Visual chat, even after the
//                                  daemon stopped (the link in ~/.visual-bridge/links/<session>.json); --new forgets it and starts over
//   watch [--id <bridgeId>]        one stdout line per question/event (for the Claude Code Monitor tool)
//   reply <questionId> [--id <bridgeId>] [--file <path> | --text <answer>]   answer a question (stdin otherwise)
//   decline <questionId> [--id <bridgeId>]   tell Visual the answer won't be shared (sends no content)
//   status [--id <bridgeId>]       stop [--id <bridgeId>]   (stop keeps the link; `start --new` starts over)
//   hook                           PreToolUse hook: asks the user before any answer is sent to Visual
//   session-end                    SessionEnd hook: stops the daemon of the Claude Code session named on stdin
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
export const LIMITS = { title: 100, cwd: 500, prompt: 4000, brief: 30000, transcript: 80000, answer: 100000, question: 20000 };
const ENTRY_LIMIT = 8000; // one transcript message, so a single paste can't crowd out the rest
const PAIR_TIMEOUT_MS = 20_000;
const POLL_MS = 25_000;
// The server gives up on an ask after 60 s, or 5 min while the user approves the answer; don't hand out stale ones.
const QUESTION_TTL_MS = 90_000;
const APPROVAL_TTL_MS = 330_000;
const IDLE_MS = 3 * 60 * 60 * 1000;
const RECONNECT_GIVE_UP_MS = 11 * 60 * 1000; // the server keeps a dropped bridge for 10 min
const PARENT_POLL_MS = 5000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DECLINED = 'Claude Code declined to share that (the user did not approve it, or it is not allowed from Visual).';

const stateDir = () => join(homedir(), '.visual-bridge');
// ~/.visual-bridge/config.json: {"apiUrl", "webUrl", "askBeforeSending"}; environment variables win.
export function config() {
  try { const value = JSON.parse(readFileSync(join(stateDir(), 'config.json'), 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
const setting = (env, key, fallback) => String(process.env[env] || (typeof config()[key] === 'string' && config()[key]) || fallback).replace(/\/+$/, '');
const apiUrl = () => setting('VISUAL_API_URL', 'apiUrl', 'https://api-beta.visualunderstanding.ai');
const webUrl = () => setting('VISUAL_WEB_URL', 'webUrl', 'https://beta.visualunderstanding.ai');
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function wsUrl(base = apiUrl()) {
  const url = new URL(`${base}/bridge/connect`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  return url.href;
}

/** Cuts to `max` UTF-16 units without leaving half a surrogate pair. */
export function clip(text, max, marker = '…') {
  text = String(text ?? '');
  if (text.length <= max) return text;
  let cut = max - marker.length;
  if (/[\uD800-\uDBFF]/.test(text[cut - 1] ?? '')) cut -= 1;
  return text.slice(0, cut) + marker;
}

/** Keeps the last `max` units, starting on a line boundary when one is near. */
export function keepTail(text, max, marker = '[… earlier conversation omitted …]\n\n') {
  if (text.length <= max) return text;
  let tail = text.slice(text.length - (max - marker.length));
  const nl = tail.indexOf('\n');
  if (nl >= 0 && nl < 2000) tail = tail.slice(nl + 1);
  else if (/[\uDC00-\uDFFF]/.test(tail[0])) tail = tail.slice(1);
  return marker + tail;
}

// ---------------------------------------------------------------- transcript

/** Claude Code's project directory name for a cwd: every non-alphanumeric character becomes '-'. */
export const projectSlug = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');

const newestJsonl = (dir) => {
  let best = null;
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path ?? null;
};
const safeReaddir = (dir) => { try { return readdirSync(dir); } catch { return []; } };

/** The session transcript: <slug>/<session>.jsonl, any project's <session>.jsonl, else the newest in cwd's (or an ancestor's) project dir. */
export function findTranscript({ cwd, session, root = join(claudeDir(), 'projects') }) {
  const validSession = session && /^[A-Za-z0-9-]{8,}$/.test(session);
  const dirs = [];
  let real = resolve(cwd);
  try { real = realpathSync(cwd); } catch {}
  for (const start of new Set([resolve(cwd), real])) {
    for (let dir = start; ; dir = dirname(dir)) {
      dirs.push(join(root, projectSlug(dir)));
      if (dirname(dir) === dir) break;
    }
  }
  if (validSession) {
    for (const dir of [dirs[0], ...safeReaddir(root).map((d) => join(root, d))]) {
      const path = join(dir, `${session}.jsonl`);
      if (existsSync(path)) return path;
    }
  }
  for (const dir of dirs) {
    const path = newestJsonl(dir);
    if (path) return path;
  }
  return null;
}

const NOISE = /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|task-notification|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g;
const CONTROL = /\u001b\[[0-9;?]*[A-Za-z]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function cleanUserText(text) {
  const command = text.match(/<command-name>\s*\/?([^<]*?)\s*<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return `/${command[1]}${args ? ` ${args}` : ''}`;
  }
  return text.replace(NOISE, '').replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, '! $1').trim();
}

const TOOL_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'path', 'url', 'query', 'skill', 'description', 'prompt'];
export function summarizeToolUse(name, input = {}) {
  const key = TOOL_KEYS.find((k) => typeof input?.[k] === 'string' && input[k].trim());
  const detail = key ? input[key] : JSON.stringify(input ?? {});
  return `[tool ${name}: ${clip(detail.replace(/\s+/g, ' ').trim(), 200)}]`;
}

/** Condenses a Claude Code JSONL transcript to user/assistant text and one-line tool calls, most recent kept. */
export function extractTranscript(jsonl, { max = LIMITS.transcript } = {}) {
  const entries = [];
  const push = (who, text) => {
    text = String(text).replace(CONTROL, '').trim();
    if (text) entries.push(clip(who ? `${who}: ${text}` : text, ENTRY_LIMIT));
  };
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!content || entry.isSidechain) continue;
    if (entry.type === 'user') {
      if (entry.isCompactSummary) { push('Summary of earlier conversation', typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('\n')); continue; }
      if (entry.isMeta) continue;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      for (const block of blocks) {
        if (block.type === 'text') push('User', cleanUserText(block.text ?? ''));
        else if (block.type === 'image') push('User', '[image]');
        else if (block.type === 'document') push('User', '[document]');
      }
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') push('Assistant', block.text ?? '');
        else if (block.type === 'tool_use') push('', summarizeToolUse(block.name, block.input));
      }
    }
  }
  return keepTail(entries.join('\n\n'), max);
}

export function readTranscript({ cwd, session }) {
  const path = findTranscript({ cwd, session });
  if (!path) return '';
  try { return extractTranscript(readFileSync(path, 'utf8')); } catch { return ''; }
}

function repoTitle(cwd) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    if (top) return basename(top);
  } catch {}
  return basename(resolve(cwd)) || 'Claude Code';
}

export function buildHello({ prompt, brief = '', cwd, session }) {
  return {
    type: 'hello',
    version: 1,
    title: clip(repoTitle(cwd), LIMITS.title),
    cwd: clip(cwd, LIMITS.cwd),
    prompt: clip(String(prompt).replace(CONTROL, '').trim(), LIMITS.prompt),
    brief: clip(String(brief).replace(CONTROL, ''), LIMITS.brief, '\n[… brief truncated …]'),
    transcript: readTranscript({ cwd, session }),
  };
}

// ---------------------------------------------------------------- state files

const statePath = (id) => join(stateDir(), `${id}.json`);
function ensureStateDir() {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  chmodSync(stateDir(), 0o700);
}
function writePrivate(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
export function loadState(id) {
  if (!id) {
    try { id = readFileSync(join(stateDir(), 'current'), 'utf8').trim(); } catch { return null; }
  }
  if (!ID_RE.test(id)) return null;
  try { return JSON.parse(readFileSync(statePath(id), 'utf8')); } catch { return null; }
}
function removeState(id) {
  rmSync(statePath(id), { force: true });
  try { if (readFileSync(join(stateDir(), 'current'), 'utf8').trim() === id) rmSync(join(stateDir(), 'current'), { force: true }); } catch {}
}
// The running bridge started from this Claude Code session, if any.
export function sessionBridge(session) {
  let names = [];
  try { names = readdirSync(stateDir()).filter((name) => name.endsWith('.json') && name !== 'config.json'); } catch { return null; }
  const states = names.map((name) => loadState(name.slice(0, -5))).filter((state) => state?.session === session && alive(state.pid));
  return states.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] ?? null;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ---------------------------------------------------------------- links
// One Visual chat per Claude Code session: links/<session>.json holds the id and secret that let a later
// `start` rejoin that chat. The secret goes only to the gateway; it is never logged or printed.

const linksDir = () => join(stateDir(), 'links');
const linkPath = (session) => join(linksDir(), `${session}.json`);
export function loadLink(session) {
  if (!SESSION_RE.test(session ?? '')) return null;
  try {
    const link = JSON.parse(readFileSync(linkPath(session), 'utf8'));
    if (!UUID_RE.test(link.linkId ?? '') || !/^[A-Za-z0-9_-]{32,128}$/.test(link.secret ?? '')) return null;
    return { linkId: link.linkId, secret: link.secret, chatId: UUID_RE.test(link.chatId ?? '') ? link.chatId : null, createdAt: link.createdAt ?? null };
  } catch { return null; }
}
function saveLink(session, link) {
  ensureStateDir();
  mkdirSync(linksDir(), { recursive: true, mode: 0o700 });
  chmodSync(linksDir(), 0o700);
  writePrivate(linkPath(session), JSON.stringify({ linkId: link.linkId, secret: link.secret, chatId: link.chatId ?? null, createdAt: link.createdAt }, null, 2));
}
/** Removes the session's link file, only if it still names `linkId` when one is given. */
function removeLink(session, linkId) {
  if (!SESSION_RE.test(session ?? '')) return;
  if (linkId && loadLink(session)?.linkId !== linkId) return;
  rmSync(linkPath(session), { force: true });
}
const newLink = () => ({ linkId: randomUUID(), secret: randomBytes(32).toString('base64url'), chatId: null, createdAt: new Date().toISOString() });
const rejoinFrame = (link, { title, cwd, prompt = '', brief = '', transcript = '' }) =>
  ({ type: 'rejoin', version: 1, linkId: link.linkId, secret: link.secret, title, cwd, prompt, brief, transcript });

// ---------------------------------------------------------------- Claude Code process

/** True for a command line that runs Claude Code, not a shell that merely sources a file under ~/.claude. */
export function isClaudeCommand(command) {
  const [exe = '', arg = ''] = String(command).trim().split(/\s+/);
  const name = basename(exe).replace(/^-/, '');
  if (/^(ba|z|da|k|c|tc|fi)?sh$|^login$/.test(name)) return false;
  // Scripts under ~/.claude (plugins, hooks) are not Claude Code itself, unless the file is named claude.
  const runsClaude = (path) => /claude/i.test(basename(path)) || /claude/i.test(path.replace(/\/\.claude\//gi, '/'));
  return runsClaude(exe) || (/^(node|bun|deno)$/i.test(name) && runsClaude(arg));
}

/** The nearest ancestor process running Claude Code (walking up from our parent via `ps`), or null. */
function claudeAncestor() {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    let out;
    try { out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
    const match = out.match(/^(\d+)\s+([\s\S]*)$/);
    if (!match) return null;
    if (isClaudeCommand(match[2])) return pid;
    pid = Number(match[1]);
  }
  return null;
}

// ---------------------------------------------------------------- daemon

// mode 'hello' pairs a new bridge (with `link` when there is a session); 'rejoin' reconnects the session's linked chat.
function runDaemon({ hello, session = null, link = null, mode = 'hello', parentPid = null }) {
  const token = randomBytes(24).toString('base64url');
  const s = { bridgeId: null, secret: null, link, claimUrl: null, claimed: false, chatId: null, conn: 'connecting', ended: false, fatal: null, startedAt: new Date().toISOString() };
  const requests = new Map(); // request id -> resolve(ack)
  const questions = new Map(); // id -> { id, question, at, answered }
  const outbox = []; // answers written while the socket was down
  const events = []; // { seq, event }
  const watchers = new Map(); // watcher id -> { delivered: Set, seen: seq, at }
  const waiters = new Set();
  let seq = 0, handedOut = 0, ws = null, attempt = 0, downSince = null, lastActivity = Date.now(), pending = [];

  const log = (...parts) => {
    const line = `${new Date().toISOString()} ${parts.join(' ')}\n`;
    if (!s.bridgeId) { pending.push(line); return; }
    try { appendFileSync(join(stateDir(), `${s.bridgeId}.log`), pending.join('') + line, { mode: 0o600 }); pending = []; } catch {}
  };
  const notify = () => { for (const waiter of [...waiters]) waiter(); };
  const emit = (event) => { events.push({ seq: ++seq, event }); log('event', event); notify(); };
  const send = (frame) => { if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(frame)); return true; } return false; };
  const report = (message) => { try { process.send?.(message); } catch {} };

  function writeState() {
    writePrivate(statePath(s.bridgeId), JSON.stringify({ bridgeId: s.bridgeId, pid: process.pid, port: server.address().port, token, title: hello.title,
      claimUrl: s.claimUrl, session, cwd: hello.cwd, chatId: s.chatId, startedAt: s.startedAt }, null, 2));
    writePrivate(join(stateDir(), 'current'), s.bridgeId);
  }

  // The chat this bridge feeds; remembered in the link file so a later `start` rejoins it.
  function setChat(chatId) {
    if (typeof chatId !== 'string' || !UUID_RE.test(chatId) || chatId === s.chatId) return;
    s.chatId = chatId;
    if (s.bridgeId) writeState();
    log('chat', chatId);
    if (s.link && !s.ended) {
      s.link.chatId = chatId;
      const onFile = loadLink(session);
      if (!onFile || onFile.linkId === s.link.linkId) try { saveLink(session, s.link); } catch (error) { log('cannot save link:', error.message); }
    }
  }

  function end(reason, failure = { type: 'error', message: reason }) {
    if (s.ended) return;
    s.ended = true;
    s.conn = 'ended';
    log('ending:', reason);
    emit('ended');
    try { ws?.close(1000, 'bye'); } catch {}
    if (!s.bridgeId) { report(failure); setTimeout(() => process.exit(1), 100); return; }
    removeState(s.bridgeId);
    // Stay reachable briefly so a watcher between polls still hears "ended".
    setTimeout(() => { server.close(); process.exit(0); }, 3000);
  }

  // A linked bridge `leave`s (Visual keeps the chat for a later `start`); `forget` or an unlinked bridge says `bye`.
  function stop(reason, { forget = false } = {}) {
    const type = s.link && !forget ? 'leave' : 'bye';
    const sent = !s.ended && send({ type });
    if (sent) log('sent', type);
    end(reason);
    return sent;
  }

  function onFrame(sock, data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return log('bad frame'); }
    if (sock !== ws || s.ended) return;
    switch (msg.type) {
      case 'paired': {
        if (!ID_RE.test(msg.bridgeId ?? '') || typeof msg.code !== 'string' || typeof msg.secret !== 'string') return log('bad paired frame');
        Object.assign(s, { bridgeId: msg.bridgeId, secret: msg.secret, conn: 'connected' });
        s.claimUrl = `${webUrl()}/connect?code=${encodeURIComponent(msg.code)}`;
        attempt = 0;
        writeState();
        log('paired', s.bridgeId, 'expires', msg.expiresAt ?? '?');
        if (s.link && msg.bridgeId !== s.link.linkId) { log('Visual did not take the link; this chat is not linked'); s.link = null; }
        if (s.link) try { saveLink(session, s.link); } catch (error) { log('cannot save link:', error.message); s.link = null; }
        report({ type: 'paired', bridgeId: s.bridgeId, claimUrl: s.claimUrl, statePath: statePath(s.bridgeId) });
        return;
      }
      case 'rejoined': {
        if (!s.link || msg.bridgeId !== s.link.linkId) return log('bad rejoined frame');
        const first = !s.bridgeId;
        Object.assign(s, { bridgeId: s.link.linkId, conn: 'connected', claimed: true });
        attempt = 0;
        downSince = null;
        if (first) writeState();
        setChat(msg.chatId);
        if (first) {
          log('rejoined', s.bridgeId, msg.requestId ? `request ${msg.requestId}` : '');
          report({ type: 'rejoined', bridgeId: s.bridgeId, chatId: s.chatId, open: !!msg.open });
        } else emit('reconnected');
        while (outbox.length && send(outbox[0])) outbox.shift();
        return;
      }
      case 'resumed':
        s.conn = 'connected';
        attempt = 0;
        downSince = null;
        emit('reconnected');
        if (msg.claimed && !s.claimed) { s.claimed = true; emit('claimed'); }
        setChat(msg.chatId);
        while (outbox.length && send(outbox[0])) outbox.shift();
        return;
      case 'claimed':
        lastActivity = Date.now();
        if (!s.claimed) { s.claimed = true; emit('claimed'); }
        return;
      case 'ask': {
        if (!ID_RE.test(msg.id ?? '') || typeof msg.question !== 'string') return log('bad ask frame');
        lastActivity = Date.now();
        if (!questions.has(msg.id)) questions.set(msg.id, { id: msg.id, question: clip(msg.question, LIMITS.question), at: Date.now(), answered: false });
        log('ask', msg.id);
        notify();
        return;
      }
      case 'chat':
        setChat(msg.chatId);
        return;
      case 'request-ack': {
        const done = requests.get(msg.id);
        if (done) { requests.delete(msg.id); done(msg); }
        setChat(msg.chatId);
        return;
      }
      case 'error':
        s.fatal = clip(String(msg.message ?? 'error'), 300);
        log('server error:', s.fatal);
        return;
      default:
        log('ignored frame', clip(String(msg.type), 40));
    }
  }

  function onClose(sock, code, reason) {
    if (sock !== ws || s.ended) return;
    log('socket closed', code, reason || '');
    // 4001: Visual no longer knows this link. A first rejoin lets `start` pair afresh; later, the link is dead.
    if (code === 4001 && !s.bridgeId) return end('unknown link', { type: 'unknown-link' });
    if (code === 4001 && s.link) removeLink(session, s.link.linkId);
    if (!s.bridgeId) return end(s.fatal || `Could not reach Visual at ${wsUrl()} (${code}${reason ? ` ${reason}` : ''}).`);
    if (code === 4000 || reason === 'ended' || s.fatal) return end(s.fatal || 'ended by Visual');
    if (s.conn !== 'disconnected') { s.conn = 'disconnected'; downSince = Date.now(); emit('disconnected'); }
    if (Date.now() - downSince > RECONNECT_GIVE_UP_MS) return end('could not reconnect');
    const delay = Math.min(30_000, 1000 * 2 ** attempt++);
    setTimeout(connect, delay);
  }

  // A linked bridge rejoins (with an empty prompt when reconnecting) once Visual has bound it to a chat, which is
  // when the gateway stores the link; before that, and for unlinked bridges, a reconnect resumes with the pairing secret.
  function firstFrame() {
    if (!s.bridgeId) {
      if (s.link && mode === 'rejoin') return rejoinFrame(s.link, hello);
      return s.link ? { ...hello, link: { id: s.link.linkId, secret: s.link.secret } } : hello;
    }
    if (s.link && (s.chatId || !s.secret)) return rejoinFrame(s.link, { title: hello.title, cwd: hello.cwd });
    return { type: 'resume', bridgeId: s.bridgeId, secret: s.secret };
  }

  function connect() {
    if (s.ended) return;
    let sock;
    try { sock = new WebSocket(wsUrl()); } catch (error) { return onClose(ws, 1006, error.message); }
    ws = sock;
    sock.onopen = () => sock.send(JSON.stringify(firstFrame()));
    sock.onmessage = (event) => onFrame(sock, event.data);
    sock.onerror = () => {};
    sock.onclose = (event) => onClose(sock, event.code, event.reason);
  }

  // Local API: 127.0.0.1 only, bearer token from the 0600 state file.
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (req) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolveBody, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size > 1_000_000) { reject(new Error('too large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
  const status = () => ({
    bridgeId: s.bridgeId, title: hello.title, connection: s.conn, claimed: s.claimed, claimUrl: s.claimUrl, chatId: s.chatId, linked: !!s.link,
    unanswered: [...questions.values()].filter((q) => !q.answered).map((q) => q.id), startedAt: s.startedAt,
  });

  function poll(req, res, url) {
    const wid = url.searchParams.get('watcher') ?? '';
    if (!ID_RE.test(wid)) return reply(res, 400, { error: 'watcher id required' });
    let w = watchers.get(wid);
    // A new watcher (e.g. a re-armed monitor) gets every unanswered question and the events nobody has seen yet.
    if (!w) watchers.set(wid, w = { delivered: new Set(), seen: handedOut });
    w.at = Date.now();
    const deliver = () => {
      const now = Date.now();
      const qs = [...questions.values()].filter((q) => !q.answered && !w.delivered.has(q.id) && now - q.at < (q.approving ? APPROVAL_TTL_MS : QUESTION_TTL_MS));
      const evs = events.filter((e) => e.seq > w.seen).map((e) => e.event);
      if (!qs.length && !evs.length && !s.ended) return false;
      for (const q of qs) w.delivered.add(q.id);
      w.seen = seq;
      handedOut = Math.max(handedOut, seq);
      reply(res, 200, { questions: qs.map(({ id, question }) => ({ id, question })), events: evs, ended: s.ended });
      return true;
    };
    if (deliver()) return;
    const waitMs = Math.min(Number(url.searchParams.get('timeout')) || POLL_MS, 60_000);
    const done = () => { waiters.delete(waiter); clearTimeout(timer); };
    const waiter = () => { if (deliver()) done(); };
    const timer = setTimeout(() => { done(); reply(res, 200, { questions: [], events: [], ended: false }); }, waitMs);
    waiters.add(waiter);
    res.on('close', done);
  }

  const server = createServer(async (req, res) => {
    if (!authorized(req)) return reply(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/status') return reply(res, 200, status());
      if (req.method === 'GET' && url.pathname === '/poll') return poll(req, res, url);
      if (req.method === 'POST' && url.pathname === '/reply') {
        const { id, text } = await readBody(req);
        const q = questions.get(id);
        if (!q) return reply(res, 404, { error: `No question ${id}.` });
        if (q.answered) return reply(res, 409, { error: `Question ${id} was already answered.` });
        if (typeof text !== 'string' || !text.trim()) return reply(res, 400, { error: 'Empty answer.' });
        q.answered = true;
        lastActivity = Date.now();
        const frame = { type: 'answer', id, text: clip(text, LIMITS.answer, '\n[… answer truncated …]') };
        const delivered = send(frame);
        if (!delivered) outbox.push(frame);
        log('answer', id, delivered ? 'sent' : 'queued');
        return reply(res, 200, { ok: true, delivered, late: Date.now() - q.at > (q.approving ? 300_000 : 60_000) });
      }
      // A repeated `/visual`: the new request goes to the Visual chat this bridge already opened.
      if (req.method === 'POST' && url.pathname === '/request') {
        const { prompt, brief = '' } = await readBody(req);
        if (typeof prompt !== 'string' || !prompt.trim()) return reply(res, 400, { error: 'Empty request.' });
        if (!s.claimed) return reply(res, 409, { error: 'Visual has not connected yet.' });
        const id = randomBytes(12).toString('base64url');
        const ack = new Promise((done) => { requests.set(id, done); setTimeout(() => { requests.delete(id); done(null); }, 5000); });
        if (!send({ type: 'request', id, prompt: clip(prompt.replace(CONTROL, '').trim(), LIMITS.prompt), brief: clip(String(brief).replace(CONTROL, ''), LIMITS.brief, '\n[… brief truncated …]') }))
          return reply(res, 503, { error: 'Visual is not connected right now.' });
        lastActivity = Date.now();
        const result = await ack;
        log('request', id, result ? (result.open ? 'delivered' : 'queued') : 'no ack');
        if (!result?.accepted) return reply(res, 502, { error: 'Visual did not accept the request.' });
        return reply(res, 200, { ok: true, open: !!result.open, chatUrl: s.chatId ? `${webUrl()}/chat/${s.chatId}` : null });
      }
      // The user is being asked to approve an answer: Visual waits longer and tells the learner.
      if (req.method === 'POST' && url.pathname === '/approving') {
        const { id } = await readBody(req);
        const q = questions.get(id);
        if (!q || q.answered) return reply(res, 404, { error: `No open question ${id}.` });
        if (!q.approving) { q.approving = true; if (send({ type: 'status', id, state: 'awaiting-approval' })) log('approving', id); }
        return reply(res, 200, { ok: true });
      }
      // `forget` (start --new) says bye so Visual drops the link; otherwise a linked bridge leaves and keeps it.
      if (req.method === 'POST' && url.pathname === '/stop') {
        const { forget = false, reason = 'stopped by user' } = await readBody(req);
        const sent = stop(clip(String(reason), 100), { forget: forget === true });
        return reply(res, 200, { ok: true, sent });
      }
      reply(res, 404, { error: 'not found' });
    } catch (error) {
      reply(res, 400, { error: error.message });
    }
  });

  setInterval(() => {
    if (Date.now() - lastActivity > IDLE_MS) stop('idle for 3 hours');
    for (const [wid, w] of watchers) if (Date.now() - w.at > 10 * 60_000) watchers.delete(wid);
    for (const [id, q] of questions) if (Date.now() - q.at > 60 * 60_000) questions.delete(id);
  }, 60_000).unref();
  // The Claude Code process this session runs in; when it is gone, so is the session.
  if (Number.isInteger(parentPid) && parentPid > 1) {
    setInterval(() => { if (!alive(parentPid)) stop('Claude Code exited'); }, PARENT_POLL_MS).unref();
  }
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('uncaughtException', (error) => { log('crash', error.stack ?? error.message); stop('crashed'); });

  ensureStateDir();
  server.listen(0, '127.0.0.1', connect);
}

// ---------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) args[arg.slice(2, eq)] = arg.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[arg.slice(2)] = argv[++i];
      else args[arg.slice(2)] = true;
    } else args._.push(arg);
  }
  return args;
}

const fail = (message) => { process.stderr.write(`visual-bridge: ${message}\n`); process.exitCode = 1; };
const printLine = (line) => new Promise((r) => process.stdout.write(`${line}\n`, r));

async function api(state, path, { method = 'GET', body, timeoutMs = 10_000 } = {}) {
  const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${state.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status });
  return json;
}

/** $PWD when it names the current directory (keeps symlinked paths as the user sees them), else process.cwd(). */
function logicalCwd() {
  const pwd = process.env.PWD;
  try { if (pwd && realpathSync(pwd) === realpathSync(process.cwd())) return pwd; } catch {}
  return process.cwd();
}

function openBrowser(url) {
  if (process.env.VISUAL_BRIDGE_NO_OPEN) return false;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

function spawnDaemon(options) {
  ensureStateDir();
  const child = spawn(process.execPath, [SCRIPT, 'daemon'], { detached: true, cwd: stateDir(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env });
  return new Promise((done) => {
    const timer = setTimeout(() => done({ type: 'error', message: `Visual did not answer within ${PAIR_TIMEOUT_MS / 1000} s (${wsUrl()}).` }), PAIR_TIMEOUT_MS);
    child.on('message', (message) => { clearTimeout(timer); done(message); });
    child.on('exit', (code) => { clearTimeout(timer); done({ type: 'error', message: `bridge exited early (${code}).` }); });
    child.send(options);
  }).then((result) => {
    if (result.type === 'paired' || result.type === 'rejoined') { child.disconnect(); child.unref(); }
    else try { child.kill('SIGKILL'); } catch {}
    return result;
  });
}

function printReused(bridgeId, chatUrl, open) {
  const opened = open ? false : chatUrl ? openBrowser(chatUrl) : false;
  return printLine(`VISUAL_BRIDGE reused id=${bridgeId}${chatUrl ? ` url=${chatUrl}` : ''}${open ? ' (sent to your open Visual chat)' : opened ? '' : ' (open this URL in your browser)'}`);
}

/** Best effort: rejoins an old link just to say `bye`, so Visual forgets it. */
function forgetLink(link, { title, cwd }) {
  return new Promise((done) => {
    let sock;
    const finish = () => { clearTimeout(timer); try { sock?.close(); } catch {} done(); };
    const timer = setTimeout(finish, 5000);
    try { sock = new WebSocket(wsUrl()); } catch { return finish(); }
    sock.onopen = () => sock.send(JSON.stringify(rejoinFrame(link, { title, cwd })));
    sock.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.type === 'rejoined') sock.send(JSON.stringify({ type: 'bye' }));
      else if (msg.type === 'error') finish();
    };
    sock.onerror = () => {};
    sock.onclose = finish;
  });
}

async function stopDaemon(state, body) {
  try { return await api(state, '/stop', { method: 'POST', body, timeoutMs: 3000 }); } catch {
    if (alive(state.pid)) try { process.kill(state.pid, 'SIGTERM'); } catch {}
    removeState(state.bridgeId);
    return { sent: false };
  }
}

async function start(args) {
  if (typeof WebSocket !== 'function') return fail(`needs Node.js 22 or newer (running ${process.version}).`);
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) return fail('start needs --prompt "<request>".');
  const cwd = typeof args.cwd === 'string' ? resolve(args.cwd) : logicalCwd();
  let brief = '';
  if (typeof args.brief === 'string') {
    try { brief = readFileSync(args.brief, 'utf8'); } catch (error) { return fail(`cannot read brief: ${error.message}`); }
  }
  const session = typeof args.session === 'string' && ID_RE.test(args.session) && !args.session.includes('$') ? args.session
    : (process.env.CLAUDE_SESSION_ID && ID_RE.test(process.env.CLAUDE_SESSION_ID) ? process.env.CLAUDE_SESSION_ID : null);
  const previous = session ? sessionBridge(session) : null;
  let link = session ? loadLink(session) : null;

  if (args.new) {
    // Start over: the old chat's link is said goodbye to (by its daemon, else by a one-shot rejoin) and deleted.
    const stopped = previous ? await stopDaemon(previous, { forget: true, reason: 'replaced by a new chat' }) : { sent: false };
    if (link && !(stopped.sent && previous.bridgeId === link.linkId)) await forgetLink(link, { title: clip(repoTitle(cwd), LIMITS.title), cwd: clip(cwd, LIMITS.cwd) });
    if (link) removeLink(session, link.linkId);
    link = null;
  } else if (previous) {
    // (1) Same Claude Code session, daemon running: ask in the Visual chat it already has.
    try {
      const r = await api(previous, '/request', { method: 'POST', body: { prompt: args.prompt, brief } });
      return printReused(previous.bridgeId, r.chatUrl, r.open);
    } catch (error) {
      // Never claimed: nothing to come back to, so start afresh. Otherwise (not connected now) rejoin below.
      const forget = error.status === 409;
      await stopDaemon(previous, { forget, reason: 'replaced by a new bridge' });
      if (forget && link?.linkId === previous.bridgeId) { removeLink(session, link.linkId); link = null; }
    }
  }

  const hello = buildHello({ prompt: args.prompt, brief, cwd, session });
  const parentPid = process.env.VISUAL_BRIDGE_PARENT_PID ? Number(process.env.VISUAL_BRIDGE_PARENT_PID) : claudeAncestor();
  if (link) {
    // (2) This session had a Visual chat: rejoin it with the new request, no connect page.
    const result = await spawnDaemon({ hello, session, link, mode: 'rejoin', parentPid });
    if (result.type === 'rejoined') return printReused(result.bridgeId, result.chatId ? `${webUrl()}/chat/${result.chatId}` : null, result.open);
    if (result.type !== 'unknown-link') return fail(result.message || 'could not reach Visual.');
    removeLink(session, link.linkId); // Visual forgot it: pair a new chat
  }
  // (3) A new Visual chat, linked to this session when there is one.
  const result = await spawnDaemon({ hello, session, link: session && SESSION_RE.test(session) ? newLink() : null, mode: 'hello', parentPid });
  if (result.type !== 'paired') return fail(result.message || 'pairing failed.');
  const opened = openBrowser(result.claimUrl);
  await printLine(`VISUAL_BRIDGE started id=${result.bridgeId} url=${result.claimUrl}${opened ? '' : ' (open this URL in your browser)'}`);
}

async function watch(args) {
  const state = loadState(args.id);
  if (!state) { process.stderr.write('visual-bridge: no running bridge.\n'); return printLine('VISUAL_BRIDGE ended'); }
  const watcher = randomBytes(8).toString('hex');
  for (let failures = 0; ;) {
    let r;
    try {
      r = await api(state, `/poll?watcher=${watcher}&timeout=${POLL_MS}`, { timeoutMs: POLL_MS + 15_000 });
      failures = 0;
    } catch (error) {
      failures += 1;
      if ((error.status === 401) || !alive(state.pid) || failures >= 10) {
        process.stderr.write(`visual-bridge: bridge unreachable (${error.message}).\n`);
        return printLine('VISUAL_BRIDGE ended');
      }
      await sleep(1000);
      continue;
    }
    for (const event of r.events ?? []) if (event !== 'ended') await printLine(`VISUAL_BRIDGE ${event}`);
    for (const q of r.questions ?? []) {
      const question = JSON.stringify(q.question).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      await printLine(`VISUAL_QUESTION id=${q.id} ${question}`);
    }
    if (r.ended) return printLine('VISUAL_BRIDGE ended');
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function replyCommand(args) {
  const id = args._[1];
  if (!id) return fail('usage: reply <questionId> [--id <bridgeId>] [--text <answer>] (answer on stdin otherwise)');
  const state = loadState(args.id);
  if (!state) return fail('no running bridge.');
  let text;
  if (typeof args.file === 'string') {
    try { text = readFileSync(args.file, 'utf8'); } catch (error) { return fail(`cannot read answer file: ${error.message}`); }
  } else text = typeof args.text === 'string' ? args.text : await readStdin();
  if (!text.trim()) return fail('empty answer.');
  try {
    const r = await api(state, '/reply', { method: 'POST', body: { id, text } });
    await printLine(r.delivered ? `answered ${id}` : `answered ${id} (queued until Visual reconnects)`);
  } catch (error) { fail(error.message); }
}

async function declineCommand(args) {
  const id = args._[1];
  if (!id) return fail('usage: decline <questionId> [--id <bridgeId>]');
  const state = loadState(args.id);
  if (!state) return fail('no running bridge.');
  try {
    await api(state, '/reply', { method: 'POST', body: { id, text: DECLINED } });
    await printLine(`declined ${id}`);
  } catch (error) { fail(error.message); }
}

// Matches this script's `reply` subcommand in a Bash command, returning the question and bridge ids.
export function replyInCommand(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(/visual-bridge\.mjs["']?\s+reply\s+["']?([A-Za-z0-9_.:-]{1,128})/);
  if (!match) return null;
  const bridge = command.match(/--id[= ]["']?([A-Za-z0-9_.:-]{1,128})/);
  return { questionId: match[1], bridgeId: bridge?.[1] ?? null };
}

// PreToolUse hook (hooks/hooks.json). An answer leaves the user's machine, so the user approves it:
// this escalates `reply` to a permission prompt (even in auto mode) and tells Visual it is waiting.
// Every other tool call passes through untouched. The user can turn the prompt off themselves with
// VISUAL_BRIDGE_ASK=0 or {"askBeforeSending": false} in ~/.visual-bridge/config.json (plus their own allow rule).
export function askBeforeSending() {
  if (process.env.VISUAL_BRIDGE_ASK === '0') return false;
  return config().askBeforeSending !== false;
}

async function hookCommand() {
  let input = null;
  try { input = JSON.parse(await readStdin()); } catch { return; }
  const target = input?.tool_name === 'Bash' ? replyInCommand(input.tool_input?.command) : null;
  if (!target || !askBeforeSending()) return;
  const state = loadState(target.bridgeId ?? undefined);
  if (state) await api(state, '/approving', { method: 'POST', body: { id: target.questionId }, timeoutMs: 2000 }).catch(() => {});
  await printLine(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: "Is it OK to send Claude Code's answer to Visual?" } }));
}

async function statusCommand(args) {
  const state = loadState(args.id);
  if (!state) return printLine('no running bridge');
  try { await printLine(JSON.stringify(await api(state, '/status'))); } catch (error) {
    if (!alive(state.pid)) { removeState(state.bridgeId); return printLine('no running bridge'); }
    fail(error.message);
  }
}

// Keeps the session's link: a later `start` continues in the same Visual chat (`start --new` starts over).
async function stopCommand(args) {
  const state = loadState(args.id);
  if (!state) return printLine('no running bridge');
  await stopDaemon(state);
  await printLine(`VISUAL_BRIDGE stopped id=${state.bridgeId}`);
}

// SessionEnd hook (hooks/hooks.json): the Claude Code session named on stdin is over, so its daemon leaves Visual.
async function sessionEndCommand() {
  let input = null;
  try { input = JSON.parse(await readStdin()); } catch { return; }
  const session = input?.session_id;
  if (typeof session !== 'string' || !ID_RE.test(session)) return;
  for (let i = 0, state; i < 5 && (state = sessionBridge(session)); i++) await stopDaemon(state, { reason: 'Claude Code session ended' });
}

async function main(argv) {
  const args = parseArgs(argv);
  const commands = { start, watch, reply: replyCommand, decline: declineCommand, status: statusCommand, stop: stopCommand, hook: hookCommand, 'session-end': sessionEndCommand };
  const command = args._[0];
  if (command === 'daemon') {
    if (!process.send) return fail('daemon is started by `start`.');
    process.once('message', (options) => runDaemon(options));
    return;
  }
  if (!commands[command]) return fail('usage: visual-bridge start|watch|reply|decline|status|stop|session-end (see header of this file)');
  await commands[command](args);
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1]) === realpathSync(SCRIPT); } catch { return false; } })();
if (invokedDirectly) await main(process.argv.slice(2));
