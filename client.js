window.__ModuleLoader__.load({
  id: 'dsh-expert-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const LABEL_PREFIX = '⚡专家团';
    const STORAGE_SLOT = 'expert-panel-ui-state-v3';

    // 仓库不预置任何模型：候选路由只来自宿主 provider 目录（Host API 的 availableModels）。
    const DEFAULT_MODELS = [];

    // 未配置时的占位专家：provider/model 为空，界面按「未配置」渲染，不会伪造成一条可用路由。
    const UNSET_EXPERT = { label: '未配置', provider: '', model: '' };

    const DEFAULT_CONFIG = {
      enableArbiter: true,
      finalExpert: { ...UNSET_EXPERT },
      workerModel: { ...UNSET_EXPERT },
      panelists: [],
      reviewer: { ...UNSET_EXPERT },
      requireApproval: true,
      maxStepsPerExpert: 30,
      expertTimeoutSeconds: 1800,
    };

    /** 唯一流程：多轮评审。三个固定阶段，不可选、不可跳过。 */
    const PIPELINE_STAGES = [
      {
        id: 'draft',
        index: 1,
        title: '独立取证',
        badge: '① 并行只读',
        desc: '多位专家并行独立诊断，各自产出带代码行号的证据报告，互不干扰。',
        tone: 'consult',
      },
      {
        id: 'review',
        index: 2,
        title: '交叉互审',
        badge: '② 挑刺收敛',
        desc: '互审官逐条核对证据、推翻错误结论、裁决分歧，收敛出唯一执行方案。',
        tone: 'review',
      },
      {
        id: 'arbiter',
        index: 3,
        title: '终裁定稿',
        badge: '③ 最终把关',
        desc: '终裁专家对收敛方案做最终裁决，下发《裁决与后续工作部署指派单》。',
        tone: 'final',
      },
    ];

    const TIERS = {
      '会诊': { hint: '一线专家独立诊断 · 只读 · 步数受控', tone: 'consult' },
      '互审': { hint: '交叉审阅各方分歧并收敛方案 · 严格单轮防卡死', tone: 'review' },
      '终裁': { hint: '最终裁决者接管核心卡点 · 步数/时间双熔断', tone: 'final' },
      '接管': { hint: '单专家直接接管排查与修改代码 · 同步编队任务板', tone: 'takeover' },
      '追问': { hint: '唤醒已有专家子会话继续第 2+ 轮深度追问复核', tone: 'review' },
    };

    function readLocalSettings() {
      try {
        const raw = localStorage.getItem(STORAGE_SLOT);
        return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
      } catch {
        return { ...DEFAULT_CONFIG };
      }
    }

    function writeLocalSettings(cfg) {
      try {
        localStorage.setItem(STORAGE_SLOT, JSON.stringify(cfg));
      } catch {
        /* ignore */
      }
    }

    function parseRunLabel(label) {
      const text = String(label ?? '');
      if (text.startsWith(LABEL_PREFIX)) {
        const rest = text.slice(LABEL_PREFIX.length);
        const parts = rest.split('·').map((part) => part.trim()).filter(Boolean);
        return { tier: parts[0] ?? '会诊', expert: parts.slice(1).join(' · ') || '未知专家' };
      }
      if (text.includes('终裁')) return { tier: '终裁', expert: 'Gemini 4 Argon（终裁）' };
      if (text.includes('互审')) return { tier: '互审', expert: '交叉互审专家' };
      if (text.includes('接管')) return { tier: '接管', expert: '接管专家' };
      return { tier: '会诊', expert: text || '专家' };
    }

    function formatTime(value) {
      try {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime()) || value <= 0) return '';
        const now = new Date();
        const sameDay =
          date.getFullYear() === now.getFullYear() &&
          date.getMonth() === now.getMonth() &&
          date.getDate() === now.getDate();
        return sameDay
          ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          : date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch {
        return '';
      }
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '';
      const sec = Math.round(ms / 1000);
      if (sec < 60) return `${sec}s`;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}m${s > 0 ? `${s}s` : ''}`;
    }

    function formatTokens(n) {
      if (!Number.isFinite(n) || n <= 0) return '';
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
      return String(n);
    }

    function shortCwd(cwd) {
      if (typeof cwd !== 'string' || !cwd) return '';
      const parts = cwd.replace(/\/+$/g, '').split('/').filter(Boolean);
      return parts.slice(-2).join('/');
    }

    function extractChildMetrics(childSummary, parentTeam, childId) {
      const pv = childSummary?.projectionValues ?? childSummary?.projections ?? {};
      const stats = pv.sessionStats ?? {};
      const usage = pv.tokenUsage?.totals ?? {};
      const timing = pv.subagentTiming ?? {};
      const modelSel = pv.modelSelection?.lastUsed ?? {};
      const outline = Array.isArray(pv.turnOutline?.turns) ? pv.turnOutline.turns : [];
      const lastTurn = outline.length > 0 ? outline[outline.length - 1] : null;

      const steps = Number(stats.steps) || 0;
      const turns = Number(stats.turns) || outline.length || 0;
      const totalTokens =
        (Number(usage.uncachedInputTokens) || 0) +
        (Number(usage.outputTokens) || 0) +
        (Number(usage.cacheReadTokens) || 0) +
        (Number(usage.cacheWriteTokens) || 0);
      const outputTokens = Number(usage.outputTokens) || 0;

      const activeMs =
        timing.active && Number.isFinite(timing.active.through) && Number.isFinite(timing.active.since)
          ? Math.max(0, timing.active.through - timing.active.since)
          : 0;
      const durationMs =
        (Number(timing.settledMs) || 0) + activeMs || (Number(stats.llmMs) || 0) + (Number(stats.toolMs) || 0);
      const completed = timing.lastTurnCompleted === true || (!childSummary?.running && steps > 0);

      const route =
        modelSel.provider && modelSel.model ? `${modelSel.provider}/${modelSel.model}` : modelSel.model || '';

      const members = Array.isArray(parentTeam?.members) ? parentTeam.members : [];
      const tasks = Array.isArray(parentTeam?.tasks) ? parentTeam.tasks : [];
      const member = members.find((m) => m && m.id === childId);
      const memberTasks = tasks.filter(
        (t) => t && (t.ownerId === childId || (member && t.ownerName === member.name)),
      );

      return {
        steps,
        turns,
        totalTokens,
        outputTokens,
        durationMs,
        completed,
        route,
        promptPreview: typeof lastTurn?.prompt === 'string' ? lastTurn.prompt : '',
        responsePreview: typeof lastTurn?.response === 'string' ? lastTurn.response : '',
        teamMemberName: member?.name || '',
        teamTasks: memberTasks,
      };
    }

    async function callHostApi(path, method = 'GET', body = undefined) {
      const init = {
        method,
        headers: { 'x-expert-panel-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      };
      const res = await fetch(`/expert-panel/api/${path}`, init);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = `HTTP ${res.status}`;
        try {
          msg = JSON.parse(text)?.error || msg;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      return await res.json();
    }

    function apply(ctx) {
      const listeners = new Set();
      let clientRows = [];
      let hostState = null;
      let mergedRows = [];
      const stops = new Map();
      const refreshedParents = new Set();

      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            /* ignore */
          }
        }
      };

      const rebuildMerged = () => {
        const map = new Map();
        if (Array.isArray(hostState?.runs)) {
          for (const r of hostState.runs) {
            if (r && r.childId) map.set(r.childId, { ...r });
          }
        }
        for (const r of clientRows) {
          if (!r || !r.childId) continue;
          const prev = map.get(r.childId);
          if (!prev) {
            map.set(r.childId, r);
          } else {
            map.set(r.childId, {
              ...prev,
              ...r,
              activity: r.activity === 'running' || prev.activity === 'running' ? 'running' : r.activity || prev.activity,
              steps: Math.max(prev.steps || 0, r.steps || 0),
              totalTokens: Math.max(prev.totalTokens || 0, r.totalTokens || 0),
              outputTokens: Math.max(prev.outputTokens || 0, r.outputTokens || 0),
              durationMs: Math.max(prev.durationMs || 0, r.durationMs || 0),
              promptPreview: r.promptPreview || prev.promptPreview || '',
              responsePreview: r.responsePreview || prev.responsePreview || '',
              teamMemberName: r.teamMemberName || prev.teamMemberName || '',
              teamTasks: (r.teamTasks && r.teamTasks.length > 0 ? r.teamTasks : prev.teamTasks) || [],
            });
          }
        }
        mergedRows = [...map.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100);
        emit();
      };

      const catalogOf = (binding, summary) => {
        try {
          const face = binding?.session?.projections?.faceOf?.('subagentCatalog');
          const snapshot = face?.getSnapshot?.();
          if (Array.isArray(snapshot)) return snapshot;
        } catch {
          /* fallback */
        }
        const pv = summary?.projectionValues ?? summary?.projections;
        if (Array.isArray(pv?.subagentCatalog)) return pv.subagentCatalog;
        if (Array.isArray(pv?.subagentCatalog?.head?.values)) return pv.subagentCatalog.head.values;
        return [];
      };

      const teamOf = (binding, summary) => {
        try {
          const face = binding?.session?.projections?.faceOf?.('agentTeam');
          const snapshot = face?.getSnapshot?.();
          if (snapshot && typeof snapshot === 'object') return snapshot;
        } catch {
          /* fallback */
        }
        const pv = summary?.projectionValues ?? summary?.projections;
        return pv?.agentTeam ?? null;
      };

      const reconcile = () => {
        const nextMap = new Map();
        try {
          const sessions = ctx.sessions ?? ctx.get?.('sessions');
          const snapshot = sessions?.list?.getSnapshot?.();
          const byId = snapshot?.byId ?? {};

          for (const summary of Object.values(byId)) {
            if (!summary || typeof summary.id !== 'string') continue;

            if (!summary.parentId && !refreshedParents.has(summary.id) && typeof sessions?.refreshSubagents === 'function') {
              refreshedParents.add(summary.id);
              try {
                sessions.refreshSubagents(summary.id).catch(() => {});
              } catch {
                /* ignore */
              }
            }

            const binding = sessions?.binding?.(summary.id);
            if (binding !== undefined && !stops.has(summary.id)) {
              try {
                const stopCat = binding.session.projections.faceOf('subagentCatalog').subscribe(reconcile);
                let stopTeam;
                try {
                  stopTeam = binding.session.projections.faceOf('agentTeam').subscribe(reconcile);
                } catch {
                  stopTeam = undefined;
                }
                stops.set(summary.id, () => {
                  try { stopCat?.(); } catch {}
                  try { stopTeam?.(); } catch {}
                });
              } catch {
                stops.set(summary.id, () => {});
              }
            }

            const catalog = catalogOf(binding, summary);
            const parentTeam = teamOf(binding, summary);
            for (const row of catalog) {
              const rowId = row?.id ?? row?.childId;
              const label = row?.label;
              if (typeof label !== 'string' || !label.startsWith(LABEL_PREFIX) || !rowId) continue;
              const childSummary = byId[rowId];
              const isRunning = row.activity === 'running' || childSummary?.running === true;
              const metrics = extractChildMetrics(childSummary, parentTeam, rowId);
              nextMap.set(rowId, {
                sessionId: summary.id,
                sessionTitle: summary.displayTitle || summary.title || summary.id.slice(0, 8),
                cwd: summary.cwd || childSummary?.cwd || '',
                childId: rowId,
                activity: isRunning ? 'running' : row.activity ?? 'completed',
                mode: row.mode ?? 'continuable',
                createdAt: row.createdAt ?? row.childCreatedAt ?? childSummary?.createdAt ?? 0,
                ...parseRunLabel(label),
                ...metrics,
              });
            }

            const pv = summary.projectionValues ?? summary.projections ?? {};
            const subLabel = pv.subagent?.label ?? pv.subagent?.identity?.label ?? '';
            if (typeof subLabel === 'string' && subLabel.startsWith(LABEL_PREFIX) && !nextMap.has(summary.id)) {
              const parentId = summary.parentId || '';
              const parentSummary = parentId ? byId[parentId] : undefined;
              const pTeam = parentSummary ? teamOf(sessions?.binding?.(parentId), parentSummary) : null;
              const metrics = extractChildMetrics(summary, pTeam, summary.id);
              nextMap.set(summary.id, {
                sessionId: parentId || summary.id,
                sessionTitle: parentSummary?.displayTitle || parentSummary?.title || (parentId ? parentId.slice(0, 8) : '历史会话'),
                cwd: summary.cwd || parentSummary?.cwd || '',
                childId: summary.id,
                activity: summary.running ? 'running' : 'completed',
                mode: pv.subagent?.mode ?? 'continuable',
                createdAt: summary.createdAt ?? summary.updatedAt ?? 0,
                ...parseRunLabel(subLabel),
                ...metrics,
              });
            }
          }
        } catch {
          return;
        }
        clientRows = [...nextMap.values()];
        rebuildMerged();
      };

      ctx.effect(() => {
        reconcile();
        const sessions = ctx.sessions ?? ctx.get?.('sessions');
        let stopList;
        try {
          stopList = sessions?.list?.subscribe?.(reconcile);
        } catch {
          stopList = undefined;
        }
        return () => {
          try { stopList?.(); } catch {}
          for (const stop of stops.values()) {
            try { stop(); } catch {}
          }
          stops.clear();
        };
      }, 'expert-panel: run catalog watch');

      const store = {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSnapshot() {
          return mergedRows;
        },
      };

      async function openExpertSession(childId) {
        if (!childId) return;
        try {
          const sessions = ctx.sessions ?? ctx.get?.('sessions');
          const ui = ctx.uiWorkspace ?? ctx.get?.('uiWorkspace');
          if (sessions?.list?.getSnapshot && !sessions.list.getSnapshot()?.byId?.[childId]) {
            if (typeof sessions.refresh === 'function') {
              await sessions.refresh().catch(() => {});
            }
          }
          if (ui && typeof ui.openSession === 'function') {
            try {
              ui.openSession(childId);
            } catch {
              ui.openSession({ sessionId: childId });
            }
          }
        } catch (error) {
          console.warn('expert-panel: openSession error', error);
        }
      }

      /** 左侧栏图标 */
      function ExpertPanelIcon(props) {
        const sz = typeof props?.size === 'number' ? props.size : 18;
        return h(
          'span',
          {
            style: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
            title: '专家团',
          },
          h(
            'svg',
            {
              width: sz,
              height: sz,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.85,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
            },
            h('path', { d: 'M12 3l7.5 4v6c0 4.2-3 7.2-7.5 8.5C7.5 20.2 4.5 17.2 4.5 13V7L12 3z' }),
            h('path', { d: 'M9 12l2 2 4-4' }),
          ),
        );
      }

      function Chip({ children, tone, onClick, active, title }) {
        return h(
          'button',
          {
            type: 'button',
            className: `ep-chip${tone ? ` ep-chip-${tone}` : ''}${active ? ' ep-chip-active' : ''}${onClick ? ' ep-chip-btn' : ''}`,
            onClick,
            title,
          },
          children,
        );
      }

      function Stat({ label, value, sub, tone }) {
        return h(
          'div',
          { className: 'ep-stat' },
          h('div', { className: `ep-stat-value${tone ? ` ep-tone-${tone}` : ''}` }, String(value)),
          h('div', { className: 'ep-stat-label' }, label),
          sub ? h('div', { className: 'ep-stat-sub' }, sub) : null,
        );
      }

      function RunRow({ run, isCurrentSession, onOpen, onStop, onQuickFollowup }) {
        const [expanded, setExpanded] = React.useState(false);
        const [detail, setDetail] = React.useState(null);
        const [loadingDetail, setLoadingDetail] = React.useState(false);
        const [askOpen, setAskOpen] = React.useState(false);
        const [askText, setAskText] = React.useState('');

        const tier = TIERS[run.tier];
        const live = run.activity === 'running';
        const durText = formatDuration(run.durationMs);
        const tokText = formatTokens(run.totalTokens);
        const outTokText = formatTokens(run.outputTokens);
        const cwdShort = shortCwd(run.cwd);

        const loadTimeline = async () => {
          if (detail || loadingDetail) {
            setExpanded((v) => !v);
            return;
          }
          setExpanded(true);
          setLoadingDetail(true);
          try {
            const d = await callHostApi(`detail?childId=${encodeURIComponent(run.childId)}`);
            setDetail(d);
          } catch {
            setDetail(null);
          } finally {
            setLoadingDetail(false);
          }
        };

        const responseBody = detail?.responseText || run.responsePreview || '';
        const promptBody = detail?.promptText || run.promptPreview || '';

        return h(
          'li',
          { className: `ep-row${live ? ' ep-row-live' : ''}` },
          h('span', { className: `ep-dot${live ? ' ep-dot-live' : run.completed ? ' ep-dot-done' : ''}`, 'aria-hidden': true }),
          h(
            'div',
            { className: 'ep-row-main' },
            h(
              'div',
              { className: 'ep-row-head' },
              h('span', { className: `ep-badge ep-tone-${tier?.tone ?? 'consult'}` }, run.tier || '会诊'),
              h('span', { className: 'ep-expert' }, run.expert),
              run.route ? h('code', { className: 'ep-route-tag' }, run.route) : null,
              live
                ? h(
                    'span',
                    { className: 'ep-live-tag' },
                    `运行中 · 第 ${run.steps || 1}/${run.maxSteps || 18} 步${run.currentTool ? ` (${run.currentTool})` : ''}`,
                  )
                : run.completed
                  ? h('span', { className: 'ep-done-tag' }, '已完成')
                  : null,
              run.teamMemberName
                ? h('span', { className: 'ep-team-tag', title: '已注册为编队队友，可通过 send_message 追问' }, `队友: ${run.teamMemberName}`)
                : null,
              isCurrentSession
                ? h('span', { className: 'ep-current-tag' }, '当前会话')
                : run.sessionTitle
                  ? h(
                      'span',
                      { className: 'ep-session-tag', title: `所属主会话: ${run.sessionTitle} (${run.cwd || ''})` },
                      `📁 ${cwdShort ? `${cwdShort} · ` : ''}${run.sessionTitle.slice(0, 18)}`,
                    )
                  : null,
            ),

            h(
              'div',
              { className: 'ep-row-metrics' },
              h('span', { className: 'ep-metric-pill' }, `⚡ ${run.steps || 0} 步 (${run.turns || 1} 轮)`),
              durText ? h('span', { className: 'ep-metric-pill' }, `⏱ ${durText}`) : null,
              tokText
                ? h(
                    'span',
                    { className: 'ep-metric-pill', title: `总计 ${tokText} tokens，输出 ${outTokText || 0} tokens` },
                    `🧮 ${tokText} tok${outTokText ? ` (输出 ${outTokText})` : ''}`,
                  )
                : null,
              run.teamTasks && run.teamTasks.length > 0
                ? run.teamTasks.map((t) =>
                    h(
                      'span',
                      { key: t.id, className: 'ep-task-pill', title: t.subject },
                      `📋 ${t.id} [${t.status === 'completed' ? '已完成' : t.status === 'in_progress' ? '进行中' : '待处理'}]`,
                    ),
                  )
                : null,
              h('span', { className: 'ep-meta-time' }, formatTime(run.createdAt) || '—'),
              h('span', { className: 'ep-child-id' }, `#${run.childId.slice(0, 8)}`),
            ),

            responseBody || expanded
              ? h(
                  'div',
                  { className: 'ep-verdict-box' },
                  h(
                    'div',
                    { className: 'ep-verdict-head' },
                    h('span', { className: 'ep-verdict-label' }, '专家裁决与工作取证摘要'),
                    h(
                      'button',
                      { type: 'button', className: 'ep-toggle-btn', onClick: loadTimeline },
                      expanded ? '收起详情与轨迹 ▲' : '展开全文与工具调用轨迹 ▼',
                    ),
                  ),
                  responseBody
                    ? h('div', { className: `ep-verdict-text${expanded ? ' ep-verdict-expanded' : ''}` }, responseBody)
                    : null,
                  expanded && loadingDetail ? h('div', { className: 'ep-row-hint' }, '正在加载子会话完整工具调用轨迹…') : null,
                  expanded && detail && Array.isArray(detail.timeline) && detail.timeline.length > 0
                    ? h(
                        'div',
                        { className: 'ep-timeline-box' },
                        h(
                          'div',
                          { className: 'ep-verdict-label' },
                          `真实工具调用轨迹（共 ${detail.timeline.length} 次调用` +
                            (detail.filesWritten?.length ? ` · 修改文件 ${detail.filesWritten.length} 个` : '') +
                            `）`,
                        ),
                        detail.filesWritten && detail.filesWritten.length > 0
                          ? h(
                              'div',
                              { className: 'ep-files-written' },
                              '✏️ 实际修改文件: ',
                              detail.filesWritten.map((f) => f.split('/').slice(-2).join('/')).join('、'),
                            )
                          : null,
                        h(
                          'div',
                          { className: 'ep-timeline-list' },
                          ...detail.timeline.slice(-25).map((item, idx) =>
                            h(
                              'div',
                              { key: `${item.seq}-${idx}`, className: 'ep-timeline-item' },
                              h('span', { className: 'ep-tl-step' }, `S${item.step || '?'}`),
                              h('code', { className: 'ep-tl-tool' }, item.tool),
                              h('span', { className: 'ep-tl-sum' }, item.summary),
                            ),
                          ),
                        ),
                      )
                    : null,
                  expanded && promptBody
                    ? h(
                        'div',
                        { className: 'ep-prompt-preview' },
                        h('div', { className: 'ep-verdict-label' }, '原始委派任务单'),
                        h('div', { className: 'ep-verdict-text ep-verdict-expanded' }, promptBody),
                      )
                    : null,
                )
              : h(
                  'div',
                  { className: 'ep-verdict-head', style: { marginTop: '2px' } },
                  h('span', { className: 'ep-row-hint' }, tier ? tier.hint : ''),
                  h('button', { type: 'button', className: 'ep-toggle-btn', onClick: loadTimeline }, '查看子会话执行轨迹 ▼'),
                ),

            askOpen
              ? h(
                  'div',
                  { className: 'ep-ask-inline' },
                  h('input', {
                    type: 'text',
                    className: 'ep-input',
                    placeholder: `向 ${run.expert} (${run.teamMemberName || run.childId.slice(0, 8)}) 发起第 2+ 轮追问…`,
                    value: askText,
                    onChange: (e) => setAskText(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' && askText.trim()) {
                        onQuickFollowup(run, askText.trim());
                        setAskText('');
                        setAskOpen(false);
                      }
                    },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ep-action-btn ep-action-primary',
                      onClick: () => {
                        if (!askText.trim()) return;
                        onQuickFollowup(run, askText.trim());
                        setAskText('');
                        setAskOpen(false);
                      },
                    },
                    '发送追问',
                  ),
                )
              : null,
          ),

          h(
            'div',
            { className: 'ep-row-actions' },
            live
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ep-stop-btn',
                    onClick: () => onStop(run.childId, run.sessionId),
                    title: '立即中断该专家的当前轮次并提取已完成结论，解除主会话等待',
                  },
                  '⏹ 立即收尾移交',
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'ep-open-btn',
                onClick: () => onOpen(run.childId),
                title: '跳转进入该专家的独立子会话，查看完整对话与工具轨迹',
              },
              '打开专家会话 ›',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ep-ask-btn',
                onClick: () => setAskOpen((v) => !v),
                title: '唤醒该专家继续第 2+ 轮深度追问',
              },
              askOpen ? '取消追问' : '💬 继续追问',
            ),
          ),
        );
      }

      // ---- Full Visual Settings Center Component ----
      function SettingsView({ cfg, models, onSave, saving, banner }) {
        const modelOptions = React.useMemo(() => {
          const map = new Map();
          for (const m of [...DEFAULT_MODELS, ...(Array.isArray(models) ? models : [])]) {
            if (!m || !m.provider || !m.model) continue;
            if (/claude/i.test(m.model) || /claude/i.test(m.label || '')) continue;
            const key = `${m.provider}/${m.model}`;
            if (!map.has(key)) map.set(key, m);
          }
          return [...map.values()];
        }, [models]);

        const [customRoute, setCustomRoute] = React.useState('');
        const [customLabel, setCustomLabel] = React.useState('');

        const findModelObj = (routeStr, fallback) => {
          const found = modelOptions.find((m) => `${m.provider}/${m.model}` === routeStr);
          if (found) return { label: found.label, provider: found.provider, model: found.model, ...(found.reasoningEffort ? { reasoningEffort: found.reasoningEffort } : {}) };
          const slash = String(routeStr || '').indexOf('/');
          if (slash > 0) {
            const provider = routeStr.slice(0, slash);
            const model = routeStr.slice(slash + 1);
            return { label: model.split('/').pop() || model, provider, model };
          }
          return fallback;
        };

        const isPanelistChecked = (m) =>
          (cfg.panelists ?? []).some((p) => p.provider === m.provider && p.model === m.model);

        const togglePanelist = (m) => {
          const cur = Array.isArray(cfg.panelists) ? [...cfg.panelists] : [];
          const idx = cur.findIndex((p) => p.provider === m.provider && p.model === m.model);
          if (idx >= 0) {
            if (cur.length <= 1) return; // keep at least 1 panelist
            cur.splice(idx, 1);
          } else {
            cur.push({ label: m.label, provider: m.provider, model: m.model });
          }
          onSave({ ...cfg, panelists: cur });
        };

        const addCustomModel = () => {
          const trimmed = customRoute.trim();
          if (!trimmed) return;
          const slash = trimmed.indexOf('/');
          // 必须写成 provider/model：仓库不再替用户补一个默认 provider
          if (slash <= 0) return;
          const provider = trimmed.slice(0, slash).trim();
          const model = trimmed.slice(slash + 1).trim();
          if (!provider || !model) return;
          const label = customLabel.trim() || model.split('/').pop() || model;
          const entry = { label, provider, model };
          const cur = Array.isArray(cfg.panelists) ? [...cfg.panelists] : [];
          if (!cur.some((p) => p.provider === provider && p.model === model)) {
            cur.push(entry);
          }
          setCustomRoute('');
          setCustomLabel('');
          onSave({ ...cfg, panelists: cur });
        };

        const finalRef = cfg.finalExpert ?? DEFAULT_CONFIG.finalExpert;
        const workerRef = cfg.workerModel ?? DEFAULT_CONFIG.workerModel;
        const reviewerRef = cfg.reviewer ?? DEFAULT_CONFIG.reviewer;

        return h(
          'div',
          { className: 'ep-settings-wrap' },

          // Card 1: 多轮评审流程（唯一流程，无模式选择）
          h(
            'section',
            { className: 'ep-card' },
            h(
              'div',
              { className: 'ep-card-head' },
              h(
                'div',
                null,
                h('h3', { className: 'ep-card-title' }, '1. 评审阵容与流程'),
                h(
                  'p',
                  { className: 'ep-card-desc' },
                  '固定流程：① 独立取证 → ② 交叉互审 → ③ 终裁定稿。没有单专家 / 原地接管等旁路模式；并行取证数等于你启用的专家数。',
                ),
              ),
            ),
            h(
              'div',
              { className: 'ep-pipe-flow' },
              ...PIPELINE_STAGES.map((st, i) =>
                h(
                  'div',
                  { key: st.id, className: `ep-pipe-node${st.id === 'arbiter' && cfg.enableArbiter === false ? ' ep-pipe-node-off' : ''}` },
                  h('div', { className: 'ep-pipe-index' }, `${st.index}`),
                  h('div', { className: 'ep-pipe-body' },
                    h('div', { className: 'ep-pipe-title' }, st.title),
                    h('div', { className: 'ep-pipe-badge' }, st.badge),
                    h('div', { className: 'ep-pipe-desc' }, st.desc),
                    st.id === 'arbiter' && cfg.enableArbiter === false
                      ? h('div', { className: 'ep-pipe-off-tag' }, '已关闭')
                      : null,
                  ),
                  i < PIPELINE_STAGES.length - 1 ? h('div', { className: 'ep-pipe-arrow' }, '→') : null,
                ),
              ),
            ),
            h(
              'div',
              { className: 'ep-form-grid' },
              h(
                'div',
                { className: 'ep-form-item' },
                h('label', { className: 'ep-form-label' }, '③ 终裁定稿'),
                h(
                  'label',
                  { className: 'ep-switch-row' },
                  h('input', {
                    type: 'checkbox',
                    checked: cfg.enableArbiter !== false,
                    onChange: (e) => onSave({ ...cfg, enableArbiter: e.target.checked }),
                  }),
                  h('span', null, cfg.enableArbiter !== false ? '已启用（推荐：互审后再由终裁把关）' : '已关闭（只跑 ① 取证 → ② 互审）'),
                ),
              ),
              h(
                'div',
                { className: 'ep-form-item' },
              ),
            ),

            h(
              'div',
              { className: 'ep-form-grid' },

              // Solo / Direct Takeover Expert
              h(
                'div',
                { className: 'ep-form-item' },
                h('label', { className: 'ep-form-label' }, '👑 ③ 终裁专家（最后把关并下发指派单）'),
                h(
                  'div',
                  { className: 'ep-form-control-row' },
                  h(
                    'select',
                    {
                      className: 'ep-select',
                      value: finalRef.model ? `${finalRef.provider}/${finalRef.model}` : '',
                      onChange: (e) => {
                        const picked = findModelObj(e.target.value, finalRef);
                        onSave({ ...cfg, finalExpert: picked });
                      },
                    },
                    ...modelOptions.map((m) =>
                      h('option', { key: `${m.provider}/${m.model}`, value: `${m.provider}/${m.model}` }, `${m.label} (${m.provider}/${m.model})`),
                    ),
                  ),
                  h(
                    'select',
                    {
                      className: 'ep-select ep-select-sm',
                      value: finalRef.reasoningEffort || '',
                      onChange: (e) => {
                        const effort = e.target.value || undefined;
                        const updated = { ...finalRef };
                        if (effort) updated.reasoningEffort = effort;
                        else delete updated.reasoningEffort;
                        onSave({ ...cfg, finalExpert: updated });
                      },
                      title: '推理档位（仅声明了 reasoningEfforts 的路由如 Argon 支持 high；其他路由请选默认）',
                    },
                    h('option', { value: '' }, '默认档位 (推荐)'),
                    h('option', { value: 'high' }, 'high (仅 Argon/Gemini)'),
                    h('option', { value: 'medium' }, 'medium'),
                    h('option', { value: 'low' }, 'low'),
                  ),
                  h(
                    'span',
                    { className: 'ep-row-hint' },
                    '仅作展示：③ 终裁由该模型执行',
                  ),
                ),
              ),

              // Daily Worker Model
              h(
                'div',
                { className: 'ep-form-item' },
                h('label', { className: 'ep-form-label' }, '🛠️ 日常主力施工模型（专家下发指派单后负责具体编码与收尾）'),
                h(
                  'div',
                  { className: 'ep-form-control-row' },
                  h(
                    'select',
                    {
                      className: 'ep-select',
                      value: workerRef.model ? `${workerRef.provider}/${workerRef.model}` : '',
                      onChange: (e) => {
                        const picked = findModelObj(e.target.value, workerRef);
                        delete picked.reasoningEffort;
                        onSave({ ...cfg, workerModel: picked });
                      },
                    },
                    ...modelOptions.map((m) =>
                      h('option', { key: `${m.provider}/${m.model}`, value: `${m.provider}/${m.model}` }, `${m.label} (${m.provider}/${m.model})`),
                    ),
                  ),
                  h(
                    'span',
                    { className: 'ep-row-hint' },
                    '仅作展示：专家下发指派单后由主力模型接力施工',
                  ),
                ),
              ),

              // Cross-Reviewer Model
              h(
                'div',
                { className: 'ep-form-item' },
                h('label', { className: 'ep-form-label' }, '🔍 ② 交叉互审官（逐条挑刺并收敛方案）'),
                h(
                  'div',
                  { className: 'ep-form-control-row' },
                  h(
                    'select',
                    {
                      className: 'ep-select',
                      value: reviewerRef.model ? `${reviewerRef.provider}/${reviewerRef.model}` : '',
                      onChange: (e) => {
                        const picked = findModelObj(e.target.value, reviewerRef);
                        delete picked.reasoningEffort;
                        onSave({ ...cfg, reviewer: picked });
                      },
                    },
                    ...modelOptions.map((m) =>
                      h('option', { key: `${m.provider}/${m.model}`, value: `${m.provider}/${m.model}` }, `${m.label} (${m.provider}/${m.model})`),
                    ),
                  ),
                  h(
                    'span',
                    { className: 'ep-switch-row', style: { opacity: 0.75 } },
                    h('span', null, '② 交叉互审：固定开启（多轮评审不可跳过）'),
                  ),
                ),
              ),
            ),

            h('div', { className: 'ep-subhead' }, `① 独立取证专家（已启用 ${(cfg.panelists ?? []).length} 个）`),
            h('p', { className: 'ep-card-desc' }, '点击切换「● 已启用 / ○ 已暂停」；未启用的模型在任何情况下都不会被启动。'),
            h(
              'div',
              { className: 'ep-roster-grid' },
              ...modelOptions.map((m) => {
                const checked = isPanelistChecked(m);
                const orderIdx = (cfg.panelists ?? []).findIndex((p) => p.provider === m.provider && p.model === m.model);
                return h(
                  'div',
                  {
                    key: `${m.provider}/${m.model}`,
                    className: `ep-roster-item${checked ? ' ep-roster-item-on' : ''}`,
                    onClick: () => togglePanelist(m),
                  },
                  h(
                    'div',
                    { className: 'ep-roster-item-top' },
                    h('span', { className: 'ep-roster-check' }, checked ? `● 已启用 #${orderIdx + 1}` : '○ 已暂停'),
                  ),
                  h('div', { className: 'ep-roster-name' }, m.label),
                  h('code', { className: 'ep-route-tag' }, `${m.provider}/${m.model}`),
                );
              }),
              modelOptions.length === 0
                ? h(
                    'div',
                    { className: 'ep-empty', key: 'no-models' },
                    '宿主还没有返回可用的 provider / model 列表：先确认 DSH 里已配好 provider，或用下方输入框手填 provider/model。',
                  )
                : null,
            ),
            h(
              'div',
              { className: 'ep-custom-add' },
              h('input', {
                type: 'text',
                className: 'ep-input',
                placeholder: '添加自定义路由（provider/model，用 /expert routes 查看）',
                value: customRoute,
                onChange: (e) => setCustomRoute(e.target.value),
              }),
              h('input', {
                type: 'text',
                className: 'ep-input',
                style: { maxWidth: '180px' },
                placeholder: '显示名称（可选）',
                value: customLabel,
                onChange: (e) => setCustomLabel(e.target.value),
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ep-action-btn ep-action-primary',
                  onClick: addCustomModel,
                },
                '+ 加入专家库',
              ),
            ),
          ),

          // Card 4: Confirmation Policy & Anti-Hang Safety Budgets
          h(
            'section',
            { className: 'ep-card' },
            h(
              'div',
              { className: 'ep-card-head' },
              h('div', null,
                h('h3', { className: 'ep-card-title' }, '2. 门禁与收口预算'),
                h('p', { className: 'ep-card-desc' }, '开启人工确认后，召唤专家时仅弹出一个「✅ 确认启动 / ❌ 暂不启动」极简确认卡；步数与超时熔断可防止子会话无限跑下去卡死主会话。'),
              ),
            ),
            h(
              'div',
              { className: 'ep-budget-grid' },
              h(
                'div',
                { className: 'ep-budget-box' },
                h('div', { className: 'ep-budget-title' }, '🛡️ 启动前本人人工确认'),
                h(
                  'label',
                  { className: 'ep-switch-row', style: { marginTop: '6px' } },
                  h('input', {
                    type: 'checkbox',
                    checked: cfg.requireApproval !== false,
                    onChange: (e) => onSave({ ...cfg, requireApproval: e.target.checked }),
                  }),
                  h('span', null, cfg.requireApproval !== false ? '已开启（每次启动弹极简一键确认卡）' : '已关闭（召唤即刻全自动执行，零弹窗）'),
                ),
              ),

              h(
                'div',
                { className: 'ep-budget-box' },
                h('div', { className: 'ep-budget-title' }, `⚡ 单次专家最大步数预算（当前: ${cfg.maxStepsPerExpert || 30} 步）`),
                h(
                  'div',
                  { className: 'ep-step-chips' },
                  ...[20, 30, 40, 60, 90].map((n) =>
                    h(
                      'button',
                      {
                        key: n,
                        type: 'button',
                        className: `ep-step-chip${(cfg.maxStepsPerExpert || 30) === n ? ' ep-step-chip-on' : ''}`,
                        onClick: () => onSave({ ...cfg, maxStepsPerExpert: n }),
                      },
                      `${n} 步`,
                    ),
                  ),
                ),
              ),

              h(
                'div',
                { className: 'ep-budget-box' },
                h('div', { className: 'ep-budget-title' }, `⏱ 单次有效工作时长上限（当前: ${Math.round((cfg.expertTimeoutSeconds || 1800) / 60)} 分钟 · 不含工具执行等待）`),
                h(
                  'div',
                  { className: 'ep-step-chips' },
                  ...[600, 900, 1200, 1800, 2700].map((s) =>
                    h(
                      'button',
                      {
                        key: s,
                        type: 'button',
                        className: `ep-step-chip${(cfg.expertTimeoutSeconds || 1800) === s ? ' ep-step-chip-on' : ''}`,
                        onClick: () => onSave({ ...cfg, expertTimeoutSeconds: s }),
                      },
                      `${Math.round(s / 60)} 分钟`,
                    ),
                  ),
                ),
              ),


            ),
          ),

          h(
            'div',
            { className: 'ep-save-bar' },
            h(
              'span',
              { className: 'ep-save-hint' },
              saving ? '正在同步保存设置…' : banner || '✅ 所有修改均已自动保存，下次在对话中 @专家 或自然语言召唤时立即按此配置执行。',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ep-action-btn ep-action-primary',
                onClick: () => onSave(cfg, true),
              },
              '💾 立即保存并同步到宿主',
            ),
          ),
        );
      }

      function ExpertPanel(props) {
        const currentSessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined;
        let allRuns = [];
        try {
          allRuns = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) ?? [];
        } catch {
          allRuns = [];
        }

        const [mainTab, setMainTab] = React.useState('monitor'); // 'monitor' | 'settings'
        const [apiOnline, setApiOnline] = React.useState(false);
        const [cfg, setCfg] = React.useState(() => readLocalSettings());
        const [availableModels, setAvailableModels] = React.useState([]);
        const [promptInput, setPromptInput] = React.useState('');
        const [statusBanner, setStatusBanner] = React.useState('');
        const [busyAction, setBusyAction] = React.useState(false);
        const syncedLocalOnce = React.useRef(false);

        const pollHost = React.useCallback(async () => {
          try {
            const data = await callHostApi('state');
            hostState = data;
            setApiOnline(true);
            if (Array.isArray(data.availableModels) && data.availableModels.length > 0) {
              setAvailableModels(data.availableModels);
            }
            if (!syncedLocalOnce.current) {
              syncedLocalOnce.current = true;
              const localRaw = localStorage.getItem(STORAGE_SLOT);
              if (localRaw) {
                try {
                  const localCfg = JSON.parse(localRaw);
                  await callHostApi('config', 'PUT', localCfg);
                } catch {}
              } else if (data.config) {
                setCfg((prev) => ({ ...prev, ...data.config }));
                writeLocalSettings({ ...DEFAULT_CONFIG, ...data.config });
              }
            } else if (data.config) {
              setCfg((prev) => ({ ...prev, ...data.config }));
            }
            rebuildMerged();
          } catch {
            setApiOnline(false);
          }
        }, []);

        React.useEffect(() => {
          let active = true;
          let timer;
          const loop = async () => {
            if (!active) return;
            await pollHost();
            if (!active) return;
            const hasLive = mergedRows.some((r) => r.activity === 'running');
            timer = setTimeout(loop, hasLive ? 2200 : 5000);
          };
          loop();
          return () => {
            active = false;
            clearTimeout(timer);
          };
        }, [pollHost]);

        const handleSaveConfig = async (nextCfg, explicitToast = false) => {
          setCfg(nextCfg);
          writeLocalSettings(nextCfg);
          setBusyAction(true);
          try {
            const res = await callHostApi('config', 'PUT', nextCfg);
            if (res?.state?.config) {
              setCfg((prev) => ({ ...prev, ...res.state.config }));
            }
            setStatusBanner('✅ 设置已实时保存并同步至宿主引擎（零重启立即生效）');
          } catch {
            if (explicitToast) {
              setStatusBanner('✅ 设置已保存在本地（重启一次 DSH 桌面端即可同步至宿主引擎）');
            }
          } finally {
            setBusyAction(false);
          }
        };

        const sessionRuns = currentSessionId
          ? allRuns.filter((run) => run.sessionId === currentSessionId)
          : allRuns;

        const [scope, setScope] = React.useState('auto');
        const effectiveScope = scope === 'auto' ? (sessionRuns.length > 0 ? 'session' : 'all') : scope;

        const displayedRuns = effectiveScope === 'session' ? sessionRuns : allRuns;
        const live = allRuns.filter((run) => run.activity === 'running');
        const consult = displayedRuns.filter((run) => run.tier === '会诊' || run.tier === '互审').length;
        const arbiter = displayedRuns.filter((run) => run.tier === '终裁').length;
        const totalSteps = displayedRuns.reduce((acc, r) => acc + (r.steps || 0), 0);
        const totalTokens = displayedRuns.reduce((acc, r) => acc + (r.totalTokens || 0), 0);

        const handleStop = async (childId, sessionId) => {
          setBusyAction(true);
          try {
            await callHostApi('stop', 'POST', { childId, sessionId: sessionId || currentSessionId });
            setStatusBanner('✅ 已发送中断收尾信号，专家将立即汇总已完成部分并释放主会话。');
            await pollHost();
          } catch (err) {
            setStatusBanner(`⚠️ 中断请求需重启生效或直接进入子会话点停止 (${err.message})`);
          } finally {
            setBusyAction(false);
          }
        };

        const handleSummonByPreset = async () => {
          const cmd = promptInput.trim();
          setBusyAction(true);
          try {
            const res = await callHostApi('summon', 'POST', {
              sessionId: currentSessionId,
              command: cmd,
            });
            setStatusBanner(res.message ? res.message.split('\n')[0] : `⚡ 已按预设启动: /expert ${cmd}`);
            setPromptInput('');
            await pollHost();
          } catch {
            try {
              await navigator.clipboard?.writeText(`/expert ${cmd}`);
            } catch {}
            setStatusBanner(`📋 已复制「/expert ${cmd}」到剪贴板（重启 DSH 后支持面板一键直接触发）`);
          } finally {
            setBusyAction(false);
          }
        };

        const handleQuickFollowup = async (run, question) => {
          const target = run.teamMemberName || run.childId.slice(0, 8);
          setBusyAction(true);
          try {
            const res = await callHostApi('summon', 'POST', {
              sessionId: run.sessionId || currentSessionId,
              command: `ask ${target} ${question}`,
            });
            setStatusBanner(res.message || `⚡ 已向 ${run.expert} (${target}) 发送追问`);
            await pollHost();
          } catch {
            try {
              await navigator.clipboard?.writeText(`/expert ask ${target} ${question}`);
            } catch {}
            setStatusBanner(`📋 已复制「/expert ask ${target} ${question}」到剪贴板，粘贴到输入框即可发送`);
          } finally {
            setBusyAction(false);
          }
        };

        const pipelineLabel = cfg.enableArbiter !== false
          ? '多轮评审 · ① 取证 → ② 互审 → ③ 终裁'
          : '多轮评审 · ① 取证 → ② 互审（终裁关闭）';
        const currentModeObj = { title: pipelineLabel, tone: 'review', badge: '多轮评审' };
        const finalRef = cfg.finalExpert ?? DEFAULT_CONFIG.finalExpert;
        const workerRef = cfg.workerModel ?? DEFAULT_CONFIG.workerModel;

        return h(
          'div',
          { className: 'ep-scroll-shell' },
          h('style', null, EP_CSS),
          h(
          'div',
          { className: 'ep-panel' },

          // Top Hero Header with Mode Summary & View Switcher
          h(
            'header',
            { className: 'ep-head' },
            h(
              'div',
              { className: 'ep-head-text' },
              h(
                'div',
                { className: 'ep-title-row' },
                h('h2', { className: 'ep-title' }, '⚡ 专家团'),
                h(
                  'span',
                  {
                    className: `ep-badge ep-tone-${currentModeObj.tone}`,
                    style: { cursor: 'pointer' },
                    onClick: () => setMainTab('settings'),
                    title: '点击进入设置中心修改默认启动模式',
                  },
                  `当前预设: ${currentModeObj.title}`,
                ),
              ),
              h(
                'p',
                { className: 'ep-subtitle' },
                (cfg.panelists ?? []).length === 0
                  ? '还没有配置阵容：到「⚙️ 设置」里至少选一位取证专家（provider / model）。未配置前 /expert 与 @专家 不会启动任何模型。'
                  : '流程、阵容与预算都在本页预设完成。日常对话只需输入 @专家 或说「请专家看看」，点一次确认即可启动多轮评审。',
              ),
            ),
            h(
              'div',
              { className: 'ep-nav-bar' },
              h(
                'button',
                {
                  type: 'button',
                  className: `ep-nav-btn${mainTab === 'monitor' ? ' ep-nav-btn-active' : ''}`,
                  onClick: () => setMainTab('monitor'),
                },
                `📊 运行记录 (${allRuns.length})`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: `ep-nav-btn${mainTab === 'settings' ? ' ep-nav-btn-active' : ''}`,
                  onClick: () => setMainTab('settings'),
                },
                '⚙️ 设置',
              ),
            ),
          ),

          // Live running banner with 1-click anti-hang Stop button!
          live.length > 0
            ? h(
                'section',
                { className: 'ep-live-banner' },
                h(
                  'div',
                  { className: 'ep-live-banner-info' },
                  h('span', { className: 'ep-dot ep-dot-live' }),
                  h(
                    'div',
                    null,
                    h(
                      'strong',
                      null,
                      `正在运行 ${live.length} 位专家：${live.map((r) => `${r.expert} (第 ${r.steps || 1}/${r.maxSteps || 18} 步)`).join('、')}`,
                    ),
                    h(
                      'div',
                      { className: 'ep-live-banner-sub' },
                      '已启用步数上限与超时自动收尾保护。若你希望主会话立刻恢复响应，可点击右侧按钮立即收尾移交。',
                    ),
                  ),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ep-stop-btn ep-stop-btn-lg',
                    disabled: busyAction,
                    onClick: () => handleStop(live[0]?.childId, live[0]?.sessionId),
                  },
                  '⏹ 立即收尾并解除主会话等待',
                ),
              )
            : null,

          mainTab === 'settings'
            ? h(SettingsView, {
                cfg,
                models: availableModels,
                onSave: handleSaveConfig,
                saving: busyAction,
                banner: statusBanner,
              })
            : h(
                React.Fragment,
                null,
                // Quick Console Bar
                h(
                  'section',
                  { className: 'ep-console' },
                  h(
                    'div',
                    { className: 'ep-console-top' },
                    h(
                      'div',
                      { className: 'ep-preset-summary' },
                      h('span', { className: 'ep-preset-label' }, '当前生效预设：'),
                      h('strong', null, currentModeObj.title),
                      h(
                        'span',
                        { className: 'ep-preset-detail' },
                        `（① 取证: ${(cfg.panelists ?? []).map((p) => p.label).join(' + ') || '—'} → ② 互审: ${cfg.reviewer?.label || '—'}${cfg.enableArbiter !== false ? ` → ③ 终裁: ${finalRef.label}` : '（终裁关闭）'}）`,
                      ),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ep-link-btn',
                        onClick: () => setMainTab('settings'),
                      },
                      '⚙️ 修改阵容与预算 ›',
                    ),
                  ),

                  h(
                    'div',
                    { className: 'ep-console-row' },
                    h('input', {
                      type: 'text',
                      className: 'ep-input',
                      placeholder: '输入问题一键发起多轮评审，或在对话里直接说「@专家 帮我看看这个问题」…',
                      value: promptInput,
                      onChange: (e) => setPromptInput(e.target.value),
                      onKeyDown: (e) => {
                        if (e.key === 'Enter') handleSummonByPreset();
                      },
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ep-action-btn ep-action-primary',
                        disabled: busyAction,
                        onClick: () => handleSummonByPreset(),
                      },
                      '⚡ 发起多轮评审',
                    ),
                  ),

                  h(
                    'div',
                    { className: 'ep-takeover-bar' },
                    h('span', { className: 'ep-takeover-label' }, '流程固定为多轮评审，无单专家 / 原地接管模式；可在'),
                    h(
                      'button',
                      { type: 'button', className: 'ep-link-btn', onClick: () => setMainTab('settings') },
                      '设置',
                    ),
                    h('span', { className: 'ep-takeover-label' }, '中调整阵容与终裁开关。'),
                  ),
                  statusBanner ? h('div', { className: 'ep-status-banner' }, statusBanner) : null,
                ),

                h(
                  'section',
                  { className: 'ep-stats' },
                  Stat({
                    label: effectiveScope === 'session' ? '当前会话记录' : '全工作区历史记录',
                    value: displayedRuns.length,
                    sub: `全库共 ${allRuns.length} 次运行 · ${consult} 次会诊/互审`,
                  }),
                  Stat({
                    label: '专家累计排查步数',
                    value: totalSteps,
                    sub: `单次预算上限 ${cfg.maxStepsPerExpert || 30} 步`,
                    tone: 'consult',
                  }),
                  Stat({
                    label: '累计 Token 吞吐',
                    value: formatTokens(totalTokens) || '0',
                    sub: '含缓存读取与裁决输出',
                    tone: 'review',
                  }),
                  Stat({
                    label: '终裁/接管动用',
                    value: arbiter,
                    sub: live.length > 0 ? `${live.length} 位专家运行中` : '当前无阻塞运行',
                    tone: arbiter > 0 ? 'final' : live.length > 0 ? 'live' : undefined,
                  }),
                ),

                h(
                  'div',
                  { className: 'ep-scope-bar' },
                  h(
                    'div',
                    { className: 'ep-tabs' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: `ep-tab${effectiveScope === 'all' ? ' ep-tab-active' : ''}`,
                        onClick: () => setScope('all'),
                      },
                      `全部历史记录 (${allRuns.length})`,
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: `ep-tab${effectiveScope === 'session' ? ' ep-tab-active' : ''}`,
                        onClick: () => setScope('session'),
                      },
                      `仅看当前会话 (${sessionRuns.length})`,
                    ),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                    h(
                      'span',
                      { className: 'ep-scope-hint' },
                      apiOnline ? '🟢 跨工作区历史引擎已连接' : '🟡 前端会话投影模式',
                    ),
                    Chip({
                      children: '↻ 刷新',
                      onClick: () => {
                        refreshedParents.clear();
                        reconcile();
                        pollHost();
                      },
                    }),
                  ),
                ),

                displayedRuns.length === 0
                  ? h(
                      'section',
                      { className: 'ep-empty' },
                      h('div', { className: 'ep-empty-icon', 'aria-hidden': true }, '⚡'),
                      h(
                        'h3',
                        { className: 'ep-empty-title' },
                        effectiveScope === 'session' ? '当前会话还没有召集过专家团' : '暂未扫描到专家团运行记录',
                      ),
                      h(
                        'p',
                        { className: 'ep-empty-text' },
                        effectiveScope === 'session' && allRuns.length > 0
                          ? `其他工作区会话共有 ${allRuns.length} 条专家运行记录，点击下方按钮即可查看：`
                          : '现在你可以在对话中直接说「@专家 帮我看看这个问题」或点击上方按钮一键启动。',
                      ),
                      effectiveScope === 'session' && allRuns.length > 0
                        ? h(
                            'div',
                            { style: { marginTop: '10px' } },
                            Chip({
                              children: `查看全部历史记录 (${allRuns.length}) ›`,
                              onClick: () => setScope('all'),
                              tone: 'ok',
                            }),
                          )
                        : null,
                    )
                  : h(
                      'section',
                      { className: 'ep-list-wrap' },
                      h(
                        'ul',
                        { className: 'ep-list' },
                        ...displayedRuns.map((run) =>
                          h(RunRow, {
                            key: run.childId,
                            run,
                            isCurrentSession: currentSessionId && run.sessionId === currentSessionId,
                            onOpen: openExpertSession,
                            onStop: handleStop,
                            onQuickFollowup: handleQuickFollowup,
                          }),
                        ),
                      ),
                    ),
              ),
          ),
        );
      }

      // 左侧栏全局面板：main（页面）+ sidebar.panellist（图标入口，order 16 位于「自进化」order 15 正下方）
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'expert-panel' }, (props) => h(ExpertPanel, props)),
      );
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'expert-panel',
            order: 16,
            label: () => '专家团',
          },
          ExpertPanelIcon,
        ),
      );
    }

    const EP_CSS = `
/* ──────────────────────────────────────────────────────────────
   专家团 · 极简设计系统
   刻度: 间距 4/8/12/16/24/32 · 字号 11/12.5/15/20 · 圆角 6/10/999
   色彩: 单主色 indigo + emerald(成功) + amber(警告) + red(错误)
   原则: 卡片不画边框，用间距与背景层级区分；不嵌套卡片
   ────────────────────────────────────────────────────────────── */

/* main 插槽的父容器不滚动，面板必须自己成为滚动容器（红线：不可改） */
.ep-scroll-shell{
  height:100%;
  width:100%;
  box-sizing:border-box;
  overflow-y:auto;
  overflow-x:hidden;
  overscroll-behavior:contain;
  -webkit-overflow-scrolling:touch;
  scrollbar-gutter:stable;
}

.ep-panel{
  --ep-accent:#6366f1;
  --ep-accent-soft:color-mix(in srgb,#6366f1 14%,transparent);
  --ep-ok:#10b981;
  --ep-warn:#f59e0b;
  --ep-err:#ef4444;
  --ep-line:color-mix(in srgb,var(--dsw-alias-border-l1,#3f3f46) 60%,transparent);
  --ep-surface:var(--dsw-alias-bg-layer-1,#18181b);
  --ep-surface-2:var(--dsw-alias-bg-layer-2,#27272a);
  --ep-fg:var(--dsw-alias-label-primary,#e4e4e7);
  --ep-fg-2:var(--dsw-alias-label-secondary,#a1a1aa);
  --ep-fg-3:var(--dsw-alias-label-tertiary,#71717a);
  --ep-mono:'SF Mono',ui-monospace,SFMono-Regular,Menlo,monospace;

  color:var(--ep-fg);
  font-size:12.5px;
  line-height:1.6;
  padding:24px 24px 32px;
  display:flex;
  flex-direction:column;
  gap:24px;
  max-width:940px;
  margin:0 auto;
  min-width:0;
  font-feature-settings:"tnum" 1;
  -webkit-font-smoothing:antialiased;
}

/* ── 页头 ────────────────────────────────────────────── */
.ep-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.ep-head-text{min-width:0;flex:1}
.ep-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ep-title{margin:0;font-size:17px;font-weight:640;letter-spacing:-.01em;line-height:1.35}
.ep-subtitle{margin:6px 0 0;color:var(--ep-fg-3);font-size:12.5px;line-height:1.55;max-width:56ch}

/* ── 页签（唯一导航，不再有第二套同形控件）──────────── */
.ep-nav-bar{display:inline-flex;gap:2px;align-self:center}
.ep-nav-btn{
  border:none;background:transparent;color:var(--ep-fg-3);
  padding:6px 12px;border-radius:6px;cursor:pointer;
  font-size:12.5px;font-weight:500;font-family:inherit;
  transition:color .15s cubic-bezier(.2,0,.38,.9),background .15s cubic-bezier(.2,0,.38,.9);
}
.ep-nav-btn:hover{color:var(--ep-fg);background:var(--ep-surface)}
.ep-nav-btn-active{color:var(--ep-fg);background:var(--ep-surface);font-weight:600}

/* ── 分级页签（范围切换）→ 纯文字 ───────────────────── */
.ep-tabs{display:inline-flex;gap:12px;align-items:center}
.ep-tab{
  border:none;background:none;padding:0;cursor:pointer;font-family:inherit;
  color:var(--ep-fg-3);font-size:12.5px;transition:color .15s;
}
.ep-tab:hover{color:var(--ep-fg-2)}
.ep-tab-active{color:var(--ep-accent);font-weight:600}

/* ── 区块（无边框、无卡片背景）──────────────────────── */
.ep-card{display:flex;flex-direction:column;gap:12px;min-width:0}
.ep-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.ep-card-title{margin:0;font-size:15px;font-weight:620;letter-spacing:-.01em}
.ep-subhead{margin:8px 0 0;font-size:12.5px;font-weight:600;color:var(--ep-fg-2)}
.ep-card-desc{margin:4px 0 0;color:var(--ep-fg-3);font-size:12.5px;line-height:1.55;max-width:64ch}

/* ── 控制台 ──────────────────────────────────────────── */
.ep-console{display:flex;flex-direction:column;gap:12px;padding:12px 16px;border-radius:10px;background:var(--ep-surface)}
.ep-console-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ep-preset-summary{min-width:0;flex:1;font-size:12.5px;line-height:1.6}
.ep-preset-label{color:var(--ep-fg-3)}
.ep-preset-detail{color:var(--ep-fg-3);display:block;margin-top:2px;font-family:var(--ep-mono);font-size:11px}
.ep-console-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ep-console-row .ep-input{flex:1;min-width:200px}

/* ── 输入控件 ────────────────────────────────────────── */
.ep-input,.ep-select,.ep-select-sm{
  box-sizing:border-box;
  background:var(--dsw-alias-bg-base,#09090b);
  border:1px solid var(--ep-line);
  border-radius:6px;color:var(--ep-fg);
  padding:6px 8px;font-size:12.5px;font-family:inherit;
  transition:border-color .15s;
}
.ep-input:focus,.ep-select:focus{outline:none;border-color:var(--ep-accent)}
.ep-select-sm{padding:4px 8px;font-size:12.5px}
.ep-input::placeholder{color:var(--ep-fg-3)}

/* ── 按钮 ────────────────────────────────────────────── */
.ep-action-btn,.ep-pill-btn,.ep-stop-btn,.ep-open-btn,.ep-ask-btn,.ep-toggle-btn,.ep-link-btn,.ep-stop-btn-lg{
  box-sizing:border-box;font-family:inherit;font-size:12.5px;cursor:pointer;
  border-radius:6px;border:1px solid var(--ep-line);
  background:transparent;color:var(--ep-fg-2);
  padding:6px 12px;line-height:1.4;
  transition:background .15s,border-color .15s,color .15s,opacity .15s;
}
.ep-action-btn:hover,.ep-pill-btn:hover,.ep-stop-btn:hover,.ep-open-btn:hover,.ep-ask-btn:hover,.ep-toggle-btn:hover,.ep-stop-btn-lg:hover{
  background:var(--ep-surface);color:var(--ep-fg);border-color:var(--ep-line);
}
.ep-action-btn:disabled,.ep-pill-btn:disabled{opacity:.45;cursor:not-allowed}
.ep-action-primary{
  background:var(--ep-accent);border-color:transparent;color:#fff;font-weight:600;
}
.ep-action-primary:hover{background:#4f46e5;color:#fff}
.ep-stop-btn,.ep-stop-btn-lg{border-color:color-mix(in srgb,var(--ep-err) 45%,transparent);color:var(--ep-err)}
.ep-stop-btn:hover,.ep-stop-btn-lg:hover{background:color-mix(in srgb,var(--ep-err) 12%,transparent);color:var(--ep-err)}
.ep-stop-btn-lg{padding:8px 16px;font-weight:600}
.ep-pill-final{color:var(--ep-accent);border-color:color-mix(in srgb,var(--ep-accent) 40%,transparent)}
.ep-pill-final:hover{background:var(--ep-accent-soft);color:var(--ep-accent)}
.ep-pill-ok{color:var(--ep-ok);border-color:color-mix(in srgb,var(--ep-ok) 40%,transparent)}
.ep-link-btn{border:none;background:none;color:var(--ep-accent);padding:0;font-size:12.5px}
.ep-link-btn:hover{background:none;text-decoration:underline}
.ep-toggle-btn{border:none;background:none;color:var(--ep-fg-3);padding:0;font-size:12.5px}
.ep-toggle-btn:hover{background:none;color:var(--ep-fg)}
.ep-ask-inline{display:inline-flex;gap:6px;align-items:center;margin-top:8px;width:100%}
.ep-ask-inline .ep-input{flex:1}

/* ── 统计 ────────────────────────────────────────────── */
.ep-stats{display:flex;gap:32px;flex-wrap:wrap;padding:4px 0}
.ep-stat{display:flex;flex-direction:column;gap:2px;min-width:0}
.ep-stat-value{font-size:20px;font-weight:640;font-variant-numeric:tabular-nums;line-height:1.2;letter-spacing:-.02em}
.ep-stat-value{background:none!important}
.ep-stat-value.ep-tone-final,.ep-stat-value.ep-tone-consult{color:var(--ep-accent);background:none}
.ep-stat-value.ep-tone-live{color:var(--ep-ok);background:none}
.ep-stat-value.ep-tone-review{color:var(--ep-fg);background:none}
.ep-stat-label{font-size:11px;color:var(--ep-fg-3)}
.ep-stat-sub{font-size:11px;color:var(--ep-fg-3);font-family:var(--ep-mono)}

/* ── 列表 ────────────────────────────────────────────── */
.ep-list-wrap{display:flex;flex-direction:column;gap:12px;min-width:0}
.ep-list{display:flex;flex-direction:column;gap:2px;list-style:none;margin:0;padding:0}
.ep-row{
  display:flex;flex-direction:column;gap:8px;
  padding:12px 0;border-top:1px solid var(--ep-line);
}
.ep-row:first-child{border-top:none}
.ep-row-live{background:color-mix(in srgb,var(--ep-ok) 6%,transparent);border-radius:6px;padding:12px 12px;margin:0 -12px}
.ep-row-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.ep-row-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.ep-row-metrics{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--ep-fg-3);font-family:var(--ep-mono)}
.ep-row-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ep-row-hint{font-size:11px;color:var(--ep-fg-3);line-height:1.5}

/* ── 行内标记 ────────────────────────────────────────── */
.ep-expert{font-size:12.5px;font-weight:620;color:var(--ep-fg)}
.ep-route-tag,.ep-child-id,.ep-session-tag,.ep-current-tag,.ep-done-tag,.ep-team-tag,.ep-task-pill,.ep-live-tag,.ep-meta-time,.ep-files-written,.ep-prompt-preview{
  font-size:11px;font-family:var(--ep-mono);color:var(--ep-fg-3);line-height:1.6;
}
.ep-current-tag{color:var(--ep-accent)}
.ep-done-tag{color:var(--ep-ok)}
.ep-live-tag{color:var(--ep-ok)}
.ep-prompt-preview{color:var(--ep-fg-2);font-family:inherit;font-size:12.5px}
.ep-files-written{color:var(--ep-fg-2)}
.ep-metric-pill{font-size:11px;font-family:var(--ep-mono);color:var(--ep-fg-3)}

/* 状态点 */
.ep-dot{width:6px;height:6px;border-radius:999px;background:var(--ep-fg-3);flex:none;display:inline-block}
.ep-dot-live{background:var(--ep-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ep-ok) 18%,transparent)}
.ep-dot-done{background:var(--ep-fg-3)}

/* 徽章 */
.ep-badge,.ep-chip{
  display:inline-flex;align-items:center;gap:4px;
  font-size:11px;font-weight:500;line-height:1.7;
  padding:2px 8px;border-radius:999px;
  background:var(--ep-surface-2);color:var(--ep-fg-2);
}
.ep-badge.ep-tone-final,.ep-badge.ep-tone-consult,.ep-chip.ep-tone-final,.ep-chip.ep-tone-consult{background:var(--ep-accent-soft);color:var(--ep-accent)}
.ep-badge.ep-tone-review,.ep-chip.ep-tone-review{background:var(--ep-surface-2);color:var(--ep-fg-2)}
.ep-badge.ep-tone-live,.ep-chip.ep-tone-live{background:color-mix(in srgb,var(--ep-ok) 14%,transparent);color:var(--ep-ok)}
.ep-badge.ep-tone-takeover,.ep-badge.ep-tone-ok,.ep-chip.ep-tone-takeover,.ep-chip.ep-tone-ok{background:color-mix(in srgb,var(--ep-ok) 14%,transparent);color:var(--ep-ok)}
.ep-chip-btn{cursor:pointer;border:none;font-family:inherit}
.ep-chip-final{background:var(--ep-accent-soft);color:var(--ep-accent)}
.ep-chip-ok{background:color-mix(in srgb,var(--ep-ok) 14%,transparent);color:var(--ep-ok)}
.ep-chip-live{background:color-mix(in srgb,var(--ep-ok) 14%,transparent);color:var(--ep-ok)}

/* ── 结论 / 时间线（去掉嵌套边框，靠左侧竖线）────────── */
.ep-verdict-box{margin-top:2px;padding-left:12px;border-left:2px solid var(--ep-accent)}
.ep-verdict-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ep-verdict-label{font-size:11px;font-weight:600;color:var(--ep-fg-3);letter-spacing:.02em}
.ep-verdict-text{margin:6px 0 0;font-size:12.5px;color:var(--ep-fg-2);line-height:1.65;white-space:pre-wrap;word-break:break-word}
.ep-verdict-expanded{max-height:none}
.ep-timeline-box{margin-top:8px;padding-left:12px;border-left:1px solid var(--ep-line)}
.ep-timeline-list{display:flex;flex-direction:column;gap:6px;list-style:none;margin:0;padding:0}
.ep-timeline-item{display:flex;gap:8px;font-size:11px;color:var(--ep-fg-3);min-width:0}
.ep-tl-step{font-family:var(--ep-mono);color:var(--ep-fg-3);flex:none}
.ep-tl-tool{font-family:var(--ep-mono);color:var(--ep-fg-2);flex:none}
.ep-tl-sum{color:var(--ep-fg-3);min-width:0;overflow-wrap:anywhere}

/* ── 横幅 ────────────────────────────────────────────── */
.ep-live-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
  padding:8px 12px;border-radius:6px;background:color-mix(in srgb,var(--ep-ok) 8%,transparent)}
.ep-live-banner-info{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ep-ok);min-width:0}
.ep-live-banner-sub{font-size:11px;color:var(--ep-fg-3);margin-top:2px}
  padding:8px 12px;border-radius:6px;background:color-mix(in srgb,var(--ep-warn) 8%,transparent)}
.ep-status-banner{padding:8px 12px;border-radius:6px;background:var(--ep-surface);font-size:12.5px;color:var(--ep-fg-2)}

/* ── 范围 / 空态 ─────────────────────────────────────── */
.ep-scope-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ep-scope-hint{font-size:11px;color:var(--ep-fg-3)}
.ep-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:32px 16px;text-align:center}
.ep-empty-icon{font-size:20px;opacity:.5}
.ep-empty-title{font-size:12.5px;font-weight:600;color:var(--ep-fg-2)}
.ep-empty-text{font-size:12.5px;color:var(--ep-fg-3);max-width:44ch;line-height:1.6}

/* ── 设置表单 ────────────────────────────────────────── */
.ep-settings-wrap{display:flex;flex-direction:column;gap:32px}
.ep-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px 24px}
.ep-form-item{display:flex;flex-direction:column;gap:6px;min-width:0}
.ep-form-label{font-size:11px;color:var(--ep-fg-3);font-weight:500}
.ep-form-control-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ep-form-control-row .ep-select{flex:1;min-width:160px}
.ep-switch-row{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ep-fg-2);cursor:pointer}
.ep-switch-row input[type="checkbox"]{accent-color:var(--ep-accent);width:14px;height:14px}
.ep-step-chips{display:flex;gap:6px;flex-wrap:wrap}
.ep-step-chip{
  border:1px solid var(--ep-line);background:transparent;color:var(--ep-fg-3);
  font-family:inherit;font-size:11px;padding:2px 8px;border-radius:999px;cursor:pointer;
  transition:all .15s cubic-bezier(.2,0,.38,.9);
}
.ep-step-chip:hover{color:var(--ep-fg-2);border-color:var(--ep-fg-3)}
.ep-step-chip-on{background:var(--ep-accent-soft);color:var(--ep-accent);border-color:transparent;font-weight:600}
.ep-budget-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px 24px}
.ep-budget-box{display:flex;flex-direction:column;gap:6px;min-width:0}
.ep-budget-title{font-size:11px;color:var(--ep-fg-3);font-weight:500}
.ep-save-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
  padding-top:16px;border-top:1px solid var(--ep-line)}
.ep-save-hint{font-size:11px;color:var(--ep-fg-3)}

/* ── 专家启停名单（一行一专家 + 圆点）────────────────── */
.ep-roster-grid{display:flex;flex-direction:column;gap:2px}
.ep-roster-item{
  display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:6px;cursor:pointer;
  transition:background .15s cubic-bezier(.2,0,.38,.9);
}
.ep-roster-item:hover{background:var(--ep-surface)}
.ep-roster-item-top{flex:none;min-width:0}
.ep-roster-check{
  display:inline-block;white-space:nowrap;flex:none;
  width:auto;height:auto;font-size:11px;line-height:1.6;
  color:var(--ep-ok);font-family:var(--ep-mono);
}
.ep-roster-item:not(.ep-roster-item-on) .ep-roster-check{color:var(--ep-fg-3)}
.ep-roster-name{
  flex:1;min-width:0;font-size:12.5px;color:var(--ep-fg);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.ep-roster-item .ep-route-tag{flex:none;white-space:nowrap;max-width:46%}
.ep-custom-add{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}
.ep-custom-add>.ep-input,.ep-custom-add>.ep-select{flex:1 1 160px;min-width:0}
.ep-custom-add>.ep-action-btn{flex:none}

/* ── 多轮评审流程可视化 ──────────────────────────────── */
.ep-pipe-flow{display:flex;align-items:stretch;gap:12px;flex-wrap:wrap}
.ep-pipe-node{flex:1;min-width:196px;display:flex;align-items:flex-start;gap:8px;min-width:0}
.ep-pipe-node-off{opacity:.4}
.ep-pipe-index{
  flex:none;width:20px;height:20px;border-radius:999px;display:grid;place-items:center;
  font-size:11px;font-weight:650;background:var(--ep-accent-soft);color:var(--ep-accent);
}
.ep-pipe-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.ep-pipe-title{font-size:12.5px;font-weight:620;color:var(--ep-fg)}
.ep-pipe-badge{font-size:11px;color:var(--ep-fg-3);font-family:var(--ep-mono)}
.ep-pipe-desc{font-size:11px;color:var(--ep-fg-3);line-height:1.55}
.ep-pipe-off-tag{font-size:11px;color:var(--ep-warn);margin-top:2px}
.ep-pipe-arrow{align-self:center;color:var(--ep-fg-3);font-size:12.5px;padding:0 2px}

/* ── 杂项 ────────────────────────────────────────────── */
.ep-takeover-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--ep-fg-3)}
.ep-takeover-label{color:var(--ep-fg-3)}
.ep-mode-grid,.ep-mode-card,.ep-mode-card-active,.ep-mode-card-top,.ep-mode-card-title,.ep-mode-card-desc,.ep-mode-check,.ep-mode-uncheck{display:none}

/* ── 浅色主题微调 ────────────────────────────────────── */
body[data-ds-light-theme] .ep-panel{
  --ep-line:color-mix(in srgb,#000 10%,transparent);
}
body[data-ds-light-theme] .ep-stat-value,

/* ── 窄屏 ────────────────────────────────────────────── */
@media (max-width:720px){
  .ep-panel{padding:16px 12px 32px;gap:16px}
  .ep-stats{gap:20px}
  .ep-pipe-flow{flex-direction:column}
  .ep-pipe-arrow{display:none}
}
`;

    return { inject: ['slots', 'sessions', 'uiWorkspace'], apply };
  },
});
