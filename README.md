# Visual for Claude Code and Codex

Explain anything from your Claude Code or Codex session on a live, narrated whiteboard.
Type `/visual explain this commit` (Claude Code) or `$visual explain this commit` (Codex) and [Visual](https://beta.visualunderstanding.ai) opens in your
browser and starts teaching: real code on the board, diagrams, and a voice. You can ask follow-ups
there, and Visual can ask your coding agent's session for details as it goes. Ask Visual to send an update back: review the exact message in chat, approve it, and the same coding session receives it.

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
- Your request, chronological request/summary history and supporting details prepared by your coding assistant. Secrets and raw tool output are excluded.
- When Visual needs more detail it asks your session. Before each answer is sent you're asked to approve it
  (Claude Code: **"Is it OK to send Claude Code's answer to Visual?"**; Codex: its **Allow** prompt for
  `visual_reply`). Say no and Visual moves on.
- Ordinary questions are read-only. Approved messages may request changes within the coding session's existing permissions and mode. Results use the existing local sharing approval. Your agent is told never to send secrets, keys or `.env` contents.

## Approved updates (Claude Code 0.8.0 / Codex 0.5.1)

Ask Visual to send a change, correction, or follow-up to your coding assistant. Visual shows
an exact message preview and asks before sending. Declining or correcting the preview sends
nothing. After approval, chat shows progress and a short result without interrupting playback.
The message is bound to the originating coding session. Reconnects do not repeat execution;
an uncertain delivery asks you to check the coding session before sending again.

Keep the coding session running. Claude Code receives messages through its Visual Monitor;
Codex receives the approved text directly in its thread. Plan mode and normal tool permissions
still apply. Result summaries require the same sharing approval as read-only answers.

To update an existing Claude Code install:

```bash
claude plugin marketplace update visual-understanding
claude plugin update visual@visual-understanding
```

Run `/reload-plugins` (or restart), then invoke `/visual` in the originating session to reconnect.
For Codex, refresh the marketplace with `codex plugin marketplace upgrade visual-understanding`,
then `codex plugin add visual@visual-understanding`. Restart Codex and invoke `$visual` in the
originating thread. Existing chat links are retained.

## Stop or reset
- Closing Claude Code or Codex disconnects it; the link comes back the next time you run `/visual` in that session.
- To forget the link for a session, use `/visual new …`, or delete `~/.visual-bridge/`.

## Uninstall

```bash
claude plugin uninstall visual@visual-understanding   # Claude Code
codex plugin remove visual@visual-understanding       # Codex
rm -rf ~/.visual-bridge
```
