/**
 * The authorization ledger: the durable record of what the USER actually
 * authorized, folded from the whole session log instead of from a transcript
 * window.
 *
 * Why this module exists. The reviewer's only conversational context used to be
 * `buildTranscript()` in `runtime.ts`, which keeps the last `context.turns` turns
 * (default 2) inside `context.maxChars` (default 6000). An authorization is a
 * LONG-LIVED fact — "deploy this to staging", "yes, use the paid endpoint", "the
 * credentials are already in the environment" — and a fact of that shape ages out
 * of a recency window while it is still in force. In a real incident the reviewer
 * could no longer see the user's explicit choice, fell back to a stale
 * instruction, and refused a legitimate action the user had already approved.
 *
 * A window is the wrong shape for this fact, so this module keeps none: it folds
 * the entire committed log for the events that STATE an authorization, and bounds
 * only each fact's text and the number of facts. Ordering is newest-first
 * throughout, because the reviewer's character budget must be spent on the most
 * recent authorization.
 *
 * Trust boundary. Every entry is asserted to the reviewer as something the USER
 * did, so the fold is narrow on purpose:
 * - a direct human `user/message`;
 * - the harness's own `ask_user_question` tool result, which is the only durable
 *   record of a selection the user made in the UI;
 * - a live authorization the caller supplies, such as a one-shot
 *   `/approval-review approve` ({@link overrideEntry}).
 *
 * Assistant text is never folded. A model's claim that it was authorized is not
 * evidence of it, and folding it would let the agent under review manufacture the
 * very permission it is being reviewed for.
 * @module dsh-approval-review/authorization-ledger
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// One truncation marker for the whole evidence packet: reuse `reviewer.ts`'s
// bound rather than growing a second wording the reviewer would have to learn.
import { clampText } from './reviewer.ts'

/**
 * Who put one authorization on the record.
 *
 * The channels stay apart instead of collapsing into a single "authorized" flag
 * because they carry different standing. A `selection` is a choice the harness
 * recorded from the user's own hands; an `override` is a live human decision made
 * about one specific refusal; an `instruction` is prose from a user turn, which
 * may be about something else entirely. The reviewer has to know which one it is
 * reading before it treats the entry as covering the action in front of it.
 */
export type AuthorizationKind = 'selection' | 'override' | 'instruction'

/** One durable authorization fact, folded from the session or supplied live. */
export interface AuthorizationEntry {
  /**
   * Epoch milliseconds the fact was recorded.
   *
   * Carried separately from {@link turn} because the reviewer reasons about
   * staleness — an authorization from three turns ago is not the same evidence as
   * one from the turn in flight — and the log's own clock is the only ordering
   * that survives a resume.
   */
  readonly at: number
  /**
   * 1-based turn the fact belongs to.
   *
   * Kept because "the user said it" is only half the fact; the reviewer also has
   * to place it relative to the action under review.
   */
  readonly turn: number
  /** Which channel recorded it. */
  readonly kind: AuthorizationKind
  /**
   * Already-bounded, human-readable rendering.
   *
   * Bounded at fold time rather than at render time so the character budget the
   * renderer spends is the budget the reviewer actually receives: a single
   * oversized fact cannot silently crowd out the rest of the ledger.
   */
  readonly text: string
}

/**
 * The harness tool whose result is the user's own selection.
 *
 * This constant is the whole point of the module's second source. An answer the
 * user picks in the UI never becomes a `user/message` — it settles the pending
 * tool call and survives ONLY as that call's `tool/result` — so a fold that reads
 * user messages alone is blind to exactly the authorization a user is most likely
 * to consider binding.
 */
export const ASK_USER_QUESTION_TOOL = 'ask_user_question'

/**
 * Bound on the text of a live override entry.
 *
 * `overrideEntry` takes no limits, because the command that calls it knows the
 * tool name and nothing else; a tool name is an identifier, so this cap exists to
 * keep a pathological name from consuming the ledger's whole budget, not to trim
 * ordinary input.
 */
const OVERRIDE_TEXT_MAX = 400

/** The label each channel carries in the rendered ledger. */
const KIND_LABEL: Readonly<Record<AuthorizationKind, string>> = {
  selection: 'user selected: ',
  override: 'human override: ',
  instruction: 'user instruction: ',
}

/**
 * Fold the durable authorization facts out of a session's events.
 *
 * Reads the whole log from seq 0, so a fact recorded in any earlier turn is still
 * on the ledger — the property a recency window cannot have. The returned array
 * is newest-first and holds at most `limits.maxEntries` facts, each with text
 * bounded to `limits.maxCharsPerEntry`.
 *
 * It never throws. A malformed or hand-built log degrades to "no evidence for
 * this fact", because the caller runs inside the approval answerer: a throwing
 * evidence builder would fail the decision and lose the authorization it was
 * built to surface.
 * @param session - the session whose committed log is folded.
 * @param limits - deployment bounds on the ledger's size.
 * @returns the newest-first authorization facts, already bounded.
 */
export function buildAuthorizationLedger(
  session: Session,
  limits: { readonly maxEntries: number; readonly maxCharsPerEntry: number },
): AuthorizationEntry[] {
  // A non-positive cap means "keep nothing", matching how `renderTranscript`
  // treats a non-positive budget, rather than a silent "unbounded".
  const maxEntries = Math.max(0, Math.floor(limits.maxEntries))
  if (maxEntries === 0) return []
  const perEntry = Math.max(0, Math.floor(limits.maxCharsPerEntry))

  const entries: AuthorizationEntry[] = []
  // `tool/result` names no tool of its own, so the fold remembers which call each
  // id belongs to and attributes a result through that pairing.
  const callsByName = new Map<string, string>()
  // The open turn, for events that carry no turn of their own: `user/message` is
  // a plain surface message and records none. Turn 1 is the honest default for a
  // fact that precedes the log's first `turn/start`.
  let turn = 1

  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq as never)
    if (event === undefined) continue
    switch (event.type) {
      case 'turn/start':
        if (typeof event.data.turn === 'number') turn = event.data.turn
        break

      case 'tool/call':
        callsByName.set(String(event.data.callId), event.data.name)
        break

      case 'user/message': {
        if (!isHumanAuthored(event.data.source)) break
        const text = clampText(blocksToText(event.data.content), perEntry)
        if (text.length === 0) break
        entries.push({ at: event.time, turn, kind: 'instruction', text })
        break
      }

      case 'tool/result': {
        const callId = toolResultCallId(event)
        // Pairing is exact here, so an UNPAIRABLE result is skipped instead of
        // guessed at. The fallback reading — "the result text of an
        // `ask_user_question` call" — cannot be applied from the result alone:
        // `tool/result` carries no tool name, so any tool's output could be
        // asserted to the reviewer as a user selection. A missing entry costs a
        // needless review of a real authorization; a wrong entry grants one.
        if (callId === undefined || callsByName.get(callId) !== ASK_USER_QUESTION_TOOL) break
        const text = clampText(blocksToText(event.data.message.content), perEntry)
        if (text.length === 0) break
        entries.push({
          at: event.time,
          turn: typeof event.data.turn === 'number' ? event.data.turn : turn,
          kind: 'selection',
          text,
        })
        break
      }

      default:
        // Everything else is skipped, `assistant/message` included: the model's
        // own account of what it was allowed to do is the claim under review,
        // never evidence for it.
        break
    }
  }

  // The log is walked oldest-first because that is the only order it has; the
  // ledger is newest-first because that is the order its consumer spends budget
  // in. Reversing after the fold keeps the cap below a slice off the newest end.
  entries.reverse()
  return entries.slice(0, maxEntries)
}

/**
 * Render the ledger for the reviewer prompt, newest first, budget-bounded.
 *
 * Lines are spent from the newest end until the budget is exhausted, and the
 * elision is labelled with the count, so the reviewer can tell "the user
 * authorized nothing" apart from "the ledger was cut" — a distinction that
 * changes whether an absent authorization is evidence of anything.
 * @param entries - newest-first entries, as {@link buildAuthorizationLedger} returns them.
 * @param maxChars - total character budget; 0 or less sends nothing.
 * @returns the rendered section, or an empty string when there is nothing to say.
 */
export function renderAuthorizationLedger(
  entries: readonly AuthorizationEntry[],
  maxChars: number,
): string {
  if (maxChars <= 0 || entries.length === 0) return ''
  const kept: string[] = []
  let used = 0
  for (const entry of entries) {
    const rendered = authorizationLine(entry)
    if (used + rendered.length > maxChars) break
    kept.push(rendered)
    used += rendered.length + 1
  }
  if (kept.length === 0) {
    // The newest entry survives even when it alone overruns the budget. Dropping
    // it would reproduce the original bug at a smaller scale — an authorization
    // the reviewer cannot see — so the line is bounded instead of omitted, and
    // the shared truncation marker tells the reviewer its text is partial.
    kept.push(clampText(authorizationLine(entries[0]!), maxChars))
  }
  const omitted = entries.length - kept.length
  const header = omitted > 0
    ? `[${omitted} older authorization(s) omitted for budget]\n`
    : ''
  return `${header}${kept.join('\n')}`
}

/**
 * Build the live entry for a one-shot `/approval-review approve` authorization.
 *
 * The ledger folds the log, but this authorization is a decision taken NOW about
 * a refusal the log already records, so it has no session event of its own to
 * fold. Passing it in live is what keeps the reviewer's view of the user's intent
 * current within the turn the retry happens in.
 * @param override - the tool the human authorized and when they did it.
 * @param turn - the 1-based turn the retry belongs to.
 * @returns the entry, ready to prepend to the folded ledger.
 */
export function overrideEntry(
  override: { readonly toolName: string; readonly at: number },
  turn: number,
): AuthorizationEntry {
  return {
    at: override.at,
    turn,
    kind: 'override',
    // The wording names the command and the SINGLE call it covers. An entry that
    // read as a standing permission would widen the human's one-shot approval
    // past what they actually gave, which is the failure this ledger exists to
    // prevent, not to enable.
    text: clampText(
      `the human ran /approval-review approve, authorizing one "${override.toolName}" call that had been refused`,
      OVERRIDE_TEXT_MAX,
    ),
  }
}

/** Render one entry as a single ledger line. */
function authorizationLine(entry: AuthorizationEntry): string {
  return `- [turn ${entry.turn}] ${KIND_LABEL[entry.kind]}${entry.text}`
}

/**
 * Whether a `user/message` event is the human speaking.
 *
 * The same event type also carries context the harness injects on the user
 * channel — AGENTS.md instructions, skill bodies, file-change notices, another
 * agent's relay — and all of that is material the agent may have read out of the
 * repository or written itself. Labelling it "user instruction" would hand the
 * agent under review a way to write its own authorization into the ledger, so a
 * declared non-human producer is excluded.
 *
 * An absent or unrecognized `kind` is treated as the human, deliberately: a
 * committed event always declares one, so the lenient branch only ever sees a
 * hand-built log, and the fail-safe direction for a MISSING kind is to let the
 * reviewer see the authorization rather than hide it.
 * @param source - the event's message source.
 * @returns true when the entry may be asserted as the user's own instruction.
 */
function isHumanAuthored(source: unknown): boolean {
  const kind = (source as { readonly kind?: unknown } | undefined)?.kind
  return kind === undefined || kind === 'user'
}

/**
 * Recover the callId a `tool/result` belongs to.
 *
 * The result message's own block names the call it settles, which is the only
 * attribution the event carries: `tool/result` records the tool's output, not
 * the tool's name.
 * @param event - a committed `tool/result` event.
 * @returns the call id, or undefined when the message shape exposes none.
 */
function toolResultCallId(
  event: Extract<SessionEvent, { type: 'tool/result' }>,
): string | undefined {
  const content = event.data.message?.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block.type === 'tool-result') return String(block.toolCallId)
  }
  return undefined
}

/**
 * Join the text of a content-block list, walking nested tool-result blocks.
 *
 * A local copy of `runtime.ts`'s walker rather than an import from it: that
 * module also pulls in the Cordis context and the whole review runtime, and this
 * module is deliberately cheap to import. `audit.ts` inlines the same walk
 * privately, so there is no exported helper to share.
 * @param blocks - the content blocks of a message or tool result.
 * @returns the joined text; `''` when the list carries none.
 */
function blocksToText(blocks: readonly ContentBlock[]): string {
  const out: string[] = []
  const walk = (list: readonly ContentBlock[]): void => {
    for (const block of list) {
      if (block.type === 'text') out.push(block.text)
      else if (block.type === 'tool-result') walk(block.content)
    }
  }
  walk(blocks)
  return out.join('\n')
}
