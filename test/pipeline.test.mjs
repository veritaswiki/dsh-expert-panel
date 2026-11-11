import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Isolate persisted settings so tests never read the developer's real config. */
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-expert-panel-test-"));
fs.mkdirSync(path.join(process.env.DSH_HOME, "state"), { recursive: true });

const PKG = new URL("../index.js", import.meta.url).pathname;
const { Config, apply: applyPlugin } = await import(PKG);

/** Minimal Cordis-shaped ctx that records registrations and can drive the tool. */
function makeContext(agentOutputText = "### 结论\n根因已定位。") {
  const listeners = new Map();
  const created = [];
  const state = { tool: null, sections: [], contexts: [], commands: [], teamState: { id: "root", members: [], tasks: [] } };

  const rootSession = { id: "root", seq: 0, header: { id: "root", cwd: "/tmp" }, append() {}, snapshotEvents: () => [] };
  const rootAgent = { id: "root", status: "running", session: rootSession, inject() {}, steer() {}, followup() {}, model: { select() {} } };

  const agentTeams = {
    config: {},
    journal: {
      state: () => state.teamState,
      async transact(_r, fn) { return await fn(); },
      async appendAndFlush() {},
    },
    listMembers: () => [{ id: "root", name: "lead", role: "lead", status: "running" }],
    listTasks: () => [],
    createTask: async (_r, req) => ({ id: "task-1", revision: 1, status: "pending", subject: req.subject }),
    getTask: () => ({ id: "task-1", revision: 1, status: "pending" }),
    updateTask: async () => ({ id: "task-1", revision: 2, status: "completed" }),
    sendMessage: async () => {},
  };

  const ctx = {
    get(k) {
      if (k === "agentTeams") return agentTeams;
      if (k === "agents") return { roots: () => [rootAgent], get: (id) => (id === "root" ? rootAgent : undefined) };
      if (k === "llm") return { listProviders: () => [{ id: "fake", name: "Fake" }], listModels: async () => [], resolveCallConfig: async () => ({}) };
      return undefined;
    },
    on(name, fn) {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
      return () => {};
    },
    emit(name, payload) { for (const fn of listeners.get(name) ?? []) fn(payload); },
    effect(fn) { const d = fn(); return typeof d === "function" ? d : () => {}; },
    inject(_deps, fn) {
      fn({
        commands: { register(def) { state.commands.push(def); } },
        effect: () => () => {},
        webServer: { register: () => () => {} },
      });
    },
    systemPrompt: {
      section(spec) { state.sections.push(spec); return () => {}; },
      context(spec) { state.contexts.push(spec); return () => {}; },
    },
    tools: { get: () => ({}), guard() {}, register(def) { state.tool = def; } },
    subagents: {
      manager: { resident: new Map() },
      getProvider: () => ({ name: "spawn" }),
      async startActivation(spec) {
        created.push({ label: spec.label, model: spec.request?.agentOptions?.model });
        const childAgent = {
          id: spec.childId,
          session: { id: spec.childId, seq: 0, snapshotEvents: () => [] },
          inbox: { append() {} },
          ctx: { effect: (f) => { f(); return () => {}; }, tools: { restrict: () => () => {} }, systemPrompt: { section: () => () => {} }, on: () => () => {} },
        };
        ctx.emit("agent/created", { agent: childAgent });
        return {
          childId: spec.childId,
          result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: agentOutputText }] }),
        };
      },
    },
  };
  return { ctx, state, created, rootAgent };
}

const baseConfig = {
  finalExpert: { label: "Arbiter", provider: "fake", model: "fake/arbiter", reasoningEffort: "high" },
  panelists: [{ label: "Arbiter", provider: "fake", model: "fake/arbiter", reasoningEffort: "high" }],
  reviewer: { label: "Arbiter", provider: "fake", model: "fake/arbiter" },
  workerModel: { label: "Worker", provider: "fake", model: "fake/worker" },
  enableArbiter: true,
  requireApproval: false,
};

test("config exposes exactly the 8 supported fields", () => {
  const parsed = Config(baseConfig);
  assert.deepEqual(Object.keys(Config.dict).sort(), [
    "enableArbiter",
    "expertTimeoutSeconds",
    "finalExpert",
    "maxStepsPerExpert",
    "panelists",
    "requireApproval",
    "reviewer",
    "workerModel",
  ]);
  assert.equal(parsed.enableArbiter, true);
});

test("activation registers the tool, prompt section, trigger context and commands", () => {
  const { ctx, state } = makeContext();
  applyPlugin(ctx, Config(baseConfig));
  assert.ok(state.tool, "tool registered");
  assert.equal(state.tool.name, "consult_expert_panel");
  assert.ok(state.sections.length >= 1, "system prompt section registered");
  assert.ok(state.contexts.length >= 1, "trigger context registered");
  assert.equal(state.commands.length, 2, "/expert and its alias");
});

test("prompt section renders non-empty roster text", () => {
  const { ctx, state } = makeContext();
  applyPlugin(ctx, Config(baseConfig));
  const sec = state.sections[0];
  const text = typeof sec.text === "function" ? sec.text() : sec.text;
  assert.ok(String(text).length > 200, "roster prompt is populated");
  assert.ok(String(text).includes("consult_expert_panel"));
});

test("pipeline runs evidence → review → arbiter in order", async () => {
  const { ctx, state, created, rootAgent } = makeContext();
  applyPlugin(ctx, Config(baseConfig));
  const out = await state.tool.execute(
    { category: "architecture", problem_summary: "deep coupling", attempted_steps: "tried twice" },
    { agent: rootAgent, signal: new AbortController().signal },
  );
  assert.equal(created.length, 3, "three stages ran");
  assert.ok(created[0].label.includes("会诊"), "stage 1 = evidence");
  assert.ok(created[1].label.includes("互审"), "stage 2 = cross-review");
  assert.ok(created[2].label.includes("终裁"), "stage 3 = arbiter");
  assert.ok(out.includes("多轮评审结论与后续工作部署指派单"));
});

test("disabling the arbiter runs only the first two stages", async () => {
  const { ctx, state, created, rootAgent } = makeContext();
  applyPlugin(ctx, Config({ ...baseConfig, enableArbiter: false }));
  const out = await state.tool.execute(
    { category: "stuck_bug", problem_summary: "ghost bug", attempted_steps: "two failures" },
    { agent: rootAgent, signal: new AbortController().signal },
  );
  assert.equal(created.length, 2, "arbiter skipped");
  assert.ok(out.includes("终裁已关闭"));
});

test("empty problem_summary is rejected", async () => {
  const { ctx, state, rootAgent } = makeContext();
  applyPlugin(ctx, Config(baseConfig));
  await assert.rejects(
    () => state.tool.execute({ category: "stuck_bug", problem_summary: "", attempted_steps: "x" }, { agent: rootAgent, signal: new AbortController().signal }),
    /problem_summary/,
  );
});

test("Config ships no default roster and no provider strings", () => {
  const parsed = Config({});
  assert.deepEqual(parsed.panelists, [], "panelists default is empty");
  assert.ok(!parsed.finalExpert || !parsed.finalExpert.provider, "finalExpert has no preset provider");
  assert.equal(parsed.maxStepsPerExpert, 30);
  assert.equal(parsed.expertTimeoutSeconds, 1800);
  assert.equal(parsed.enableArbiter, true);
  assert.equal(parsed.requireApproval, true);
});

test("unconfigured roster: tool refuses with a setup hint and spawns nothing", async () => {
  const { ctx, state, created, rootAgent } = makeContext();
  applyPlugin(ctx, Config({}));
  await assert.rejects(
    state.tool.execute(
      { category: "architecture", problem_summary: "deep coupling", attempted_steps: "tried twice" },
      { agent: rootAgent, signal: new AbortController().signal },
    ),
    (error) => /设置 → 专家团 → 设置/.test(String(error?.message ?? "")),
  );
  assert.equal(created.length, 0, "no expert was spawned");
});

test("unconfigured roster: /expert returns an error card instead of crashing", async () => {
  const { ctx, state, created, rootAgent } = makeContext();
  applyPlugin(ctx, Config({}));
  const out = await state.commands[0].handler({
    agent: rootAgent,
    rawInput: "帮我看看这个卡点",
    attachments: [],
  });
  assert.equal(out.kind, "error");
  assert.match(out.text, /还没有配置阵容/);
  assert.equal(created.length, 0, "no expert was spawned");
});

test("unconfigured roster: prompt section carries the warning", () => {
  const { ctx, state } = makeContext();
  applyPlugin(ctx, Config({}));
  const section = state.sections[0];
  const text = String(typeof section.text === "function" ? section.text({}) : section.text);
  assert.match(text, /阵容未配置/);
});

test("only panelists configured: the first panelist doubles as arbiter", async () => {
  const { ctx, state, created, rootAgent } = makeContext();
  applyPlugin(ctx, Config({ panelists: [{ label: "Only", provider: "fake", model: "fake/only" }], requireApproval: false }));
  await state.tool.execute(
    { category: "stuck_bug", problem_summary: "p", attempted_steps: "a" },
    { agent: rootAgent, signal: new AbortController().signal },
  );
  assert.equal(created.length, 3, "evidence + review + arbiter all ran");
});

/* ---------- 设置页「用宿主模型选择器选一条模型」→ 落盘 ---------- */

test("picker selection persists exactly as { provider, model, label, reasoningEffort }", async () => {
  const httpApi = await import(new URL("../http-api.js", import.meta.url).href);
  const picked = { label: "Model X", provider: "prov", model: "prov/x", reasoningEffort: "high" };
  const config = { enableArbiter: true, requireApproval: true, maxStepsPerExpert: 30, expertTimeoutSeconds: 1800, panelists: [] };

  // 选择器可能带上视图字段（supportsEffort 之类），落盘时必须被丢掉
  httpApi.applySettingsPatch(config, { finalExpert: { ...picked, supportsEffort: true } });
  assert.deepEqual(config.finalExpert, picked, "view-only fields are not persisted");

  httpApi.savePersistedSettings(config, {});
  const reloaded = { ...config, finalExpert: undefined };
  httpApi.loadPersistedSettings(reloaded);
  assert.deepEqual(reloaded.finalExpert, picked, "round-trips through the settings file");
  assert.deepEqual(reloaded.panelists, []);
});

test("multi-select of panelists keeps the persisted entry shape", async () => {
  const httpApi = await import(new URL("../http-api.js", import.meta.url).href);
  const config = { enableArbiter: true, requireApproval: true, maxStepsPerExpert: 30, expertTimeoutSeconds: 1800, panelists: [] };
  httpApi.applySettingsPatch(config, {
    panelists: [
      { label: "Model A", provider: "p", model: "p/a" },
      { label: "Model B", provider: "p", model: "p/b", reasoningEffort: "low" },
    ],
  });
  assert.deepEqual(config.panelists, [
    { label: "Model A", provider: "p", model: "p/a" },
    { label: "Model B", provider: "p", model: "p/b", reasoningEffort: "low" },
  ]);
});

test("clearing a selection (empty string) leaves the stored expert untouched", async () => {
  const httpApi = await import(new URL("../http-api.js", import.meta.url).href);
  const kept = { label: "Model A", provider: "p", model: "p/a" };
  const config = { enableArbiter: true, requireApproval: true, maxStepsPerExpert: 30, expertTimeoutSeconds: 1800, panelists: [] };
  httpApi.applySettingsPatch(config, { finalExpert: kept });
  httpApi.applySettingsPatch(config, { finalExpert: { label: "", provider: "", model: "" } });
  assert.deepEqual(config.finalExpert, kept, "an empty patch never wipes the expert");
});

test("client reuses the host modelDirectories service and ships no hand-typed route box", () => {
  const source = fs.readFileSync(new URL("../client.js", import.meta.url), "utf8");
  assert.match(source, /ctx\.inject\(\['modelDirectories'\]/, "mounts the host model catalog service");
  assert.ok(!source.includes("customRoute"), "no hand-typed route input state");
  assert.ok(!source.includes("DEFAULT_MODELS"), "no plugin-owned seed model list");
  assert.ok(source.includes("optgroup"), "renders the host catalog as grouped options");
});

test("package.json declares the host model-selection client package", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(
    pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-model-selection"),
    "client bundle must wait for the host model-selection UI",
  );
});
