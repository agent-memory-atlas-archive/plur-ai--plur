/**
 * The hook matcher `plur-mcp init` uses to see whether PLUR's Claude Code
 * hooks are already installed, so it never adds a second set next to the
 * ones `plur init` wrote. A copy of @plur-ai/cli's matcher: this package
 * cannot import the CLI.
 */
import { homedir } from 'os'

// BEGIN shared hook matcher — packages/mcp/src/hook-command.ts keeps a
// byte-identical copy of this region (the mcp package cannot import the
// CLI); test/hook-decisions-h2-h3.test.ts fails when they drift.

/**
 * The matcher is anchored (decision F4): the WHOLE command must be PLUR's
 * launcher, then a `hook-*` subcommand, then nothing but plain arguments.
 * A chained, piped, redirected or wrapped command (`&&`, `;`, `|`, `>`,
 * backticks, `$(`, a leading `echo`/`nice`/`env`) is the user's, even when
 * it mentions the shim. The one prefix allowed is PowerShell's `& `, which
 * init itself writes (decision H3's no-short-name fallback).
 */

/** A path or argument character: no whitespace, quote or shell metacharacter. */
const PLAIN = '[^\\s"\'`$&;|<>()]'

/**
 * A PLUR hook subcommand — any `hook-*` (decision H2 "prefix"), so a new hook
 * needs no list update — then only plain arguments to the end. Arguments are
 * separated by spaces or tabs only: a newline or CR ends a shell command, so
 * a hook chained on the next line is the user's.
 */
const HOOK_TAIL = `[ \\t]+hook-[a-z0-9][a-z0-9-]*(?:[ \\t]+${PLAIN}+)*[ \\t]*$`

/**
 * The shim's file name: `plur-hook` or `plur-hook.cmd`, or its Windows 8.3
 * alias. On a spaced home with short names (the default on C:), decision H3
 * writes the short path and the file name is shortened too:
 * `C:/Users/RUNNER~1/.../PLUR~1/bin/PLUR-H~1.CMD`. The alias (`plur-h~<n>.cmd`)
 * is claimed only inside PLUR's own bin directory (`.plur/bin/` or its alias
 * `plur~<n>/bin/`), so another file that shortens to the same name elsewhere
 * stays the user's.
 */
const SHIM_FILE = '(?:plur-hook(?:\\.cmd)?|(?<=/(?:\\.plur|plur~\\d+)/bin/)plur-h~\\d+\\.cmd)'

/**
 * The shim path in the forms any command may use, whoever's machine wrote it:
 *  - unquoted, no whitespace (darwin/linux, and Windows short or space-free paths);
 *  - quoted, any characters but a quote (a path with whitespace).
 * The third form, an unquoted path WITH spaces, is not in this pattern: it
 * is claimed only when it is this machine's own shim (see `spacedShimPaths`).
 */
const SHIM_PATH = [
  `(?:${PLAIN}*/)?${SHIM_FILE}`,
  `"(?:[^"]*/)?${SHIM_FILE}"`,
].join('|')

const SHIM_FORM = new RegExp(`^(?:&[ \\t]+)?(?:${SHIM_PATH})${HOOK_TAIL}`)

/** The `npx [-y] @plur-ai/cli[@version] hook-*` fallback, in every form init wrote. */
const NPX_FORM = new RegExp(`^npx(?:[ \\t]+-y)?[ \\t]+@plur-ai/cli(?:@${PLAIN}+)?${HOOK_TAIL}`)

/** The subcommand and arguments after a spaced shim path. */
const SPACED_TAIL = new RegExp(`^${HOOK_TAIL}`)

/**
 * The unquoted shim path with spaces — what versions before #1267 wrote on
 * Windows (`C:\Users\John Smith\.plur\bin\plur-hook.cmd hook-inject`),
 * and the Antigravity fallback of decision H3. Unquoted, a space cannot tell
 * the path from an argument: `/usr/bin/time ~/.plur/bin/plur-hook hook-x`
 * and `C:/Tools/log.exe %USERPROFILE%/.plur/bin/plur-hook.cmd hook-x` are
 * another binary running the shim. So this form is claimed only when the
 * path is exactly the shim init installs, `<homedir>/.plur/bin/plur-hook`
 * (`.cmd` on Windows), compared without regard to slash style or case (like
 * the recorded-entry check of decision F4). When in doubt the command is the
 * user's: a PLUR hook left unclaimed costs at worst a duplicate entry, a
 * user's hook wrongly claimed is deleted by init. A home directory holding a
 * quote or shell metacharacter never takes this form.
 */
function spacedShimPaths(): string[] {
  const bin = `${homedir().replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')}/.plur/bin/`
  if (/["'`$&;|<>()\r\n]/.test(bin)) return []
  return [`${bin}plur-hook.cmd`, `${bin}plur-hook`]
}

/**
 * The longest command ever claimed. A PLUR hook command is one shim path
 * plus a subcommand and a few short arguments. A path is at most 4096 bytes
 * on Linux (PATH_MAX) and 1024 on macOS, and `cmd.exe`, which runs the
 * Windows string hooks, accepts at most 8191 characters in all. Anything
 * longer is not a hook PLUR wrote, so it is the user's without running the
 * patterns at all — a guard on top of the patterns being linear.
 */
export const MAX_HOOK_COMMAND_LENGTH = 8192

/**
 * Is this hook command one PLUR wrote? The whole command must be PLUR's own
 * launcher (the plur-hook shim in any slash, quote or case form, or the
 * `npx @plur-ai/cli` fallback) followed by any `hook-*` subcommand (decision
 * H2) and plain arguments only (decision F4). A hook run by any other binary
 * is the user's, whatever its subcommand is called, and so is a look-alike
 * such as `plur-hook-backup.ps1`. A command longer than
 * MAX_HOOK_COMMAND_LENGTH is the user's.
 */
export function isPlurHookCommand(command: string): boolean {
  return command.length <= MAX_HOOK_COMMAND_LENGTH && matchesPlurHookLauncher(command)
}

/**
 * The patterns of `isPlurHookCommand` without the length cap. Exported so
 * the linear-time test can run them on inputs far above the cap: every
 * pattern must stay linear on its own, since the cap may be raised.
 */
export function matchesPlurHookLauncher(command: string): boolean {
  const normalised = command.trim().replace(/\\/g, '/').toLowerCase()
  if (SHIM_FORM.test(normalised) || NPX_FORM.test(normalised)) return true
  return spacedShimPaths().some((p) => normalised.startsWith(p) && SPACED_TAIL.test(normalised.slice(p.length)))
}

// END shared hook matcher
