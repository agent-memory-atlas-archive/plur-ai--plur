# When a hook times out and no memory is injected

Symptom: the agent starts without memory, or the harness reports a hook timeout.
Reported against Codex; the reasoning applies to every synchronous harness.

## Why these hooks are synchronous, and therefore bounded

An async hook's `additionalContext` is delivered at the harness's "next safe
point", which is **not the turn that triggered it**: a first reply that uses no
tools gets no memory, and a one-shot (`codex exec`, `claude -p`) never does. So
every injection hook is synchronous, and a synchronous hook has a hard budget.
Claude Code's `hook-inject` was async with a 90s timeout until #1313.

| Harness | Hook | Budget |
|---|---|---|
| Codex | `SessionStart`, `UserPromptSubmit` | 25s |
| Antigravity | pre-invocation | 20s |
| Cursor | `sessionStart` | 10s |
| Claude Code | `UserPromptSubmit`, `SessionStart` (matcher `compact`) | 20s; the hook exits itself at 15s (`PLUR_HOOK_CEILING_MS`) |

Codex's own default is 600s. PLUR's are deliberately tight so a wedged hook
cannot hang a turn.

In Claude Code only the first prompt of a session and the rehydrate after
compaction do the full injection. Later prompts check the session marker and
exit: 68 to 101ms on a 10,000-engram store, against 34ms for a bare
`node -e 0`. Re-run `plur init` to move an existing async registration to sync.

## What actually consumes the budget

A synchronous injection runs hybrid search first and falls back to BM25 on a
soft deadline (`injectWithFallback`):

1. **Hybrid deadline** — `PLUR_HOOK_HYBRID_DEADLINE_MS`, default **8s**.
2. **BM25 fallback** — runs *after* the deadline is missed. Sub-second on a few
   thousand engrams; longer on a very large store.
3. **Remote recall** (PLUR Enterprise) — `PLUR_REMOTE_RECALL_TIMEOUT_MS`,
   default **2s**, and it runs *before* the local pipeline, so its real cost is
   `max(0, remote − local)` rather than a straight addition.

The expensive item is not in that list: **loading the BGE embedder takes ~20s
cold** once a store passes a few thousand engrams. The 8s deadline exists to
abandon it — but the wait still happened, so the worst case is
`8s + BM25`, not `8s`.

## Two failures that look identical and want opposite fixes

**A. The deadline was missed, BM25 served the turn.** You will see on stderr:

```
[plur] hybrid injection exceeded 8000ms — falling back to BM25 for this turn.
```

Memory was injected, just keyword-only. If this is routine and you want
embeddings back, **raise** the deadline — and keep it below the harness budget
in the table above, or you convert this case into case B.

**B. The hook was killed at the harness budget, nothing was injected.** The
harness reports a timeout. Here you must **lower** the deadline, not raise it,
so the BM25 fallback starts sooner and the hook finishes inside its budget:

```sh
PLUR_HOOK_HYBRID_DEADLINE_MS=3000
```

If it still times out, the local embedder is the cost. Take it out of the hot
path entirely — recall stays keyword-only and `plur doctor` reports it:

```yaml
# ~/.plur/config.yaml
embeddings:
  enabled: false
```

The stderr message in case A recommends *raising* the deadline. That advice is
correct for A and wrong for B — read which one you have before acting on it.

## A hook that exits on its own must not leave the store lock

Every Codex and Antigravity hook force-exits when it is done, and the Claude
Code hook force-exits past a missed hybrid deadline and on its 15s watchdog.
`process.exit()` does not wait for in-flight work, and the abandoned hybrid
search still records its injection under `engrams.yaml.lock`. Exiting inside
that write leaves the lock behind — often empty, which core cannot attribute,
so every later writer waits out the 60s stale threshold and the next prompts
come back with no memory.

So each of those exits first waits, bounded, while the lock may be its own
(`lib/store-lock-exit.ts`): 5s after a finished run, 3s once the Claude Code
watchdog has fired (15s + 3s stays below the 20s budget). A lock left by a
hook that was *killed* at the harness budget is not covered — that is case B
above. If one is there and no PLUR process is running, it is safe to delete.

## If the store is remote

A slow or unreachable PLUR Enterprise host cannot hang the hook — the dial is
bounded at 2s and fast-fails a host for 60s after a network-level failure. To
rule it out anyway:

```sh
PLUR_REMOTE_RECALL=0        # kill-switch, local only
PLUR_REMOTE_RECALL_TIMEOUT_MS=500
```

## Confirm before and after

```sh
plur doctor                 # embedder state, hook wiring, remote health
time plur inject 'test'     # BM25-only cost for your store
```

A store whose BM25 pass alone approaches the harness budget wants
`plur forget`/decay attention, not a larger timeout.
