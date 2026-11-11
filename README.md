# dsh-expert-panel v5.0 · 多轮评审专家团

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](https://nodejs.org/en/download)
<!-- npm 徽章：等首次发包后再开，位置留在这里。
[![npm version](https://img.shields.io/npm/v/dsh-expert-panel.svg)](https://www.npmjs.com/package/dsh-expert-panel)
-->

## 一、一句话公理

> **只在主力模型陷入僵局时，用一次受「硬性预算与收口契约」约束的跨模型对抗式评审，把未知盲区压成一份主力模型可直接执行的《裁决与后续工作部署指派单》。**

这条公理里唯一不可去掉的不是「多模型」，而是 **硬性收口契约** —— 它保证每次召唤都能拿到结论，而不是跑满预算后交白卷。

## 二、唯一流程

| 阶段 | 谁执行 | 权限 | 产出 |
|---|---|---|---|
| **① 独立取证** | `panelists` 全部并行 | 只读 | 各自带代码行号的独立证据报告 |
| **② 交叉互审** | `reviewer` | 只读 | 逐条挑刺、推翻错误结论、收敛方案 |
| **③ 终裁定稿** | `finalExpert`（可关） | 可写 | 《裁决与后续工作部署指派单》 |

② 强制不可跳过；③ 由 `enableArbiter` 控制。

**没有**单专家 / 主会话原地接管等旁路模式。

## 三、硬性收口契约（本插件的真正差异点）

- **步数收口**：达预算 60% 时注入「开始收口」提示；达 100% 时工具 guard 锁死取证类工具；
- **时间收口**：有效工作时长（扣除工具等待）达 70% 时置 `timeBudgetLocked` 并锁工具；
- **零正文不结案**：被中断且无正式文本时自动续跑一轮「只收口、不再取证」；
- **兜底**：仍无正文则回退最后推理摘要并标记 `emptyConclusion`，绝不留空白结案。

## 四、8 个配置项

`index.js` 的 `Config`（Schemastery）里只有这 8 个键，全部在 `设置 → 专家团 → 设置` 里可改。

**仓库不预置任何 `provider` / `model`**：装好后第一件事是去设置页选阵容（不知道有哪些路由就先执行 `/expert routes`）。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `finalExpert` | `{ label, provider, model, reasoningEffort? }` | 空（未配置） | ③ 终裁专家；留空时自动由第一位取证专家承担 |
| `panelists` | 同上对象的数组 | `[]` | ① 独立取证专家；并行数 = 本数组长度（单一事实源，不另设配置项） |
| `reviewer` | 同上对象的可选对象 | 空 | ② 互审官；留空取第一位取证专家 |
| `enableArbiter` | boolean | `true` | 是否启用 ③ 终裁；关掉只跑前两轮 |
| `workerModel` | 同上对象的可选对象 | 空（未配置） | 日常主力施工模型，仅用于展示与交接口径；不影响流水线 |
| `requireApproval` | boolean | `true` | 模型主动申请时是否弹确认卡；用户自己 `/expert` 不弹 |
| `maxStepsPerExpert` | number（最小 4，步长 1） | `30` | 单次专家最大步数预算，到限强制收尾交回主模型 |
| `expertTimeoutSeconds` | number（最小 60，步长 1） | `1800` | 单次有效工作时长上限（秒，不含工具执行等待） |

## 五、HTTP 面（4 个动作）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/expert-panel/api/state` | 运行记录 + 配置 |
| POST/PUT | `/expert-panel/api/config` | 保存配置 |
| GET | `/expert-panel/api/detail?childId=` | 子会话工具轨迹 |
| POST | `/expert-panel/api/stop` | 中断专家 |

## 六、界面

左侧栏「专家团」（order 16，位于「自进化」下方）→ 两个页签：

- **运行记录**：发起一次多轮评审、历史运行、遥测、停止 / 追问 / 打开子会话；
- **设置**：① 评审阵容与流程（流程可视化 + 模型 + 启停名单）、② 门禁与收口预算。

设计系统：5 档字号 / 8 档间距 / 3 档圆角 / 4 色强调 / 卡片无边框。

## 七、v5.0 相对 v4.2 删掉了什么（第一性原理审计）

| 删除项 | 原因 |
|---|---|
| 会话监督全套（893 行 + 6 端点 + 1 页签 + 73 个 CSS 类） | 监控的是「全局日常会话健不健康」，与「本次召唤解不解决问题」正交；且 `analyze` 绕过门禁烧配额、`act` 跨会话 steer |
| 共享任务 DAG 记账（`createExpertTeamTask` 等） | 不参与任何控制流，只产「看起来在协作」的叙事与额外工具步 |
| 任务板摘要注入专家题面 | 纯 token 噪音 |
| `takeover` / `summon` 端点及前端入口 | 绕开主对话门禁的旁路入口 |
| 4 个可推导配置项 | 并行数=专家数、上下文模式固定 digest、事件上限 16、审批超时 240s |

保留：三阶段流水线、只读硬件锁、预算守卫三件套、指派单回交、账本内联（防伪验真）。
保留 `provisionTeamMember` / `settleTeamMember`：让专家在「编队」里可见（用户明确要求），但不做任务记账。

## 八、安装与生效

> 本版尚未发布到 npm registry（`npm view dsh-expert-panel` 目前是 404），因此下面的装法都不走 npm 包名。

### 方式 A：让 Agent 用 `plugin_manager` 安装（推荐）

在 DSH 里对 Agent 说「装 `dsh-expert-panel`」，它会调 `plugin_manager`：

- `action: "install_bundle"`，`target` 填安装 spec：`github:veritaswiki/dsh-expert-panel`，或本地 `file:/abs/path/to/dsh-expert-panel`；
- 装完 `action: "set_bundle"` 启用。

### 方式 B：从源码挂到 profile

```bash
git clone https://github.com/veritaswiki/dsh-expert-panel.git
cd dsh-expert-panel
# dsh plugin 把参数原样转给 profile 目录里的 pnpm；--profile 指定目标 profile（web / desktop / 自定义）
dsh plugin --profile web add .
```

### 手动组合

在 profile 的 `cordis.patch.yml` 里以 `- insert:` 行挂载：

```yaml
- insert:
    - id: expert-panel
      name: 'dsh-expert-panel'
```

- `client.js` 改动：刷新页面即可；
- Host 侧改动：由 loader 热重载生效，必要时重启桌面端。

### 装完先配阵容

`/expert routes` 列出本机真实可用的 `provider/model`，然后在「设置 → 专家团 → 设置」里至少选一位取证专家。没配之前 `/expert` 只会回一句「还没有配置阵容」，不会调用任何模型。

## 九、开发

```bash
npm test        # 语法检查 + 流水线单测
```

## 已知限制

- **需要外部模型可用。** 三个阶段全部跑在你配置的 `provider` / `model` 路由上，插件不做本地推理。但失败不是硬停：某位专家在第 1 步就以 0 输出失败（鉴权、上游 403、流超时）时，会自动换到另一位取证专家的路由重试一次（`index.js` 的 route failover），换完仍失败该阶段才判失败——所以「最后拿到了结论」并不等于你选的那条路由是好的。
- **每次召唤有真实成本。** 一次多轮评审 = N 位取证专家 + 1 位互审官（`enableArbiter` 打开时再加 1 位终裁），每位都按 `maxStepsPerExpert` 跑满预算，按所选模型实际计费；它不是一次轻量的单模型问答。
- **跨模型延迟明显。** 流程是「并行取证 → 串行互审 → 终裁」，端到端通常要几十秒到几分钟；到步数 / 时间预算上限会被强制收口，拿到的是阶段性结论而不是最全结论。
- **不替代 diff 级代码评审。** 它产出的是根因裁决与《裁决与后续工作部署指派单》（改哪里、谁去改、怎么验），不是逐行 patch 审阅；落地改动仍须由人或主力模型逐行核对。
- **必须自己配阵容，插件不预置模型。** `panelists` 与 `finalExpert` 都留空时，`/expert` 会直接返回「去设置页配置阵容」的提示、`consult_expert_panel` 抛同一句提示、system prompt 顶部也会注入同样的警告——不会拿任何隐式默认模型跑。只配一位取证专家时，这一位同时充当取证 / 互审 / 终裁（`normalizeConfig` 的兜底）。

## 十、许可证

MIT
