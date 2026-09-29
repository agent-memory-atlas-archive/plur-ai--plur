/**
 * Automatic rating of injected engrams from the assistant's reply (#1310).
 *
 * An editor hook knows which engrams it injected this session and, at the end
 * of a turn, what the assistant replied. From those two it can often tell
 * whether an engram was used (the reply repeats it) or contradicted (the reply
 * corrects it). This module is the ONE implementation of that heuristic; it is
 * a port of plur-hermes's `_detect_injection_signal` (#1086), with the negative
 * rule tightened.
 *
 * Rules, first match wins:
 *
 *   1. The statement appears verbatim in the reply (case, whitespace and
 *      punctuation ignored)                                  → positive, 0.95
 *   2. At least 80% of the statement's word trigrams appear
 *      in the reply (statements of three words or more)      → positive, 0.7–0.9
 *   3. One sentence of the reply holds BOTH a correction
 *      phrase AND the statement's distinctive words          → negative, 0.65
 *
 * A match under rule 1 or 2 is only positive when neither the sentence(s)
 * holding it nor the sentence right after carry a correction phrase. A reply
 * that quotes a memory in order to correct it ("your note says 'use npm' —
 * that is no longer true") is rated negative, never positive (#1318 review).
 *
 * The match itself is also checked where it sits (#1362): a negation in the
 * word right before it ("Do not use pnpm" against "Use pnpm") or a
 * verdict right after it ('"use npm" is outdated') makes it negative too.
 * Only the words next to the match count, so a reply that follows the engram
 * and says "not" about something else in the same sentence stays positive.
 *
 * Statements under three words have no trigrams; comparing bare words would
 * rate "Prefer pnpm" positive for any short reply containing both words, so
 * they are matched verbatim only.
 *
 * Rule 3 used to look at a ±100–200 character window around any correction
 * word. A reply that fixed an unrelated thing next to a shared word therefore
 * marked the engram wrong. Sentences are the unit now, and "distinctive words"
 * means at least two of the statement's longer non-stopwords (or all of them
 * when it has fewer), so one shared common word is not enough.
 *
 * Only verdicts at or above {@link AUTO_FEEDBACK_MIN_CONFIDENCE} are returned
 * by {@link rateInjectedEngrams}. What a caller does with them is decided
 * elsewhere: automatic feedback adjusts ranking only and never commitment
 * (see `applyFeedbackSignal`'s `source` option).
 *
 * Pure functions — no I/O — so hooks can run them before paying for a store
 * load, and a server-side deployment can reuse them.
 */

export type InjectionSignal = 'positive' | 'negative'

export interface InjectionSignalResult {
  signal: InjectionSignal | null
  confidence: number
}

export interface RatedEngram {
  id: string
  signal: InjectionSignal
  confidence: number
}

/** Verdicts below this are never sent. */
export const AUTO_FEEDBACK_MIN_CONFIDENCE = 0.6

const EXACT_CONFIDENCE = 0.95
const TRIGRAM_MIN_OVERLAP = 0.8
const NEGATIVE_CONFIDENCE = 0.65
/** A word must be longer than this to count as distinctive. */
const DISTINCTIVE_MIN_LENGTH = 4
/** How many distinctive words a correcting sentence must share with the statement. */
const NEGATIVE_MIN_SHARED_WORDS = 2

/** Correction phrases that open a sentence. */
const LEADING_CORRECTION = /^(?:actually,|no,|correction:|wrong,|incorrect,)/
/**
 * Correction phrases anywhere in a sentence — constructions aimed at a prior
 * claim ("that is wrong", "is no longer true"), not a bare "is wrong", which
 * ordinary prose uses all the time ("check what is wrong with the deploy").
 */
const INLINE_CORRECTION =
  /\b(?:(?:that|this|it)(?:'s| is| was) (?:wrong|incorrect|outdated|out of date|not true|not correct|not accurate|no longer (?:true|valid|correct|accurate|the case))|(?:is|was|are|were) no longer (?:true|valid|correct|accurate|the case|needed|required)|no longer (?:applies|holds)|not correct anymore)\b/

/**
 * Longer words that carry no topic of their own. Kept small on purpose: a
 * word missing here only makes the negative rule slightly easier to meet, and
 * the two-word minimum already absorbs most of that.
 */
const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'always', 'before', 'being', 'below',
  'between', 'could', 'during', 'every', 'first', 'never', 'other', 'should',
  'since', 'their', 'there', 'these', 'thing', 'things', 'those', 'through',
  'under', 'until', 'using', 'where', 'which', 'while', 'would', 'without',
])

/**
 * Curly and modifier-letter apostrophes (U+2018, U+2019, U+02BC) count as
 * straight ones, so "don’t" is "don't" and "that’s wrong" is a correction.
 */
function straightApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019\u02bc]/g, "'")
}

function tokens(text: string): string[] {
  // Inner apostrophes and hyphens belong to the word ("don't", "zebra-quartz");
  // leading/trailing ones are quote marks and dashes around it.
  return (straightApostrophes(text.toLowerCase()).match(/[\p{L}\p{N}_'-]+/gu) ?? [])
    .map(t => t.replace(/^['-]+|['-]+$/g, ''))
    .filter(Boolean)
}

function trigrams(words: string[]): Set<string> {
  if (words.length < 3) return new Set(words)
  const out = new Set<string>()
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`)
  return out
}

function sentences(text: string): string[] {
  // Normalised here, before the correction regexes see the sentence.
  return straightApostrophes(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0)
}

/** Words that negate what directly follows them ("do not use pnpm"). */
const NEGATORS = new Set([
  'not', 'never', "don't", 'dont', "doesn't", "didn't", "shouldn't",
  "mustn't", "won't", "can't", 'cannot', 'avoid',
])
/**
 * Filler a negator may sit behind ("don't ever use pnpm"). Only the word right
 * before the match is checked otherwise, so "If not sure, use pnpm" follows it.
 */
const NEGATION_FILLER = new Set(['ever', 'just', 'really', 'even', 'actually', 'always'])
/**
 * A verdict on the matched text, read from the words right after it:
 * '"use npm" is outdated', "…, which is no longer true".
 */
const TRAILING_VERDICT =
  /^(?:which |that )?(?:is|was|are|were)(?: now| also)? (?:outdated|out of date|obsolete|deprecated|stale|wrong|incorrect|false|(?:not|no longer) (?:true|valid|correct|accurate|right|the case|needed|required|recommended))\b/

function isCorrection(sentence: string): boolean {
  return LEADING_CORRECTION.test(sentence) || INLINE_CORRECTION.test(sentence)
}

/** Rate one injected engram against the assistant's reply. */
export function detectInjectionSignal(statement: string, reply: string): InjectionSignalResult {
  const stmtWords = tokens(statement)
  const sents = sentences(reply)
  // The reply's tokens, each tagged with the sentence it sits in, so a match
  // can be traced back to the sentences that hold it.
  const flat: string[] = []
  const sentOf: number[] = []
  sents.forEach((s, i) => { for (const t of tokens(s)) { flat.push(t); sentOf.push(i) } })
  if (stmtWords.length === 0 || flat.length === 0) return { signal: null, confidence: 0 }

  /** Is the match in these sentences corrected there or in the next sentence? */
  const corrected = (idxs: Iterable<number>): boolean => {
    for (const i of idxs) {
      if (isCorrection(sents[i])) return true
      if (i + 1 < sents.length && isCorrection(sents[i + 1])) return true
    }
    return false
  }
  const quotedThenCorrected: InjectionSignalResult = { signal: 'negative', confidence: NEGATIVE_CONFIDENCE }

  /**
   * Is the matched span flat[start..end] negated right before it or given a
   * wrong/outdated verdict right after it, within its own sentence? (#1362)
   */
  const rejectedInPlace = (start: number, end: number): boolean => {
    let k = start - 1
    if (k >= 0 && sentOf[k] === sentOf[start] && NEGATION_FILLER.has(flat[k])) k--
    if (k >= 0 && sentOf[k] === sentOf[start] && NEGATORS.has(flat[k])) return true
    const after: string[] = []
    for (let k = end + 1; k < flat.length && after.length < 6 && sentOf[k] === sentOf[end]; k++) after.push(flat[k])
    return TRAILING_VERDICT.test(after.join(' '))
  }

  // 1. Verbatim, on token boundaries.
  const n = stmtWords.length
  const exactAt = new Set<number>()
  let exactRejected = false
  for (let k = 0; k + n <= flat.length; k++) {
    let hit = true
    for (let j = 0; j < n; j++) if (flat[k + j] !== stmtWords[j]) { hit = false; break }
    if (!hit) continue
    for (let j = 0; j < n; j++) exactAt.add(sentOf[k + j])
    if (rejectedInPlace(k, k + n - 1)) exactRejected = true
  }
  if (exactAt.size > 0) {
    return exactRejected || corrected(exactAt)
      ? quotedThenCorrected
      : { signal: 'positive', confidence: EXACT_CONFIDENCE }
  }

  // 2. Trigram overlap — only for statements that have trigrams.
  if (n >= 3) {
    const stmtTris = trigrams(stmtWords)
    const triSentences = new Map<string, number[]>()
    let first = -1
    let last = -1
    for (let k = 0; k + 2 < flat.length; k++) {
      const t = `${flat[k]} ${flat[k + 1]} ${flat[k + 2]}`
      if (!stmtTris.has(t)) continue
      const list = triSentences.get(t) ?? []
      list.push(sentOf[k], sentOf[k + 2])
      triSentences.set(t, list)
      if (first < 0) first = k
      last = k + 2
    }
    const overlap = triSentences.size / stmtTris.size
    if (overlap >= TRIGRAM_MIN_OVERLAP) {
      const where = new Set([...triSentences.values()].flat())
      return corrected(where) || rejectedInPlace(first, last)
        ? quotedThenCorrected
        : { signal: 'positive', confidence: 0.7 + 0.2 * overlap }
    }
  }

  // 3. Correction in the same sentence as the statement's distinctive words.
  const distinctive = [...new Set(stmtWords)].filter(
    w => w.length > DISTINCTIVE_MIN_LENGTH && !STOPWORDS.has(w),
  )
  if (distinctive.length > 0) {
    const needed = Math.min(NEGATIVE_MIN_SHARED_WORDS, distinctive.length)
    for (const sentence of sents) {
      if (!isCorrection(sentence)) continue
      const words = new Set(tokens(sentence))
      const hits = distinctive.filter(w => words.has(w)).length
      if (hits >= needed) return { signal: 'negative', confidence: NEGATIVE_CONFIDENCE }
    }
  }

  return { signal: null, confidence: 0 }
}

/**
 * Rate every injected engram against one reply and keep only the verdicts
 * confident enough to send.
 */
export function rateInjectedEngrams(
  engrams: ReadonlyArray<{ id: string; statement: string }>,
  reply: string,
  minConfidence: number = AUTO_FEEDBACK_MIN_CONFIDENCE,
): RatedEngram[] {
  const out: RatedEngram[] = []
  for (const e of engrams) {
    if (!e.id || !e.statement) continue
    const { signal, confidence } = detectInjectionSignal(e.statement, reply)
    if (signal && confidence >= minConfidence) out.push({ id: e.id, signal, confidence })
  }
  return out
}
