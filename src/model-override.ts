/**
 * Resolving which reviewer one session actually uses.
 *
 * The picker offers one list of reviewers that spans both engines, so a selection
 * has to CARRY its engine: picking an LLM route means "this session reviews with
 * that LLM", picking a Jev model means "this session reviews with Jev". Anything
 * less made the picker a lie — the row would be listed, chosen, and then discarded
 * because the deployment's engine could not use it.
 *
 * The encoding is the provider half:
 *
 * - `typesafe/<model>` selects the Jev engine;
 * - `<provider>/<model>` selects the LLM engine on that route;
 * - a bare `<model>` keeps the engine in force and replaces only the model;
 * - `default` (folded by the audit state) clears the selection entirely.
 *
 * Two guards remain, because a session must never widen what the deployment
 * permitted:
 *
 * - **Egress.** Switching to Jev sends evidence to TypeSafe. While the deployment
 *   has not acknowledged that (`reviewer.jev.allowEgress`), a Jev selection is
 *   refused and the deployment's own engine stays in force.
 * - **Shape.** The Jev endpoint receives a bare model name; a value that still
 *   contains `/` after the display label is stripped is not one, so it is reported
 *   and ignored rather than forwarded.
 * @module dsh-approval-review/model-override
 */

/** Which engine answers reviews. Mirrors `reviewer.engine` without importing config. */
export type ReviewerEngineName = 'llm' | 'jev'

/** The provider half that marks the Jev engine in a selection. */
export const JEV_ROUTE_PROVIDER = 'typesafe'

/** The prefix the card uses to display a Jev selection; also its select marker. */
const JEV_ROUTE_PREFIX = `${JEV_ROUTE_PROVIDER}/`

/** The reviewer actually in force for one session. */
export interface ReviewerIdentity {
  /** Engine that will answer: the deployment's choice, or the session's. */
  readonly engine: ReviewerEngineName
  /** Provider half to display and to record in the audit marker. */
  readonly provider: string
  /** Model id to use: an LLM model, or a bare Jev model name. */
  readonly model: string
  /** A selection that had to be discarded, for the log. */
  readonly rejectedOverride?: string
}

/** A non-empty string, or undefined. */
function present(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

/**
 * Resolve the reviewer identity for one session.
 * @param input - deployment engine and route defaults, the recorded selection, and whether Jev egress was acknowledged.
 * @returns the identity to use, plus any selection it had to discard.
 */
export function effectiveReviewerModel(input: {
  /** Engine selected by the deployment configuration. */
  readonly engine: ReviewerEngineName
  /** Engine the session selection implies, when it named a provider. */
  readonly overrideEngine?: ReviewerEngineName | undefined
  /** Provider half of the session selection. */
  readonly overrideProvider?: string | undefined
  /** Model half of the session selection, or the whole bare id. */
  readonly overrideModel?: string | undefined
  /** Deployment default provider label for the deployment engine. */
  readonly defaultProvider: string
  /** Deployment default model for the deployment engine. */
  readonly defaultModel: string
  /** `reviewer.jev.allowEgress`: the deployment's consent to send evidence out. */
  readonly jevPermitted: boolean
}): ReviewerIdentity {
  const provider = present(input.overrideProvider)
  const model = present(input.overrideModel)
  const defaults: ReviewerIdentity = {
    engine: input.engine,
    provider: input.defaultProvider,
    model: input.defaultModel,
  }

  // A session may switch engines, but never past the deployment's consent to send
  // evidence to TypeSafe.
  if (input.overrideEngine === 'jev' && !input.jevPermitted) {
    return { ...defaults, rejectedOverride: `${JEV_ROUTE_PROVIDER}/${model ?? ''}` }
  }

  const engine = input.overrideEngine ?? input.engine
  if (engine === 'jev') {
    // A selection that names the Jev engine must name a model with it; a bare id
    // under the deployment's own Jev engine falls back to the configured model.
    const raw = model ?? (input.overrideEngine === 'jev' ? '' : input.defaultModel)
    const bare = raw.startsWith(JEV_ROUTE_PREFIX) ? raw.slice(JEV_ROUTE_PREFIX.length) : raw
    if (bare.length === 0 || bare.includes('/')) {
      return {
        engine: 'jev',
        provider: JEV_ROUTE_PROVIDER,
        model: input.engine === 'jev' ? input.defaultModel : '',
        rejectedOverride: raw.length > 0 ? raw : `${JEV_ROUTE_PROVIDER}/${model ?? ''}`,
      }
    }
    return { engine: 'jev', provider: JEV_ROUTE_PROVIDER, model: bare }
  }

  // LLM: a selection that named a provider is self-contained; otherwise the
  // deployment's provider stands and only the model moves.
  return {
    engine: 'llm',
    provider: provider ?? input.defaultProvider,
    model: model ?? input.defaultModel,
  }
}
