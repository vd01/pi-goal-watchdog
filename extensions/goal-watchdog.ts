/**
 * goal-watchdog — pi-goal-x 的外部看门狗扩展（不修改 pi-goal-x 本体，升级不受影响）。
 *
 * 解决什么问题
 *   pi-goal-x 在若干"基础设施类"异常下会停下来，并且明确设计成**只有用户手工
 *   /goal-resume 才能继续**：
 *     - 上次自动执行被中断（进程被杀 / 回合中被打断）→ scheduler.restore() 直接 pause；
 *     - 自动续跑额度耗尽 / 需要 contract-repair 后仍无 disposition → pause；
 *     - wait 到期、wait 检查次数耗尽 → pause；
 *     - waiting 阶段但没有生产者信号、且没配 polling（纯事件等待）→ 一直等到 deadline 才 pause。
 *   它的定时器只在 Pi 进程内活着时生效（见 docs/advanced-usage.md），跨会话/关掉 Pi
 *   不会自愈；也不存在"paused 太久自动拉起来"的内置机制。
 *
 * 本扩展怎么做
 *   只读目标池文件判断状态，然后用两条**公开**通道恢复：
 *     1) waiting 卡住 → pi.events.emit("pi-goal:wake", { goalId, waitToken })
 *        （pi-goal-x 文档 advanced-usage.md 的 "Background producer integration" 通道）
 *     2) paused / active 卡死 → pi.sendUserMessage("/goal-resume", { expandPromptTemplates: true })
 *        （pi 公开 API：expandPromptTemplates 会派发已注册的扩展命令，见
 *          agent-session 的 _tryExecuteExtensionCommand；等价于用户敲 /goal-resume）
 *
 * 安全边界（默认保守）
 *   - 默认 enabled=true（新会话自动开启，无需 /goal-watchdog on），并在状态栏显示
 *     `dog: on` / `dog: on (n)` / `dog: off`（statusHint，默认开）。
 *   - 只处理"本会话拥有的 goal"（scheduler.owner === 当前 sessionId）或本来无主的 goal；
 *     别的会话拥有的 goal 只告警，不抢所有权。
 *   - 只处理"本会话显式 focus 的 goal"（读 session branch 里的 pi-goal-focus 条目），
 *     避免触发 pi-goal-x 的"请选择 goal"对话框。
 *   - 只在 ctx 空闲（无进行中的 run / 无排队消息）时动作。
 *   - 每个 goal 有尝试次数上限 + 窗口期 + 通知冷却，防止恢复风暴。
 *   - 明确不自动恢复的：stopReason==="user"（用户主动 Esc/暂停）、blocked（语义上等人裁决）、
 *     budget_limited、token 预算耗尽、maxAutonomousRuns=0。
 *   - 默认 autoWake=true / autoResume=true：
 *     基础设施类 paused / 长期失去续跑的 active goal 自动 /goal-resume；
 *     waiting 且无 polling、无生产者信号的 goal 自动发 pi-goal:wake。
 *     注意 wake 会花一次模型回合、消耗一次自动续跑额度，且绕过 wait 的 remainingChecks
 *     （pi-goal-x claim() 里 signalled → kind="wake" 不递减计数），阈值/次数上限因此偏保守。
 *     若你的常见故障是"进程被杀后重开会话"（此时 goal 的 scheduler.owner 是旧会话，
 *     本会话不算 owner），请再打开 autoResumeOtherSessions（wake 不支持跨会话，
 *     且 wake 只对本会话 focus 的 goal 生效）。
 *
 * 配置（后者覆盖前者）：内置默认 < $PI_CODING_AGENT_DIR|~/.pi/agent/pi-goal-watchdog.json
 *                    < <cwd>/.pi/pi-goal-watchdog.json < 环境变量
 *   环境变量：PI_GOAL_WATCHDOG=0|1, PI_GOAL_WATCHDOG_POLL_SECONDS（巡检周期，最小 10s），
 *            PI_GOAL_WATCHDOG_INTERVAL_SECONDS（同上的别名），
 *            PI_GOAL_WATCHDOG_AUTOWAKE=0|1, PI_GOAL_WATCHDOG_AUTORESUME=0|1
 *   常用键：pollSeconds（或 intervalSeconds/interval，巡检周期秒数，最小 10）、notify、statusHint、
 *          startupNotice、autoWake、autoResume、autoResumeOtherSessions、waitStaleSeconds、
 *          pausedStaleSeconds、activeIdleSeconds、maxAttemptsPerGoal、attemptWindowSeconds、
 *          notifyCooldownSeconds
 *
 * 命令：/goal-watchdog                 查看配置 + 立即巡检（只读）
 *      /goal-watchdog on|off          本会话开关（新会话自动恢复默认 on）
 *      /goal-watchdog interval <秒>   本会话巡检周期
 *      /goal-watchdog wake <goalId>   强制发一次 wake
 *      /goal-watchdog resume [goalId] 强制派发 /goal-resume
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TAG = "[goal-watchdog]";
const FOCUS_ENTRY = "pi-goal-focus";

// ───────────────────────────── 配置 ─────────────────────────────

interface WatchdogConfig {
	enabled: boolean;
	pollSeconds: number;
	notify: boolean;
	/** 在状态栏显示 dog: on/off （默认开，防止"忘了看门狗到底开没开"）。 */
	statusHint: boolean;
	/** 会话启动后额外发一条通知汇总当前开关（默认关，避免噪声）。 */
	startupNotice: boolean;
	autoWake: boolean;
	autoResume: boolean;
	/** 同 autoResume，但连"属于其他会话"的 paused goal 也接管（适合"进程被杀 + 重开会话"场景）。 */
	autoResumeOtherSessions: boolean;
	/** waiting 且"纯事件等待"（无 polling）多久算卡住。 */
	waitStaleSeconds: number;
	/** paused 多久算卡住。 */
	pausedStaleSeconds: number;
	/** active+autoContinue 但长时间无任何写入（疑似续跑丢失）多久算卡住。 */
	activeIdleSeconds: number;
	/** 同一 goal 在 attemptWindowSeconds 内最多自动动作几次。 */
	maxAttemptsPerGoal: number;
	attemptWindowSeconds: number;
	/** 同一问题的告警冷却。 */
	notifyCooldownSeconds: number;
}

const DEFAULTS: WatchdogConfig = {
	enabled: true,
	pollSeconds: 60,
	notify: true,
	statusHint: true,
	startupNotice: false,
	autoWake: true,
	autoResume: true,
	autoResumeOtherSessions: false,
	waitStaleSeconds: 3600,
	pausedStaleSeconds: 900,
	activeIdleSeconds: 3600,
	maxAttemptsPerGoal: 3,
	attemptWindowSeconds: 3600,
	notifyCooldownSeconds: 1800,
};

function readJsonFile(file: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function asBool(v: unknown): boolean | undefined {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") {
		if (/^(1|true|yes|on)$/i.test(v.trim())) return true;
		if (/^(0|false|no|off)$/i.test(v.trim())) return false;
	}
	return undefined;
}

function asPositiveInt(v: unknown, min = 1): number | undefined {
	const n = typeof v === "string" ? Number(v.trim()) : typeof v === "number" ? v : NaN;
	return Number.isSafeInteger(n) && n >= min ? n : undefined;
}

function loadWatchdogConfig(cwd: string): WatchdogConfig {
	const cfg: WatchdogConfig = { ...DEFAULTS };
	const apply = (raw: Record<string, unknown> | null): void => {
		if (!raw) return;
		const b = (k: string): void => {
			const v = asBool(raw[k]);
			if (v !== undefined) (cfg as unknown as Record<string, unknown>)[k] = v;
		};
		const n = (k: string, min = 1): void => {
			const v = asPositiveInt(raw[k], min);
			if (v !== undefined) (cfg as unknown as Record<string, unknown>)[k] = v;
		};
		for (const k of ["enabled", "notify", "statusHint", "startupNotice", "autoWake", "autoResume", "autoResumeOtherSessions"]) b(k);
		// 巡检周期：接受 pollSeconds 与 interval/intervalSeconds/interval_seconds 等价写法（最小 10s）。
		for (const k of ["pollSeconds", "interval", "intervalSeconds", "interval_seconds"]) n(k, 10);
		for (const k of ["interval", "intervalSeconds", "interval_seconds"]) {
			const v = asPositiveInt(raw[k], 10);
			if (v !== undefined) cfg.pollSeconds = v;
		}
		for (const k of ["waitStaleSeconds", "pausedStaleSeconds", "activeIdleSeconds", "maxAttemptsPerGoal", "attemptWindowSeconds", "notifyCooldownSeconds"]) n(k);
	};
	apply(readJsonFile(path.join(agentDir(), "pi-goal-watchdog.json")));
	apply(readJsonFile(path.join(cwd, ".pi", "pi-goal-watchdog.json")));
	const env = process.env;
	apply({
		enabled: env.PI_GOAL_WATCHDOG,
		pollSeconds: env.PI_GOAL_WATCHDOG_POLL_SECONDS ?? env.PI_GOAL_WATCHDOG_INTERVAL_SECONDS,
		autoWake: env.PI_GOAL_WATCHDOG_AUTOWAKE,
		autoResume: env.PI_GOAL_WATCHDOG_AUTORESUME,
		autoResumeOtherSessions: env.PI_GOAL_WATCHDOG_AUTORESUME_OTHER_SESSIONS,
		waitStaleSeconds: env.PI_GOAL_WATCHDOG_WAIT_STALE_SECONDS,
		pausedStaleSeconds: env.PI_GOAL_WATCHDOG_PAUSED_STALE_SECONDS,
	});
	return cfg;
}

// ─────────────────────── 只读目标池定位 / 解析 ───────────────────────

function projectSettingsFile(cwd: string): string {
	const override = process.env.PI_GOAL_SETTINGS_FILE;
	if (override) return path.isAbsolute(override) ? override : path.resolve(cwd, override);
	return path.join(cwd, ".pi", "pi-goal-x-settings.json");
}

function globalSettingsFile(): string {
	return process.env.PI_GOAL_GLOBAL_SETTINGS_FILE ?? path.join(agentDir(), "pi-goal-x-settings.json");
}

/** 与 pi-goal-x storage/goal-root.ts 的 goalsRoot 优先级保持一致：env > project > global > 默认。 */
function resolveGoalsRoot(cwd: string): string {
	const fromEnv = process.env.PI_GOAL_ROOT;
	if (fromEnv && fromEnv.trim()) return path.normalize(expandHome(fromEnv.trim()));
	for (const file of [projectSettingsFile(cwd), globalSettingsFile()]) {
		const value = readJsonFile(file)?.goalsRoot;
		if (typeof value === "string" && value.trim()) return path.normalize(expandHome(value.trim()));
	}
	return path.resolve(cwd, ".pi", "goals");
}

function snapshotPathFor(root: string, cwd: string): string {
	return root === path.resolve(cwd, ".pi", "goals")
		? path.join(path.dirname(root), ".goals-pool-snapshot.json")
		: path.join(root, ".metadata", ".goals-pool-snapshot.json");
}

/** 取文件开头那个 JSON 对象的结束位置（goal 文件 = JSON 元数据 + markdown 正文）。 */
function findJsonObjectEnd(text: string): number {
	let depth = 0;
	let started = false;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (!started) {
			if (ch === "{") {
				started = true;
				depth = 1;
			} else if (!/\s/.test(ch)) return -1;
			continue;
		}
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return i;
	}
	return -1;
}

interface WaitView {
	id?: string;
	token?: string;
	deadlineMs?: number;
	intervalMs?: number;
	nextCheckAtMs?: number;
	remainingChecks?: number;
	signalled?: boolean;
}

interface GoalView {
	id: string;
	status: string;
	autoContinue: boolean;
	updatedMs: number;
	fileMtimeMs: number;
	pauseReason?: string;
	pauseSuggestedAction?: string;
	stopReason?: string;
	owner?: string;
	phase?: string;
	wait?: WaitView;
	activePath?: string;
}

function toGoalView(raw: Record<string, unknown>, fallbackMs: number, activePath?: string): GoalView | null {
	const id = typeof raw.id === "string" ? raw.id : null;
	if (!id) return null;
	const scheduler = (raw.scheduler ?? null) as Record<string, unknown> | null;
	const rawWait = (scheduler?.wait ?? null) as Record<string, unknown> | null;
	const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
	const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
	const updated = Date.parse(String(raw.updatedAt ?? ""));
	return {
		id,
		status: typeof raw.status === "string" ? raw.status : "unknown",
		autoContinue: raw.autoContinue === true,
		updatedMs: Number.isFinite(updated) ? updated : fallbackMs,
		fileMtimeMs: fallbackMs,
		pauseReason: str(raw.pauseReason),
		pauseSuggestedAction: str(raw.pauseSuggestedAction),
		stopReason: str(raw.stopReason),
		owner: str(scheduler?.owner),
		phase: str(scheduler?.phase),
		wait: rawWait
			? {
				id: str(rawWait.id),
				token: str(rawWait.token),
				deadlineMs: num(rawWait.deadline),
				intervalMs: num(rawWait.intervalMs),
				nextCheckAtMs: num(rawWait.nextCheckAt),
				remainingChecks: num(rawWait.remainingChecks),
				signalled: rawWait.signalled === true,
			}
			: undefined,
		activePath,
	};
}

/** 只读扫描目标池（goal 文件优先；目录读不到时回退 pool snapshot）。 */
function readGoalViews(root: string, cwd: string): GoalView[] {
	const views: GoalView[] = [];
	let names: string[] = [];
	try {
		names = fs.readdirSync(root);
	} catch {
		names = [];
	}
	for (const name of names) {
		if (!/^active_goal_.*\.md$/.test(name)) continue;
		const file = path.join(root, name);
		let text: string;
		let mtimeMs = Date.now();
		try {
			mtimeMs = fs.statSync(file).mtimeMs;
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const end = findJsonObjectEnd(text);
		if (end < 0) continue;
		let raw: Record<string, unknown>;
		try {
			raw = JSON.parse(text.slice(0, end + 1)) as Record<string, unknown>;
		} catch {
			continue;
		}
		const view = toGoalView(raw, mtimeMs, path.posix.join(".pi/goals", name));
		if (view) views.push(view);
	}
	if (views.length > 0) return views;
	const snapshot = readJsonFile(snapshotPathFor(root, cwd));
	const goals = Array.isArray(snapshot?.goals) ? (snapshot!.goals as unknown[]) : [];
	for (const entry of goals) {
		if (!entry || typeof entry !== "object") continue;
		const view = toGoalView(entry as Record<string, unknown>, Date.now(), (entry as Record<string, unknown>).activePath as string | undefined);
		if (view && view.status !== "complete") views.push(view);
	}
	return views;
}

/** pi-goal-x 把本会话的 focus 写进 session branch 的 custom entry（appendEntry）。 */
function readFocusedGoalId(ctx: ExtensionContext): string | null {
	try {
		const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			if (entry.type !== "custom" || entry.customType !== FOCUS_ENTRY) continue;
			const data = entry.data as Record<string, unknown> | null;
			if (!data || data.version !== 1) continue;
			return typeof data.focusedGoalId === "string" && data.focusedGoalId.trim() ? data.focusedGoalId : null;
		}
	} catch {
		// 读不到就当没有 focus。
	}
	return null;
}

// ───────────────────────────── 判定 ─────────────────────────────

type ActionKind = "none" | "notify" | "wake" | "resume";

interface Decision {
	kind: ActionKind;
	key: string;
	message: string;
	severity: "info" | "warning";
}

/** 这些 pause 是"基础设施问题"，不是用户决策，可以安全重试。 */
const RECOVERABLE_PAUSE_PATTERNS = [
	"Previous autonomous execution was interrupted",
	"Autonomous-run allowance exhausted",
	"No execution disposition after the contract-repair prompt",
	"Wait deadline reached",
	"Wait check allowance exhausted",
	"Goal wake stopped",
	"Goal checkpoint delivery failed",
];

/** 这些即使看起来可恢复也不自动碰。 */
const NON_RECOVERABLE_PAUSE_PATTERNS = [
	"Goal token budget exhausted",
	"Automatic continuation disabled by maxAutonomousRuns=0",
];

function matchesAny(reason: string | undefined, patterns: readonly string[]): boolean {
	if (!reason) return false;
	return patterns.some((p) => reason.startsWith(p));
}

function decide(goal: GoalView, cfg: WatchdogConfig, now: number, sessionId: string | undefined, focusedId: string | null): Decision {
	const idleMs = Math.max(0, now - goal.updatedMs); // updatedAt 由 pi-goal-x 每次状态写入刷新，是可靠的"最后状态变化"时间
	const owned = !goal.owner || goal.owner === sessionId;
	const focused = focusedId === goal.id;
	const ownedNote = owned ? "" : `（属于其他会话 ${goal.owner?.slice(0, 8) ?? "?"}…，只告警不接管）`;

	if (goal.status === "active" && goal.autoContinue) {
		const wait = goal.wait;
		if (goal.phase === "waiting" && wait) {
			// 1) 纯事件等待：没有 polling 也没有 signal —— 只有外部生产者能唤醒它，
			//    卡住就是"生产者死了/没注册 token"，这是 wake 的正当用途。
			if (!wait.intervalMs && !wait.signalled) {
				if (idleMs < cfg.waitStaleSeconds * 1000) return { kind: "none", key: "waiting-ok", message: "", severity: "info" };
				if (!cfg.notify && !cfg.autoWake) return { kind: "none", key: "waiting-off", message: "", severity: "info" };
				if (wait.deadlineMs && wait.deadlineMs <= now) {
					return { kind: "notify", key: `wait-expired:${goal.id}`, severity: "warning", message: `goal ${goal.id} 的 wait 已过 deadline 仍未 pause，说明 pi-goal-x 定时器可能没在跑；建议 /goal-resume 或 /goal-refresh。` };
				}
				if (cfg.autoWake && owned && focused) {
					return { kind: "wake", key: `wake:${goal.id}`, severity: "warning", message: `goal ${goal.id} 纯事件等待已 ${Math.round(idleMs / 60000)} 分钟无信号，发送 pi-goal:wake 触发一次检查。` };
				}
				// pi-goal-x 的 signal() 只作用于本会话 focus 的 goal（它读 core.state.goal），
				// 所以未 focus 时 wake 是无效信号，只能提醒先 focus。
				const wakeHint = owned && !focused
					? `需先 /goal-focus ${goal.id} 才能 wake（信号只作用于本会话 focus 的 goal）`
					: `可 /goal-watchdog wake ${goal.id} 或 /goal-resume`;
				return { kind: "notify", key: `wait-stale:${goal.id}`, severity: "warning", message: `goal ${goal.id} 处于 waiting 且无生产者信号已 ${Math.round(idleMs / 60000)} 分钟${ownedNote}；${wakeHint}。` };
			}
			// 2) 有 polling 的等待：pi-goal-x 自己会按时 check。只有明显"过期很久"才说明定时器死了。
			if (wait.intervalMs) {
				const dueAt = wait.nextCheckAtMs ?? goal.updatedMs;
				const overdueMs = now - dueAt;
				if (overdueMs > Math.max(3 * wait.intervalMs, cfg.waitStaleSeconds * 1000)) {
					return { kind: "notify", key: `poll-overdue:${goal.id}`, severity: "warning", message: `goal ${goal.id} 的 wait 轮询已逾期 ${Math.round(overdueMs / 60000)} 分钟（interval ${Math.round(wait.intervalMs / 1000)}s），疑似扩展定时器停止；建议 /goal-refresh 或 /goal-resume。` };
				}
				return { kind: "none", key: "waiting-poll-ok", message: "", severity: "info" };
			}
			return { kind: "none", key: "waiting-ok", message: "", severity: "info" };
		}
		// 3) active 但既没在跑也没在等，且长时间无写入 → 续跑链接丢失，re-kick 一次。
		if (idleMs >= cfg.activeIdleSeconds * 1000) {
			if (cfg.autoResume && (owned || cfg.autoResumeOtherSessions) && focused) {
				return { kind: "resume", key: `re-kick:${goal.id}`, severity: "warning", message: `goal ${goal.id} 处于 active 但 ${Math.round(idleMs / 60000)} 分钟无活动（phase=${goal.phase ?? "none"}），重新拉起（/goal-resume）。` };
			}
			return { kind: "notify", key: `active-idle:${goal.id}`, severity: "warning", message: `goal ${goal.id} 处于 active 但 ${Math.round(idleMs / 60000)} 分钟无活动${ownedNote}；可 /goal-resume 重新拉起。` };
		}
		return { kind: "none", key: "active-ok", message: "", severity: "info" };
	}

	if (goal.status === "paused") {
		if (goal.stopReason === "user") return { kind: "none", key: "user-pause", message: "", severity: "info" };
		if (matchesAny(goal.pauseReason, NON_RECOVERABLE_PAUSE_PATTERNS)) {
			return { kind: "notify", key: `nonrecoverable:${goal.id}`, severity: "warning", message: `goal ${goal.id} 因 ${goal.pauseReason} 暂停，需要人工处理（改预算 / 改 maxAutonomousRuns）后再 /goal-resume。` };
		}
		const recoverable = matchesAny(goal.pauseReason, RECOVERABLE_PAUSE_PATTERNS);
		const humanDecision = Boolean(goal.pauseSuggestedAction) || !recoverable;
		if (idleMs < cfg.pausedStaleSeconds * 1000) return { kind: "none", key: "paused-fresh", message: "", severity: "info" };
		if (humanDecision) {
			return { kind: "notify", key: `paused-manual:${goal.id}`, severity: "warning", message: `goal ${goal.id} 已 paused ${Math.round(idleMs / 60000)} 分钟${goal.pauseSuggestedAction ? "（agent 留了建议，等你决定）" : ""}：${(goal.pauseReason ?? "无原因").slice(0, 160)}` };
		}
		if (cfg.autoResume && (owned || cfg.autoResumeOtherSessions) && focused) {
			return { kind: "resume", key: `resume:${goal.id}`, severity: "warning", message: `goal ${goal.id} 因基础设施原因 paused ${Math.round(idleMs / 60000)} 分钟：${(goal.pauseReason ?? "").slice(0, 120)} → 自动 /goal-resume。` };
		}
		const flagHint = owned ? "（或打开 autoResume）" : "（或打开 autoResumeOtherSessions 自动接管其他会话的 paused goal）";
		return { kind: "notify", key: `paused-stale:${goal.id}`, severity: "warning", message: `goal ${goal.id} 因基础设施原因 paused ${Math.round(idleMs / 60000)} 分钟${ownedNote}；可 /goal-resume 恢复${flagHint}。` };
	}

	if (goal.status === "blocked") {
		return { kind: "notify", key: `blocked:${goal.id}`, severity: "warning", message: `goal ${goal.id} 处于 blocked，需要你裁决：${(goal.pauseReason ?? "无说明").slice(0, 160)}` };
	}
	if (goal.status === "budget_limited") {
		return { kind: "notify", key: `budget:${goal.id}`, severity: "warning", message: `goal ${goal.id} 因 token 预算耗尽停止；需 /goal-tweak 调整预算。` };
	}
	return { kind: "none", key: `other:${goal.id}`, message: "", severity: "info" };
}

// ───────────────────────────── 扩展本体 ─────────────────────────────

export default function goalWatchdogExtension(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let sessionEnabled: boolean | undefined;
	let sessionInterval: number | undefined;
	const attempts = new Map<string, number[]>();
	const lastNotify = new Map<string, number>();
	let lastReport: string[] = [];
	let running = false;

	const currentConfig = (ctx: ExtensionContext): WatchdogConfig => {
		const cfg = loadWatchdogConfig(ctx.cwd);
		if (sessionEnabled !== undefined) cfg.enabled = sessionEnabled; // /goal-watchdog on|off 的会话级覆盖
		if (sessionInterval !== undefined) cfg.pollSeconds = sessionInterval; // /goal-watchdog interval <秒>
		return cfg;
	};

	function noteAttempt(goalId: string, now: number): void {
		const list = (attempts.get(goalId) ?? []).filter((t) => now - t < 3_600_000);
		list.push(now);
		attempts.set(goalId, list);
	}

	function attemptsAllowed(goalId: string, cfg: WatchdogConfig, now: number): boolean {
		const list = (attempts.get(goalId) ?? []).filter((t) => now - t < cfg.attemptWindowSeconds * 1000);
		attempts.set(goalId, list);
		return list.length < cfg.maxAttemptsPerGoal;
	}

	function notifyOnce(ctx: ExtensionContext, cfg: WatchdogConfig, key: string, message: string, severity: "info" | "warning", now: number): boolean {
		const last = lastNotify.get(key) ?? 0;
		if (now - last < cfg.notifyCooldownSeconds * 1000) return false;
		lastNotify.set(key, now);
		ctx.ui.notify(`${TAG} ${message}`, severity);
		return true;
	}

	function idleAndFree(ctx: ExtensionContext): boolean {
		try {
			return ctx.isIdle() && !ctx.hasPendingMessages();
		} catch {
			return false;
		}
	}

	const STATUS_KEY = "goal-watchdog";

	/** 状态栏可见性：dog: on / dog: on (n) / dog: off —— 新会话无需"记得开关"也能看到。 */
	function setStatusHint(ctx: ExtensionContext, cfg: WatchdogConfig, flagged = 0): void {
		if (!cfg.statusHint) return;
		try {
			if (!ctx.hasUI) return;
			ctx.ui.setStatus(STATUS_KEY, cfg.enabled ? (flagged > 0 ? `dog: on (${flagged})` : "dog: on") : "dog: off");
		} catch {
			// 状态栏失败不影响功能。
		}
	}

	function clearStatusHint(ctx: ExtensionContext): void {
		try {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// ignore
		}
	}

	async function tick(ctx: ExtensionContext, opts: { force?: boolean; act?: boolean } = {}): Promise<string[]> {
		if (running) return lastReport;
		running = true;
		try {
			const cfg = currentConfig(ctx);
			const act = opts.act !== false;
			if (!cfg.enabled && !opts.force) {
				setStatusHint(ctx, cfg);
				return lastReport;
			}
			const now = Date.now();
			const sessionId = (() => {
				try {
					return ctx.sessionManager.getSessionId();
				} catch {
					return undefined;
				}
			})();
			const focusedId = readFocusedGoalId(ctx);
			const root = resolveGoalsRoot(ctx.cwd);
			const goals = readGoalViews(root, ctx.cwd);
			const report: string[] = [
				`巡检 ${new Date(now).toISOString()} · 池 ${root} · 本会话 focus=${focusedId ?? "(无)"}`,
				`配置 enabled=${cfg.enabled} statusHint=${cfg.statusHint} notify=${cfg.notify} autoWake=${cfg.autoWake} autoResume=${cfg.autoResume} resumeOther=${cfg.autoResumeOtherSessions} poll=${cfg.pollSeconds}s stale(wait/paused/active)=${cfg.waitStaleSeconds}/${cfg.pausedStaleSeconds}/${cfg.activeIdleSeconds}s`,
				`命令：/goal-watchdog on|off | interval <秒> | wake <goalId> | resume <goalId>`
			];
			if (goals.length === 0) report.push("池内没有 open goal。");
			let flagged = 0;

			for (const goal of goals) {
				const decision = decide(goal, cfg, now, sessionId, focusedId);
				const age = Math.round((now - goal.updatedMs) / 60000);
				report.push(`  - ${goal.id} [${goal.status}${goal.autoContinue ? "+auto" : ""}${goal.phase ? "/" + goal.phase : ""}] idle ${age}m → ${decision.kind}`);
				if (decision.kind !== "none") flagged++;
				if (!act || decision.kind === "none") continue;

				if (decision.kind === "notify") {
					if (cfg.notify) notifyOnce(ctx, cfg, decision.key, decision.message, decision.severity, now);
					continue;
				}
				// wake / resume 需要空闲，避免插进进行中的 run。
				if (!idleAndFree(ctx)) {
					report.push(`      （非空闲，跳过 ${decision.kind}，下轮重试）`);
					continue;
				}
				if (!attemptsAllowed(goal.id, cfg, now)) {
					if (cfg.notify) notifyOnce(ctx, cfg, `${decision.key}:capped`, `goal ${goal.id} 自动恢复次数已达上限（${cfg.maxAttemptsPerGoal}/${Math.round(cfg.attemptWindowSeconds / 60)}min），需要人工介入。`, "warning", now);
					continue;
				}
				if (decision.kind === "wake") {
					const token = goal.wait?.token;
					if (!token) {
						report.push("      （没有 waitToken，无法 wake）");
						continue;
					}
					noteAttempt(goal.id, now);
					pi.events.emit("pi-goal:wake", { goalId: goal.id, waitToken: token });
					report.push(`      → emitted pi-goal:wake token=${token.slice(0, 8)}…`);
					ctx.ui.notify(`${TAG} ${decision.message}`, "info");
					continue;
				}
				// resume：走 pi 公开的命令派发通道，等价于用户敲 /goal-resume。
				noteAttempt(goal.id, now);
				pi.sendUserMessage("/goal-resume", { expandPromptTemplates: true });
				report.push("      → dispatched /goal-resume");
				ctx.ui.notify(`${TAG} ${decision.message}`, "info");
			}
			lastReport = report;
			setStatusHint(ctx, cfg, flagged);
			return report;
		} finally {
			running = false;
		}
	}

	function startTimer(ctx: ExtensionContext): void {
		stopTimer();
		const cfg = currentConfig(ctx);
		setStatusHint(ctx, cfg);
		if (!cfg.enabled) return;
		const interval = Math.max(10, cfg.pollSeconds) * 1000;
		timer = setInterval(() => {
			void tick(ctx).catch(() => {});
		}, interval);
		timer.unref?.();
		// 启动后先给 pi-goal-x 一点时间完成 restore，再巡检一次。
		const kick = setTimeout(() => {
			const c = currentConfig(ctx);
			if (c.startupNotice && c.notify) {
				ctx.ui.notify(`${TAG} 已自动开启（新会话默认 on）：autoWake=${c.autoWake} autoResume=${c.autoResume} resumeOther=${c.autoResumeOtherSessions} poll=${c.pollSeconds}s。用 /goal-watchdog 查看，off 只影响本会话。`, "info");
			}
			void tick(ctx).catch(() => {});
		}, 5_000);
		kick.unref?.();
	}

	function stopTimer(): void {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionEnabled = undefined;
		sessionInterval = undefined;
		attempts.clear();
		lastNotify.clear();
		startTimer(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		clearStatusHint(ctx);
	});

	// 每个回合收尾后顺手看一眼（paused 往往就是这时产生的），主要巡检仍由定时器负责。
	pi.on("agent_settled", async (_event, ctx) => {
		const cfg = currentConfig(ctx);
		if (!cfg.enabled || !cfg.notify || !cfg.autoResume) return;
		void tick(ctx).catch(() => {});
	});

	pi.registerCommand("goal-watchdog", {
		description: "pi-goal-x 看门狗：巡检并（可选）自动恢复长期 paused/waiting 的 goal",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [sub = "check", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "on" || sub === "off") {
				sessionEnabled = sub === "on";
				ctx.ui.notify(`${TAG} 本会话看门狗已${sub === "on" ? "开启" : "关闭"}（新会话自动恢复默认 on）。`, "info");
				if (sessionEnabled) startTimer(ctx);
				else {
					stopTimer();
					setStatusHint(ctx, currentConfig(ctx));
				}
				return;
			}
			if (sub === "interval" || sub === "intervalSeconds" || sub === "poll") {
				const seconds = Number.parseInt(rest[0] ?? "", 10);
				if (!Number.isSafeInteger(seconds) || seconds < 10) {
					ctx.ui.notify(`${TAG} 用法：/goal-watchdog interval <秒>（最小 10）。当前 ${loadWatchdogConfig(ctx.cwd).pollSeconds}s；持久化请写 .pi/pi-goal-watchdog.json 的 pollSeconds。`, "warning");
					return;
				}
				sessionInterval = seconds;
				startTimer(ctx);
				ctx.ui.notify(`${TAG} 本会话巡检周期改为 ${seconds}s（持久化请写 .pi/pi-goal-watchdog.json 的 pollSeconds/intervalSeconds）。`, "info");
				return;
			}
			if (sub === "wake" || sub === "resume") {
				const target = rest[0];
				const goals = readGoalViews(resolveGoalsRoot(ctx.cwd), ctx.cwd);
				const goal = target ? goals.find((g) => g.id === target) : goals.find((g) => g.status === "active" && g.phase === "waiting");
				if (!goal) {
					ctx.ui.notify(`${TAG} 找不到目标 goal${target ? ` ${target}` : ""}。`, "warning");
					return;
				}
				if (!idleAndFree(ctx)) {
					ctx.ui.notify(`${TAG} 会话非空闲，稍后再试。`, "warning");
					return;
				}
				if (sub === "wake") {
					const token = goal.wait?.token;
					if (!token) {
						ctx.ui.notify(`${TAG} goal ${goal.id} 没有 waitToken，无法 wake。`, "warning");
						return;
					}
					pi.events.emit("pi-goal:wake", { goalId: goal.id, waitToken: token });
					ctx.ui.notify(`${TAG} 已发送 pi-goal:wake（goal ${goal.id}，token ${token.slice(0, 8)}…）。`, "info");
					return;
				}
				const focusedId = readFocusedGoalId(ctx);
				if (focusedId !== goal.id) {
					ctx.ui.notify(`${TAG} goal ${goal.id} 不是本会话 focus（focus=${focusedId ?? "无"}），先 /goal-focus 再 resume，避免弹选择框。`, "warning");
					return;
				}
				pi.sendUserMessage("/goal-resume", { expandPromptTemplates: true });
				ctx.ui.notify(`${TAG} 已派发 /goal-resume（goal ${goal.id}）。`, "info");
				return;
			}
			const report = await tick(ctx, { force: true });
			ctx.ui.notify(report.join("\n"), "info");
		},
	});
}
