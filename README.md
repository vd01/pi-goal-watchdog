# pi-goal-watchdog

An external **watchdog extension for [pi-goal-x](https://github.com/tmonk/pi-goal-x)**: it detects goals that got stuck in `paused`, `waiting`, or `active`-but-idle and recovers them.

It uses **only public interfaces**, so it never patches pi-goal-x and keeps working across pi-goal-x upgrades:

| Recovery channel | Interface |
| --- | --- |
| Wake an event-only wait | `pi.events.emit("pi-goal:wake", { goalId, waitToken })` — documented in pi-goal-x [`docs/advanced-usage.md`](https://github.com/tmonk/pi-goal-x/blob/main/docs/advanced-usage.md) ("Background producer integration") |
| Resume a paused / stalled goal | `pi.sendUserMessage("/goal-resume", { expandPromptTemplates: true })` — pi's public API that dispatches a registered extension command (equal to the user typing `/goal-resume`) |
| State discovery | read-only scan of `<goalsRoot>/active_goal_*.md` (honours `PI_GOAL_ROOT` / `goalsRoot`, falls back to the pool snapshot) |

## Why it exists

pi-goal-x has good *"keep going while healthy"* behaviour, but it deliberately has no *"recover after it stopped"* behaviour:

| Situation | pi-goal-x built-in | Self-healing? |
| --- | --- | --- |
| Provider network errors | escalating backoff retry (`network-error-backoff.ts`), unbounded by default | yes |
| `wait` with `polling` | scheduler re-checks by `nextCheckAt` | yes |
| Event-only `wait` (no polling, no signal) | waits until `deadline` (may be days) | no |
| Previous dispatch interrupted (process killed / turn aborted) | `scheduler.restore()` pauses it, never replays | no — `/goal-resume` required |
| Allowance exhausted, wait deadline/checks exhausted, missing contract disposition | pauses | no — `/goal-resume` required |
| Another session / Pi was closed | timers only live inside a Pi process | no |
| Stall detection | `stallTimeoutMinutes` (default `0` = off) only injects a `[GOAL STALLED]` prompt note | no |

So pi-goal-x **does not have** a watchdog, and resume is intentionally user-owned. This extension adds the missing watchdog from the outside.

## Install

```bash
# as a pi package (recommended)
pi install git:github.com/vd01/pi-goal-watchdog

# or drop the file into your user extensions directory
curl -fsSL https://raw.githubusercontent.com/vd01/pi-goal-watchdog/main/extensions/goal-watchdog.ts \
  -o ~/.pi/agent/extensions/goal-watchdog.ts

# or try it for one session
pi -e git:github.com/vd01/pi-goal-watchdog
```

Then `/reload` (or restart pi). It is **enabled by default in every session**; the status bar shows `dog: on` / `dog: on (n)` / `dog: off`.

## Commands

| Command | Effect |
| --- | --- |
| `/goal-watchdog` | show effective config + run one read-only scan |
| `/goal-watchdog on` / `off` | enable/disable for **this session only** (new sessions default to `on`) |
| `/goal-watchdog interval <seconds>` | set the scan interval for this session (min 10) |
| `/goal-watchdog wake <goalId>` | emit one `pi-goal:wake` |
| `/goal-watchdog resume [goalId]` | dispatch `/goal-resume` |

## Configuration

Precedence: built-in defaults < `$PI_CODING_AGENT_DIR/pi-goal-watchdog.json` (default `~/.pi/agent/`) < `<cwd>/.pi/pi-goal-watchdog.json` < environment variables.

```json
{
  "enabled": true,
  "pollSeconds": 60,
  "statusHint": true,
  "startupNotice": false,
  "notify": true,
  "autoWake": true,
  "autoResume": true,
  "autoResumeOtherSessions": false,
  "waitStaleSeconds": 3600,
  "pausedStaleSeconds": 900,
  "activeIdleSeconds": 3600,
  "maxAttemptsPerGoal": 3,
  "attemptWindowSeconds": 3600,
  "notifyCooldownSeconds": 1800
}
```

Key aliases: `interval`, `intervalSeconds`, `interval_seconds` are accepted for `pollSeconds`.

Environment variables: `PI_GOAL_WATCHDOG=0|1`, `PI_GOAL_WATCHDOG_POLL_SECONDS`, `PI_GOAL_WATCHDOG_INTERVAL_SECONDS`, `PI_GOAL_WATCHDOG_AUTOWAKE=0|1`, `PI_GOAL_WATCHDOG_AUTORESUME=0|1`, `PI_GOAL_WATCHDOG_AUTORESUME_OTHER_SESSIONS=0|1`, `PI_GOAL_WATCHDOG_WAIT_STALE_SECONDS`, `PI_GOAL_WATCHDOG_PAUSED_STALE_SECONDS`.

### What each decision means

| Detected state | Action |
| --- | --- |
| `active` + `waiting`, **no polling**, no signal, idle > `waitStaleSeconds` | emit `pi-goal:wake` (if `autoWake`, owned + focused) |
| `active` + `waiting`, **with polling**, `nextCheckAt` overdue beyond `max(3 × interval, waitStaleSeconds)` | notify: scheduler timer looks dead |
| `active`, not waiting, no writes for `activeIdleSeconds` | `/goal-resume` re-kick (if `autoResume`, owned + focused) |
| `paused` with an infrastructure reason (see below) | `/goal-resume` (if `autoResume`) |
| `paused` by the user (`stopReason: "user"`) | never touched |
| `paused` with a `pauseSuggestedAction` or an unknown reason | notify only (a human decision is pending) |
| `blocked`, `budget_limited`, token budget exhausted | notify only |

Infrastructure pause reasons that are auto-resumable: `Previous autonomous execution was interrupted`, `Autonomous-run allowance exhausted`, `No execution disposition after the contract-repair prompt`, `Wait deadline reached`, `Wait check allowance exhausted`, `Goal wake stopped`, `Goal checkpoint delivery failed`.

### Safety rails

- Acts only on goals owned by the current session (`scheduler.owner`) — or on any paused goal if you opt into `autoResumeOtherSessions`.
- Acts only on the goal the session has **focused** (reads the `pi-goal-focus` entry from the session branch), so it never pops pi-goal-x's "choose a goal" dialog. `pi-goal:wake` is a no-op for unfocused goals in pi-goal-x, so it is gated the same way.
- Acts only while the session is idle (`ctx.isIdle() && !ctx.hasPendingMessages()`).
- Per-goal attempt cap + window, and a notification cooldown, to prevent recovery storms.
- Never resumes user-initiated pauses, `blocked` goals, budget-limited goals, or `maxAutonomousRuns=0`.

### Cost warnings

- A wake spends one model turn, consumes one autonomous run (`used++`), and **bypasses the wait's `remainingChecks`** (pi-goal-x's `claim()` sets `kind = "wake"` when signalled without decrementing the counter). Keep `waitStaleSeconds` generous.
- `/goal-resume` **resets** `scheduler.used`, i.e. it renews the `maxAutonomousRuns` allowance. That is why `autoResumeOtherSessions` is off by default.

## 中文说明

`pi-goal-x` 的外部看门狗，**不修改 pi-goal-x**，只用公开接口：读目标池文件判断状态 → 用 `pi.events.emit("pi-goal:wake", …)` 唤醒"纯事件等待" → 用 `pi.sendUserMessage("/goal-resume", { expandPromptTemplates: true })` 派发官方命令恢复 paused / 卡死的 goal。

- 新会话**默认开启**，状态栏显示 `dog: on`；`/goal-watchdog off` 只影响当前会话。
- `/goal-watchdog` 查看配置与巡检结果；`interval <秒>` 可改本会话巡检周期。
- 默认只动"本会话拥有且已 focus"的 goal；用户主动暂停（`stopReason: user`）、`blocked`、预算耗尽**永不**自动恢复。
- 注意成本：wake 会花一次模型回合并绕过 wait 的剩余检查次数；`/goal-resume` 会重置自动续跑额度。

## License

MIT
