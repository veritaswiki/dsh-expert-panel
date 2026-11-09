import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const LABEL_PREFIX = "⚡专家团";

function parseRunLabel(label) {
  const rest = String(label ?? "").slice(LABEL_PREFIX.length);
  const parts = rest.split("·").map((p) => p.trim()).filter(Boolean);
  return { tier: parts[0] ?? "会诊", expert: parts.slice(1).join(" · ") || "未知专家" };
}

function dshRootDir() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(os.homedir(), ".dsh");
}

function settingsFilePath() {
  return path.join(dshRootDir(), "state", "expert-panel-settings.json");
}

function sanitizeExpert(raw, fallback) {
  if (!raw || typeof raw !== "object") return fallback;
  const provider = typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : fallback?.provider;
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : fallback?.model;
  if (!provider || !model) return fallback;
  const label =
    typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim()
      : fallback?.label || model.split("/").pop() || model;
  const out = { label, provider, model };
  if (typeof raw.reasoningEffort === "string" && raw.reasoningEffort.trim()) {
    out.reasoningEffort = raw.reasoningEffort.trim();
  }
  return out;
}

export function loadPersistedSettings(config) {
  const file = settingsFilePath();
  if (!fs.existsSync(file)) return config;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    applySettingsPatch(config, saved);
  } catch {
    // ignore malformed state file
  }
  return config;
}

export function applySettingsPatch(config, patch) {
  if (!patch || typeof patch !== "object") return config;
  if (typeof patch.enableArbiter === "boolean") {
    config.enableArbiter = patch.enableArbiter;
  }
  if (patch.finalExpert && typeof patch.finalExpert === "object") {
    config.finalExpert = sanitizeExpert(patch.finalExpert, config.finalExpert);
  }
  // 单专家 / 原地接管模式已移除，旧配置里的 soloExpert 直接忽略。
  if (patch.workerModel && typeof patch.workerModel === "object") {
    config.workerModel = sanitizeExpert(patch.workerModel, config.workerModel);
  }
  if (patch.reviewer && typeof patch.reviewer === "object") {
    config.reviewer = sanitizeExpert(patch.reviewer, config.reviewer);
  }
  if (Array.isArray(patch.panelists)) {
    const cleaned = patch.panelists
      .map((item, idx) => sanitizeExpert(item, { label: `专家 ${idx + 1}`, provider: "magpie", model: "" }))
      .filter((item) => item && item.provider && item.model);
    if (cleaned.length > 0) config.panelists = cleaned;
  }
  // 交叉互审是多轮评审的固定第 ② 轮，不再可关闭。
  if (typeof patch.requireApproval === "boolean") {
    config.requireApproval = patch.requireApproval;
  }
  if (Number.isInteger(patch.maxStepsPerExpert) && patch.maxStepsPerExpert >= 4 && patch.maxStepsPerExpert <= 60) {
    config.maxStepsPerExpert = patch.maxStepsPerExpert;
  }
  if (Number.isInteger(patch.expertTimeoutSeconds) && patch.expertTimeoutSeconds >= 30 && patch.expertTimeoutSeconds <= 3600) {
    config.expertTimeoutSeconds = patch.expertTimeoutSeconds;
  }
  return config;
}

export function savePersistedSettings(config, patch) {
  applySettingsPatch(config, patch);
  const file = settingsFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          enableArbiter: config.enableArbiter !== false,
          finalExpert: config.finalExpert,

          workerModel: config.workerModel ?? {
            label: "DeepSeek 4.1 Flash",
            provider: "magpie",
            model: "seoul/auto/deepseek-v4.1-flash",
          },
          panelists: config.panelists,
          reviewer: config.reviewer,

          requireApproval: config.requireApproval,

          maxStepsPerExpert: config.maxStepsPerExpert,
          expertTimeoutSeconds: config.expertTimeoutSeconds,
          updatedAt: Date.now(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // ignore write error
  }
  return config;
}

const projFileCache = new Map();

function loadAllProjCaches() {
  const dir = path.join(dshRootDir(), "storages", "session_projcache", "sessions");
  if (!fs.existsSync(dir)) return new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return new Map();
  }
  const byId = new Map();
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const id = file.slice(0, -5);
    try {
      const st = fs.statSync(fullPath);
      const cached = projFileCache.get(id);
      if (cached && cached.mtimeMs === st.mtimeMs) {
        byId.set(id, cached.data);
        continue;
      }
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      const rec = parsed?.record ?? {};
      const entry = {
        id,
        mtimeMs: st.mtimeMs,
        createdAt: rec.identity?.createdAt ?? 0,
        cwd: rec.identity?.cwd ?? "",
        rows: rec.rows ?? {},
      };
      projFileCache.set(id, { mtimeMs: st.mtimeMs, data: entry });
      byId.set(id, entry);
    } catch {
      // ignore unreadable cache file
    }
  }
  return byId;
}

async function collectAvailableModels(ctx, config) {
  const seen = new Map();
  const add = (item) => {
    if (!item || !item.provider || !item.model) return;
    const key = `${item.provider}/${item.model}`;
    if (!seen.has(key)) seen.set(key, item);
  };

  // Seed with configured models + common working routes
  add({ ...config.finalExpert, supportsEffort: true });

  if (config.reviewer) add(config.reviewer);
  for (const p of config.panelists ?? []) add(p);
  add({ label: "DeepSeek 4.1 Flash (日常主力)", provider: "magpie", model: "seoul/auto/deepseek-v4.1-flash" });
  add({ label: "Gemini 4 Argon（终裁）", provider: "magpie", model: "seoul/antigravity/gemini-4-argon", reasoningEffort: "high", supportsEffort: true });
  add({ label: "Qwen3.8-Max", provider: "magpie", model: "seoul/qoder/qmodel_38max" });
  add({ label: "Kimi-K3.1-Pro", provider: "magpie", model: "seoul/qoder/kmodel_latest" });
  add({ label: "GLM-5.3", provider: "magpie", model: "seoul/qoder/gmodel" });
  add({ label: "Gemini 3.8 Flash", provider: "magpie", model: "seoul/antigravity/gemini-3.8-flash", supportsEffort: true });

  const llm = ctx.get("llm");
  if (llm) {
    try {
      for (const prov of llm.listProviders()) {
        const models = await llm.listModels(prov.id).catch(() => []);
        for (const m of Array.isArray(models) ? models : []) {
          if (!m?.id) continue;
          // Filter out Claude models per user preference
          if (/claude/i.test(m.id) || /claude/i.test(m.name || "")) continue;
          add({
            label: m.name || m.id,
            provider: prov.id,
            model: m.id,
            supportsEffort: Array.isArray(m.reasoning?.efforts) && m.reasoning.efforts.length > 0,
          });
        }
      }
    } catch {
      /* ignore */
    }
  }
  return [...seen.values()];
}

async function buildStateSnapshot(ctx, { config, expertChildren }) {
  const byId = loadAllProjCaches();
  const liveAgents = ctx.get("agents");
  const runMap = new Map();

  for (const [parentId, parentRec] of byId.entries()) {
    const catValues = parentRec.rows?.subagentCatalog?.val?.head?.values;
    if (!Array.isArray(catValues)) continue;
    const parentTitle = parentRec.rows?.title?.val || parentId.slice(0, 8);
    const parentTeam = parentRec.rows?.agentTeam?.val ?? {};
    const teamMembers = Array.isArray(parentTeam.members) ? parentTeam.members : [];
    const teamTasks = Array.isArray(parentTeam.tasks) ? parentTeam.tasks : [];

    for (const item of catValues) {
      const label = item?.label;
      const childId = item?.childId ?? item?.id;
      if (typeof label !== "string" || !label.startsWith(LABEL_PREFIX) || !childId) continue;
      const childRec = byId.get(childId);
      const childRows = childRec?.rows ?? {};
      const stats = childRows.sessionStats?.val ?? {};
      const usage = childRows.tokenUsage?.val?.totals ?? {};
      const timing = childRows.subagentTiming?.val ?? {};
      const modelSel = childRows.modelSelection?.val?.lastUsed ?? {};
      const outline = Array.isArray(childRows.turnOutline?.val?.turns) ? childRows.turnOutline.val.turns : [];
      const lastTurn = outline.length > 0 ? outline[outline.length - 1] : null;

      const liveChild = liveAgents?.get(childId);
      const meta = expertChildren.get(childId);
      const isRunning = liveChild?.status === "running" || meta?.status === "running";

      const steps = Math.max(Number(stats.steps) || 0, Number(meta?.liveSteps) || 0);
      const turns = Number(stats.turns) || outline.length || 1;
      const totalTokens =
        (Number(usage.uncachedInputTokens) || 0) +
        (Number(usage.outputTokens) || 0) +
        (Number(usage.cacheReadTokens) || 0) +
        (Number(usage.cacheWriteTokens) || 0);
      const outputTokens = Number(usage.outputTokens) || 0;
      const durationMs =
        Number(timing.settledMs) ||
        (Number(stats.llmMs) || 0) + (Number(stats.toolMs) || 0) ||
        (meta?.startedAt ? Date.now() - meta.startedAt : 0);

      const member = teamMembers.find((m) => m && m.id === childId);
      const memberName = meta?.memberName || member?.name || "";
      const tasks = teamTasks
        .filter((t) => t && (t.ownerId === childId || (memberName && t.ownerName === memberName)))
        .map((t) => ({ id: t.id, status: t.status, subject: t.subject }));

      const route =
        meta?.expertRoute ||
        (modelSel.provider && modelSel.model ? `${modelSel.provider}/${modelSel.model}` : modelSel.model || "");

      runMap.set(childId, {
        childId,
        sessionId: parentId,
        sessionTitle: String(parentTitle),
        cwd: parentRec.cwd || childRec?.cwd || "",
        activity: isRunning ? "running" : meta?.status === "error" ? "error" : "completed",
        mode: item.mode ?? "continuable",
        createdAt: Number(item.childCreatedAt ?? item.createdAt ?? childRec?.createdAt) || 0,
        ...parseRunLabel(label),
        route,
        steps,
        maxSteps: meta?.maxSteps ?? config.maxStepsPerExpert ?? 18,
        currentTool: isRunning ? (meta?.currentTool || "") : "",
        turns,
        totalTokens,
        outputTokens,
        durationMs,
        completed: !isRunning && steps > 0,
        promptPreview: typeof lastTurn?.prompt === "string" ? lastTurn.prompt : "",
        responsePreview: typeof lastTurn?.response === "string" ? lastTurn.response : "",
        teamMemberName: memberName,
        teamTasks: tasks,
      });
    }
  }

  for (const [childId, meta] of expertChildren.entries()) {
    if (runMap.has(childId)) continue;
    const liveChild = liveAgents?.get(childId);
    const isRunning = liveChild?.status === "running" || meta.status === "running";
    const t = meta.lastTelemetry ?? {};
    runMap.set(childId, {
      childId,
      sessionId: meta.rootId || meta.parentId,
      sessionTitle: (meta.rootId || meta.parentId || "").slice(0, 8),
      cwd: "",
      activity: isRunning ? "running" : (meta.status || "completed"),
      mode: "continuable",
      createdAt: meta.startedAt || Date.now(),
      tier: meta.roleTag === "review" ? "互审" : meta.trigger === "final" ? "终裁" : meta.trigger === "solo" ? "接管" : "会诊",
      expert: meta.expertLabel || "专家",
      route: meta.expertRoute || "",
      steps: t.steps || meta.liveSteps || 0,
      maxSteps: meta.maxSteps ?? config.maxStepsPerExpert ?? 18,
      currentTool: isRunning ? (meta.currentTool || "") : "",
      turns: t.turns || 1,
      totalTokens: t.totalTokens || 0,
      outputTokens: t.outputTokens || 0,
      durationMs: t.durationMs || (meta.startedAt ? Date.now() - meta.startedAt : 0),
      completed: !isRunning,
      promptPreview: "",
      responsePreview: "",
      teamMemberName: meta.memberName || "",
      teamTasks: meta.taskId ? [{ id: meta.taskId, status: isRunning ? "in_progress" : "completed", subject: meta.stageLabel }] : [],
    });
  }

  const runs = [...runMap.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);

  const activeSessions = [];
  for (const root of liveAgents?.roots?.() ?? []) {
    const rec = byId.get(root.id);
    const curModel = root.model?.current?.() ?? {};
    activeSessions.push({
      id: root.id,
      title: rec?.rows?.title?.val || root.id.slice(0, 8),
      cwd: root.session?.header?.cwd || rec?.cwd || "",
      status: root.status,
      provider: curModel.provider || "",
      model: curModel.model || "",
      reasoningEffort: curModel.reasoningEffort || "",
    });
  }

  const availableModels = await collectAvailableModels(ctx, config);

  return {
    runs,
    activeSessions,
    availableModels,
    config: {
      enableArbiter: config.enableArbiter !== false,
      finalExpert: config.finalExpert,

      workerModel: config.workerModel ?? {
        label: "DeepSeek 4.1 Flash",
        provider: "magpie",
        model: "seoul/auto/deepseek-v4.1-flash",
      },
      panelists: config.panelists,
      reviewer: config.reviewer,

      requireApproval: config.requireApproval,

      maxStepsPerExpert: config.maxStepsPerExpert,
      expertTimeoutSeconds: config.expertTimeoutSeconds,
    },
  };
}

function loadChildDetail(childId, expertChildren) {
  let events = [];
  const meta = expertChildren.get(childId);
  if (meta?.session && typeof meta.session.snapshotEvents === "function") {
    events = meta.session.snapshotEvents();
  } else {
    const sessionsBase = path.join(dshRootDir(), "sessions");
    if (fs.existsSync(sessionsBase)) {
      for (const wsDir of fs.readdirSync(sessionsBase)) {
        const zstFile = path.join(sessionsBase, wsDir, childId, "session.v4.jsonl.zstd");
        if (fs.existsSync(zstFile)) {
          try {
            const raw = zlib.zstdDecompressSync(fs.readFileSync(zstFile)).toString("utf8");
            events = raw.trim().split("\n").map((l) => JSON.parse(l));
          } catch {
            events = [];
          }
          break;
        }
      }
    }
  }

  let promptText = "";
  let responseText = "";
  const timeline = [];
  const filesRead = new Set();
  const filesWritten = new Set();
  const toolCounts = {};
  let currentStep = 0;

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "step/start") {
      currentStep = ev.data?.step ?? currentStep + 1;
    } else if (ev.type === "user/message") {
      const sk = ev.data?.source?.kind;
      if (!promptText && (!sk || sk === "user")) {
        const txt = (ev.data?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n\n");
        if (txt && !txt.startsWith("<system-reminder>") && !txt.startsWith("<hindsight_")) {
          promptText = txt;
        }
      }
    } else if (ev.type === "assistant/message") {
      const content = ev.data?.message?.content ?? [];
      const txt = content.filter((b) => b?.type === "text").map((b) => b.text).join("\n\n").trim();
      if (txt) responseText = txt;
    } else if (ev.type === "tool/call") {
      const name = String(ev.data?.name ?? "tool");
      toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      let args = {};
      try {
        args = typeof ev.data?.arguments === "string" ? JSON.parse(ev.data.arguments) : (ev.data?.arguments ?? {});
      } catch {
        args = {};
      }
      let summary = "";
      if (name === "read" || name === "read_image") {
        if (args.file_path) {
          filesRead.add(args.file_path);
          summary = String(args.file_path);
        }
      } else if (name === "write" || name === "edit") {
        if (args.file_path) {
          filesWritten.add(args.file_path);
          summary = String(args.file_path);
        }
      } else if (name === "bash") {
        summary = args.description || String(args.command || "").split(/\r?\n/)[0].slice(0, 100);
      } else if (name === "grep" || name === "glob") {
        summary = `${args.pattern || ""} ${args.path || ""}`.trim();
      } else if (name === "send_message") {
        summary = `→ ${args.target || args.agent_id || "lead"}: ${String(args.message || "").slice(0, 80)}`;
      } else {
        summary = JSON.stringify(args).slice(0, 90);
      }
      timeline.push({
        seq: ev.seq,
        time: ev.time,
        step: currentStep,
        tool: name,
        summary,
      });
    }
  }

  return {
    childId,
    promptText,
    responseText,
    toolCounts,
    filesRead: [...filesRead],
    filesWritten: [...filesWritten],
    timeline: timeline.slice(-60),
  };
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error("Request body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

export function registerExpertPanelHttp(ctx, { config, expertChildren, manualControllers, handleCommand }) {
  // Load persisted UI settings immediately on plugin activation
  loadPersistedSettings(config);

  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: "prefix",
        path: "/expert-panel",
        handler: async (req, res) => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          if (!url.pathname.startsWith("/expert-panel/api/")) {
            res.writeHead(404);
            res.end();
            return;
          }
          const action = url.pathname.slice("/expert-panel/api/".length);
          try {
            if (req.method === "GET" && action === "state") {
              const snap = await buildStateSnapshot(ctx, { config, expertChildren });
              sendJson(res, 200, snap);
              return;
            }
            if ((req.method === "POST" || req.method === "PUT") && action === "config") {
              const body = await readJsonBody(req);
              savePersistedSettings(config, body);
              sendJson(res, 200, {
                ok: true,
                state: await buildStateSnapshot(ctx, { config, expertChildren }),
              });
              return;
            }
            if (req.method === "GET" && action === "detail") {
              const childId = url.searchParams.get("childId") ?? "";
              if (!childId) {
                sendJson(res, 400, { error: "Missing childId" });
                return;
              }
              sendJson(res, 200, loadChildDetail(childId, expertChildren));
              return;
            }
            if (req.method === "POST" && action === "stop") {
              const body = await readJsonBody(req);
              const { childId, sessionId } = body ?? {};
              let stoppedCount = 0;
              if (childId) {
                const meta = expertChildren.get(childId);
                const parentId = meta?.rootId || meta?.parentId || sessionId;
                try {
                  if (parentId) ctx.subagents.interrupt(childId, { kind: "user", parentSessionId: parentId });
                  const resident = ctx.subagents.manager?.resident?.get(childId);
                  if (resident?.handle?.agent) resident.handle.agent.cancel({ kind: "user" });
                  if (meta) meta.status = "interrupted";
                  stoppedCount += 1;
                } catch {
                  /* ignore */
                }
              }
              if (sessionId) {
                const ctrls = manualControllers.get(sessionId);
                if (ctrls) {
                  for (const c of ctrls) {
                    c.abort(new Error("Stopped from Expert Panel UI"));
                    stoppedCount += 1;
                  }
                }
                for (const [cid, m] of expertChildren.entries()) {
                  if (m.rootId === sessionId || m.parentId === sessionId) {
                    try {
                      ctx.subagents.interrupt(cid, { kind: "user", parentSessionId: sessionId });
                      m.status = "interrupted";
                      stoppedCount += 1;
                    } catch {
                      /* ignore */
                    }
                  }
                }
              }
              sendJson(res, 200, { ok: true, stoppedCount });
              return;
            }
sendJson(res, 404, { error: `Unknown endpoint: ${action}` });
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    );
  });
}
