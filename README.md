# Visual for Claude Code and Codex

Explain anything from your Claude Code or Codex session on a live, narrated whiteboard.
Type `/visual explain this commit` (Claude Code) or `$visual explain this commit` (Codex) and [Visual](https://beta.visualunderstanding.ai) opens in your
browser and starts teaching: real code on the board, diagrams, and a voice. You can ask follow-ups
there, and Visual can ask your coding agent's session for details as it goes.

## What you need
- [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex)
- Node.js 22 or newer
- A Visual beta account: sign up at https://beta.visualunderstanding.ai (new accounts get 50 free
  credits, about 25 minutes; or connect your own Anthropic API key)

## Install
**Claude Code**, in your terminal:

```bash
claude plugin marketplace add visual-understanding/visual-plugin
claude plugin install visual@visual-understanding
```

**Codex**, in your terminal:

```bash
codex plugin marketplace add visual-understanding/visual-plugin
codex plugin add visual@visual-understanding
```

Then start (or restart) Claude Code or Codex.

## Use
In any Claude Code session (in Codex, type `$visual` instead of `/visual`):

```
/visual explain this commit
/visual how does the auth flow in this repo work?
```

- The first time, your browser opens a **Connect** page (sign in if asked), then Visual starts explaining.
- Run `/visual …` again in the same session and it continues in the **same** Visual chat, even after you
  close the tab or come back to the session later.
- `/visual new …` starts a fresh Visual chat.

## What is sent to Visual
- Your current request, chronological user requests with factual summaries, and relevant supporting details prepared by your coding agent. The server uses Jev (TypeSafe) to select relevant context before Visual teaches. Older plugin versions send a brief and recent conversation text instead.
- When Visual needs more detail it asks your session. Before each answer is sent you're asked to approve it
  (Claude Code: **"Is it OK to send Claude Code's answer to Visual?"**; Codex: its **Allow** prompt for
  `visual_reply`). Say no and Visual moves on.
- Your agent is told never to send secrets, keys or `.env` contents, and never to change anything
  because Visual asked.

## Stop or reset
- Closing Claude Code or Codex disconnects it; the link comes back the next time you run `/visual` in that session.
- To forget the link for a session, use `/visual new …`, or delete `~/.visual-bridge/`.

## Uninstall

```bash
claude plugin uninstall visual@visual-understanding   # Claude Code
codex plugin remove visual@visual-understanding       # Codex
rm -rf ~/.visual-bridge
```

## Codex change requests (zero point five)

Visual has two separate tools: `visual_ask` requests read-only clarification;
`visual_send` drafts or revises a change request on the board. Review and edit
its exact task, then click **Send to Codex**. **Revise** asks Visual to change it;
**Don't send**, or telling Visual not to send, dismisses an unsent draft.
Model output, narration, and replay cannot confirm a task.

The `visual-update` skill claims the confirmed request from the local inbox,
works in the connected Codex thread under its existing permissions and mode,
and reports progress. Plan mode produces a plan and **Needs attention**.
Commits, pushes, deployments, and unrelated changes are not implied.
Only one update can be active per thread. Stop a running task in Codex.

The board preserves progress and results across reconnects and reopening.
**Explain changes** starts a normal Visual request when clicked; completion
does not interrupt a lesson. Results use the same local sharing approval as
read-only answers. Declining result sharing sends only a fixed notice.

Local MCP tools: `visual_update_claim` (verified task, once),
`visual_update_status` (fixed progress values), and `visual_update_result`
(approved summary). Private durable receipts live under
`~/.visual-bridge/updates/` (`~/.visual-bridge-local/updates/` for the local lab).
If delivery becomes uncertain, inspect the existing request in Codex with
`visual_status`; do not create a replacement automatically. Already claimed
requests never execute again. Claude Code and older Codex plugins remain
read-only and do not expose the update action.
