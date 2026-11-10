import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { loadPersistedSettings, registerExpertPanelHttp } from "./http-api.js";

export const name = "expert-panel";
export const inject = ["tools", "subagents", "systemPrompt"];

/**
 * Declaring `Config` is what gives this bundle a real settings page: DSH
 * projects this schema into a settings form and validates the row's `config`
 * at activation. Every tunable lives here so the whole plugin is configurable
 * from the UI without hand-editing YAML.
 *
 * Each call builds a fresh object schema: schemastery schemas are mutable, so
 * sharing one instance between `.required()`, an array item, and an optional
 * field would leak the required-ness across all three.
 */
const expertEntry = () =>
  z.object({
    label: z.string().description("显示名称（面板与审批卡片里用这个名字）"),
    provider: z.string().required().description("provider id，例如 magpie"),
    model: z.string().required().description("模型 id，例如 ctyun/qoder-cn/qmodel_38max"),
    reasoningEffort: z.string().description("推理档位；留空则用该路由默认档（该路由不支持时会拒绝显式档位）"),
  });

/**
 * An all-optional entry for fields a user may legitimately leave out.
 * schemastery descends into an absent object and still demands its required
 * inner keys, so an optional field must not reuse the strict shape above —
 * otherwise omitting it rejects the whole config and the plugin fails to load.
 */
const optionalExpertEntry = () =>
  z.object({
    label: z.string().description("显示名称；留空则取专家库第一位"),
    provider: z.string().description("provider id，例如 magpie"),
    model: z.string().description("模型 id"),
    reasoningEffort: z.string().description("推理档位；留空则用该路由默认档"),
  });

export const Config = z.object({
  finalExpert: expertEntry()
    .default({
      label: "Gemini 4 Argon（终裁）",
      provider: "magpie",
      model: "ctyun/auto/gemini-4-argon",
      reasoningEffort: "high",
    })
    .description("终裁专家：最贵，只在专家团收敛不了时出场"),
  panelists: z.array(expertEntry()).default([]).description("① 独立取证专家：≥1 位并行只读诊断，各自产出独立报告"),
  reviewer: optionalExpertEntry().description("② 互审官：逐条挑刺、裁决分歧、收敛方案；留空则取第一位取证专家"),
  enableArbiter: z.boolean().default(true).description("③ 是否启用终裁定稿（关闭则只跑前两轮）"),
  workerModel: optionalExpertEntry().description("日常主力施工模型（专家下发指派单后负责落地）；留空则不切换"),

  requireApproval: z.boolean().default(true).description("主力模型主动申请时是否弹审批卡片"),
  maxStepsPerExpert: z.number().step(1).min(4).default(30).description("单次专家运行最大步数预算；到限后强制收尾交回主模型，防卡死"),
  expertTimeoutSeconds: z.number().step(1).min(60).default(1800).description("单次专家运行有效工作时长上限（秒，不含工具执行等待）；超时自动收尾并提取阶段性结论"),
});

const TOOL_NAME = "consult_expert_panel";
const COMMAND_NAME = "expert";
const LEGACY_COMMAND_NAME = "argon";
const SECTION_NAME = `tool:${TOOL_NAME}`;
const SECTION_ORDER = 2850; // right after TOOL_SUBAGENT (2800)

/** Prefix the client panel filters subagent catalog rows by. Keep in sync with client.js. */
const RUN_LABEL_PREFIX = "⚡专家团";

const CATEGORY_LABELS = {
  stuck_bug: "疑难杂症 / 连续修复失败根因定位",
  architecture: "跨模块复杂架构设计 / 高风险重构",
  multimodal_ui: "多模态视觉诊断 / 复杂 UI 与图形审计",
  algorithm_security: "硬核算法 / 并发竞态 / 安全边界审计",
  red_team_review: "重大变更落地前红队挑刺终审",
  followup: "针对前序专家诊断的多轮追问与复核",
};

/** 唯一流程：多轮评审。三个固定阶段，不再有「单专家 / 原地接管」等旁路模式。 */
const REVIEW_STAGES = [
  { id: "draft", index: 1, label: "独立取证", desc: "多位专家并行只读诊断，各自产出独立报告" },
  { id: "review", index: 2, label: "交叉互审", desc: "互审官逐条挑刺、裁决分歧、收敛方案" },
  { id: "arbiter", index: 3, label: "终裁定稿", desc: "终裁专家最终把关并下发《裁决与后续工作部署指派单》" },
];

const TIER_LABELS = {
  review: "多轮评审（① 独立取证 → ② 交叉互审 → ③ 终裁定稿）",
  review_no_arbiter: "多轮评审（① 独立取证 → ② 交叉互审）",
  followup: "专家多轮追问（唤醒已有专家子会话继续深挖）",
};

const DELEGATION_DENY_CANDIDATES = [
  TOOL_NAME,
  "consult_argon_specialist",
  "subagent",
  "subagent_fork",
  "workflow",
  "ralph",
  "spawn_teammate",
];

const WRITE_DENY_CANDIDATES = ["write", "edit", "create_worktree"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeExpert(raw, fallbackLabel) {
  if (typeof raw !== "object" || raw === null) return undefined;
  if (!isNonEmptyString(raw.provider) || !isNonEmptyString(raw.model)) return undefined;
  return {
    label: isNonEmptyString(raw.label) ? raw.label.trim() : fallbackLabel,
    provider: raw.provider.trim(),
    model: raw.model.trim(),
    ...(isNonEmptyString(raw.reasoningEffort) ? { reasoningEffort: raw.reasoningEffort.trim() } : {}),
  };
}

function normalizeConfig(raw = {}) {
  const cfg = typeof raw === "object" && raw !== null ? raw : {};

  const finalExpert = normalizeExpert(cfg.finalExpert, "终裁专家") ?? {
    label: "Gemini 4 Argon（终裁）",
    provider: "magpie",
    model: "ctyun/antigravity/gemini-4-argon",
    reasoningEffort: "high",
  };

  const panelists = Array.isArray(cfg.panelists)
    ? cfg.panelists
        .map((entry, index) => normalizeExpert(entry, `专家 ${index + 1}`))
        .filter((entry) => entry !== undefined)
    : [finalExpert];

  const reviewer = normalizeExpert(cfg.reviewer, undefined) ?? panelists[0] ?? finalExpert;

  return {
    finalExpert,
    workerModel: normalizeExpert(cfg.workerModel, "日常主力") ?? {
      label: "DeepSeek V4.1 Flash",
      provider: "magpie",
      model: "ctyun/auto/deepseek-v4.1-flash",
    },
    panelists: panelists.length > 0 ? panelists : [finalExpert],
    reviewer,
    // 并行取证数 = 已启用专家数（单一事实源），不再单列配置项
    maxPanelists: panelists.length > 0 ? panelists.length : 1,
    // 多轮评审是唯一流程：交叉互审恒开启，不再有单专家 / 原地接管等旁路模式。
    crossReview: true,
    enableArbiter: cfg.enableArbiter !== false,
    // 上下文模式固定为 digest；fork 只保留给显式 --fork 与追问场景
    defaultContextMode: "digest",
    requireApproval: cfg.requireApproval !== false,
    approvalTimeoutSeconds: 240,
    maxDigestEvents: 16,
    maxStepsPerExpert: Number.isInteger(cfg.maxStepsPerExpert) && cfg.maxStepsPerExpert >= 4 ? cfg.maxStepsPerExpert : 30,
    expertTimeoutSeconds:
      Number.isInteger(cfg.expertTimeoutSeconds) && cfg.expertTimeoutSeconds >= 60 ? cfg.expertTimeoutSeconds : 1800,
  };
}

function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return value;
}

function createWakingUserMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

function createRelayMessage({ senderSessionId, senderName, text }) {
  const header = senderName ? `Team message from ${senderName}:` : `Agent ${senderSessionId} sent a message: `;
  return deepFreeze({
    id: randomUUID(),
    role: "user",
    content: [
      { type: "text", text: header },
      { type: "text", text },
    ],
    source: {
      kind: "agent-message",
      form: "relay",
      senderSessionId,
      ...(senderName ? { senderName } : {}),
    },
  });
}

function truncateText(text, maxChars = 600) {
  if (typeof text !== "string") return "";
  const cleaned = text.trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}… [截断 ${cleaned.length - maxChars} 字]`;
}

function truncateSimple(text, maxChars = 200) {
  if (typeof text !== "string") return "";
  const cleaned = text.trim();
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 1)}…`;
}

function extractTextFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function firstMeaningfulParagraph(text) {
  if (typeof text !== "string") return "";
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("---") && !line.startsWith("|"));
  return lines.slice(0, 2).join(" ") || text.trim();
}

/**
 * Compact, high-signal digest of recent session activity so experts see both
 * recent completed turns and the in-flight turn without burning quota on the
 * whole raw log.
 */
function buildLiveSessionDigest(session, maxItems = 16) {
  if (!session || typeof session.snapshotEvents !== "function") return "（无法读取当前会话历史摘要）";
  const events = session.snapshotEvents();
  const items = [];

  for (let i = events.length - 1; i >= 0 && items.length < maxItems; i--) {
    const ev = events[i];
    if (!ev || typeof ev !== "object") continue;

    if (ev.type === "user/message") {
      const msg = ev.data;
      const sourceKind = msg?.source?.kind ?? "";
      if (
        sourceKind === "runtime-context" ||
        sourceKind === "model-selection" ||
        sourceKind === "user-approval" ||
        sourceKind === "time-context" ||
        sourceKind.startsWith("plugin:")
      ) {
        continue;
      }
      const text = extractTextFromBlocks(msg?.content);
      if (!text || text.startsWith("<system-reminder>") || text.startsWith("<hindsight_")) continue;
      const tag = sourceKind === "agent-message" || sourceKind === "team-message"
        ? `队友/子代理消息 (seq ${ev.seq})`
        : `用户 (seq ${ev.seq})`;
      items.push(`[${tag}]：${truncateText(text, 500)}`);
    } else if (ev.type === "assistant/message") {
      const msg = ev.data?.message;
      const text = extractTextFromBlocks(msg?.content);
      const toolCalls = Array.isArray(msg?.content)
        ? msg.content.filter((b) => b && b.type === "tool-call" && b.name !== TOOL_NAME).map((b) => b.name)
        : [];
      if (!text && toolCalls.length === 0) continue;
      const modelTag = msg?.source?.model ? ` (${msg.source.model})` : "";
      const toolNote = toolCalls.length > 0 ? ` [调用工具: ${toolCalls.join(", ")}]` : "";
      items.push(`[助手${modelTag} (seq ${ev.seq})]${toolNote}：${truncateText(text || "(仅工具调用)", 500)}`);
    } else if (ev.type === "tool/result") {
      const isErr = ev.data?.message?.isError === true || ev.data?.error !== undefined;
      if (!isErr) continue;
      const errText = extractTextFromBlocks(ev.data?.message?.content) || ev.data?.error?.message || "unknown error";
      items.push(`[工具报错 (seq ${ev.seq})]：${truncateText(errText, 450)}`);
    }
  }

  if (items.length === 0) return "（当前会话尚无有效的历史交互记录）";
  return items.reverse().join("\n\n");
}

/**
 * Summarize existing Agent Team members and shared tasks so the expert has
 * full situational awareness of what teammates (e.g. ai-analyst, capsis-fixer)
 * have already investigated or completed.
 */
function resolveRootAgent(ctx, agent) {
  if (!agent) return undefined;
  const agents = ctx.get("agents");
  if (!agents) return agent;
  const roots = agents.roots();
  if (roots.includes(agent)) return agent;

  let current = agent;
  const visited = new Set([agent.id]);
  while (current?.session?.header?.parentSession) {
    const parentId = current.session.header.parentSession;
    if (visited.has(parentId)) break;
    visited.add(parentId);
    const parent = agents.get(parentId);
    if (!parent) break;
    if (roots.includes(parent)) return parent;
    current = parent;
  }
  return roots[0] ?? agent;
}

/** Bound the approval wait so a missed card can never hang the turn forever. */
async function askWithTimeout(userQuestions, request, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { kind: "answer", answer: await userQuestions.ask(request) };
  }
  const outer = request.signal;
  if (outer?.aborted === true) throw outer.reason ?? new Error("approval aborted");
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outer?.reason ?? new Error("approval aborted"));
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("expert panel approval timed out")), timeoutMs);
  try {
    return { kind: "answer", answer: await userQuestions.ask({ ...request, signal: controller.signal }) };
  } catch (error) {
    if (outer?.aborted !== true && controller.signal.aborted) return { kind: "timeout" };
    throw error;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

function routeOf(expert) {
  return `${expert.provider}/${expert.model}`;
}

function rosterLines(config) {
  const lines = config.panelists.map(
    (expert, index) =>
      `${index + 1}. ${expert.label} — \`${routeOf(expert)}\`` +
      (expert.reasoningEffort ? ` (effort: ${expert.reasoningEffort})` : ""),
  );
  lines.push(
    `★ 终裁：${config.finalExpert.label} — \`${routeOf(config.finalExpert)}\`` +
      (config.finalExpert.reasoningEffort ? ` (effort: ${config.finalExpert.reasoningEffort})` : ""),
  );
  return lines;
}

/**
 * The live DSH model catalog across all registered providers, as selectable experts.
 * Catalog routes carry no reasoningEffort on purpose: a route that declares no
 * `reasoningEfforts` rejects an explicit effort in `llm.resolveCallConfig`, so
 * the adapter default (its highest tier) applies instead.
 */
async function listCatalogExperts(ctx, preferredProvider) {
  const llm = ctx.get("llm");
  if (!llm) return [];
  try {
    const providers = llm.listProviders();
    const candidateProviders = preferredProvider
      ? providers.filter((p) => p.id === preferredProvider)
      : providers;
    const targetProviders = candidateProviders.length > 0 ? candidateProviders : providers;
    const results = [];
    for (const provider of targetProviders) {
      try {
        const models = await llm.listModels(provider.id);
        for (const model of Array.isArray(models) ? models : []) {
          if (model && typeof model.id === "string" && model.id.length > 0) {
            results.push({
              label: typeof model.name === "string" && model.name.trim().length > 0 ? model.name.trim() : model.id,
              provider: provider.id,
              model: model.id,
            });
          }
        }
      } catch {
        // Individual provider listing failures must not break the overall catalog
      }
    }
    return results;
  } catch {
    return [];
  }
}

/** Roster first, then the live catalog, so any DSH-added model can be summoned. */
function findExpertIn(config, catalog, spec) {
  if (spec === undefined || spec === null) return undefined;
  const needle = String(spec).trim();
  if (!needle) return undefined;
  const all = [...config.panelists, config.finalExpert, ...(Array.isArray(catalog) ? catalog : [])];
  if (/^\d+$/.test(needle)) {
    const index = Number.parseInt(needle, 10);
    return index >= 1 && index <= all.length ? all[index - 1] : undefined;
  }
  const lower = needle.toLowerCase();
  return (
    all.find((expert) => expert.model.toLowerCase() === lower) ??
    all.find((expert) => routeOf(expert).toLowerCase() === lower) ??
    all.find((expert) => expert.label.toLowerCase() === lower) ??
    all.find((expert) => expert.model.toLowerCase().includes(lower) || expert.label.toLowerCase().includes(lower))
  );
}

function findExpert(config, spec) {
  return findExpertIn(config, [], spec);
}

/** Rebuild the expert identity recorded on a child, including catalog models absent from the roster. */
function expertFromMeta(config, meta) {
  const roster = [...config.panelists, config.finalExpert, config.reviewer];
  return (
    roster.find((expert) => routeOf(expert) === meta.expertRoute) ?? {
      label: meta.expertLabel ?? "专家",
      provider: meta.provider ?? config.finalExpert.provider,
      model: meta.model ?? config.finalExpert.model,
      ...(meta.expertEffort ? { reasoningEffort: meta.expertEffort } : {}),
    }
  );
}

/** Build a valid lower-kebab-case Agent Team member name (`<= 64` chars, not `lead`). */
function buildMemberSlug(roleTag, expert, existingMembers = []) {
  const rawBase = String(expert?.label || expert?.model || "").toLowerCase();
  let modelSlug = rawBase
    .replace(/gemini[\s-]*4[\s-]*argon.*/g, "argon")
    .replace(/qwen[\s-]*3\.?8[\s-]*max|auto\/qmodel_38max/g, "qwen38-max")
    .replace(/kimi[\s-]*k3\.?1[\s-]*pro|auto\/kmodel_latest/g, "kimi-k31-pro")
    .replace(/glm[\s-]*5\.?3|auto\/gmodel/g, "glm53")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28)
    .replace(/-+$/g, "");
  if (!modelSlug) modelSlug = "model";
  const prefix =
    roleTag === "final"
      ? "expert-final"
      : roleTag === "review"
        ? "expert-review"
        : "expert-panel";
  const stem = `${prefix}-${modelSlug}`.replace(/-+/g, "-").slice(0, 54).replace(/-+$/g, "");
  const taken = new Set(existingMembers.map((m) => m.name));
  if (!taken.has(stem)) return stem;
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${randomUUID().slice(0, 6)}`;
}

/** Convert user/model file paths into valid workspace-relative Team task writeScopes. */
function normalizeWriteScopes(files, cwd) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const cleanCwd = typeof cwd === "string" && cwd.length > 0 ? cwd.replace(/\/+$/g, "") : "";
  const out = new Set();
  for (const raw of files) {
    if (typeof raw !== "string") continue;
    let candidate = raw.trim().replaceAll("\\", "/");
    if (cleanCwd && candidate.startsWith(`${cleanCwd}/`)) {
      candidate = candidate.slice(cleanCwd.length + 1);
    }
    candidate = candidate.replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (!candidate || candidate.startsWith("/") || /^[a-z]:/iu.test(candidate)) continue;
    const segments = candidate.split("/");
    if (segments.some((seg) => seg.length === 0 || seg === "." || seg === "..")) continue;
    out.add(candidate);
  }
  return [...out].slice(0, 16);
}

/**
 * Register the expert subagent in the root session's `team/member` projection
 * BEFORE `startActivation` runs, so `tool-agent-team` recognizes it as an
 * active Teammate and mounts `send_message`, `list_agents`, and `team_task_*`!
 */
async function provisionTeamMember(ctx, root, { childId, roleTag, expert, label, providerName, contextMode }) {
  const agentTeams = ctx.get("agentTeams");
  if (!agentTeams?.journal || !root?.session) return undefined;
  try {
    return await agentTeams.journal.transact(root.id, async () => {
      const state = agentTeams.journal.state(root);
      if (state.failure !== undefined) return undefined;
      const existing = state.members.find((m) => m.id === childId);
      if (existing) return existing;
      const name = buildMemberSlug(roleTag, expert, state.members);
      const member = {
        id: childId,
        name,
        description: truncateSimple(`${label} (${routeOf(expert)})`, 190),
        provider: providerName,
        context: contextMode === "fork" ? "fork" : "fresh",
        phase: "provisioning",
      };
      await agentTeams.journal.appendAndFlush(root, "team/member", {
        version: 2,
        teamId: root.id,
        member,
      });
      return member;
    });
  } catch {
    return undefined;
  }
}

async function settleTeamMember(ctx, root, childId, phase, errorText) {
  const agentTeams = ctx.get("agentTeams");
  if (!agentTeams?.journal || !root?.session || !childId) return;
  try {
    await agentTeams.journal.transact(root.id, async () => {
      const state = agentTeams.journal.state(root);
      if (state.failure !== undefined) return;
      const cur = state.members.find((m) => m.id === childId);
      if (!cur || cur.phase !== "provisioning") return;
      const updated = {
        ...cur,
        phase,
        ...(phase === "failed" && errorText ? { error: truncateSimple(errorText, 190) } : {}),
      };
      await agentTeams.journal.appendAndFlush(root, "team/member", {
        version: 2,
        teamId: root.id,
        member: updated,
      });
    });
  } catch {
    // non-fatal
  }
}

/**
 * 任务板记账已按第一性原理审计移除：共享任务 DAG 不参与任何控制流，
 * 只产生「看起来在协作」的叙事与额外工具步。保留同名空实现让调用点安全。
 */
async function createExpertTeamTask() {
  return undefined;
}
async function assignExpertTeamTask() {
  return undefined;
}
async function completeExpertTeamTask() {
  return undefined;
}

function extractChildTelemetry(meta) {
  const empty = {
    steps: 0,
    turns: 0,
    durationMs: meta?.startedAt ? Math.max(0, Date.now() - meta.startedAt) : 0,
    totalTools: 0,
    toolCounts: {},
    filesRead: [],
    filesWritten: [],
    bashCommands: [],
    teamMessagesSent: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };
  const session = meta?.session;
  if (!session || typeof session.snapshotEvents !== "function") return empty;

  const events = session.snapshotEvents(meta.startSeq ?? 0);
  const toolCounts = {};
  const filesRead = new Set();
  const filesWritten = new Set();
  const bashCommands = [];
  let steps = 0;
  let turns = 0;
  let totalTools = 0;
  let teamMessagesSent = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let totalTokens = 0;

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "turn/start") turns += 1;
    else if (ev.type === "step/start") steps += 1;
    else if (ev.type === "assistant/message") {
      const usage = ev.data?.usage;
      if (usage && typeof usage === "object") {
        inputTokens += Number(usage.inputTokens) || 0;
        outputTokens += Number(usage.outputTokens) || 0;
        cacheReadTokens += Number(usage.cacheReadTokens) || 0;
        totalTokens += Number(usage.totalTokens) || (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0);
      }
    } else if (ev.type === "tool/call") {
      const toolName = String(ev.data?.name ?? "unknown");
      totalTools += 1;
      toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
      if (toolName === "send_message") teamMessagesSent += 1;

      let parsedArgs = {};
      try {
        parsedArgs = typeof ev.data?.arguments === "string" ? JSON.parse(ev.data.arguments) : (ev.data?.arguments ?? {});
      } catch {
        parsedArgs = {};
      }
      if (toolName === "read" || toolName === "read_image") {
        if (typeof parsedArgs.file_path === "string" && parsedArgs.file_path.trim()) {
          filesRead.add(parsedArgs.file_path.trim());
        }
      } else if (toolName === "write" || toolName === "edit") {
        if (typeof parsedArgs.file_path === "string" && parsedArgs.file_path.trim()) {
          filesWritten.add(parsedArgs.file_path.trim());
        }
      } else if (toolName === "grep" || toolName === "glob") {
        if (typeof parsedArgs.path === "string" && parsedArgs.path.trim()) {
          filesRead.add(parsedArgs.path.trim());
        }
      } else if (toolName === "bash") {
        const desc = typeof parsedArgs.description === "string" ? parsedArgs.description.trim() : "";
        const cmd = typeof parsedArgs.command === "string" ? parsedArgs.command.trim().split(/\r?\n/)[0].slice(0, 90) : "";
        if (desc || cmd) bashCommands.push(desc ? `${desc} (\`${cmd}\`)` : `\`${cmd}\``);
      }
    }
  }

  return {
    steps,
    turns: Math.max(1, turns),
    durationMs: meta?.startedAt ? Math.max(0, Date.now() - meta.startedAt) : 0,
    totalTools,
    toolCounts,
    filesRead: [...filesRead],
    filesWritten: [...filesWritten],
    bashCommands: bashCommands.slice(0, 12),
    teamMessagesSent,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
  };
}

function formatDurationSec(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s > 0 ? `${s}s` : ""}`;
}

function formatTokensCompact(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatTelemetryLedger(records) {
  if (!Array.isArray(records) || records.length === 0) return "";
  const rows = [
    `## 📊 专家团实际工作取证账本（不可伪造 · 源自子会话真实事件流）`,
    "",
    `| 阶段 / 角色 | 专家模型 | 编队代号 (\`target\`) | 共享任务 | 步数 / 耗时 | Token 消耗 (总/输出) | 工具调用明细 | 实际读写文件 / 关键操作 |`,
    `|---|---|---|---|---|---|---|---|`,
  ];

  for (const rec of records) {
    const t = rec.telemetry ?? {};
    const toolSummary =
      Object.entries(t.toolCounts ?? {})
        .map(([k, v]) => `${k}×${v}`)
        .join(", ") || "无工具调用";
    const fileOps = [];
    if (t.filesWritten?.length) fileOps.push(`✏️ 写: ${t.filesWritten.slice(0, 4).map((f) => `\`${f.split("/").pop()}\``).join(", ")}`);
    if (t.filesRead?.length) fileOps.push(`📖 读: ${t.filesRead.slice(0, 4).map((f) => `\`${f.split("/").pop()}\``).join(", ")}`);
    if (!fileOps.length && t.bashCommands?.length) fileOps.push(`💻 命令: ${t.bashCommands.slice(0, 2).join("; ")}`);
    const opsCell = fileOps.join("<br>") || "纯推理分析";

    rows.push(
      `| ${rec.stageLabel || "会诊"} | **${rec.expert.label}**<br>\`${routeOf(rec.expert)}\` | ${rec.memberName ? `\`${rec.memberName}\`` : `\`${rec.childId.slice(0, 8)}\``} | ${rec.taskId ? `\`${rec.taskId}\`` : "—"} | ${t.steps ?? 0} 步 / ${formatDurationSec(t.durationMs)} | ${formatTokensCompact(t.totalTokens)} / ${formatTokensCompact(t.outputTokens)} | ${toolSummary} | ${opsCell} |`,
    );
  }

  return rows.join("\n");
}

function buildProblemPacket({
  tier,
  category,
  problemSummary,
  attemptedSteps,
  relevantFiles,
  expectedDeliverable,
  userGuidance,
  sessionDigest,
  teamBoardDigest,
  includeDigest,
}) {
  const sections = [
    `# ⚡ 专家团会诊任务单`,
    `- **会诊层级**：${TIER_LABELS[tier] ?? tier}`,
    `- **问题分类**：${CATEGORY_LABELS[category] ?? category}`,
  ];
  if (problemSummary) sections.push("", `## 1. 核心卡点`, problemSummary);
  if (attemptedSteps) sections.push("", `## 2. 主力模型已尝试的排查与失败记录`, attemptedSteps);
  if (Array.isArray(relevantFiles) && relevantFiles.length > 0) {
    sections.push("", `## 3. 涉及的关键文件`, relevantFiles.map((f) => `- \`${f}\``).join("\n"));
  }
  if (expectedDeliverable) sections.push("", `## 4. 期望专家交付的裁决重点`, expectedDeliverable);
  if (userGuidance) sections.push("", `## 5. 用户附加指示`, userGuidance);
  if (includeDigest && sessionDigest) sections.push("", `## 7. 主会话最近交互与报错摘要`, sessionDigest);
  return sections.join("\n");
}

function panelistRole(expert, isReadOnly, meta = {}) {
  const memberHint = meta.memberName
    ? `你在本会话编队（Agent Team）中的正式代号为 **\`${meta.memberName}\`**${meta.taskId ? `，负责共享任务 **\`${meta.taskId}\`**` : ""}，主控 Agent 代号为 **\`lead\`**。`
    : `你是主会话召集的专家子代理。`;

  return [
    `## ⚡ 你的身份：专家团成员「${expert.label}」（\`${routeOf(expert)}\`）`,
    "",
    `${memberHint}`,
    `你是被召集来会诊一个主力模型（日常廉价模型）搞不定的疑难问题。请先通过 \`read\` / \`grep\` / \`bash\` 等工具查证关键代码与事实，给出**有代码行号与实测证据支撑的高置信度判断**。`,
    ``,
    `### 🚀 取证效率纪律（务必遵守，直接决定本轮能否在预算内跑完）`,
    `1. **先定位再精读**：优先 \`grep\` 搜索关键符号拿到行号，再用 \`read(offset, limit)\` 只读目标区间；`,
    `2. **单次读取不超过 200 行**：禁止一次性 read 整个大文件（本项目有 100KB+ 的单文件，全文读取会让单步耗时暴涨 5–10 倍）；`,
    `3. **前 40% 步数内必须产出一版初步结论**（哪怕标为「暂定」），确保即使后续被预算截断也能交回可用成果；`,
    `4. **不要重复读同一文件**：已读过的内容凭记忆引用行号即可。`,
    isReadOnly
      ? `当前为【只读会诊】：硬件级禁止调用 \`write\`/\`edit\` 修改任何文件，请把算力全部用在定位根因、核查代码与给出精确方案上。`
      : `当前为【接管模式】：你可以直接修改最核心、最棘手的关键卡点并运行验证，把大面积机械收尾工作留给主力模型。`,
    "",
    `### 输出要求（务必结构化，便于交叉审阅与汇总）`,
    `1. **根因判断**：一针见血说明问题本质（附精确文件路径与行号证据），以及主力模型此前为什么会卡住；`,
    `2. **置信度**：高 / 中 / 低，并说明已验证的事实与仍不确定的部分；`,
    `3. **修复方案 / 已落地的修改**：精确到文件路径、函数名与行号的改动要点；`,
    `4. **需要终裁吗**：明确回答「不需要」或「需要 Argon 终裁」，并给出一句理由；`,
    `5. **风险提示与红线**：这个方案可能踩的坑与必须守住的不变量。`,
  ].join("\n");
}

function crossReviewPrompt(config, packet, verdicts) {
  return [
    `# ⚡ 专家团交叉审阅与汇总（Cross-Review）`,
    "",
    `下面是 ${verdicts.length} 位一线专家对同一个疑难问题的独立诊断（也将作为编队消息同步投递给你）。你的任务是**互相挑刺、核对代码证据并收敛结论**，而不是简单复述他们的话。`,
    "",
    `## 原始问题单`,
    packet,
    "",
    `## 各专家独立诊断汇总`,
    verdicts
      .map(
        (entry) =>
          `### 专家「${entry.expert.label}」（\`${routeOf(entry.expert)}\`，编队代号 \`${entry.memberName || entry.childId.slice(0, 8)}\`，执行 ${entry.telemetry?.steps ?? 0} 步 / 工具 ${entry.telemetry?.totalTools ?? 0} 次）\n${entry.text || "（无文本输出）"}`,
      )
      .join("\n\n"),
    "",
    `## 请按以下结构输出（并在结束前用 \`send_message({ target: "lead", message: "【互审收敛快报】..." })\` 同步核心结论）`,
    `1. **共识点**：多数专家一致同意且经代码印证的根因与方案；`,
    `2. **分歧点与裁决**：谁和谁不一致、分歧的实质是什么、哪一边的代码证据更扎实；`,
    `3. **被推翻的判断**：指出哪位专家的结论存在漏洞或与真实代码不符；`,
    `4. **收敛后的最终执行方案**：精确到文件与行号的可执行步骤（Step 1 / Step 2 / Step 3）；`,
    `5. **是否需要终裁**：回答「不需要，方案已收敛」或「需要 ${config.finalExpert.label} 终裁」，并说明理由；`,
    `6. **红线与不变量**：主力模型执行时绝对不能违反的边界条件。`,
  ].join("\n");
}

function finalArbiterPrompt(config, packet, panelDigest) {
  return [
    `# ⚡ 终裁任务单 · ${config.finalExpert.label}`,
    "",
    `你是本次会诊的**最终裁决者**。请结合代码事实与前置会诊记录：`,
    `1. 判定前置诊断是否正确；如有错误，直接给出正确结论；`,
    `2. 对无法收敛的分歧做出最终架构与算法裁决；`,
    `3. 亲自处理最核心、最微妙的关键卡点（若需要），并通过 \`send_message({ target: "lead", message: "【终裁快报】..." })\` 留存编队通讯记录；`,
    `4. 把剩余的机械施工精确指派回主力模型，节省你宝贵的配额。`,
    "",
    `## 原始问题单`,
    packet,
    "",
    panelDigest
      ? `## 专家团已有的会诊与互审结论\n${panelDigest}`
      : "## 专家团已有的会诊与互审结论\n（本次未经过专家团前置会诊，直接终裁）",
  ].join("\n");
}

function formatDispatch({
  tier,
  expertsUsed,
  stopReasons,
  panelDigest,
  finalText,
  config,
  userGuidance,
  childIds,
  telemetryRecords,
}) {
  let headline = "# ⚡ 多轮评审结论与后续工作部署指派单";
  if (tier === "followup") {
    headline = "# ⚡ 专家多轮追问复核结论与后续工作指派单";
  } else if (tier === "review_no_arbiter") {
    headline = "# ⚡ 多轮评审结论与后续工作部署指派单（① 取证 → ② 互审，终裁已关闭）";
  }

  const step4 = `4. **继续追问**：若对某位专家的细节有疑问，可直接用 \`send_message({ target: "<专家编队代号>", message: "..." })\` 或 \`${TOOL_NAME}({ followup_target: "<专家代号>", followup_question: "..." })\` 多轮追问；如需再次评审，重新申请 \`${TOOL_NAME}\` 即可（流程固定为多轮评审）。`;

  const ledgerBlock = formatTelemetryLedger(telemetryRecords);

  return [
    headline,
    "",
    `- **会诊层级**：${TIER_LABELS[tier] ?? tier}`,
    `- **参与专家**：${expertsUsed.length > 0 ? expertsUsed.map((e) => `${e.label}(\`${routeOf(e)}\`)`).join("、") : "（无）"}`,
    `- **结束状态**：${stopReasons.length > 0 ? stopReasons.join("、") : "n/a"}`,
    `- **专家子会话**：${childIds.length > 0 ? childIds.map((id) => `\`${id}\``).join(" ") : "（无）"}`,
    ...(Array.isArray(telemetryRecords) && telemetryRecords.some((r) => r.memberName)
      ? [
          `- **编队成员代号（支持 \`send_message\` 直接追问）**：${telemetryRecords
            .filter((r) => r.memberName)
            .map((r) => `\`${r.memberName}\`${r.taskId ? ` (任务 \`${r.taskId}\`)` : ""}`)
            .join("、")}`,
        ]
      : []),
    ...(userGuidance ? [`- **用户附加指示**：${userGuidance}`] : []),
    "",
    ledgerBlock ? `${ledgerBlock}\n\n---` : `---`,
    "",
    panelDigest ? `## 专家团会诊与互审过程\n\n${panelDigest}\n\n---\n` : "",
    `## 专家裁决正文\n\n${finalText || "（专家未返回文本内容，请检查子会话日志）"}`,
    "",
    `---`,
    "",
    `## ▶ 主力模型接力执行指令（Mandatory Continuation）`,
    `1. **立即接棒**：专家团已完成会诊/攻坚并下发上述指派单，控制权正式交回给你；`,
    `2. **严守裁决**：严格遵照专家的根因结论与红线约束，**切勿覆盖或回退**专家已完成的修改；`,
    `3. **自动继续**：立即按指派单中的 Step 清单更新 \`todo_write\` 并逐步执行到底，无需再向用户确认；`,
    step4,
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function parseExpertCommand(rawInput) {
  const input = (rawInput ?? "").trim();
  const useFork = /(^|\s)--fork(\s|$)/i.test(input);
  const withoutFlag = input.replace(/(^|\s)--fork(\s|$)/gi, " ").trim();
  const tokens = withoutFlag.split(/\s+/).filter(Boolean);
  const head = (tokens[0] ?? "").toLowerCase();

  const ctxMode = useFork ? "fork" : undefined;
  if (tokens.length === 0) return { kind: "run", contextMode: ctxMode, instruction: "" };
  if (/^(status|help|-h|--help)$/.test(head)) return { kind: "status" };
  if (head === "routes") return { kind: "routes" };
  if (head === "ask" || head === "followup") {
    return {
      kind: "followup",
      target: tokens[1] ?? "",
      question: tokens.slice(2).join(" "),
    };
  }
  // 旧的 solo / final 子命令已废弃：一律走多轮评审，多余的关键字当作问题描述的一部分。
  if (/^(panel|review|diagnose)$/.test(head)) {
    return { kind: "run", contextMode: ctxMode, instruction: tokens.slice(1).join(" ") };
  }
  return { kind: "run", contextMode: ctxMode, instruction: withoutFlag };
}

function buildMainAgentPromptSection(config) {
  return [
    `## ⚡ 专家团（Expert Panel v3.1）分级会诊与接管机制`,
    "",
    `> 插件版本标记：@local/expert-panel v3.1（UI 全量预设配置 + @/自然语言触发 + 极简一键确认 + Superagent 原地接管）`,
    "",
    `你身边有一个**多轮评审专家团**，用于处理主力模型搞不定的硬骨头。它只有一个固定流程：**① 独立取证 → ② 交叉互审${config.enableArbiter !== false ? " → ③ 终裁定稿" : ""}**，没有单专家 / 原地接管等旁路模式。用户已在「专家团 UI 页面」配好阵容，启动时只需点一次确认：`,
    "",
    `### 专家团名册`,
    ...rosterLines(config).map((line) => `- ${line}`),
    "",
    `### 何时必须立即调用 \`${TOOL_NAME}\`（含 @ 与自然语言召唤）`,
    `1. **用户通过 \`@\` 或自然语言召唤（最高优先级）**：只要用户在消息中写了 \`@专家\`、\`@专家团\`、\`@argon\`、\`@expert\`，或用自然语言说「请专家看看」「让专家接管」「调用专家」「让专家审核/分析」，你必须**立即在本步调用 \`${TOOL_NAME}\`**，不得自己硬撑或推脱；`,
    `2. **遇到 5 类高价值硬骨头**：`,
    `   - **\`stuck_bug\`**：同一 Bug 自行排查/修复 **≥ 2 次** 仍失败、测试反复挂、修好 A 坏了 B、异步竞态等；`,
    `   - **\`architecture\`**：跨包协议、复杂状态机折叠、核心存储迁移或 10+ 文件耦合改造；`,
    `   - **\`multimodal_ui\`**：复杂 UI 错位、架构图/设计稿审计、复杂 Canvas/CSS 渲染异常；`,
    `   - **\`algorithm_security\`**：复杂 AST/编译器转换、死锁反证、算法级重构、权限/沙箱边界审查；`,
    `   - **\`red_team_review\`**：重大变更或重要报告落地前的专家挑刺终审。`,
    "",
    `### 多轮追问（\`followup_target\` + \`followup_question\` 或 \`send_message\`）`,
    `- 每位召集的专家都会自动注册为当前会话的编队队友（Teammate）并绑定共享任务，你可随时对已有专家发起第 2/3 轮深度追问或补充验证。`,
    "",
    `### 收到指派单后的接力规范`,
    `专家团处理完毕会下发 **《专家团裁决与后续工作部署指派单》**（附带不可伪造的子会话工具调用与文件改动取证账本）。收到后你必须：`,
    `1. **无条件采纳**其根因裁决与红线约束，切勿回退或覆盖专家已改动的代码；`,
    `2. **立即认领**指派给你的 Step 清单，用 \`todo_write\` 同步进度；`,
    `3. **直接动手执行**剩余编码、清理与验证，让原流程无缝继续，无需再次反问用户。`,
  ].join("\n");
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);

  /**
   * childSessionId -> {
   *   parentId, rootId, trigger, roleTag, stageLabel, readOnly,
   *   expertLabel, expertRoute, provider, model, expertEffort,
   *   runId, memberName, taskId, startedAt, startSeq, session,
   *   incomingRelays: Array<{ senderSessionId, senderName, text }>,
   *   lastTelemetry
   * }
   * Retained across turns so continuable follow-ups (`send_message` / `followup_target`)
   * preserve the expert's persona, tool guards, and team identity!
   */
  const expertChildren = new Map();
  /** childSessionId -> agent.ctx effect disposer */
  const childScopedDisposers = new Map();
  /** parentSessionId -> Set<AbortController> for manual runs */
  const manualControllers = new Map();
  /** parentSessionId -> stats */
  const sessionStats = new Map();
  /** runId -> { tier, startedAt, experts, childIds, status, telemetryRecords } */
  const runs = new Map();
  /** childSessionId -> touched file paths for presentResult locations */
  const callLocationsByChild = new Map();

  function statsFor(parentId) {
    const prev = sessionStats.get(parentId) ?? { calls: 0, panelRuns: 0, finalRuns: 0, followups: 0 };
    sessionStats.set(parentId, prev);
    return prev;
  }

  function beginRun(parentId, tier, experts) {
    const runId = randomUUID().slice(0, 8);
    runs.set(runId, {
      runId,
      parentId,
      tier,
      experts: experts.map((expert) => expert.label),
      childIds: [],
      telemetryRecords: [],
      status: "running",
      startedAt: Date.now(),
    });
    return runId;
  }

  function endRun(runId, status, telemetryRecords) {
    const run = runs.get(runId);
    if (!run) return;
    run.status = status;
    if (Array.isArray(telemetryRecords)) run.telemetryRecords = telemetryRecords;
    run.finishedAt = Date.now();
    if (runs.size > 50) {
      const oldest = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest) runs.delete(oldest.runId);
    }
  }

  /**
   * Inject a compact `agent-message` execution receipt into the root session when
   * the expert did not manually call `send_message` during its turn, so
   * `dsh-context` (Fleet Comms & Context) always shows the communication edge.
   */
  function ensureCommsReceipt(root, meta, expert, text, telemetry) {
    if (!root || telemetry.teamMessagesSent > 0) return;
    try {
      const toolBrief =
        Object.entries(telemetry.toolCounts ?? {})
          .map(([k, v]) => `${k}×${v}`)
          .join(", ") || "纯推理";
      const writtenBrief =
        telemetry.filesWritten?.length > 0
          ? ` · 已修改文件：${telemetry.filesWritten.slice(0, 4).join("、")}`
          : "";
      const summaryLine = truncateText(firstMeaningfulParagraph(text), 240);
      const relayMsg = createRelayMessage({
        senderSessionId: meta.childId,
        senderName: meta.memberName || expert.label,
        text: `[${meta.stageLabel || "会诊"}结案回执 · ${telemetry.steps} 步 / 工具 ${telemetry.totalTools} 次 (${toolBrief}) / 耗时 ${formatDurationSec(telemetry.durationMs)}${writtenBrief}]\n${summaryLine || "（已完成会诊，详见指派单）"}`,
      });
      if (root.status === "running" && typeof root.inject === "function") {
        root.inject(relayMsg);
      }
    } catch {
      // non-fatal
    }
  }

  async function runExpert({
    parent,
    expert,
    tier,
    roleTag,
    stageLabel,
    readOnly,
    label,
    promptBlocks,
    signal,
    contextMode,
    runId,
    taskId,
    writeScopes,
    taskSubject,
    taskDescription,
    incomingRelays,
  }) {
    const providerName = contextMode === "fork" ? "fork" : "spawn";
    const provider = ctx.subagents.getProvider(providerName);
    if (!provider) {
      throw new Error(`未找到子代理后端 "${providerName}"，请确认 @deepseek-ai/dsh-subagent-${providerName}-in-process 已启用。`);
    }

    const llm = ctx.get("llm");
    if (llm) {
      await llm.resolveCallConfig(
        {
          provider: expert.provider,
          model: expert.model,
          ...(expert.reasoningEffort ? { reasoningEffort: expert.reasoningEffort } : {}),
        },
        signal,
      );
    }

    const root = resolveRootAgent(ctx, parent) ?? parent;
    const childId = randomUUID();

    // 1. Provision as a first-class Agent Team member BEFORE startActivation so
    //    `tool-agent-team` automatically installs `send_message` and `team_task_*`!
    const member = await provisionTeamMember(ctx, root, {
      childId,
      roleTag: roleTag ?? tier,
      expert,
      label,
      providerName,
      contextMode,
    });
    const memberName = member?.name;

    // 2. Create or bind the shared Team task on the task board.
    let activeTaskId = taskId;
    if (!activeTaskId && taskSubject) {
      const createdTask = await createExpertTeamTask(ctx, root, {
        subject: taskSubject,
        description: taskDescription || label,
        writeScopes,
      });
      activeTaskId = createdTask?.id;
    }

    const maxSteps = readOnly ? Math.max(12, Math.min(config.maxStepsPerExpert, 20)) : config.maxStepsPerExpert;
    const meta = {
      childId,
      parentId: parent.id,
      rootId: root.id,
      trigger: tier,
      roleTag: roleTag ?? tier,
      stageLabel: stageLabel ?? (roleTag === "review" ? "交叉互审" : roleTag === "final" ? "终裁定稿" : "独立取证"),
      readOnly,
      expertLabel: expert.label,
      expertRoute: routeOf(expert),
      provider: expert.provider,
      model: expert.model,
      ...(expert.reasoningEffort ? { expertEffort: expert.reasoningEffort } : {}),
      runId,
      memberName,
      taskId: activeTaskId,
      startedAt: Date.now(),
      startSeq: 0,
      maxSteps,
      liveSteps: 0,
      currentTool: "",
      status: "running",
      session: undefined,
      incomingRelays: Array.isArray(incomingRelays) ? incomingRelays : [],
      lastTelemetry: undefined,
    };
    expertChildren.set(childId, meta);

    const run = runs.get(runId);
    if (run) run.childIds.push(childId);

    const rolePrompt = panelistRole(expert, readOnly, meta);
    const fullPromptBlocks = [...promptBlocks, { type: "text", text: `\n\n---\n\n${rolePrompt}` }];

    let activation;
    try {
      activation = await ctx.subagents.startActivation({
        childId,
        provider: providerName,
        label,
        request: {
          parent: root,
          prompt: fullPromptBlocks,
          agentOptions: {
            provider: expert.provider,
            model: expert.model,
            ...(expert.reasoningEffort ? { reasoningEffort: expert.reasoningEffort } : {}),
          },
        },
        signal,
        delivery: "caller",
      });
      await settleTeamMember(ctx, root, childId, "active");
      if (activeTaskId && memberName) {
        await assignExpertTeamTask(ctx, root, activeTaskId, memberName);
      }
    } catch (error) {
      meta.status = "error";
      await settleTeamMember(ctx, root, childId, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }

    // Bound execution time & watch for user steering in the parent session so the
    // parent session can NEVER hang indefinitely waiting on a runaway subagent.
    // The budget is an ACTIVE-WORK budget: time spent waiting on tools (long bash
    // jobs, sleeps, CDP probes) does not consume it, so a productive expert that
    // keeps making progress is never cut off mid-investigation.
    const timeoutMs = (config.expertTimeoutSeconds ?? 1800) * 1000;
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let timedOut = false;
    let timedOutReason = "";
    let lastAssistantAt = 0;
    let lastToolCallAt = 0;
    let sawAssistantMessage = false;
    let toolActiveSince = 0;
    let toolActiveMs = 0;

    const offProgress = ctx.on("session/event", (sess, ev) => {
      if (sess !== meta.session || !ev || typeof ev !== "object") return;
      if (ev.type === "assistant/message") {
        sawAssistantMessage = true;
        lastAssistantAt = ev.time ?? Date.now();
        lastProgressAt = Date.now();
      } else if (ev.type === "tool/call") {
        lastToolCallAt = ev.time ?? Date.now();
        if (toolActiveSince === 0) toolActiveSince = Date.now();
      } else if (ev.type === "tool/result") {
        if (toolActiveSince !== 0) {
          toolActiveMs += Math.max(0, Date.now() - toolActiveSince);
          toolActiveSince = 0;
        }
        lastProgressAt = Date.now();
      }
    });

    const timeoutTimer = setInterval(() => {
      if (timedOut) return;
      const now = Date.now();
      const wallMs = now - startedAt;
      const currentToolHoldMs = toolActiveSince !== 0 ? Math.max(0, now - toolActiveSince) : 0;
      const activeWorkMs = Math.max(0, wallMs - (toolActiveMs + currentToolHoldMs));
      const idleMs = now - lastProgressAt;
      // A run that has produced nothing at all (no assistant message, no tool call)
      // is a stalled provider stream: its wall clock is the only signal we have.
      const stalledBeforeStart = !sawAssistantMessage && lastToolCallAt === 0;
      const budgetMs = stalledBeforeStart ? Math.max(120_000, Math.min(timeoutMs, 300_000)) : timeoutMs;
      // 时间维度软收口：当有效工作时长（不含工具等待）达到预算 70% 时，置位 timeBudgetLocked，
      // 由 ctx.tools.guard 锁定后续工具调用并强制模型在当前轮直接输出最终结论，避免被硬中断导致零正文。
      if (!stalledBeforeStart && activeWorkMs >= budgetMs * 0.7 && !meta.timeBudgetLocked) {
        meta.timeBudgetLocked = true;
      }
      // 真正的「卡死」判定：不在等待工具结果的前提下，连续 5 分钟无任何事件（兼顾 Argon high 深度推理耗时）。
      const overIdle = !stalledBeforeStart && toolActiveSince === 0 && idleMs > 300_000;
      const overActiveBudget = !stalledBeforeStart && activeWorkMs > budgetMs;
      const overHardCeiling = !stalledBeforeStart && wallMs > budgetMs * 2;
      if (overIdle || overActiveBudget || overHardCeiling) {
        timedOut = true;
        timedOutReason = overIdle ? "idle" : "budget";
        try {
          ctx.subagents.interrupt(childId, { kind: "user", parentSessionId: root.id });
        } catch {
          /* ignore */
        }
      }
    }, 5_000);
    if (typeof timeoutTimer === "object" && timeoutTimer !== null && "unref" in timeoutTimer) {
      try {
        timeoutTimer.unref();
      } catch {
        /* ignore */
      }
    }

    const offParentSteer = ctx.on("session/event", (sess, ev) => {
      if (sess !== root.session || ev?.type !== "agent/inbox/spliced") return;
      const inserted = Array.isArray(ev.data?.inserted) ? ev.data.inserted : [];
      for (const msg of inserted) {
        if (msg?.source?.kind === "user" && msg?.source?.rpcId) {
          const userTxt = extractTextFromBlocks(msg.content);
          if (/^(停止|停下|取消|跳过|重新|够了|收尾|打断|stop|cancel|abort)/i.test(userTxt.trim())) {
            try {
              ctx.subagents.interrupt(childId, { kind: "user", parentSessionId: root.id });
            } catch {
              /* ignore */
            }
          }
        }
      }
    });

    let settled;
    try {
      settled = await activation.result;
    } finally {
      clearInterval(timeoutTimer);
      try {
        offProgress?.();
      } catch {
        /* ignore */
      }
      try {
        offParentSteer?.();
      } catch {
        /* ignore */
      }
    }

    const telemetry = extractChildTelemetry(meta);
    meta.lastTelemetry = telemetry;
    meta.status = settled.stopReason === "completed" ? "completed" : settled.stopReason;
    meta.currentTool = "";

    let text = extractTextFromBlocks(settled.output);
    let fallbackReasoning = "";
    if (!text && meta.session && typeof meta.session.snapshotEvents === "function") {
      // 先只提取真实 assistant 文本；切勿在此处用 reasoning 填充 text，否则会短路下方 O3 自动续跑收口！
      const evs = meta.session.snapshotEvents(meta.startSeq ?? 0);
      for (let i = evs.length - 1; i >= 0; i--) {
        if (evs[i]?.type === "assistant/message") {
          const msgContent = evs[i].data?.message?.content;
          const t = extractTextFromBlocks(msgContent);
          const r = Array.isArray(msgContent)
            ? msgContent.filter((b) => b?.type === "reasoning" && b.text).map((b) => b.text.trim()).join("\n")
            : "";
          if (t) {
            text = t;
            break;
          }
          if (!fallbackReasoning && r) {
            fallbackReasoning = `（专家已执行 ${telemetry.steps} 步 / ${telemetry.totalTools} 次工具调用后收尾，最后推理摘要）：\n${truncateText(r, 1500)}`;
          }
        }
      }
    }
    // O3：被预算截断且没有任何正式正文时，自动续跑一次「只收口、不再取证」的短轮，
    // 避免因最后一步仍在调工具或推理而被中断、导致用户拿到空白指派单或半截 reasoning。
    if (
      !text &&
      (settled.stopReason === "aborted" || settled.stopReason === "max-tokens") &&
      telemetry.steps >= 3 &&
      !meta.wrapupTried &&
      !signal?.aborted
    ) {
      meta.wrapupTried = true;
      meta.timeBudgetLocked = true;
      try {
        await ctx.subagents.sendMessage(
          root,
          childId,
          [
            {
              type: "text",
              text: "⏳ 上一轮已因预算/时长被系统收尾，但尚未输出正式正文结论。请**立即**在当前一步内直接输出结构化《裁决与后续工作部署指派单》：只写你已确认的根因、行号证据与交给主力模型的 Step 1/2/3，禁止再调用任何读取或搜索工具。",
            },
          ],
          { signal },
        );
        const resumed = ctx.subagents.manager?.resident?.get(childId);
        if (resumed?.result?.promise) {
          const settled2 = await resumed.result.promise;
          const text2 = extractTextFromBlocks(settled2.output);
          if (text2) {
            text = text2;
            settled = settled2;
            meta.status = "completed";
          }
        }
      } catch {
        /* 续跑失败时保留原始结果 */
      }
    }
    if (!text && fallbackReasoning) {
      text = fallbackReasoning;
      meta.emptyConclusion = true;
    }

    if (timedOut) {
      const reasonDesc =
        timedOutReason === "idle"
          ? "连续 5 分钟无流式响应/工具进展，触发防卡死熔断"
          : `已达单轮有效工作时长上限（${Math.round((config.expertTimeoutSeconds ?? 1800) / 60)} 分钟，不含工具执行等待）`;
      const banner = `> ⏱️ **${reasonDesc}，系统已自动收尾并提取已完成成果**`;
      text = text ? `${banner}\n\n${text}` : `${banner}\n\n（本轮未产出正文，已保留 ${telemetry.steps} 步 / ${telemetry.totalTools} 次工具调用的排查痕迹，可在「专家团」页签查看完整轨迹。）`;
    }

    // Automatic route failover if a ctyun/antigravity/* route failed on step 1 with 0 output (e.g. 403 / stream timeout)
    if (
      settled.stopReason === "error" &&
      !text &&
      telemetry.steps <= 2 &&
      String(expert.model).startsWith("ctyun/") &&
      config.panelists.length > 0
    ) {
      const model = String(expert.model);
      // 同一个 Gemini 4 Argon 在 ctyun 渠道下有两条独立上游路由：auto（路由组）与 antigravity（直连）。
      // 任一上游 403 / 流超时时，自动切到另一条，避免整套会诊直接失败。
      const routeFallback =
        model === "ctyun/auto/gemini-4-argon"
          ? { label: `${expert.label} (Antigravity 灾备路由)`, provider: expert.provider, model: "ctyun/antigravity/gemini-4-argon" }
          : model === "ctyun/antigravity/gemini-4-argon"
            ? { label: `${expert.label} (Auto 灾备路由)`, provider: expert.provider, model: "ctyun/auto/gemini-4-argon" }
            : undefined;
      const fallback = routeFallback ?? config.panelists.find((p) => routeOf(p) !== routeOf(expert)) ?? config.panelists[0];
      if (routeOf(fallback) !== routeOf(expert)) {
        try {
          return await runExpert({
            parent,
            expert: fallback,
            tier,
            roleTag,
            stageLabel: `${stageLabel || "会诊"}(灾备)`,
            readOnly,
            label: `${label}·灾备`,
            promptBlocks,
            signal,
            contextMode,
            runId,
            taskId: activeTaskId,
            writeScopes,
          });
        } catch {
          // keep original result if fallback also fails
        }
      }
    }

    for (const file of [...telemetry.filesWritten, ...telemetry.filesRead]) {
      let set = callLocationsByChild.get(runId);
      if (!set) {
        set = new Set();
        callLocationsByChild.set(runId, set);
      }
      set.add(file);
    }

    // Complete the shared Team task with an execution footprint appendix
    if (activeTaskId) {
      const toolBrief =
        Object.entries(telemetry.toolCounts ?? {})
          .map(([k, v]) => `${k}×${v}`)
          .join(", ") || "无";
      const summaryAppend = [
        `### ✅ 专家执行账本（${expert.label} · \`${memberName || childId.slice(0, 8)}\`）`,
        `- **结束状态**：${settled.stopReason} · **步数**：${telemetry.steps} 步 · **耗时**：${formatDurationSec(telemetry.durationMs)} · **Token**：${formatTokensCompact(telemetry.totalTokens)}`,
        `- **工具调用（${telemetry.totalTools} 次）**：${toolBrief}`,
        ...(telemetry.filesWritten.length > 0 ? [`- **修改文件**：${telemetry.filesWritten.map((f) => `\`${f}\``).join("、")}`] : []),
        ...(telemetry.filesRead.length > 0 ? [`- **审阅文件**：${telemetry.filesRead.slice(0, 8).map((f) => `\`${f}\``).join("、")}`] : []),
        "",
        `### 核心结论摘录`,
        truncateText(text, 1200),
      ].join("\n");
      await completeExpertTeamTask(ctx, root, activeTaskId, memberName, summaryAppend);
    }

    // Ensure a Comms relay edge is recorded in the root session if the expert didn't call send_message

    const telemetryRecord = {
      childId: activation.childId,
      memberName,
      taskId: activeTaskId,
      stageLabel: meta.stageLabel,
      expert,
      stopReason: settled.stopReason,
      telemetry,
    };

    return {
      childId: activation.childId,
      memberName,
      taskId: activeTaskId,
      stopReason: settled.stopReason,
      text,
      expert,
      telemetry,
      telemetryRecord,
    };
  }

  /**
   * Resolve an existing continuable expert child session by memberName, childId prefix,
   * expert label, or "last" (most recent expert in this root session).
   */
  function resolveExistingExpertChild(rootId, targetSpec) {
    const candidates = [...expertChildren.values()]
      .filter((m) => m.rootId === rootId || m.parentId === rootId)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    if (candidates.length === 0) return undefined;
    const needle = String(targetSpec ?? "").trim().toLowerCase();
    if (!needle || needle === "last" || needle === "latest") return candidates[0];
    return (
      candidates.find((m) => m.childId.toLowerCase() === needle) ??
      candidates.find((m) => m.memberName?.toLowerCase() === needle) ??
      candidates.find((m) => m.childId.toLowerCase().startsWith(needle)) ??
      candidates.find(
        (m) =>
          m.memberName?.toLowerCase().includes(needle) ||
          m.expertLabel?.toLowerCase().includes(needle) ||
          m.expertRoute?.toLowerCase().includes(needle),
      ) ??
      candidates[0]
    );
  }

  /**
   * Multi-turn interactive follow-up: cold-resumes or steers an existing expert
   * child session with a new question/challenge and awaits its new turn result!
   */
  async function runFollowupExpert({ parent, targetSpec, question, readOnlyOverride, signal, runId }) {
    const root = resolveRootAgent(ctx, parent) ?? parent;
    const meta = resolveExistingExpertChild(root.id, targetSpec);
    if (!meta) {
      throw new Error(
        `未找到可追问的专家子会话（目标: "${targetSpec || "latest"}"）。请先发起一次会诊，或用 /${COMMAND_NAME} status 查看已有专家代号。`,
      );
    }

    if (typeof readOnlyOverride === "boolean") {
      meta.readOnly = readOnlyOverride;
    }
    meta.startedAt = Date.now();
    meta.stageLabel = "多轮追问";
    if (meta.session) {
      meta.startSeq = meta.session.seq;
    }

    const expert = expertFromMeta(config, meta);
    const run = runs.get(runId);
    if (run && !run.childIds.includes(meta.childId)) run.childIds.push(meta.childId);

    const followupPrompt = [
      `# ⚡ 主控（Lead）对你的第 2+ 轮深度追问与复核请求`,
      "",
      question,
      "",
      `请基于你此前在本会话中已排查的代码上下文继续深挖，必要时补充运行工具验证，并在结束前通过 \`send_message({ target: "lead", message: "【追问复核快报】..." })\` 同步结论摘要。`,
    ].join("\n");

    const agentTeams = ctx.get("agentTeams");
    if (agentTeams && meta.memberName) {
      await agentTeams.sendMessage(root, {
        target: meta.memberName,
        content: [{ type: "text", text: followupPrompt }],
        signal,
      });
    } else {
      await ctx.subagents.sendMessage(root, meta.childId, [{ type: "text", text: followupPrompt }], { signal });
    }

    // Wait for the resumed activation in SubagentManager to settle
    const activation = ctx.subagents.manager?.resident?.get(meta.childId);
    let settled = { output: [], stopReason: "completed" };
    if (activation?.result?.promise) {
      settled = await activation.result.promise;
    }

    const text = extractTextFromBlocks(settled.output);
    const telemetry = extractChildTelemetry(meta);
    meta.lastTelemetry = telemetry;

    for (const file of [...telemetry.filesWritten, ...telemetry.filesRead]) {
      let set = callLocationsByChild.get(runId);
      if (!set) {
        set = new Set();
        callLocationsByChild.set(runId, set);
      }
      set.add(file);
    }


    const telemetryRecord = {
      childId: meta.childId,
      memberName: meta.memberName,
      taskId: meta.taskId,
      stageLabel: "多轮追问",
      expert,
      stopReason: settled.stopReason,
      telemetry,
    };

    return {
      childId: meta.childId,
      memberName: meta.memberName,
      taskId: meta.taskId,
      stopReason: settled.stopReason,
      text,
      expert,
      telemetry,
      telemetryRecord,
    };
  }

  /** Tier 1: cheap experts diagnose in parallel, then cross-review each other. */
  async function runReviewPipeline({ parent, packet, signal, contextMode, runId, guidance, selectedPanelists, writeScopes, problemSummary, enableArbiter }) {
    const pool = Array.isArray(selectedPanelists) && selectedPanelists.length > 0 ? selectedPanelists : config.panelists;
    if (pool.length === 0) {
      throw new Error("专家库（panelists）为空，无法进行专家团会诊。请在插件配置中至少添加一位便宜专家，或改用 final 层级。");
    }
    const chosen = pool.slice(0, Math.max(1, config.maxPanelists));
    const root = resolveRootAgent(ctx, parent) ?? parent;
    const shortTopic = truncateSimple(problemSummary || guidance || "疑难问题会诊", 80);

    // Pre-create panelist tasks and a dependent Cross-Review task (DAG!) on the Team Task Board
    const panelistTasks = await Promise.all(
      chosen.map((expert) =>
        createExpertTeamTask(ctx, root, {
          subject: `[专家会诊] ${expert.label} 独立诊断：${shortTopic}`,
          description: `由专家团成员 ${expert.label}（\`${routeOf(expert)}\`）对当前问题进行只读独立会诊，产出根因判断与修复方案。`,
          writeScopes,
        }),
      ),
    );
    const panelistTaskIds = panelistTasks.map((t) => t?.id).filter(Boolean);

    let reviewTask;
    if (config.crossReview && chosen.length >= 1 && panelistTaskIds.length > 0) {
      reviewTask = await createExpertTeamTask(ctx, root, {
        subject: `[交叉互审] ${config.reviewer.label} 审阅各方分歧并收敛方案：${shortTopic}`,
        description: `汇总并交叉审阅 ${chosen.map((e) => e.label).join("、")} 的独立诊断，指出漏洞、裁决分歧并输出收敛的执行步骤。`,
        blockedBy: panelistTaskIds,
        writeScopes,
      });
    }

    const verdicts = [];
    const failures = [];
    const telemetryRecords = [];

    const results = await Promise.all(
      chosen.map((expert, index) =>
        runExpert({
          parent,
          expert,
          tier: "panel",
          roleTag: "panel",
          stageLabel: `会诊#${index + 1}`,
          readOnly: true,
          label: `${RUN_LABEL_PREFIX}·会诊·${expert.label}`,
          promptBlocks: [{ type: "text", text: packet }],
          signal,
          contextMode,
          runId,
          taskId: panelistTasks[index]?.id,
          writeScopes,
        })
          .then((result) => ({ ok: true, index, result }))
          .catch((error) => ({ ok: false, index, expert, error })),
      ),
    );

    for (const entry of results) {
      if (entry.ok) {
        verdicts.push(entry.result);
        telemetryRecords.push(entry.result.telemetryRecord);
      } else {
        failures.push({
          expert: entry.expert,
          message: entry.error instanceof Error ? entry.error.message : String(entry.error),
        });
      }
    }

    if (verdicts.length === 0) {
      throw new Error(`专家团会诊全部失败：${failures.map((f) => `${f.expert.label}: ${f.message}`).join("; ")}`);
    }

    const digestParts = verdicts.map(
      (entry) =>
        `### 「${entry.expert.label}」（\`${routeOf(entry.expert)}\` · 编队 \`${entry.memberName || entry.childId.slice(0, 8)}\` · ${entry.telemetry?.steps ?? 0} 步 / 工具 ${entry.telemetry?.totalTools ?? 0} 次 · 状态 ${entry.stopReason}）\n${entry.text || "（无文本输出）"}`,
    );
    if (failures.length > 0) {
      digestParts.push(`### 未能完成会诊的专家\n${failures.map((f) => `- ${f.expert.label}: ${f.message}`).join("\n")}`);
    }

    let reviewText = "";
    let reviewChildId;
    if (config.crossReview && verdicts.length >= 1) {
      try {
        // Build peer-to-peer relay messages from each panelist to the reviewer
        // so `dsh-context` Fleet Comms shows genuine `panelist -> reviewer` edges!
        const incomingRelays = verdicts.map((v) => ({
          senderSessionId: v.childId,
          senderName: v.memberName || v.expert.label,
          text: `【${v.expert.label} 独立会诊报告（${v.telemetry?.steps ?? 0} 步 / 工具 ${v.telemetry?.totalTools ?? 0} 次）】\n${truncateText(v.text || "（无文本输出）", 1800)}`,
        }));

        const review = await runExpert({
          parent,
          expert: config.reviewer,
          tier: "panel",
          roleTag: "review",
          stageLabel: "交叉互审",
          readOnly: true,
          label: `${RUN_LABEL_PREFIX}·互审·${config.reviewer.label}`,
          promptBlocks: [{ type: "text", text: crossReviewPrompt(config, packet, verdicts) }],
          signal,
          contextMode,
          runId,
          taskId: reviewTask?.id,
          writeScopes,
          incomingRelays,
        });
        reviewText = review.text;
        reviewChildId = review.childId;
        telemetryRecords.push(review.telemetryRecord);
      } catch (error) {
        reviewText = `（交叉互审未能完成：${error instanceof Error ? error.message : String(error)}）`;
      }
    }

    const panelDigest = [
      ...digestParts,
      reviewText ? `### 交叉互审与收敛结论（由「${config.reviewer.label}」汇总）\n${reviewText}` : "",
      guidance ? `### 用户附加指示\n${guidance}` : "",
    ]
      .filter((part) => part !== "")
      .join("\n\n");

    const expertsUsed = [...verdicts.map((v) => v.expert), ...(reviewText ? [config.reviewer] : [])];
    const childIds = [...verdicts.map((v) => v.childId), ...(reviewChildId ? [reviewChildId] : [])];
    const stopReasons = [
      ...verdicts.map((v) => `${v.expert.label}:${v.stopReason}`),
      ...(reviewChildId ? [`互审(${config.reviewer.label}):completed`] : []),
    ];
    let finalText = reviewText || verdicts.map((v) => v.text).join("\n\n---\n\n");

    // ③ 终裁定稿：把「互审收敛方案」交给终裁专家做最终把关并下发指派单。
    // 这是多轮评审流程的固定第三轮，不再是「升级」或「可选旁路」。
    if (enableArbiter) {
      try {
        const arbiter = await runFinalTier({
          parent,
          packet,
          panelDigest,
          signal,
          contextMode,
          runId,
          guidance,
          writeScopes,
          problemSummary,
        });
        expertsUsed.push(config.finalExpert);
        childIds.push(...arbiter.childIds);
        stopReasons.push(...arbiter.stopReasons);
        telemetryRecords.push(...arbiter.telemetryRecords);
        finalText = arbiter.finalText || finalText;
      } catch (error) {
        const note = `（③ 终裁定稿未能完成：${error instanceof Error ? error.message : String(error)}）`;
        finalText = `${note}\n\n${finalText}`;
      }
    }

    return {
      expertsUsed,
      childIds,
      stopReasons,
      panelDigest,
      finalText,
      failures,
      telemetryRecords,
    };
  }

  /** Tier 3: the expensive final arbiter, fed with the panel digest when available. */
  async function runFinalTier({ parent, packet, panelDigest, signal, contextMode, runId, guidance, writeScopes, problemSummary }) {
    const shortTopic = truncateSimple(problemSummary || guidance || "终裁攻坚", 80);
    const result = await runExpert({
      parent,
      expert: config.finalExpert,
      tier: "final",
      roleTag: "final",
      stageLabel: "终裁攻坚",
      readOnly: false,
      label: `${RUN_LABEL_PREFIX}·终裁·${config.finalExpert.label}`,
      promptBlocks: [{ type: "text", text: finalArbiterPrompt(config, packet, panelDigest) }],
      signal,
      contextMode,
      runId,
      writeScopes,
      taskSubject: `[终裁接管] ${config.finalExpert.label}：${shortTopic}`,
      taskDescription: `由终裁专家 ${config.finalExpert.label} 接管核心疑难卡点并下发后续工作部署指派单。`,
    });
    return {
      expertsUsed: [config.finalExpert],
      childIds: [result.childId],
      stopReasons: [`${result.expert.label}:${result.stopReason}`],
      finalText: result.text,
      guidance,
      telemetryRecords: [result.telemetryRecord],
    };
  }

  // ---- scoped setup for expert child agents ----
  ctx.on(
    "agent/created",
    ({ agent }) => {
      const meta = expertChildren.get(agent.id);
      if (!meta) return;

      meta.session = agent.session;
      meta.startSeq = agent.session.seq;

      const existing = childScopedDisposers.get(agent.id);
      if (existing) existing();

      const disposeScoped = agent.ctx.effect(() => {
        const cleanups = [];
        const candidates = meta.readOnly
          ? [...DELEGATION_DENY_CANDIDATES, ...WRITE_DENY_CANDIDATES]
          : [...DELEGATION_DENY_CANDIDATES];
        const deny = candidates.filter((toolName) => ctx.tools.get(toolName) !== undefined);
        if (deny.length > 0) {
          try {
            cleanups.push(agent.ctx.tools.restrict({ deny }));
          } catch {
            // the guard below still enforces the restriction
          }
        }
        const expert = expertFromMeta(config, meta);
        cleanups.push(
          agent.ctx.systemPrompt.section({
            name: SECTION_NAME,
            order: SECTION_ORDER,
            interpolate: false,
            text: () => panelistRole(expert, meta.readOnly, meta),
          }),
        );

        // Track live step count and current tool in real time for the UI panel & step budget guard.
        // (Note: never append extra items to `next-turn` here, as that would trigger multiple turns!)
        const offEvent = agent.ctx.on("session/event", (_sess, ev) => {
          if (!ev || typeof ev !== "object") return;
          if (ev.type === "step/start") {
            meta.liveSteps = (meta.liveSteps ?? 0) + 1;
            const budget = meta.maxSteps ?? 20;
            const nudgeAt = Math.max(3, Math.floor(budget * 0.6));
            if (!meta.nudged && meta.liveSteps >= nudgeAt) {
              meta.nudged = true;
              try {
                agent.inject(
                  deepFreeze({
                    id: randomUUID(),
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text: `⏳ [专家团调度提示] 你已用掉约 ${meta.liveSteps}/${budget} 步预算。请从下一步开始收口：先把当前的根因判断与修复方案写成结构化结论（哪怕标注「暂定/待验证」），再决定是否继续深挖；务必留至少 2 步用于输出最终《裁决与后续工作部署指派单》。`,
                      },
                    ],
                    source: { kind: "plugin:expert-panel" },
                  }),
                );
              } catch {
                /* ignore */
              }
            }
          } else if (ev.type === "tool/call") {
            meta.currentTool = String(ev.data?.name ?? "");
          } else if (ev.type === "turn/end") {
            meta.currentTool = "";
          }
        });
        cleanups.push(offEvent);

        return () => {
          for (const fn of cleanups.reverse()) {
            try {
              fn();
            } catch {
              /* ignore teardown errors */
            }
          }
        };
      });
      childScopedDisposers.set(agent.id, disposeScoped);
    },
    { global: true },
  );

  ctx.on(
    "agent/disposed",
    ({ agent }) => {
      const disposeScoped = childScopedDisposers.get(agent.id);
      if (disposeScoped) {
        childScopedDisposers.delete(agent.id);
        try {
          disposeScoped();
        } catch {
          /* ignore */
        }
      }
      // Note: we deliberately keep `expertChildren.get(agent.id)` when an expert
      // child finishes a turn and parks idle, so a later coldResume via
      // `send_message` or `followup_target` restores its persona and guards!
      const controllers = manualControllers.get(agent.id);
      if (controllers) {
        manualControllers.delete(agent.id);
        for (const controller of controllers) controller.abort(new Error("parent agent disposed"));
      }
    },
    { global: true },
  );

  ctx.effect(() => () => {
    for (const disposeScoped of childScopedDisposers.values()) {
      try {
        disposeScoped();
      } catch {
        /* ignore */
      }
    }
    childScopedDisposers.clear();
    expertChildren.clear();
    for (const controllers of manualControllers.values()) {
      for (const controller of controllers) controller.abort(new Error("expert-panel plugin unloaded"));
    }
    manualControllers.clear();
  });

  // ---- monotonic guard: no recursion, no writes in read-only tiers, and hard step budget ceiling ----
  ctx.tools.guard((exec) => {
    const caller = exec.agent;
    if (!caller) return undefined;
    const meta = expertChildren.get(caller.id);
    if (!meta) return undefined;
    if (DELEGATION_DENY_CANDIDATES.includes(exec.name)) {
      return `专家团子会话内禁止调用 \`${exec.name}\`（防止递归召集与额外配额消耗）。你可以通过 \`send_message({ target: "lead", message: "..." })\` 与主控通信，并直接给出你的诊断或完成关键修改。`;
    }
    if (meta.readOnly && WRITE_DENY_CANDIDATES.includes(exec.name)) {
      return `当前专家处于【只读会诊】层级，禁止调用 \`${exec.name}\`。请把精确到文件与行号的方案写进结论，交由主力模型执行。`;
    }
    const maxSteps = meta.maxSteps ?? config.maxStepsPerExpert ?? 30;
    if (
      ((meta.liveSteps ?? 0) >= maxSteps || meta.timeBudgetLocked) &&
      exec.name !== "send_message" &&
      exec.name !== "team_task_update"
    ) {
      const reason = meta.timeBudgetLocked
        ? `单次专家运行有效时长已达安全预算上限的 70%`
        : `已达到单次专家运行步数预算上限（${maxSteps} 步）`;
      return `⚠️ ${reason}，为避免主会话长时间挂起或被硬中断丢失结论，系统已锁定后续工具调用。请立即基于目前已掌握的代码证据直接输出最终《专家团裁决与后续工作部署指派单》，将剩余编码与测试交回主力模型执行！`;
    }
    return undefined;
  });

  // ---- system prompt section ----
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    interpolate: false,
    text: (context) => {
      loadPersistedSettings(config);
      const agent = context?.agent;
      if (agent && expertChildren.has(agent.id)) {
        const meta = expertChildren.get(agent.id);
        const expert = expertFromMeta(config, meta);
        return panelistRole(expert, meta.readOnly, meta);
      }
      return buildMainAgentPromptSection(config);
    },
  });

  // ---- natural language & @mention trigger detector ----
  if (typeof ctx.systemPrompt.context === "function") {
    ctx.systemPrompt.context({
      name: `${SECTION_NAME}:trigger`,
      order: 950,
      interpolate: false,
      text: (context) => {
        const agent = context?.agent;
        if (!agent || expertChildren.has(agent.id)) return "";
        const events = agent.session?.snapshotEvents?.() ?? [];
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i];
          if (ev?.type !== "user/message") continue;
          const sk = ev.data?.source?.kind ?? "";
          if (sk && sk !== "user") continue;
          const txt = extractTextFromBlocks(ev.data?.content);
          if (!txt || txt.startsWith("<system-reminder>") || txt.startsWith("<hindsight_")) continue;
          if (
            /@(专家团|专家|argon|expert)/i.test(txt) ||
            /(请|让|调用|启动|召唤|使用|找).{0,6}(专家团|专家|argon)/i.test(txt) ||
            /(专家团|专家|argon).{0,6}(会诊|接管|审核|看看|诊断|分析|处理|启动)/i.test(txt)
          ) {
            loadPersistedSettings(config);
            return `⚡ [系统检测到用户通过 @ 或自然语言召唤专家]：用户已在最新消息中要求启动专家机制。请在本步立即调用 \`${TOOL_NAME}\` 工具（无需挑选模型或模式，系统会按「专家团 UI」配好的阵容走固定流程：① 独立取证 → ② 交叉互审${config.enableArbiter !== false ? " → ③ 终裁定稿" : ""}，并向用户弹出极简一键确认卡）！`;
          }
          break;
        }
        return "";
      },
    });
  }

  // ---- model-facing escalation tool ----
  ctx.tools.register({
    name: TOOL_NAME,
    description:
      "Request the multi-round review Expert Panel on a high-difficulty problem, or ask a follow-up question to an existing expert subagent. There is exactly one pipeline: ① several experts gather independent evidence in parallel (read-only) → ② a reviewer cross-examines every claim and converges a plan → ③ the arbiter issues the final work dispatch (toggleable in the Expert Panel UI). No single-expert or in-session takeover modes exist. Returns a structured dispatch with an unforgeable execution telemetry ledger. To continue conversing with an already-summoned expert, pass `followup_target` and `followup_question`.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["category", "problem_summary", "attempted_steps"],
      properties: {
        category: {
          type: "string",
          enum: ["stuck_bug", "architecture", "multimodal_ui", "algorithm_security", "red_team_review"],
          description:
            "Why this warrants the panel: stuck_bug (>=2 failed attempts or elusive bug), architecture (cross-module design/refactor), multimodal_ui (visual/UI/canvas inspection), algorithm_security (complex algorithm/concurrency/security proof), or red_team_review (critical review before risky changes).",
        },
        problem_summary: {
          type: "string",
          description: "Clear, self-contained summary of the core problem, exact error messages, and what is blocking progress.",
        },
        attempted_steps: {
          type: "string",
          description: "Concrete investigation and fix attempts you already made, and why they failed or remained inconclusive.",
        },
        relevant_files: {
          type: "array",
          items: { type: "string" },
          description: "Workspace-relative or absolute paths of the key files the experts should inspect first.",
        },
        note: {
          type: "string",
          description: "Optional free-form note for the panel. There is no mode/tier parameter: every request runs the fixed multi-round review pipeline (① independent evidence → ② cross-review → ③ arbiter verdict, the last stage toggleable in the Expert Panel UI).",
        },
        expected_deliverable: {
          type: "string",
          description: "Specific decision, fix, or step-by-step work breakdown you need the panel to hand back.",
        },
        followup_target: {
          type: "string",
          description:
            "Optional: to ask a multi-turn follow-up question to an already-summoned expert subagent in this session, pass its team member name (e.g. `expert-panel-qwen38-max`), child session id prefix, or `last`.",
        },
        followup_question: {
          type: "string",
          description:
            "Optional: the follow-up question, challenge, or new verification evidence to send to `followup_target`.",
        },
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    presentCall(args) {
      if (isNonEmptyString(args?.followup_target) || isNonEmptyString(args?.followup_question)) {
        return {
          card: "generic",
          title: `⚡ 追问专家子代理 · ${args.followup_target || "最近专家"}`,
          kind: "other",
          content: [
            {
              type: "text",
              text: truncateText(String(args?.followup_question || args?.problem_summary || ""), 260),
            },
          ],
        };
      }
      const cat = CATEGORY_LABELS[args?.category] ?? args?.category ?? "疑难杂症会诊";
      const tier = config.enableArbiter !== false ? TIER_LABELS.review : TIER_LABELS.review_no_arbiter;
      const summary = String(args?.problem_summary ?? "").trim();
      const attempted = String(args?.attempted_steps ?? "").trim();
      const files = Array.isArray(args?.relevant_files) ? args.relevant_files.map((f) => String(f).trim()).filter(Boolean) : [];
      const body = [
        `**流程**：${tier}`,
        summary ? `**卡点**：${truncateText(summary, 200)}` : "",
        attempted ? `**已排查**：${truncateText(attempted, 160)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        card: "generic",
        title: `⚡ 申请专家团介入 · ${cat}`,
        kind: "other",
        ...(body ? { content: [{ type: "text", text: body }] } : {}),
        ...(files.length > 0 ? { locations: files.map((path) => ({ path })) } : {}),
      };
    },
    presentResult(args, result) {
      const files = new Set(
        Array.isArray(args?.relevant_files) ? args.relevant_files.map((f) => String(f).trim()).filter(Boolean) : [],
      );
      const text = extractTextFromBlocks(result?.content);
      const childMatches = text.matchAll(/`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/g);
      for (const m of childMatches) {
        const meta = expertChildren.get(m[1]);
        if (meta?.lastTelemetry) {
          for (const f of meta.lastTelemetry.filesWritten ?? []) files.add(f);
          for (const f of (meta.lastTelemetry.filesRead ?? []).slice(0, 6)) files.add(f);
        }
      }
      return {
        card: "generic",
        title: "⚡ 专家团裁决与工作部署（含子会话真实取证账本）",
        content: result.content,
        ...(files.size > 0 ? { locations: [...files].slice(0, 12).map((path) => ({ path })) } : {}),
      };
    },
    async execute(args, exec) {
      const caller = exec.agent;
      if (!caller) throw new Error(`${TOOL_NAME} requires an active calling agent.`);
      if (expertChildren.has(caller.id)) throw new Error("当前已处于专家团子会话内，禁止再次召集专家团。");

      const rootAgent = resolveRootAgent(ctx, caller) ?? caller;
      const stats = statsFor(rootAgent.id);

      // Multi-turn follow-up branch: wake an existing expert session directly!
      if (isNonEmptyString(args.followup_target) || isNonEmptyString(args.followup_question)) {
        const question = String(args.followup_question || args.problem_summary || "").trim();
        if (!question) throw new Error("多轮追问时必须提供非空的 followup_question 或 problem_summary。");
        stats.calls += 1;
        stats.followups += 1;
        const runId = beginRun(rootAgent.id, "followup", []);
        try {
          const outcome = await runFollowupExpert({
            parent: caller,
            targetSpec: args.followup_target || args.expert || "last",
            question,
            signal: exec.signal,
            runId,
          });
          endRun(runId, "done", [outcome.telemetryRecord]);
          return formatDispatch({
            tier: "followup",
            expertsUsed: [outcome.expert],
            stopReasons: [`${outcome.expert.label}:${outcome.stopReason}`],
            finalText: outcome.text,
            config,
            userGuidance: `追问 \`${outcome.memberName || outcome.childId.slice(0, 8)}\`：${truncateText(question, 160)}`,
            childIds: [outcome.childId],
            telemetryRecords: [outcome.telemetryRecord],
          });
        } catch (error) {
          endRun(runId, "error");
          throw error;
        }
      }

      const category = args.category ?? "stuck_bug";
      const problemSummary = String(args.problem_summary ?? "").trim();
      const attemptedSteps = String(args.attempted_steps ?? "").trim();
      const relevantFiles = Array.isArray(args.relevant_files)
        ? args.relevant_files.map((f) => String(f).trim()).filter(Boolean)
        : [];
      const expectedDeliverable = args.expected_deliverable ? String(args.expected_deliverable).trim() : undefined;
      if (!problemSummary || !attemptedSteps) throw new Error("必须提供非空的 problem_summary 与 attempted_steps。");

      // Always sync the latest settings configured in the Expert Panel UI page!
      loadPersistedSettings(config);

      // 唯一流程：多轮评审。是否启用第 ③ 轮终裁由 UI 开关决定，不再有模式选择。
      const enableArbiter = config.enableArbiter !== false;
      const tier = enableArbiter ? "review" : "review_no_arbiter";
      let selectedPanelists;
      let userGuidance = "";
      let contextMode = config.defaultContextMode;

      const userQuestions = ctx.get("userQuestions");

      if (config.requireApproval && userQuestions && rootAgent) {
        const OPT_CONFIRM = "✅ 确认启动（按专家团 UI 预设执行） (Recommended)";
        const OPT_REJECT = "❌ 暂不启动（让当前模型继续处理）";

        const activePanelList = config.panelists
          .slice(0, Math.max(1, config.maxPanelists))
          .map((e) => e.label)
          .join(" + ");
        const presetSummary = [
          `① 独立取证 · **${activePanelList || config.finalExpert.label}**`,
          `② 交叉互审 · **${config.reviewer.label}**`,
          enableArbiter ? `③ 终裁定稿 · **${config.finalExpert.label}**` : `③ 终裁 · 已关闭（只跑前两轮）`,
        ].join(" → ");

        const filesLine = relevantFiles.length > 0 ? `\n文件：${relevantFiles.slice(0, 4).join("、")}` : "";
        const questionText = [
          `**${CATEGORY_LABELS[category] ?? category}**`,
          `预设方案：${presetSummary}`,
          `卡点：${truncateText(problemSummary, 180)}`,
          `已排查：${truncateText(attemptedSteps, 140)}${filesLine}`,
        ].join("\n");

        const outcome = await askWithTimeout(
          userQuestions,
          {
            agent: rootAgent,
            signal: exec.signal,
            questions: [
              {
                id: "expert_confirm",
                header: "⚡ 专家团启动确认",
                question: questionText,
                options: [
                  {
                    label: OPT_CONFIRM,
                    description: `直接按你在「专家团 UI 页面」设定的模式与模型阵容执行（无需每次手动挑模型）。`,
                  },
                  {
                    label: OPT_REJECT,
                    description: "取消本次专家介入，不消耗专家配额，让当前模型继续排查。",
                  },
                ],
                multiSelect: false,
              },
            ],
          },
          config.approvalTimeoutSeconds * 1000,
        );

        if (outcome.kind === "timeout") {
          return [
            `## ⏳ 专家团调用申请等待超时（未消耗任何专家配额）`,
            "",
            `确认卡片等待 ${config.approvalTimeoutSeconds} 秒未收到响应，本次申请已安全取消。`,
          ].join("\n");
        }

        const answers = outcome.answer?.answers ?? [];
        const confirmAnswer = answers.find((item) => item.id === "expert_confirm") ?? answers[0];
        const chosen = confirmAnswer?.selected?.[0] ?? "";
        const customText = typeof confirmAnswer?.custom === "string" ? confirmAnswer.custom.trim() : "";
        userGuidance = customText;

        if (chosen === OPT_REJECT || (customText && /^(拒绝|不用|不要|取消|no|reject)/iu.test(customText))) {
          return [
            `# ❌ 用户已取消本次专家团启动（未消耗任何专家配额）`,
            "",
            customText
              ? `- **用户给你的排查指示**：${customText}`
              : `- **用户指示**：暂不启动专家团，请继续用当前模型深入排查。`,
          ].join("\n");
        }
        if (chosen !== OPT_CONFIRM && !customText) {
          return [
            `# ⏸️ 用户未确认专家团启动（未消耗任何专家配额）`,
            "",
            `确认卡片已关闭或被跳过，未获得明确授权，因此不启动专家团。`,
          ].join("\n");
        }
      }

      const writeScopes = normalizeWriteScopes(relevantFiles, rootAgent.session?.header?.cwd);
      const packet = buildProblemPacket({
        tier,
        category,
        problemSummary,
        attemptedSteps,
        relevantFiles,
        expectedDeliverable,
        userGuidance,
        sessionDigest: buildLiveSessionDigest(caller.session, config.maxDigestEvents),
        includeDigest: true,
      });

      stats.calls += 1;

      const activePanel = selectedPanelists ?? config.panelists.slice(0, config.maxPanelists);
      const runId = beginRun(rootAgent.id, tier, activePanel);
      try {
        const outcome = await runReviewPipeline({
          parent: caller,
          packet,
          signal: exec.signal,
          contextMode,
          runId,
          guidance: userGuidance,
          selectedPanelists,
          writeScopes,
          problemSummary,
          enableArbiter,
        });
        if (enableArbiter) stats.finalRuns += 1;
        else stats.panelRuns += 1;
        endRun(runId, "done", outcome.telemetryRecords);
        return formatDispatch({ tier, config, userGuidance, ...outcome });
      } catch (error) {
        endRun(runId, "error");
        throw error;
      }
    },
  });

  // ---- human command: /expert (with /argon kept as an alias) ----
  async function handleCommand(invocation) {
    const parent = invocation.agent;
    const root = resolveRootAgent(ctx, parent) ?? parent;
    const parsed = parseExpertCommand(invocation.rawInput);

    if (parsed.kind === "status") {
      const stats = sessionStats.get(root.id) ?? { calls: 0, panelRuns: 0, finalRuns: 0, followups: 0 };
      const recent = [...runs.values()]
        .filter((run) => run.parentId === root.id)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 6);
      const summonedExperts = [...expertChildren.values()]
        .filter((m) => m.rootId === root.id || m.parentId === root.id)
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
        .slice(0, 8);
      return {
        kind: "success",
        text: [
          `⚡ 专家团 (@local/expert-panel v2.1 · 编队/任务/通讯全链路融合)`,
          ``,
          `### 名册`,
          ...rosterLines(config).map((line) => `- ${line}`),
          `- 交叉互审由：${config.reviewer.label} 承担`,
          ``,
          `### 策略`,
          `- ① 独立取证并行专家数：${config.maxPanelists} 位；② 交叉互审：固定开启；③ 终裁定稿：${config.enableArbiter !== false ? "开启" : "关闭"}`,
          `- 固定流程：① 独立取证 → ② 交叉互审${config.enableArbiter !== false ? ` → ③ 终裁定稿（${config.finalExpert.label}）` : "（终裁已关闭）"}`,
          `- 上下文模式：${config.defaultContextMode === "fork" ? "fork（继承完整历史）" : "digest（精简实时摘要）"}`,
          `- 模型主动申请审批门禁：${config.requireApproval ? "开启" : "关闭"}（超时 ${config.approvalTimeoutSeconds}s 自动取消）`,
          ``,
          `### 本会话统计与已驻留专家（支持多轮追问）`,
          `- 申请/召集次数：${stats.calls}；专家团会诊：${stats.panelRuns}；终裁：${stats.finalRuns}；多轮追问：${stats.followups ?? 0}`,
          summonedExperts.length === 0
            ? `- 尚无已召集的专家子会话`
            : `- 本会话已召集的专家（可用 \`/${COMMAND_NAME} ask <代号> <问题>\` 或 \`send_message\` 追问）：\n${summonedExperts
                .map(
                  (m) =>
                    `  - \`${m.memberName || m.childId.slice(0, 8)}\` (${m.expertLabel} · \`${m.expertRoute}\`)${m.taskId ? ` · 任务 \`${m.taskId}\`` : ""}${m.lastTelemetry ? ` · ${m.lastTelemetry.steps} 步 / 工具 ${m.lastTelemetry.totalTools} 次` : ""}`,
                )
                .join("\n")}`,
          recent.length === 0
            ? ``
            : `- 最近运行批次：\n${recent.map((run) => `  - #${run.runId} [${run.tier}] ${run.status} · ${run.experts.join("、")}`).join("\n")}`,
          ``,
          `### 命令`,
          `- /${COMMAND_NAME} <问题描述>                召集专家团会诊（便宜专家并行 + 互审，不动用终裁）`,
          `- /${COMMAND_NAME} solo <专家> <问题>         指定一位专家直接接管`,
          `- /${COMMAND_NAME} final <问题>               直接召集终裁专家接管（最贵）`,
          `- /${COMMAND_NAME} ask <专家代号|last> <问题>  向本会话已召集的专家发起第 2+ 轮深度追问`,
          `- /${COMMAND_NAME} routes                     列出当前真实可用的模型路由`,
          `- 任意命令后加 --fork                         让专家继承本会话完整历史`,
        ]
          .filter((line) => line !== "")
          .join("\n"),
      };
    }

    if (parsed.kind === "routes") {
      const llm = ctx.get("llm");
      if (!llm) return { kind: "error", text: "llm 服务不可用，无法列出模型路由。" };
      const providers = llm.listProviders();
      const lines = [];
      for (const provider of providers) {
        let models = [];
        try {
          models = await llm.listModels(provider.id);
        } catch {
          models = [];
        }
        lines.push(`- **${provider.id}** — ${provider.name}`);
        for (const model of models) lines.push(`    - \`${provider.id}/${model.id}\` · ${model.name}`);
      }
      return {
        kind: "success",
        text: [
          `### 当前可用模型路由（用于配置专家库 panelists）`,
          lines.length > 0 ? lines.join("\n") : "（没有已注册的 provider）",
          ``,
          `提示：目录仅供参考，适配器也可能接受未列出的模型 id。把选中的路由写进插件配置的 \`panelists\` 即可加入专家库。`,
        ].join("\n"),
      };
    }

    if (parsed.kind === "followup") {
      const targetSpec = parsed.target || "last";
      const question = parsed.question || "请结合最新进展进一步核查你此前的诊断，并给出补充方案。";
      const meta = resolveExistingExpertChild(root.id, targetSpec);
      if (!meta) {
        return {
          kind: "error",
          text: `未找到可追问的专家子会话（目标: "${targetSpec}"）。请先使用 \`/${COMMAND_NAME} <问题>\` 召集专家团，或用 \`/${COMMAND_NAME} status\` 查看代号。`,
        };
      }
      const stats = statsFor(root.id);
      stats.calls += 1;
      stats.followups = (stats.followups ?? 0) + 1;

      const controller = new AbortController();
      let controllers = manualControllers.get(root.id);
      if (!controllers) {
        controllers = new Set();
        manualControllers.set(root.id, controllers);
      }
      controllers.add(controller);

      const expert = expertFromMeta(config, meta);
      const runId = beginRun(root.id, "followup", [expert]);

      runFollowupExpert({
        parent,
        targetSpec,
        question,
        signal: controller.signal,
        runId,
      })
        .then((outcome) => {
          endRun(runId, "done", [outcome.telemetryRecord]);
          const liveParent = ctx.get("agents")?.get(parent.id);
          if (!liveParent || liveParent !== parent) return;
          const text = formatDispatch({
            tier: "followup",
            expertsUsed: [outcome.expert],
            stopReasons: [`${outcome.expert.label}:${outcome.stopReason}`],
            finalText: outcome.text,
            config,
            userGuidance: `追问 \`${outcome.memberName || outcome.childId.slice(0, 8)}\`：${question}`,
            childIds: [outcome.childId],
            telemetryRecords: [outcome.telemetryRecord],
          });
          const message = createWakingUserMessage(text);
          if (liveParent.status === "running") liveParent.steer(message);
          else liveParent.followup(message);
        })
        .catch((error) => {
          endRun(runId, "error");
          const liveParent = ctx.get("agents")?.get(parent.id);
          if (!liveParent || liveParent !== parent) return;
          const message = createWakingUserMessage(
            `[⚡ 专家团追问异常] 追问 #${runId} 未能完成：${error instanceof Error ? error.message : String(error)}。`,
          );
          if (liveParent.status === "running") liveParent.steer(message);
          else liveParent.followup(message);
        })
        .finally(() => {
          controllers.delete(controller);
        });

      return {
        kind: "success",
        text: `⚡ 已向专家 \`${meta.memberName || meta.childId.slice(0, 8)}\`（${expert.label}）发送第 2+ 轮追问（运行编号 #${runId}），完成后将自动汇总回主会话并更新编队通讯记录。`,
      };
    }

    const contextMode = parsed.contextMode ?? config.defaultContextMode;
    const instruction =
      parsed.instruction ||
      "请结合当前会话上下文与最近遇到的卡点进行会诊/接管，并输出《专家团裁决与后续工作部署指派单》。";

    const packet = buildProblemPacket({
      tier,
      category: "stuck_bug",
      problemSummary: instruction,
      attemptedSteps: `（由用户通过 /${COMMAND_NAME} 手动召集，请参考下方主会话实时摘要与共享任务板了解此前进展）`,
      relevantFiles: [],
      expectedDeliverable: "完成会诊/接管，并输出结构化的《后续工作部署指派单》交由主力模型自动接力继续。",
      userGuidance: instruction,
      sessionDigest: buildLiveSessionDigest(parent.session, config.maxDigestEvents),
      includeDigest: true,
    });

    const promptBlocks = [
      ...(Array.isArray(invocation.attachments) ? invocation.attachments : []),
      { type: "text", text: packet },
    ];

    const stats = statsFor(root.id);
    stats.calls += 1;

    const controller = new AbortController();
    let controllers = manualControllers.get(root.id);
    if (!controllers) {
      controllers = new Set();
      manualControllers.set(root.id, controllers);
    }
    controllers.add(controller);

    const enableArbiter = config.enableArbiter !== false;
    const tier = enableArbiter ? "review" : "review_no_arbiter";
    const experts = config.panelists.slice(0, Math.max(1, config.maxPanelists));
    const runId = beginRun(root.id, tier, experts);

    const kickoff = (async () => {
      try {
        return await runReviewPipeline({
          parent,
          packet,
          signal: controller.signal,
          contextMode,
          runId,
          guidance: instruction,
          problemSummary: instruction,
          enableArbiter: config.enableArbiter !== false,
        });
      } finally {
        controllers.delete(controller);
      }
    })();

    kickoff
      .then((outcome) => {
        if (config.enableArbiter !== false) stats.finalRuns += 1;
        else stats.panelRuns += 1;
        endRun(runId, "done", outcome.telemetryRecords);

        const liveParent = ctx.get("agents")?.get(parent.id);
        if (!liveParent || liveParent !== parent) return;
        const text = formatDispatch({
          tier,
          expertsUsed: outcome.expertsUsed ?? [],
          stopReasons: outcome.stopReasons ?? [],
          panelDigest: outcome.panelDigest,
          finalText: outcome.finalText,
          config,
          userGuidance: instruction,
          childIds: outcome.childIds ?? [],
          telemetryRecords: outcome.telemetryRecords ?? [],
        });
        const message = createWakingUserMessage(text);
        if (liveParent.status === "running") liveParent.steer(message);
        else liveParent.followup(message);
      })
      .catch((error) => {
        endRun(runId, "error");
        const liveParent = ctx.get("agents")?.get(parent.id);
        if (!liveParent || liveParent !== parent) return;
        const message = createWakingUserMessage(
          `[⚡ 专家团运行异常] 召集 #${runId}（${tier}）未能完成：${error instanceof Error ? error.message : String(error)}。请主力模型继续处理当前任务。`,
        );
        if (liveParent.status === "running") liveParent.steer(message);
        else liveParent.followup(message);
      });

    const expertNames = experts.map((expert) => expert.label).join("、");
    return {
      kind: "success",
      text: [
        `⚡ 已召集专家团（运行编号 #${runId}，层级：${TIER_LABELS[tier] ?? tier}）`,
        `- 参与专家：${expertNames}`,
        `- 上下文模式：${contextMode === "fork" ? "fork（继承完整历史）" : "digest（精简实时摘要）"}`,
        `- 编队联动：已自动在「编队（Fleet）」注册队友身份与共享任务链，并在「通讯（Comms）」实时同步回报`,
        ``,
        `你可以在「编队」或「专家团」页签实时查看每位专家的推理、工具调用与通讯；全部结束后会自动下发《后续工作部署指派单》并唤醒主模型接力继续。`,
        `流程：① 独立取证（${experts.map((e) => e.label).join(" + ")}）→ ② 交叉互审（${config.reviewer.label}）${config.enableArbiter !== false ? ` → ③ 终裁定稿（${config.finalExpert.label}）` : "（终裁已关闭）"}`,
      ]
        .filter((line) => line !== "")
        .join("\n"),
    };
  }

  ctx.inject(["commands"], (cmdCtx) => {
    const definition = {
      description:
        "召集专家团会诊、单专家接管或多轮追问：便宜专家并行诊断并交叉互审，全链路接入 DSH 编队/任务/通讯视图，必要时才升级到 Argon 终裁",
      input: {
        hint: "[<问题描述> | solo <专家> <问题> | final <问题> | ask <专家代号|last> <追问> | routes | status] [--fork]",
        attachments: true,
      },
      handler: handleCommand,
    };
    cmdCtx.commands.register({ name: COMMAND_NAME, ...definition });
    cmdCtx.commands.register({ name: LEGACY_COMMAND_NAME, ...definition });
  });

  // Register loopback HTTP management & cross-workspace history API (/expert-panel/api/*)
  registerExpertPanelHttp(ctx, { config, expertChildren, manualControllers, handleCommand });
}

// The Loader resolves a plugin's runtime from its default export when one is
// present, and DSH's Config projection reads `runtime.Config`. A default object
// that omits `Config` therefore hides the schema: the row shows up as "absent"
// and no settings form is generated. Keep `Config` on both shapes so the schema
// is visible regardless of which object the Loader adopts.
export default { name, inject, apply, Config };
