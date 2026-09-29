import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'
import yaml from 'js-yaml'
import { logger } from './logger.js'
import { canonicalize } from './project-config.js'

/**
 * Directory trust — a one-time, explicit, per-directory grant, the same
 * shape as `direnv allow`, `git config safe.directory`, and VS Code's
 * workspace trust.
 *
 * Why this exists (2026-09 audit, D2): a `.plur.yaml` a repo ships can set
 * `scope`/`domain`, and an adapter (opencode, claw, ...) that adopts those
 * values automatically lets a directory the user merely opened — cloned,
 * not vetted — redirect that session's recall/writes to a scope the user
 * never chose FOR THAT SESSION. Team/remote stores are the legitimate use of
 * `.plur.yaml` (an enterprise user's own repo declaring `scope:
 * group:acme/eng` so recall reaches their team's store) — the fix is not to
 * refuse remote scopes, it is to require the user to have said, once, "I
 * trust this directory."
 *
 * Stored under the PLUR home (`<root>/trust.yaml`), never inside the
 * project — a repo cannot grant itself trust; only a human running
 * `plur trust` on their own machine can.
 */

interface TrustFile {
  version: 1
  trusted: string[]
}

function trustFilePath(root: string): string {
  return join(root, 'trust.yaml')
}

function loadTrustFile(root: string): TrustFile {
  const file = trustFilePath(root)
  if (!existsSync(file)) return { version: 1, trusted: [] }
  try {
    const raw = yaml.load(readFileSync(file, 'utf8')) as Partial<TrustFile> | null | undefined
    const trusted = Array.isArray(raw?.trusted)
      ? raw!.trusted.filter((t): t is string => typeof t === 'string')
      : []
    return { version: 1, trusted }
  } catch (err) {
    logger.warning(`[plur:trust] cannot parse ${file}: ${(err as Error).message} — treating as no trusted directories`)
    return { version: 1, trusted: [] }
  }
}

function saveTrustFile(root: string, data: TrustFile): void {
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  writeFileSync(trustFilePath(root), yaml.dump(data), 'utf8')
}

/**
 * The forms of a STORED entry a trust check accepts (#1319).
 *
 * An entry saved before canonicalize resolved the existing ancestor of a
 * missing path kept a symlinked parent's spelling for a folder that did not
 * exist at trust time. The entry's PARENT is canonicalised at compare time
 * and its last segment re-appended, so such a grant keeps working with no
 * rewrite of trust.yaml.
 *
 * The last segment is deliberately NOT resolved: canonicalising the whole
 * entry would follow a symlink put in place of the trusted folder AFTER it
 * was trusted, and trust whatever it points to (#778). The checked folder is
 * compared only in its canonical form, never its plain spelling, for the
 * same reason.
 */
function entryForms(entry: string): string[] {
  const parent = dirname(entry)
  if (parent === entry) return [entry]
  const canonical = join(canonicalize(parent), basename(entry))
  return canonical === entry ? [entry] : [entry, canonical]
}

function covers(entry: string, target: string): boolean {
  return entryForms(entry).some(f => target === f || target.startsWith(f + sep))
}

/**
 * True when `dir` — or an ancestor of it — has been explicitly trusted.
 *
 * Hierarchical: trusting a repo root also trusts everything below it (VS
 * Code's workspace-trust shape). A `.plur.yaml` living in a subdirectory of a
 * trusted repo is exactly as much the user's own project as the root is;
 * requiring a separate grant per subdirectory would make the common flow
 * ("clone the repo, `plur trust .` once") not actually work.
 *
 * Paths are canonicalized before comparing (`canonicalize`, shared with
 * `project-config.ts` — see #778 there for why a plain string compare fails
 * OPEN on a symlinked path component).
 */
export function isDirectoryTrusted(dir: string, root: string): boolean {
  const target = canonicalize(dir)
  const { trusted } = loadTrustFile(root)
  return trusted.some(t => covers(t, target))
}

/**
 * Grant trust to `dir`. Idempotent. Returns the canonicalized path recorded,
 * so a caller can echo back exactly what was trusted.
 */
export function trustDirectory(dir: string, root: string): string {
  const target = canonicalize(dir)
  const data = loadTrustFile(root)
  if (!data.trusted.includes(target)) {
    data.trusted.push(target)
    data.trusted.sort()
    saveTrustFile(root, data)
  }
  return target
}

/**
 * Revoke trust from `dir`. Exact match only — untrusting a root does not
 * walk its previously-covered descendants (there is nothing to walk; they
 * were never their own entries). Returns whether an entry was removed.
 */
export function untrustDirectory(dir: string, root: string): boolean {
  const target = canonicalize(dir)
  const raw = resolve(dir)
  const data = loadTrustFile(root)
  const kept = data.trusted.filter(t => !(t === raw || entryForms(t).includes(target)))
  if (kept.length === data.trusted.length) return false
  data.trusted = kept
  saveTrustFile(root, data)
  return true
}

/** List every directory this user has explicitly trusted (canonicalized, sorted). */
export function listTrustedDirectories(root: string): string[] {
  return loadTrustFile(root).trusted
}

/**
 * Find the trusted entry that COVERS `dir` — either `dir` itself (an exact
 * grant) or an ancestor directory whose grant is hierarchical over it.
 * Returns `null` when nothing covers `dir` at all.
 *
 * E3 (2026-09 audit): `untrustDirectory` is an exact-match removal (by
 * design — trust is hierarchical, grants are not, so there is nothing to
 * "walk" for a subdirectory that was never its own entry). But that made
 * `plur untrust <subdir-of-a-trusted-repo>` print "was not trusted" —
 * true of the exact string, false of the actual security question ("is this
 * directory still trusted after this command?", answer: yes) — on a
 * revocation command for a security primitive, telling the user the
 * opposite of the truth. This lets the caller name the covering ancestor and
 * the command that actually revokes it, instead of silently doing nothing
 * while claiming success.
 */
export function coveringTrustedAncestor(dir: string, root: string): string | null {
  const target = canonicalize(dir)
  const { trusted } = loadTrustFile(root)
  return trusted.find(t => covers(t, target)) ?? null
}
