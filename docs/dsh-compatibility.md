# DSH compatibility

The current development target is **DSH 0.2.2-rc.1**, the official npm `latest`
and `next` version checked on 2026-11-09. The DSH development dependencies are
pinned to that release so tests exercise its actual APIs. Zod is pinned to the
host's 4.4.3 version to avoid incompatible schema types from a second version.

The existing older-host peer ranges are retained. The newer clauses admit the
0.2.1 and 0.2.2 prerelease lines with ordinary npm semantics. Their upper bound
is `<0.3.0-0`: the host evaluates peers with `includePrerelease: true`, so
`<0.3.0` alone would also admit unreviewed 0.3.0 alpha and RC builds.

## API changes handled

- Tool results may be flat messages identified by `source.callId` instead of
  nested `tool-result` blocks. The audit trail and stop-on-rejection circuit
  breaker read both shapes, and reject conflicting result identities.
- Reviewer evidence declares its own `approval-review` message source instead
  of the removed catch-all `plugin` source.
- Modern subagents use `startActivation` rather than `start`. Passing the old
  `persona` and `toolFilter` fields to the new API would not enforce them.
  The adapter reserves a child ID, registers the recursion guard before
  creation, and installs the reviewer policy and hard tool restrictions in the
  host's awaited `agent/created` barrier before any child work is released.
- The modern child has both a scoped visibility restriction and an execution
  guard. Even a tool registered later in the child's own scope cannot execute
  outside the configured read-only subset of `read`, `glob`, and `grep`.
  Its complete, literal system prompt contains the reviewer policy. The
  parent's tools and prompt are unchanged.
- This modern path requires a local backend such as `spawn` or `fork`.
  Unsupported external providers and failed initialization follow the existing
  reviewer-failure policy; they do not receive an unrestricted fallback.
  Older hosts retain their capability-checked `start` path.

Cancellation, deadline, late-start disposal, and recursion-guard lifetime are
covered by regression tests. The latest-host native-execution test checks that
a child read runs, a dynamically registered child write is denied before its
body executes, the parent can still write, and the assembled reviewer prompt
contains the reviewer policy without inherited prompt text.

## Verification

Run `pnpm check` for TypeScript, the full test suite, and the checked-in host and
client bundles. The integration suite mounts the real approval service,
session-projection registry, and LLM runtime with a scripted model adapter.
The peer matrix also rejects 0.3.0 numeric, alpha, beta, RC, and stable versions.

Live Jev tests require `TYPESAFE_API_KEY` and are skipped without it. A passing
local suite does not claim live model-provider or desktop UI testing. The
checked-in bundles support GitHub installs; merging does not publish a new npm
release. Restart DSH after installing an updated plugin build.

## Upstream contracts

- [Official 0.2.2-rc.1 source](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1)
- [Compatibility evaluator](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/boot/app-boot/src/plugin-compatibility.ts)
- [Subagent activation service](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent/src/index.ts)
- [Subagent manager](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/subagent/subagent/src/manager.ts)
- [Message source and tool-result shapes](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/llm/llm/src/message.ts)
