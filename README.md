# `@local/expert-panel` v5.0 · 多轮评审专家团

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

| 字段 | 说明 |
|---|---|
| `finalExpert` | ③ 终裁专家 |
| `panelists` | ① 独立取证专家（并行数 = 本数组长度，单一事实源） |
| `reviewer` | ② 互审官；留空取第一位取证专家 |
| `enableArbiter` | 是否启用 ③ 终裁 |
| `workerModel` | 日常主力施工模型（仅展示与交接用） |
| `requireApproval` | 模型主动申请时是否弹确认卡（用户自己 `/expert` 不弹，属正确分层） |
| `maxStepsPerExpert` | 单次专家最大步数（默认 30） |
| `expertTimeoutSeconds` | 单次有效工作时长上限（默认 1800s，不含工具等待） |

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

### 从 npm 安装（推荐）

```bash
dsh plugin add dsh-expert-panel
```

### 从源码安装

```bash
git clone https://github.com/veritaswiki/dsh-expert-panel.git
cd dsh-expert-panel
dsh plugin add .
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

## 九、开发

```bash
npm test        # 语法检查 + 流水线单测
```

## 十、许可证

MIT
