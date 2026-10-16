import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Durable delivery receipts, bound to one paired link and Codex thread. */
export class UpdateInbox {
  constructor({ path, bridgeId, threadId, send, queue, direct = false }) {
    Object.assign(this, { path, bridgeId, threadId, send, queue, direct }); this.rows = {};
    try { this.rows = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.durable = structuredClone(this.rows);
  }
  save() {
    try {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.rows), { mode: 0o600 }); renameSync(temp, this.path);
    this.durable = structuredClone(this.rows);
    } catch (error) { this.rows = structuredClone(this.durable); throw error; }
  }
  once(id, action) {
    try { writeFileSync(`${this.path}.${id}.${action}`, '', { flag: 'wx', mode: 0o600 }); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  }
  report(row, status, summary, finished = false) {
    row.report = { type: 'update-report', id: row.update.id, sequence: (row.report?.sequence || 0) + 1, status, ...(summary ? { summary } : {}), finished };
    this.save(); this.send(row.report);
  }
  receive(update, chatId) {
    if (!update || !/^[0-9a-f-]{36}$/i.test(update.id || '') || update.bridgeId !== this.bridgeId || update.chatId !== chatId
      || (this.threadId && update.threadId !== this.threadId)
      || typeof update.confirmedAt !== 'string' || typeof update.task !== 'string' || !update.task.trim() || update.task.length > 12000) return;
    let row = this.rows[update.id];
    if (row) { if (row.report) this.send(row.report); return; }
    row = this.rows[update.id] = { update, delivery: 'queueing', claimed: this.direct };
    this.save(); // Written BEFORE invoking the CLI. Ambiguous delivery is never retried automatically.
    if (!this.once(update.id, 'queued')) { this.report(row, 'needs-attention'); return; }
    this.queue(update.id, (success) => {
      row.delivery = success ? 'queued' : 'uncertain'; this.save();
      if (!row.report) this.report(row, success ? 'queued' : 'needs-attention');
    }, update);
  }
  flush() { for (const row of Object.values(this.rows)) {
    if (!row.report && row.delivery === 'queueing') this.report(row, 'needs-attention');
    else if (row.report) this.send(row.report);
  } }
  claim(id) {
    const row = this.rows[id];
    if (!row) throw new Error('No user-confirmed update with that ID exists in this Codex thread.');
    if (row.claimed || row.report?.finished || !this.once(id, 'claimed')) return { claimed: false, status: row.report?.status, message: 'Already claimed. Do not execute this task again.' };
    row.claimed = true; this.report(row, 'working');
    return { claimed: true, request_id: id, task: row.update.task, title: row.update.title, confirmedAt: row.update.confirmedAt };
  }
  status(id, status) {
    const row = this.rows[id];
    if (!row?.claimed || row.report?.finished) throw new Error('This update is not active in this thread.');
    if (status === 'result-withheld') { this.report(row, 'needs-attention', 'Codex did not share the result.', true); return { accepted: true }; }
    if (!['working', 'needs-attention'].includes(status)) throw new Error('Invalid progress status.');
    this.report(row, status); return { accepted: true };
  }
  result(id, status, summary) {
    const row = this.rows[id];
    if (!row?.claimed) throw new Error('Claim this confirmed update first.');
    if (row.report?.finished) return { accepted: true, alreadyReported: true };
    if (!['completed', 'failed', 'needs-attention'].includes(status) || typeof summary !== 'string' || !summary.trim() || summary.length > 16000) throw new Error('Invalid update result.');
    this.report(row, status, summary.trim(), true); return { accepted: true };
  }
}
