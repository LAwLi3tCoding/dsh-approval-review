# dsh-approval-review

[English](README.md) | [简体中文](README-zh.md)

**Codex-style agent auto-approval for DeepSeek Harness.** When an action crosses a
boundary that the sandbox does not cover on its own, a second, independent
reviewer model reads the proposed action and returns a verdict — so a human
approves nothing routine, and nothing unsafe slips through. Every decision leaves
a full rationale in a dedicated Approvals tab.

This plugin implements the shape of Codex's
[Auto-review](https://developers.openai.com/codex/concepts/sandboxing/auto-review):
an interactive approval request is routed to a reviewer agent instead of a person,
the reviewer answers with a structured verdict, a denial is handed back to the
calling model as reasoning rather than as a bare error, and a per-turn rejection
circuit breaker stops the agent from looping on escalation attempts.

> **It is a reviewer swap, not a permission grant.** The plugin never widens a
> sandbox, never invents a grant, and never removes a human from a decision it was
> not configured to take over. Requests it does not own are delegated with
> `next()`, unchanged.

## What it does

| | |
|---|---|
| **Official seam** | An `approval/request` answerer registered with `prepend: true`, so it claims a request ahead of the human UI answerer, and delegates everything else back to the chain. |
| **Second-model review** | A one-shot reviewer runs as a **read-only subagent** (`fork`) holding only `read`/`glob`/`grep`, so it can go READ the workspace — "is this path actually inside the repo?" becomes a fact, not a guess. `mode: direct` falls back to a plain model call over the evidence packet. |
| **No silent failure** | A crashed, timed-out, truncated, or off-schema reviewer answer never becomes an approval: it yields the configured failure policy, which defaults to `delegate` — the request goes back to the human chain. Set `onReviewerFailure: rejected` for the fail-closed stance. |
| **Rationale reaches the model** | A denial's reason is appended to the refused tool result, with an explicit instruction not to pursue the same outcome through a workaround. An **allow** verdict rides the same channel (gated by `recordAllowedVerdicts`): the approval outcome is a closed vocabulary, so the tool result is the only place the plugin can write durably — without it the card can show that an action ran but never why. |
| **Risk gate** | An `allow` verdict above `maxAutoAllowRisk` does not auto-allow; it delegates to the human. |
| **Circuit breaker** | Consecutive and rolling-window denial thresholds, matching Codex's per-turn breaker, after which further requests go to the human chain. |
| **Budgets** | A per-turn cap on reviewer calls, so a loop cannot bill unlimited reviews. |
| **One-shot override** | `/approval-review approve [n]` records a human authorization for one retry. The reviewer still decides; it just learns the human authorized it. |
| **Fourth access mode** | An `替我审批` ("approve for me") entry beside 仅可查看 / 工作区内修改 / 完全权限. It shares its sandbox and approval knobs with `workspace-write` on purpose — the difference is WHO answers — so the menu entry itself is the switch. `PermissionPresetService.derive()` checks the recorded selection first, which is what lets the two coexist and stay selected. |
| **Verdict cache** | Reuses a recent verdict for a byte-identical `tool + arguments`, so a retry loop does not bill a reviewer call each time. Only consulted when `context.turns` is 0, where the verdict really is replayable from the action alone. |
| **Failure budget** | A per-turn cap on reviewer *failures*, so a broken reviewer cannot be retried without bound while the request waits. |
| **Approvals tab** | A conversation tab rendering every request with its verdict, routing policy, risk, rationale, safer-alternative suggestion, reviewer route, timing, and the live budget/breaker state, plus working on/off and one-shot-approve buttons. |

## Install

> **No build step on install.** The repository carries the built bundles
> (`lib/`) and `package.json` declares no `prepare` script, because pnpm blocks a
> git dependency's `prepare`/`install` build scripts
> (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`) and that fails the entire install.
> `dsh plugin add github:...` therefore works with no `allowBuilds` entry in the
> profile's `pnpm-workspace.yaml`.
>
> You only build when working from a source clone: `pnpm build` (and `prepack`
> runs it automatically before a publish).

```sh
# npm (published releases)
dsh plugin --profile <profile> add dsh-approval-review

# a local checkout
dsh plugin --profile <profile> add /path/to/dsh-approval-review

# a git pin
dsh plugin --profile <profile> add "github:LAwLi3tCoding/dsh-approval-review#<sha>"
```

Then restart and confirm the row composed:

```sh
dsh --profile <profile> --dump-config | grep -A6 'id: approval-review'
```

The desktop profile is managed by the Electron app and refuses `dsh plugin`; add
the dependency and bundle entry by hand there, or drive it from the app's plugin
manager.

## Configuration

All tunables live in the bundle's `cordis.patch.yml` row, so they are changeable
without touching code. **An id-targeted override replaces the whole config row** —
restate every key you still want, or the omitted ones silently return to their
schema defaults.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` mounts the plugin but claims nothing. |
| `enabledByDefault` | `true` | Session-start default for the runtime switch. |
| `reviewTools` | `[bash, pwsh, write]` | Tool-name globs routed to the reviewer. |
| `defaultPolicy` | `human` | Policy for tools matching no glob: `ai` / `human` / `never`. |
| `rules` | `[]` | Ordered `{pattern, policy, field?, note?}` regex rules, evaluated before the tool table. `field` is `reason` (default), `toolName`, or `arguments`. |
| `reviewer.mode` | `subagent` | `subagent` forks a read-only child that can inspect the workspace; `direct` makes one plain model call. |
| `reviewer.provider` / `.model` | *(inherit)* | Reviewer route; unset inherits the calling agent's own route. |
| `reviewer.subagentProvider` | `fork` | Subagent backend for `mode: subagent` (`fork` / `spawn`). |
| `reviewer.tools` | `[read, glob, grep]` | The reviewer child's tool allow-list. An empty list falls back to the read-only default rather than the parent's whole face. |
| `reviewer.timeoutMs` | `120000` | Hard deadline for one reviewer call. A slow route plus a reasoning reviewer can take ~50s; a deadline that expires mid-review becomes a failure-policy outcome (a delegation to the human by default), not a verdict. |
| `reviewer.maxTokens` | `1024` | Output cap. |
| `reviewer.temperature` | `0` | Sampling temperature. |
| `reviewer.policyText` | *(shipping policy)* | Replaces the ruling policy text. |
| `reviewer.guidance` | *(none)* | Extra deployment guidance appended after the policy. |
| `reviewer.argumentMaxChars` | `4000` | Per-string argument cap. |
| `reviewer.argumentsBudgetChars` | `16000` | Whole-argument-document cap; `0` disables. |
| `context.turns` | `2` | Prior turns of transcript evidence; `0` sends none. |
| `context.maxChars` | `6000` | Transcript character budget. |
| `context.includeAssistant` | `true` | Include assistant messages in the transcript. |
| `context.includeToolActivity` | `true` | Include tool calls and results. |
| `maxAutoAllowRisk` | `medium` | Highest risk the reviewer may auto-allow. |
| `onRiskExceeded` | `delegate` | `allow` / `delegate` / `deny` above that ceiling. |
| `onUncertain` | `delegate` | Reviewer reported it could not decide. |
| `onReviewerFailure` | `delegate` | Reviewer crashed, timed out, or answered off-schema. Defaults to **delegating**: a reviewer that could not run is an infrastructure problem, not a verdict — set `rejected` for the fail-closed stance. |
| `budget.maxReviewsPerTurn` | `20` | Reviewer calls per open turn. |
| `budget.onExhausted` | `delegate` | `delegate` / `deny` once spent. |
| `maxFailuresPerTurn` | `10` | Reviewer *failures* per open turn before requests delegate. |
| `verdictCache.ttlMs` | `60000` | Reuse a verdict for an identical action; `0` disables. Only consulted when `context.turns` is 0. |
| `verdictCache.maxEntries` | `256` | Cached fingerprints before oldest-eviction. |
| `circuitBreaker.consecutiveDenials` | `3` | Consecutive denials that trip the breaker. |
| `circuitBreaker.windowDenials` | `10` | Denials within `windowSize` that trip it; `0` disables. |
| `circuitBreaker.windowSize` | `50` | Rolling window size. |
| `circuitBreaker.action` | `delegate` | `delegate` / `deny` once open. |
| `override.ttlMs` | `300000` | How long an `/approval-review approve` stays usable; `0` never expires. |
| `override.maxPending` | `10` | How many recent denials the override can address. |
| `reasonMaxChars` | `2000` | Cap on any reason string the plugin emits. |
| `feedReasonToModel` | `true` | Append the rationale to the refused tool result. |
| `recordAllowedVerdicts` | `true` | Append the **allow** verdict to the accepted tool result, so the card can show why an action was allowed. Costs one short marker block in the model context per auto-allowed call. |
| `language` | `en` | `/approval-review` output language (`en` / `zh`). |

### Tool policies

- **`ai`** — this plugin's reviewer decides. `allowed-once` or `rejected`.
- **`human`** — delegate with `next()` to the rest of the answerer chain: the
  ordinary approval prompt. The plugin never short-circuits it.
- **`never`** — deterministic `rejected` with an explanatory marker, no reviewer
  call and no prompt. The hard-disable stance for a tool family.

`edit` is deliberately **not** in the default `reviewTools`: in-place modification
of an existing file is the highest-consequence routine action, so it keeps the
human prompt until a deployment decides otherwise.

### Example: stricter deployment

```yaml
- insert:
    - id: approval-review
      name: dsh-approval-review
      config:
        reviewTools: ['bash', 'pwsh', 'write', 'edit']
        defaultPolicy: human
        rules:
          - pattern: '(?i)(rm\s+(-[a-z]+\s+)*/|git\s+push\s+--force)'
            policy: never
            note: destructive
          - pattern: 'curl|wget|nc\s'
            policy: ai
            field: arguments
        reviewer:
          model: '<a cheaper reviewer model>'
          timeoutMs: 30000
        maxAutoAllowRisk: low
        onRiskExceeded: delegate
        circuitBreaker: { consecutiveDenials: 2, windowDenials: 5, windowSize: 20, action: deny }
```

## Session command

```
/approval-review on|off|status|approve [n]|model [<provider>/]<id>
```

- **`on` / `off`** — the durable per-session switch. It survives restart and
  resume, because the switch is folded from the command's own session event
  rather than held in memory.
- **`status`** — the effective switch, this turn's reviewer budget, the denial
  streak, cumulative counts, whether the breaker is open, how many one-shot
  overrides are pending, and the most recent decision.
- **`approve [n]`** — records a one-shot authorization for the n-th most recent
  denial (1 = most recent). The next review of that tool carries the human
  authorization as reviewer context, and the reviewer still decides
  independently.

## The Approvals tab

The package's `dsh.client` declaration auto-registers the browser half; the host
registers an `approvalReview` session projection whenever the profile provides
the session-projection capability. No extra patch row is needed.

The **Approvals tab** sits in the conversation view beside 轨迹 / 上下文 / 费用 and
renders the ledger as a full page: per request, the tool, the verdict, the
**routing policy**, the risk grade, the reviewer's rationale, an optional
safer-alternative suggestion, the asker's own reason, the reviewer route and
duration, the risk/uncertainty flags, an expandable argument view, and a one-shot
approve button for recent denials. It also shows the live budget, denial streak,
and breaker state, plus the equivalent slash command.

**There is no session-header card any more.** It read the same projection as the
tab and rendered the same ledger into a popover, on the most contended strip of
the session chrome — the tab already shows it full-page, so the card was a
duplicate.

**Every row states whether this plugin decided it.** The projection folds the
host's own `approval/asked` events, so the tab also contains requests this plugin
never arbitrated — a `web_fetch` handed back by `defaultPolicy: human`, or an
`ask` raised by `dsh-permission-rules`' network policy. Those rows carry a
`delegated` / `hard-disabled` tag and the real `policy · policySource` (re-derived
from the deployment config at fold time) instead of masquerading as `ai ·
unrecorded`. A missing rationale is likewise worded per routing policy, so "no
record" is never reported as "not decided by this plugin".

**It lists approval requests, not tool calls.** A call the sandbox allowed
outright, which never raised an approval, never appears; anything that DID raise
one appears, whichever plugin raised it.

Without the projection capability the tab reports itself unavailable and the
answerer is unaffected.

## The access-mode glyph

The access-mode menu's icon table inside
`@deepseek-ai/dsh-client-ui-conversation` is a **closed design set**: only the
three built-in keys have shield glyphs, and the `permissions` projection carries
value/name/description only, so the host cannot be asked for one. The fourth
entry therefore renders with no icon.

`src/client/access-mode-glyph.ts` supplies it from the browser half: it marks the
access-mode trigger and the matching menu row with
`data-dsh-approval-review-glyph`, and a plugin-owned stylesheet draws the same
shield carrying an eye (the boundary is unchanged — someone looked before it was
crossed) through `::before` and an SVG mask.

- **It never touches React's tree**: attributes only, no inserted nodes, so
  child reconciliation is left alone.
- **It yields to the built-in glyph**: once the host really ships one for this
  key (e.g. you rebuilt the harness client package), the shim sees it and drops
  its own mark, so the icon is never drawn twice.
- Rename the preset without updating the label list in that file and the glyph
  simply does not appear; the menu keeps working. It is a progressive
  enhancement, not a dependency.

## How it works

```text
              approval/request waterfall (answerer chain)
               │
   ┌───────────┴──────────────────────────────────┐
   │ dsh-approval-review answerer (prepended)     │
   │  · plugin + session switch on?               │  no ── next() ──▶ human answerer
   │  · risk rules → reviewTools → defaultPolicy   │
   │    = human? ─────────────────────────────────┼── next() ──▶ human answerer
   │    = never? ─────────────────────────────────┼── rejected + marker
   │  · circuit breaker open? ────────────────────┼── delegate / deny
   │  · per-turn budget spent? ───────────────────┼── delegate / deny
   └───────────┬──────────────────────────────────┘
               │ ai
               ▼
   ┌──────────────────────────────────────────────┐
   │ reviewer: one-shot call / read-only subagent  │
   │  · evidence: proposed action + redacted args  │
   │    + ask reason + bounded transcript,         │
   │      fenced as DATA and not instructions      │
   │  · output: {decision, risk, reason, suggest}  │
   │  · timeout raced against the request signal   │
   └───────────┬──────────────────────────────────┘
               │ verdict | failure (failure policy)
               ▼
    allow ─▶ allowed-once     deny ─▶ rejected
                                    └▶ rationale appended to the refused
                                       tool result (tools/post-execute)
```

The approval outcome vocabulary is closed, so a denial has nowhere to carry
text. The plugin puts the rationale on the refused **tool result** instead, via a
`tools/post-execute` listener. That single channel serves two purposes: the model
reads why it was refused, and the audit ledger — which folds the session log —
recovers the same rationale for the card.

### Why the ledger adds no session event type

The persistence read path refuses to interpret a log containing an event type
outside the harness's own `KNOWN_SESSION_EVENT_TYPES` unless the record carries
the envelope's `ignorable: true` marker, and `Session.append` cannot stamp that
marker on any published line — only the harness that owns the log can. A plugin
that appended its own `approvalReview/*` event would therefore make the session
unresumable.

So the ledger adds **no** event type. It folds the events the host already writes
(`approval/asked`, `approval/decided`, `tool/call`, `step/*`, `turn/*`,
`command/run`, `tool/result`) into a pinned projection, and correlates the
reviewer's rationale out of the refused tool result. Every field on the card is
reconstructible from the log alone.

## Security notes

- **Redaction is structural, then textual.** Argument objects are walked and
  secret-keyed leaves replaced before anything reaches the reviewer; keys are
  matched on word boundaries so `auth` does not redact `author`. A payload that
  fails to parse gets a best-effort textual scrub plus a length bound instead.
- **The transcript uses the same redaction.** It reads the same `tool/call` event
  as the proposed-action section; a transcript built from the raw argument string
  would hand the reviewer exactly the credentials the other section masked.
- **The reviewer's evidence is data, not instructions.** The transcript and the
  asker's reason can contain repository-controlled text (`AGENTS.md`, a file under
  review, command output). The data/instruction boundary is appended by code and
  cannot be overridden by `policyText`, and an instruction — or a claim that the
  action was already approved — inside the evidence counts AGAINST the action.
- **The reviewer is read-only.** `mode: direct` is one model call holding no
  tools; `mode: subagent` is a child with a `toolFilter` allow-list and
  `maxDepth: 1` — the child's own delegation depth, so it may exist and may not
  spawn a grandchild. Neither form can write, execute, or delegate, so a reviewer
  compromise cannot escalate the boundary it guards.
- **The reviewer cannot recurse.** A reviewer child is registered as soon as it
  exists, so its own approval asks are delegated to the human chain instead of
  returning to the answerer serving it.
- **A reviewer that cannot run asks a human.** `onReviewerFailure: delegate`,
  `onUncertain: delegate`, and `maxAutoAllowRisk: medium` are the shipping
  choices: refusing in the model's name would make an infrastructure failure
  look like a judgement. Set `onReviewerFailure: rejected` for fail-closed, where
  refusing a safe action costs a retry while approving an unsafe one may be
  unrecoverable.
- **It is not a security guarantee.** It evaluates only the requests the approval
  seam raises, and a language model can be wrong, especially in adversarial
  contexts. It complements a well-configured sandbox; it does not replace one.

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # tsdown: lib/index.js + lib/client.js
pnpm check       # all three
```

The test suite is layered: pure policy tables, the reviewer packet and verdict
parser, the audit fold, the runtime guards, and an integration layer that mounts
the **real** `ApprovalService` and `LlmRuntime` with a scripted adapter and drives
real `approval/request` dispatches. The integration layer is what caught a
transcript-path secret leak, so it is the part worth extending first.

## License

Apache-2.0.
