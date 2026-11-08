# Conditional graceful stop (CRA-1153)

This source fork adds a native CORE/HOST admission fence and a local control socket. It is not an `isIdle()` check followed by `shutdown()`. For example, a prompt can be waiting in an `input` handler while `isIdle` is true. The new admission lease is acquired synchronously before that handler runs; a concurrent stop returns `busy` without aborting it.

## Safety contract

`AgentSession.probeSafeStop()` is a synchronous, conservative snapshot. `tryBeginSafeStop({ native_id, generation })` checks again and changes admission from open to stopping in the same stack, before any cleanup await. It fences session prompts, steering, follow-ups, custom/user messages, compaction, tree summaries, bug-report summaries, bash, reload, and model mutations. The generation changes on reload and a new AgentSession gets a new generation.

`RefreshController` combines that primitive with host and runtime admission gates. The interactive host accounts for asynchronous commands, preflight, dialogs, clipboard/external editor work, runtime replacement, startup catalog work and queued input. It refuses nonempty editor text (including whitespace), pending callbacks, queues (including custom `nextTurn` messages), retry, compaction, bash and cache warming. Cache warming includes cancelled requests still unwinding, not just the displayed status.

An idle result requires an existing regular persisted session file containing history. Nothing sends a wake prompt, creates fallback history, clears queues, aborts work, waits for busy work to finish, or escalates to a kill. A repeated stop or mismatched identity is rejected. Once accepted, admission never reopens, even if graceful cleanup fails.

SDK hosts must account for their own work using `SafeStopGate.beginWork()` before starting it and release in `finally` **after cleanup**. Use `RefreshController` to join host and runtime gates with the current session; the core-only primitive does not certify a host. Direct mutation of `session.agent`, `SessionManager`, provider globals or arbitrary SDK callbacks bypasses AgentSession admission and is outside this contract. Such hosts must not advertise this capability without an audit and complete leases. Raw SDK custom tools and providers registered outside a qualified extension are refused.

## Cooperative extensions

Arbitrary JavaScript, child processes, timers, watchers, background tasks and external resources cannot be inferred idle. Every loaded extension is **unsupported by default**, including built-in extensions. An audited extension can declare support once in its factory:

```typescript
export default function (pi: ExtensionAPI) {
  const work = pi.registerSafeStop({ version: 1 });

  async function ownedOperation() {
    const release = work.beginWork(); // before starting work or awaiting anything
    try {
      await performOperationAndCleanup();
    } finally {
      release();
    }
  }

  pi.on("session_shutdown", async () => {
    await closeIdleResources(); // idempotent; no new prompts/work
  });
}
```

A lease is idempotently released; acquiring one after the fence throws. Pi tracks awaited lifecycle handlers and `pi.exec()` automatically. The declaration covers **all** code the extension owns: tools, custom providers, shortcuts, event bus callbacks, late registrations and detached operations. Do not release a lease merely because cancellation was requested or a caller stopped awaiting a task. Idle resources may remain open only if they cannot start unleased work and `session_shutdown` closes them. Cleanup can append final extension state with `appendEntry`, but cannot send new messages.

Declarations require code review. They are not a security sandbox, a user allowlist, or proof that arbitrary third-party JavaScript is safe. There is no bypass that certifies installed packages by name.

Current qualification:

- `tool_search`: qualified after audit; its only operation synchronously ranks tool metadata and updates the loadout inside a core-owned tool call. It has no background resources.
- `codemode`: **unsupported**. Sandbox termination can resolve while aborted host model calls are still unwinding; `sandbox.close()` is not proof those calls completed. It requires separate leases before qualification.
- MCP: **unsupported**. Startup connections, reconnects, transport/list-change callbacks and background manager actions require a complete lease audit.
- Other built-ins and external extensions: **unsupported** unless they explicitly implement the audited contract.

The test fixture extension demonstrates cooperation; it does not certify any installed extension. A stock/configured launch can therefore still report `unsupported`. Probe reasons include up to eight unqualified extension path basenames. Deployment and extension qualification remain separate work; do not remove extensions to manufacture an idle canary.

## Managed local socket

Only the interactive `run()` host enables the bridge, after initial prompts are handled, when these environment values are present and valid:

- `LEDGER_RUN_ID`: `run_` plus 32 lowercase hex characters
- `AOE_INSTANCE_ID`: 16 lowercase hex characters
- `LEDGER_LOCK_HASH`: 64 lowercase hex characters
- `LEDGER_PROFILE`: `personal`, `work`, or `work-claude`
- `AOE_PROFILE`: the AoE profile name (a different namespace from Ledger profiles)

SDK, print, JSON and RPC construction do not create sockets. Older/no-capability processes are skipped. This version uses the deterministic short path `/tmp/aoe-pi-refresh-<uid>/<LEDGER_RUN_ID>.sock` to fit macOS Unix-domain socket limits; it does not implement `AOE_PI_REFRESH_SOCKET` overrides. The directory must be owned by the current uid, mode 0700, and not a symlink. The socket is mode 0600. Existing endpoints are never removed or replaced during startup, including stale ones. Bridge setup failure disables the capability, not the session.

This is a same-user local interface, not protection from malicious code already running as that user. There are no bearer tokens or transcript payloads. Requests cannot specify filesystem operations or shutdown commands.

One connection accepts one UTF-8 JSON line, at most 16 KiB including its newline, with a five-second absolute connection deadline and at most 32 concurrent connections. Invalid framing is closed without execution. No timeout kills Pi. The two methods are `probe` and `stop`:

```json
{"schema":"aoe.pi-refresh.v1","method":"probe","request_id":"unique-request-nonce"}
```

A response repeats the request nonce and current identity:

```json
{"schema":"aoe.pi-refresh.v1","request_id":"unique-request-nonce","identity":{"pid":123,"run_id":"run_...","native_id":"native-session-id","cwd":"/physical/worktree","generation":"random-generation-uuid","instance_id":"...","profile":"personal","aoe_profile":"personal-ledger","lock_hash":"...","session_file":"/physical/history.jsonl"},"status":"idle","reason":"quiescent","resource_discovery":{"skill_names":["example"]}}
```

Statuses are `idle`, `busy`, `unsupported`, `accepted`, and `error`. An unsupported unsaved session has `session_file: null`. `resource_discovery` contains sorted actual discovered skill names, never skill bodies. A stop request **must** include `expected` equal to the full returned identity. Probe may omit it for discovery; when supplied it is also checked. The parent must independently cross-check the discovered identity against its expected managed run before submitting stop.

On acceptance, CORE, runtime and HOST fences close synchronously and terminal input is disabled. The bridge sends `accepted` before scheduling the existing interactive graceful shutdown order: input drain, stop terminal rendering, awaited session shutdown hooks and disposal, then process exit. Socket cleanup is part of shutdown. `accepted` means admission was committed, **not** that the process exited.

The parent must observe the exact old process/pane exit before relaunching that same persisted native session. A lost reply or cleanup failure is not permission to kill, relaunch early, fall back to a new session, or inject a prompt. This package does not implement the parent's exit observation/relaunch policy.

## Verification

Focused tests use `test/suite/harness.ts`, faux providers and controlled promise barriers. They cover preflight/stop ordering, core queues, compaction admission, bash, cooperative work, identity mismatches, repeated stop, persisted JSONL preservation and refused ingress. Socket tests use private temporary directories and verify permissions, framing, discovery, acceptance and cleanup. No live managed process is stopped by these tests.
