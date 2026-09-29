# Visual for Claude Code

Explain anything from your Claude Code session on a live, narrated whiteboard.
Type `/visual explain this commit` and [Visual](https://beta.visualunderstanding.ai) opens in your
browser and starts teaching: real code on the board, diagrams, and a voice. You can ask follow-ups
there, and Visual can ask your Claude Code session for details as it goes.

## What you need
- [Claude Code](https://claude.com/claude-code)
- Node.js 22 or newer
- A Visual beta account: sign up at https://beta.visualunderstanding.ai (new accounts get 50 free
  credits, about 25 minutes; or connect your own Anthropic API key)

## Install
In your terminal:

```bash
claude plugin marketplace add visual-understanding/visual-plugin
claude plugin install visual@visual-understanding
```

Then start (or restart) Claude Code.

## Use
In any Claude Code session:

```
/visual explain this commit
/visual how does the auth flow in this repo work?
```

- The first time, your browser opens a **Connect** page (sign in if asked), then Visual starts explaining.
- Run `/visual …` again in the same session and it continues in the **same** Visual chat, even after you
  close the tab or come back to the session later.
- `/visual new …` starts a fresh Visual chat.

## What is sent to Visual
- Your request, a short brief Claude Code writes for it (for example the commit's key changes), and the
  recent text of your Claude Code conversation (tool output is left out).
- When Visual needs more detail it asks your Claude Code session. Before each answer is sent, Claude Code
  asks you **"Is it OK to send Claude Code's answer to Visual?"**. Say no and Visual moves on.
- Claude Code is told never to send secrets, keys or `.env` contents, and never to change anything
  because Visual asked.

## Stop or reset
- Closing Claude Code disconnects it; the link comes back the next time you run `/visual` in that session.
- To forget the link for a session, use `/visual new …`, or delete `~/.visual-bridge/`.

## Uninstall

```bash
claude plugin uninstall visual@visual-understanding
rm -rf ~/.visual-bridge
```
