# Replay

Replay real prompts against the changed prompt or plugin, then compare the new runs with the originals.

## Steps

1. Export the original prompt: `python3 scripts/session.py SID --prompt` prints it first. Save only the prompt text to a file. For a run where the caller sent several messages, join the user messages of the parent session.
2. Make sure the run loads your working tree. The recall prompt is read from `prompts/recall-agent-prompt.txt` when the plugin starts, and code changes need `pnpm run build` when the OpenCode config loads `dist/`.
3. Run the prompt in a fresh OpenCode process so that the plugin loads again:

   ```sh
   opencode run --standalone --agent recall --title "replay: <label>" "$(cat prompt.txt)"
   ```

   Use the OpenCode binary or wrapper that loads this plugin checkout. `--standalone` starts a private server, so a shared server with an older plugin load does not affect the run.
4. Find the new session with `python3 scripts/sessions.py --grep "<distinctive prompt words>"`, then compare runs with `python3 scripts/session.py ORIGINAL_SID NEW_SID`.

## What to compare

- Steps and wall time.
- First-step width.
- Truncated steps.
- Whether the answer names the same session and quotes the same evidence as the original, or a better one.

Replays that run at the same time share the index lock: one run syncs while the other skips the sync. Run them one after another when tool seconds matter, and in parallel when only the agent behavior matters.
