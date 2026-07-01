// ==UserScript==
// @name         美团活动推广采集助手
// @namespace    https://ganfanba.local/userscripts
// @version      1.1.4
// @description  在美团联盟「物料推广 > 活动推广」页面批量采集活动文案素材并导出 CSV / JSON。V1.1.4 修复文案素材选中态误判：严格校验目标 radio/内容变化，避免未选中却提示已选中。
// @author       Codex
// @match        *://*.meituan.com/*
// @match        *://meituan.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    mediaName: '干饭吧智能决策管家-1000519381',
    promotionPositionName: '美团红包01',
    mediaOptionPreferLast: true,
    dropdownScrollAttempts: 3,
    materialTypes: ['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令'],
    optionalMaterialTypes: [],
    delay: {
      click: 800,
      modalOpen: 1500,
      dropdown: 800,
      materialSwitch: 1000,
      nextRow: 1200,
      retry: 800
    },
    modalOpenRetry: 2,
    textareaRetry: 3,
    exportFilePrefix: 'meituan_activity_materials',
    storageKey: 'meituan_activity_material_collector_cache',
    stateKey: 'meituan_activity_material_collector_state',
    panelPositionKey: 'meituan_activity_material_collector_panel_position',
    panelMinimizedKey: 'meituan_activity_material_collector_panel_minimized'
  };

  const CSV_FIELDS = [
    'material_id',
    'activity_name',
    'activity_intro',
    'commission_info',
    'activity_time',
    'start_date',
    'end_date',
    'banner_url',
    'media_name',
    'promotion_position_name',
    'material_type',
    'material_text',
    'material_link',
    'pure_link_text',
    'status',
    'error_message',
    'page_index',
    'row_index',
    'collected_at'
  ];

  const State = {
    status: '未开始',
    rows: [],
    records: [],
    logs: [],
    currentIndex: 0,
    totalRows: 0,
    currentActivityName: '-',
    stopped: false,
    paused: false,
    running: false,

    init() {
      this.records = Storage.loadRecords();
      const saved = Storage.loadState();
      this.currentIndex = saved.currentIndex || 0;
    },

    setStatus(status) {
      this.status = status;
      UI.update();
    },

    setCurrent(index, total, activityName) {
      this.currentIndex = index;
      this.totalRows = total;
      this.currentActivityName = activityName || '-';
      Storage.saveState({ currentIndex: index });
      UI.update();
    },

    counts() {
      return this.records.reduce(
        (acc, record) => {
          if (record.status === 'success') acc.success += 1;
          if (record.status === 'failed') acc.failed += 1;
          if (record.status === 'skipped') acc.skipped += 1;
          return acc;
        },
        { success: 0, failed: 0, skipped: 0 }
      );
    }
  };

  const Storage = {
    loadRecords() {
      try {
        const raw = localStorage.getItem(CONFIG.storageKey);
        const value = raw ? JSON.parse(raw) : [];
        return Array.isArray(value) ? value : [];
      } catch (error) {
        console.warn('[美团采集助手] 缓存读取失败', error);
        return [];
      }
    },

    saveRecords(records) {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(records || []));
    },

    loadState() {
      try {
        return JSON.parse(localStorage.getItem(CONFIG.stateKey) || '{}') || {};
      } catch (error) {
        return {};
      }
    },

    saveState(nextState) {
      const current = this.loadState();
      localStorage.setItem(CONFIG.stateKey, JSON.stringify({ ...current, ...nextState }));
    },

    makeKey(record) {
      return [
        record.material_id || '',
        record.media_name || '',
        record.promotion_position_name || '',
        record.material_type || ''
      ].join('::');
    },

    hasSuccess(base, materialType) {
      const key = this.makeKey({
        material_id: base.material_id,
        media_name: CONFIG.mediaName,
        promotion_position_name: CONFIG.promotionPositionName,
        material_type: materialType
      });
      return State.records.some((record) => this.makeKey(record) === key && record.status === 'success');
    },

    upsertRecord(record) {
      const key = this.makeKey(record);
      const index = State.records.findIndex((item) => this.makeKey(item) === key);
      if (index >= 0) {
        State.records.splice(index, 1, record);
      } else {
        State.records.push(record);
      }
      this.saveRecords(State.records);
      UI.update();
    },

    clear() {
      localStorage.removeItem(CONFIG.storageKey);
      localStorage.removeItem(CONFIG.stateKey);
      State.records = [];
      State.currentIndex = 0;
      Logger.info('已清空缓存数据');
      UI.update();
    }
  };

  const Logger = {
    push(level, message) {
      const item = {
        time: new Date().toLocaleTimeString(),
        level,
        message: String(message || '')
      };
      State.logs.unshift(item);
      State.logs = State.logs.slice(0, 20);
      const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[consoleMethod](`[美团采集助手] ${item.message}`);
      UI.update();
    },

    info(message) {
      this.push('info', message);
    },

    warn(message) {
      this.push('warn', message);
    },

    error(message) {
      this.push('error', message);
    }
  };

  const UI = {
    root: null,
    fields: {},
    minimized: false,
    dragState: null,

    createControlPanel() {
      if (document.getElementById('mtamc-panel')) return;
      const style = document.createElement('style');
      style.id = 'mtamc-style';
      style.textContent = `
        #mtamc-panel {
          position: fixed;
          right: 18px;
          bottom: 18px;
          z-index: 2147483647;
          width: 392px;
          box-sizing: border-box;
          background: #ffffff;
          color: #1f2329;
          border: 1px solid rgba(31, 35, 41, 0.08);
          box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18);
          border-radius: 16px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          font-size: 13px;
          line-height: 1.5;
          overflow: hidden;
          user-select: none;
        }
        #mtamc-panel * { box-sizing: border-box; }
        .mtamc-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 14px;
          background: linear-gradient(135deg, #ffd100 0%, #ffbf00 100%);
          color: #1f2329;
          cursor: move;
        }
        .mtamc-head-title {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 15px;
          font-weight: 800;
          letter-spacing: .2px;
        }
        .mtamc-head-title::before {
          content: '';
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #1f2329;
          box-shadow: 0 0 0 4px rgba(31,35,41,.12);
        }
        .mtamc-version {
          display: inline-flex;
          align-items: center;
          height: 20px;
          padding: 0 7px;
          border-radius: 999px;
          background: rgba(31, 35, 41, .12);
          color: #1f2329;
          font-size: 11px;
          font-weight: 800;
          flex: 0 0 auto;
        }
        .mtamc-head-tools {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 0 0 auto;
        }
        .mtamc-count-pill {
          display: inline-flex;
          align-items: center;
          height: 24px;
          padding: 0 9px;
          border-radius: 999px;
          background: rgba(255,255,255,.72);
          color: #1f2329;
          font-size: 12px;
          font-weight: 800;
        }
        .mtamc-mini-btn {
          width: 26px;
          height: 26px;
          padding: 0;
          border: 0;
          border-radius: 9px;
          background: rgba(31, 35, 41, 0.12);
          color: #1f2329;
          cursor: pointer;
          font-size: 16px;
          line-height: 24px;
          font-weight: 800;
        }
        .mtamc-mini-btn:hover { background: rgba(31, 35, 41, 0.18); }
        .mtamc-body { padding: 14px; background: #ffffff; }
        #mtamc-panel.mtamc-minimized { width: 330px; }
        #mtamc-panel.mtamc-minimized .mtamc-body { display: none; }
        .mtamc-status-line {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 10px;
        }
        .mtamc-status-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          max-width: 150px;
          height: 28px;
          padding: 0 10px;
          border-radius: 999px;
          background: #f3f4f6;
          color: #374151;
          font-weight: 800;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mtamc-status-badge::before {
          content: '';
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #9ca3af;
          flex: 0 0 auto;
        }
        .mtamc-status-badge[data-status="运行中"] { background: #ecfdf3; color: #027a48; }
        .mtamc-status-badge[data-status="运行中"]::before { background: #12b76a; }
        .mtamc-status-badge[data-status="已暂停"] { background: #fff7ed; color: #b54708; }
        .mtamc-status-badge[data-status="已暂停"]::before { background: #f79009; }
        .mtamc-status-badge[data-status="已停止"] { background: #fef3f2; color: #b42318; }
        .mtamc-status-badge[data-status="已停止"]::before { background: #f04438; }
        .mtamc-status-badge[data-status="已完成"] { background: #eef4ff; color: #3538cd; }
        .mtamc-status-badge[data-status="已完成"]::before { background: #6172f3; }
        .mtamc-current {
          flex: 1;
          min-width: 0;
          text-align: right;
          color: #1f2329;
          font-weight: 800;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .mtamc-progress-wrap { margin: 8px 0 12px; }
        .mtamc-progress-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 6px;
          color: #667085;
          font-size: 12px;
        }
        .mtamc-progress-track {
          width: 100%;
          height: 8px;
          border-radius: 999px;
          background: #eef1f5;
          overflow: hidden;
        }
        .mtamc-progress-bar {
          width: 0%;
          height: 100%;
          border-radius: 999px;
          background: linear-gradient(90deg, #1f2329 0%, #ffd100 100%);
          transition: width .22s ease;
        }
        .mtamc-stats {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          margin-bottom: 12px;
        }
        .mtamc-stat-card {
          padding: 9px 10px;
          border: 1px solid #edf0f5;
          border-radius: 12px;
          background: #fafbfc;
        }
        .mtamc-stat-label {
          color: #7a8495;
          font-size: 11px;
          white-space: nowrap;
        }
        .mtamc-stat-value {
          margin-top: 2px;
          color: #1f2329;
          font-size: 17px;
          font-weight: 900;
          line-height: 1.2;
        }
        .mtamc-actions {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          margin: 10px 0 12px;
        }
        .mtamc-actions button {
          height: 36px;
          border: 1px solid #d0d5dd;
          background: #ffffff;
          color: #1f2329;
          border-radius: 10px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
          transition: background .16s ease, border-color .16s ease, transform .08s ease, opacity .16s ease;
        }
        .mtamc-actions button:hover { background: #f6f7f9; border-color: #b8c0cc; }
        .mtamc-actions button:active { transform: translateY(1px); }
        .mtamc-actions button:disabled { opacity: .45; cursor: not-allowed; transform: none; }
        .mtamc-actions button[data-primary="true"] {
          background: #1f2329;
          color: #ffffff;
          border-color: #1f2329;
        }
        .mtamc-actions button[data-primary="true"]:hover { background: #111827; }
        .mtamc-actions button[data-warning="true"] {
          background: #fff7d6;
          border-color: #ffd100;
          color: #7a4b00;
        }
        .mtamc-actions button[data-danger="true"] {
          background: #fffafa;
          border-color: #fda29b;
          color: #b42318;
        }
        .mtamc-actions .mtamc-wide { grid-column: span 2; }
        .mtamc-log {
          height: 170px;
          overflow: auto;
          padding: 9px 10px;
          background: #f8fafc;
          border: 1px solid #edf0f5;
          border-radius: 12px;
          color: #414957;
          font-size: 12px;
          user-select: text;
        }
        .mtamc-log-item {
          padding: 0 0 6px;
          margin-bottom: 6px;
          border-bottom: 1px dashed rgba(102,112,133,.16);
          word-break: break-word;
        }
        .mtamc-log-item:last-child { border-bottom: 0; margin-bottom: 0; }
        .mtamc-log-item[data-level="error"] { color: #b42318; }
        .mtamc-log-item[data-level="warn"] { color: #b54708; }
        .mtamc-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding-top: 9px;
          color: #8a94a6;
          font-size: 12px;
        }
        .mtamc-foot span:last-child { white-space: nowrap; }
      `;
      document.head.appendChild(style);

      const root = document.createElement('div');
      root.id = 'mtamc-panel';
      root.innerHTML = `
        <div class="mtamc-head">
          <span class="mtamc-head-title">美团活动推广采集助手 <span class="mtamc-version">V1.1.4</span></span>
          <span class="mtamc-head-tools">
            <span class="mtamc-count-pill" id="mtamc-record-count">0 条</span>
            <button class="mtamc-mini-btn" id="mtamc-minimize" type="button" title="最小化/展开">−</button>
          </span>
        </div>
        <div class="mtamc-body">
          <div class="mtamc-status-line">
            <span class="mtamc-status-badge" id="mtamc-status">未开始</span>
            <span class="mtamc-current" id="mtamc-current" title="当前活动">-</span>
          </div>
          <div class="mtamc-progress-wrap">
            <div class="mtamc-progress-meta">
              <span>采集进度</span>
              <strong id="mtamc-progress">0 / 0</strong>
            </div>
            <div class="mtamc-progress-track"><div class="mtamc-progress-bar" id="mtamc-progress-bar"></div></div>
          </div>
          <div class="mtamc-stats">
            <div class="mtamc-stat-card"><div class="mtamc-stat-label">成功</div><div class="mtamc-stat-value" id="mtamc-success">0</div></div>
            <div class="mtamc-stat-card"><div class="mtamc-stat-label">失败</div><div class="mtamc-stat-value" id="mtamc-failed">0</div></div>
            <div class="mtamc-stat-card"><div class="mtamc-stat-label">跳过</div><div class="mtamc-stat-value" id="mtamc-skipped">0</div></div>
          </div>
          <div class="mtamc-actions">
            <button id="mtamc-start" data-primary="true">▶ 开始</button>
            <button id="mtamc-toggle-pause" data-warning="true">⏸ 暂停</button>
            <button id="mtamc-stop" data-danger="true">■ 停止</button>
            <button id="mtamc-export-csv">导出 CSV</button>
            <button id="mtamc-export-json">导出 JSON</button>
            <button id="mtamc-clear">清空缓存</button>
          </div>
          <div class="mtamc-log" id="mtamc-log"></div>
          <div class="mtamc-foot"><span>当前页采集</span><span>自动翻页已预留，默认不启用</span></div>
        </div>
      `;
      document.body.appendChild(root);
      this.root = root;
      this.fields = {
        status: root.querySelector('#mtamc-status'),
        progress: root.querySelector('#mtamc-progress'),
        progressBar: root.querySelector('#mtamc-progress-bar'),
        success: root.querySelector('#mtamc-success'),
        failed: root.querySelector('#mtamc-failed'),
        skipped: root.querySelector('#mtamc-skipped'),
        current: root.querySelector('#mtamc-current'),
        recordCount: root.querySelector('#mtamc-record-count'),
        log: root.querySelector('#mtamc-log'),
        startButton: root.querySelector('#mtamc-start'),
        togglePauseButton: root.querySelector('#mtamc-toggle-pause'),
        stopButton: root.querySelector('#mtamc-stop')
      };
      root.querySelector('#mtamc-start').addEventListener('click', () => Collector.start());
      root.querySelector('#mtamc-toggle-pause').addEventListener('click', () => {
        if (!State.running) return;
        if (State.paused) Collector.resume();
        else Collector.pause();
      });
      root.querySelector('#mtamc-stop').addEventListener('click', () => Collector.stop());
      root.querySelector('#mtamc-export-csv').addEventListener('click', () => Exporter.exportCSV());
      root.querySelector('#mtamc-export-json').addEventListener('click', () => Exporter.exportJSON());
      root.querySelector('#mtamc-clear').addEventListener('click', () => {
        if (window.confirm('确认清空本地缓存的采集数据？')) Storage.clear();
      });
      root.querySelector('#mtamc-minimize').addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggleMinimized();
      });
      this.restorePanelPlacement();
      this.bindDrag();
      this.update();
    },

    update() {
      if (!this.root) return;
      const counts = State.counts();
      const current = Math.min(State.currentIndex, State.totalRows);
      const total = State.totalRows || 0;
      const percent = total ? Math.min(100, Math.round((current / total) * 100)) : 0;

      this.fields.status.textContent = State.status;
      this.fields.status.dataset.status = State.status;
      this.fields.progress.textContent = `${current} / ${total}`;
      this.fields.progressBar.style.width = `${percent}%`;
      this.fields.success.textContent = counts.success;
      this.fields.failed.textContent = counts.failed;
      this.fields.skipped.textContent = counts.skipped;
      this.fields.current.textContent = State.currentActivityName || '-';
      this.fields.current.title = State.currentActivityName || '-';
      this.fields.recordCount.textContent = `${State.records.length} 条`;

      if (this.fields.startButton) this.fields.startButton.disabled = State.running;
      if (this.fields.stopButton) this.fields.stopButton.disabled = !State.running;
      if (this.fields.togglePauseButton) {
        this.fields.togglePauseButton.disabled = !State.running;
        this.fields.togglePauseButton.textContent = State.paused ? '▶ 继续' : '⏸ 暂停';
      }

      this.fields.log.innerHTML = State.logs
        .map(
          (item) =>
            `<div class="mtamc-log-item" data-level="${escapeHTML(item.level)}">[${escapeHTML(item.time)}] ${escapeHTML(
              item.message
            )}</div>`
        )
        .join('');
    },

    restorePanelPlacement() {
      const position = this.loadPanelPosition();
      if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
        this.root.style.left = `${position.left}px`;
        this.root.style.top = `${position.top}px`;
        this.root.style.right = 'auto';
        this.root.style.bottom = 'auto';
      }
      this.minimized = localStorage.getItem(CONFIG.panelMinimizedKey) === '1';
      this.applyMinimized();
      window.addEventListener('resize', () => this.constrainPanelToViewport());
    },

    bindDrag() {
      const header = this.root.querySelector('.mtamc-head');
      header.addEventListener('mousedown', (event) => {
        if (event.button !== 0 || event.target.closest('button')) return;
        const rect = this.root.getBoundingClientRect();
        this.dragState = {
          startX: event.clientX,
          startY: event.clientY,
          left: rect.left,
          top: rect.top
        };
        document.addEventListener('mousemove', this.handleDragMove);
        document.addEventListener('mouseup', this.handleDragEnd);
        event.preventDefault();
      });
    },

    handleDragMove: (event) => {
      if (!UI.dragState) return;
      const nextLeft = UI.dragState.left + event.clientX - UI.dragState.startX;
      const nextTop = UI.dragState.top + event.clientY - UI.dragState.startY;
      UI.setPanelPosition(nextLeft, nextTop);
    },

    handleDragEnd: () => {
      if (!UI.dragState) return;
      UI.dragState = null;
      UI.savePanelPosition();
      document.removeEventListener('mousemove', UI.handleDragMove);
      document.removeEventListener('mouseup', UI.handleDragEnd);
    },

    setPanelPosition(left, top) {
      const rect = this.root.getBoundingClientRect();
      const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
      const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
      const safeLeft = Math.min(Math.max(8, left), maxLeft);
      const safeTop = Math.min(Math.max(8, top), maxTop);
      this.root.style.left = `${safeLeft}px`;
      this.root.style.top = `${safeTop}px`;
      this.root.style.right = 'auto';
      this.root.style.bottom = 'auto';
    },

    savePanelPosition() {
      const rect = this.root.getBoundingClientRect();
      localStorage.setItem(CONFIG.panelPositionKey, JSON.stringify({ left: rect.left, top: rect.top }));
    },

    loadPanelPosition() {
      try {
        return JSON.parse(localStorage.getItem(CONFIG.panelPositionKey) || 'null');
      } catch (error) {
        return null;
      }
    },

    constrainPanelToViewport() {
      const rect = this.root.getBoundingClientRect();
      this.setPanelPosition(rect.left, rect.top);
      this.savePanelPosition();
    },

    toggleMinimized() {
      this.minimized = !this.minimized;
      localStorage.setItem(CONFIG.panelMinimizedKey, this.minimized ? '1' : '0');
      this.applyMinimized();
      this.constrainPanelToViewport();
    },

    applyMinimized() {
      if (!this.root) return;
      this.root.classList.toggle('mtamc-minimized', this.minimized);
      const button = this.root.querySelector('#mtamc-minimize');
      if (button) button.textContent = this.minimized ? '+' : '−';
    }
  };

  const DOM = {
    sleep(ms) {
      return new Promise((resolve) => window.setTimeout(resolve, ms));
    },

    async delay(name) {
      await this.sleep(CONFIG.delay[name] || 500);
    },

    normalizeText(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    },

    visibleText(element) {
      return this.normalizeText(element ? element.innerText || element.textContent || '' : '');
    },

    isVisible(element) {
      if (!element || element.nodeType !== 1) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },

    all(selector, root = document) {
      return Array.from(root.querySelectorAll(selector));
    },

    async waitFor(conditionFn, timeout = 10000, interval = 200) {
      const start = Date.now();
      let lastError = null;
      while (Date.now() - start < timeout) {
        try {
          const value = await conditionFn();
          if (value) return value;
        } catch (error) {
          lastError = error;
        }
        await this.sleep(interval);
      }
      if (lastError) throw lastError;
      return null;
    },

    findByText(text, selectors = ['button', 'a', 'label', 'span', 'div'], root = document, exact = true) {
      const target = this.normalizeText(text);
      const candidates = selectors.flatMap((selector) => this.all(selector, root));
      return candidates.find((element) => {
        if (!this.isVisible(element)) return false;
        const content = this.visibleText(element);
        return exact ? content === target : content.includes(target);
      });
    },

    findSmallestByText(text, root = document, exact = true) {
      const target = this.normalizeText(text);
      const candidates = this.all('button,a,label,span,div,p,td,li,[role="button"],[role="option"]', root).filter(
        (element) => {
          if (!this.isVisible(element)) return false;
          const content = this.visibleText(element);
          return exact ? content === target : content.includes(target);
        }
      );
      candidates.sort((a, b) => {
        const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
        const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
        return areaA - areaB;
      });
      return candidates[0] || null;
    },

    async clickElement(element, reason) {
      if (!element) throw new Error(`无法点击：${reason || '目标元素不存在'}`);
      element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      await this.delay('click');
      const rect = element.getBoundingClientRect();
      const clientX = rect.left + Math.min(Math.max(rect.width / 2, 10), Math.max(rect.width - 10, 10));
      const clientY = rect.top + rect.height / 2;
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY
      };
      const pointTarget = document.elementFromPoint(clientX, clientY);
      const dispatchTargets = uniqueElements([
        pointTarget,
        element,
        element.querySelector && element.querySelector('input,span,div,[role="combobox"],[role="button"]'),
        element.closest && element.closest('[role="combobox"],[role="button"],button,a,label')
      ]).filter(Boolean);
      dispatchTargets.forEach((target) => {
        if (typeof target.focus === 'function') {
          try {
            target.focus({ preventScroll: true });
          } catch (error) {
            target.focus();
          }
        }
        if (window.PointerEvent) {
          target.dispatchEvent(new PointerEvent('pointerover', eventOptions));
          target.dispatchEvent(new PointerEvent('pointerenter', eventOptions));
          target.dispatchEvent(new PointerEvent('pointermove', eventOptions));
          target.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
          target.dispatchEvent(new PointerEvent('pointerup', eventOptions));
        }
        target.dispatchEvent(new MouseEvent('mouseover', eventOptions));
        target.dispatchEvent(new MouseEvent('mouseenter', eventOptions));
        target.dispatchEvent(new MouseEvent('mousemove', eventOptions));
        target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        target.dispatchEvent(new MouseEvent('click', eventOptions));
      });
      if (typeof element.click === 'function') {
        try {
          element.click();
        } catch (error) {
          // ignore native click errors from non-clickable nodes
        }
      }
    },

    findClickableAncestor(element, root = document.body) {
      let current = element;
      while (current && current !== root.parentElement) {
        if (
          current.matches &&
          current.matches('button,a,label,li,[role="button"],[role="option"],[role="radio"],[role="combobox"]')
        ) {
          return current;
        }
        current = current.parentElement;
      }
      return element;
    },

    closestRowFromButton(button) {
      let current = button;
      while (current && current !== document.body) {
        const tag = current.tagName ? current.tagName.toLowerCase() : '';
        if (tag === 'tr') return current;
        const text = this.visibleText(current);
        const rect = current.getBoundingClientRect();
        if (
          text.includes('立即推广') &&
          /\d{2,}/.test(text) &&
          rect.width > 400 &&
          rect.height > 50 &&
          rect.height < Math.max(window.innerHeight * 0.75, 420)
        ) {
          return current;
        }
        current = current.parentElement;
      }
      return button.closest('tr') || button.parentElement;
    },

    getPromoteButton(row) {
      const selectors = ['button', 'a', '[role="button"]'];
      return selectors
        .flatMap((selector) => this.all(selector, row))
        .find((element) => this.isVisible(element) && this.visibleText(element) === '立即推广');
    }
  };

  const TableParser = {
    parseActivityRows() {
      const tableRows = DOM.all('tbody tr, table tr').filter((row) => DOM.getPromoteButton(row));
      if (tableRows.length) return uniqueElements(tableRows);

      const promoteButtons = DOM.all('button,a,[role="button"]')
        .filter((button) => DOM.isVisible(button))
        .filter((button) => DOM.visibleText(button) === '立即推广')
        .filter((button) => !button.closest('#mtamc-panel'))
        .filter((button) => !PromotionModal.isInsideCurrentModal(button));

      const rows = promoteButtons.map((button) => DOM.closestRowFromButton(button)).filter(Boolean);
      return uniqueElements(rows);
    },

    parseActivityRow(row, index) {
      const cells = DOM.all('td', row).filter((cell) => DOM.isVisible(cell));
      const pageIndex = this.getPageIndex();
      if (cells.length >= 5) {
        const activityCell = cells[1];
        const activityLines = splitLines(activityCell.innerText || activityCell.textContent || '');
        const banner = activityCell.querySelector('img');
        const activityTime = DOM.visibleText(cells[4]);
        const dates = parseDateRange(activityTime);
        return {
          material_id: DOM.visibleText(cells[0]),
          activity_name: activityLines[activityLines.length - 1] || '',
          activity_intro: DOM.visibleText(cells[2]),
          commission_info: DOM.visibleText(cells[3]),
          activity_time: activityTime,
          start_date: dates.start,
          end_date: dates.end,
          banner_url: banner ? banner.currentSrc || banner.src || banner.getAttribute('data-src') || '' : '',
          row_index: index + 1,
          page_index: pageIndex,
          collected_at: new Date().toISOString()
        };
      }

      const text = DOM.visibleText(row);
      const lines = splitLines(row.innerText || row.textContent || '');
      const banner = row.querySelector('img');
      const activityTime = (text.match(/\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\s*[-~至]\s*\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}/) || [''])[0];
      const dates = parseDateRange(activityTime);
      const materialId = (text.match(/(?:物料ID[:：]?\s*)?(\d{2,})/) || [])[1] || '';
      const activityName =
        lines.find((line) => !/立即推广|下载素材|^\d+$|\d{4}[.\-/]/.test(line) && line.length >= 3) || '';

      return {
        material_id: materialId,
        activity_name: activityName,
        activity_intro: '',
        commission_info: '',
        activity_time: activityTime,
        start_date: dates.start,
        end_date: dates.end,
        banner_url: banner ? banner.currentSrc || banner.src || banner.getAttribute('data-src') || '' : '',
        row_index: index + 1,
        page_index: pageIndex,
        collected_at: new Date().toISOString()
      };
    },

    getPageIndex() {
      const active = DOM.all('[aria-current="page"], .active, .current, li, button, a')
        .filter((element) => DOM.isVisible(element))
        .find((element) => /^\d+$/.test(DOM.visibleText(element)) && /active|current|selected/i.test(element.className || ''));
      return active ? Number(DOM.visibleText(active)) || 1 : 1;
    }
  };

  const PromotionModal = {
    currentModal: null,

    isInsideCurrentModal(element) {
      return Boolean(this.currentModal && this.currentModal.contains(element));
    },

    async clickPromote(row) {
      const button = DOM.getPromoteButton(row);
      if (!button) throw new Error('当前行找不到「立即推广」按钮');
      await DOM.clickElement(button, '立即推广');
      Logger.info('已点击「立即推广」');
    },

    async waitForPromotionModal() {
      const modal = await DOM.waitFor(() => this.findModal(), 10000, 250);
      if (!modal) throw new Error('右侧推广面板未打开');
      this.currentModal = modal;
      await DOM.delay('modalOpen');
      return modal;
    },

    findModal() {
      const heading = DOM.findSmallestByText('立即推广', document, true);
      if (heading) {
        let current = heading;
        while (current && current !== document.body) {
          const text = DOM.visibleText(current);
          const rect = current.getBoundingClientRect();
          if (
            text.includes('选择推广媒体') &&
            (text.includes('文案素材') || text.includes('选择推广位')) &&
            rect.width >= 280 &&
            rect.height >= 180
          ) {
            return current;
          }
          current = current.parentElement;
        }
      }

      const candidates = DOM.all('aside,section,div,[role="dialog"],[class*="drawer"],[class*="modal"]', document)
        .filter((element) => DOM.isVisible(element))
        .filter((element) => {
          const text = DOM.visibleText(element);
          const rect = element.getBoundingClientRect();
          return (
            text.includes('立即推广') &&
            text.includes('选择推广媒体') &&
            rect.width >= 280 &&
            rect.height >= 180 &&
            rect.right > window.innerWidth * 0.45
          );
        });
      candidates.sort((a, b) => {
        const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
        const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
        return areaA - areaB;
      });
      return candidates[0] || null;
    },

    async selectDropdownByLabel(labelText, optionText, options = {}) {
      const selectOptions = {
        preferLast: false,
        fuzzy: true,
        ...options
      };
      const ready = await DOM.waitFor(() => {
        const modal = this.currentModal || this.findModal();
        if (!modal) return null;
        const label = this.findFieldLabel(labelText, modal);
        if (!label) return null;

        const group = this.findFieldGroup(label, labelText, modal);
        if (group && this.isSelectedText(group, optionText)) {
          return { alreadySelected: true };
        }

        const selectedNearLabel = this.findSelectedValueNearLabel(label, optionText, modal);
        if (selectedNearLabel) {
          return { alreadySelected: true };
        }

        const triggers = this.findDropdownTriggers(group || modal, label, modal, optionText);
        if (triggers.length) {
          return { trigger: triggers[0], triggers };
        }
        return null;
      }, 12000, 250);

      if (!ready) {
        const modal = this.currentModal || this.findModal();
        const diag = this.getDropdownDiagnostics(labelText, optionText, modal);
        throw new Error(`找不到「${labelText}」的下拉框${diag ? `（${diag}）` : ''}`);
      }
      if (ready.alreadySelected) {
        Logger.info(`「${labelText}」已是 ${optionText}`);
        return true;
      }

      const triggers = uniqueElements(ready.triggers || [ready.trigger]).filter(Boolean);
      let option = null;
      let lastTriggerText = '';

      for (let i = 0; i < triggers.length && !option; i += 1) {
        const trigger = triggers[i];
        lastTriggerText = DOM.visibleText(trigger) || trigger.value || trigger.tagName;
        Logger.info(`尝试打开「${labelText}」下拉框 ${i + 1}/${triggers.length}：${lastTriggerText || '空文本元素'}`);
        await DOM.clickElement(trigger, `${labelText}下拉框`);
        await DOM.delay('dropdown');

        option = await DOM.waitFor(
          async () => {
            const found = this.findDropdownOption(optionText, selectOptions);
            if (found) return found;
            await this.scrollOpenDropdown();
            return this.findDropdownOption(optionText, selectOptions);
          },
          2600,
          200
        );

        if (!option && i < triggers.length - 1) {
          Logger.warn(`未找到「${optionText}」选项，切换下一个下拉框候选`);
          this.sendEscape();
          await DOM.sleep(180);
        }
      }

      if (!option) {
        const diag = this.getOpenDropdownDiagnostics(optionText);
        throw new Error(`找不到下拉选项：${optionText}${diag ? `（${diag}，最近点击：${lastTriggerText || '未知'}）` : ''}`);
      }
      await this.clickDropdownOptionAndVerify(labelText, optionText, option);
      return true;
    },

    async clickDropdownOptionAndVerify(labelText, optionText, option) {
      let lastText = '';
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await this.clickDropdownOptionElement(option, optionText);
        await DOM.delay('dropdown');
        const selected = await DOM.waitFor(() => {
          const modal = this.currentModal || this.findModal();
          const label = modal ? DOM.findSmallestByText(labelText, modal, false) : null;
          const group = label ? this.findFieldGroup(label, labelText) : null;
          lastText = group ? DOM.visibleText(group) : '';
          return group && this.isSelectionAccepted(labelText, group, optionText, modal);
        }, 2500, 200);
        if (selected) {
          Logger.info(`已选择「${labelText}」：${DOM.visibleText(option) || optionText}`);
          return true;
        }
        Logger.warn(`点击「${labelText}」选项后未生效，重试 ${attempt}/2：${DOM.visibleText(option) || optionText}`);
      }
      throw new Error(`选择「${labelText}」后未生效，当前字段内容：${lastText || '空'}`);
    },

    async clickDropdownOptionElement(option, optionText) {
      if (!option) throw new Error(`找不到下拉选项：${optionText}`);
      const rect = option.getBoundingClientRect();
      const clientX = rect.left + Math.min(Math.max(rect.width / 2, 12), Math.max(rect.width - 12, 12));
      const clientY = rect.top + rect.height / 2;
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY
      };
      const target = document.elementFromPoint(clientX, clientY) || option;
      const dispatchTargets = uniqueElements([target, option]);
      dispatchTargets.forEach((element) => {
        if (window.PointerEvent) {
          element.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
          element.dispatchEvent(new PointerEvent('pointerup', eventOptions));
        }
        element.dispatchEvent(new MouseEvent('mouseover', eventOptions));
        element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        element.dispatchEvent(new MouseEvent('click', eventOptions));
      });
      if (typeof option.click === 'function') option.click();
      await DOM.sleep(120);
    },

    isSelectionAccepted(labelText, group, optionText, modal) {
      if (this.isSelectedText(group, optionText)) return true;
      if (labelText.includes('推广媒体') && modal && DOM.findSmallestByText('选择推广位', modal, false)) return true;
      return false;
    },

    isSelectedText(group, optionText) {
      const text = DOM.visibleText(group);
      if (!text) return false;
      const compactText = compactOptionText(text);
      const compactTarget = compactOptionText(optionText);
      const compactBase = compactMediaDisplayText(optionText);
      return (
        compactText === compactTarget ||
        compactText.includes(compactTarget) ||
        compactTarget.includes(compactText) ||
        (compactBase.length >= 8 && compactText.includes(compactBase))
      );
    },

    findFieldLabel(labelText, modal) {
      const exact = DOM.findSmallestByText(labelText, modal, false);
      if (exact) return exact;
      const compactTarget = compactOptionText(labelText);
      return DOM.all('label,span,div,p,td', modal)
        .filter((element) => DOM.isVisible(element))
        .filter((element) => compactOptionText(DOM.visibleText(element)).includes(compactTarget))
        .sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          return rectA.width * rectA.height - rectB.width * rectB.height;
        })[0] || null;
    },

    findSelectedValueNearLabel(label, optionText, modal) {
      if (!label || !modal || !optionText) return null;
      const labelRect = label.getBoundingClientRect();
      const compactTarget = compactOptionText(optionText);
      return DOM.all('input,span,div,p', modal)
        .filter((element) => DOM.isVisible(element))
        .find((element) => {
          const value = element.tagName && element.tagName.toLowerCase() === 'input' ? element.value : DOM.visibleText(element);
          if (!value || !compactOptionText(value).includes(compactTarget)) return false;
          const rect = element.getBoundingClientRect();
          const verticalDistance = Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2));
          return rect.left > labelRect.right - 8 && verticalDistance <= 42;
        }) || null;
    },

    findFieldGroup(label, labelText, modal = this.currentModal) {
      if (!label) return null;
      const root = modal || this.currentModal || document.body;
      const fieldSelector = [
        'input',
        '[role="combobox"]',
        'select',
        '[class*="select"]',
        '[class*="Select"]',
        '[class*="dropdown"]',
        '[class*="Dropdown"]',
        '[class*="picker"]',
        '[class*="Picker"]'
      ].join(',');

      let current = label.parentElement;
      while (current && current !== root.parentElement) {
        const text = DOM.visibleText(current);
        const rect = current.getBoundingClientRect();
        const containsField = Boolean(current.querySelector(fieldSelector));
        if (
          text.includes(labelText) &&
          containsField &&
          rect.height <= 140 &&
          rect.width >= 180 &&
          !current.closest('#mtamc-panel')
        ) {
          return current;
        }
        if (current === root) break;
        current = current.parentElement;
      }

      return this.findFieldGroupByLayout(label, labelText, root) || label.parentElement || root;
    },

    findFieldGroupByLayout(label, labelText, modal) {
      if (!label || !modal) return null;
      const labelRect = label.getBoundingClientRect();
      const candidates = [];
      let current = label.parentElement;
      while (current && current !== modal.parentElement) {
        if (!DOM.isVisible(current)) break;
        const rect = current.getBoundingClientRect();
        const text = DOM.visibleText(current);
        const verticalDistance = Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2));
        if (
          text.includes(labelText) &&
          rect.width >= 220 &&
          rect.height >= 24 &&
          rect.height <= 120 &&
          verticalDistance <= 40
        ) {
          candidates.push({ element: current, area: rect.width * rect.height });
        }
        if (current === modal) break;
        current = current.parentElement;
      }
      candidates.sort((a, b) => a.area - b.area);
      return candidates[0] ? candidates[0].element : null;
    },

    findDropdownTriggers(group, label, modal, optionText = '') {
      const root = modal || this.currentModal || document.body;
      const labelRect = label ? label.getBoundingClientRect() : null;
      const primary = this.findDropdownTrigger(group, label, root, optionText);
      const candidates = [];
      if (primary) candidates.push(primary);

      if (!labelRect) return uniqueElements(candidates).filter((element) => !this.isDisabled(element));

      const selectors = [
        'input',
        'select',
        'button',
        '[role="button"]',
        '[role="combobox"]',
        '[aria-haspopup="listbox"]',
        '[aria-haspopup="menu"]',
        '[class*="select"]',
        '[class*="Select"]',
        '[class*="dropdown"]',
        '[class*="Dropdown"]',
        '[class*="picker"]',
        '[class*="Picker"]',
        'div',
        'span'
      ];

      const extra = uniqueElements(selectors.flatMap((selector) => DOM.all(selector, group || root)))
        .concat(uniqueElements(selectors.flatMap((selector) => DOM.all(selector, root))))
        .filter((element) => DOM.isVisible(element))
        .filter((element) => !element.closest('#mtamc-panel'))
        .filter((element) => !label.contains(element) && !this.isDisabled(element))
        .map((element) => this.normalizeDropdownClickable(element, label, root))
        .filter(Boolean)
        .filter((element) => DOM.isVisible(element) && !this.isDisabled(element))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = DOM.visibleText(element) || element.value || '';
          const compact = compactOptionText(text);
          const verticalDistance = Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2));
          const overlapY = rect.bottom >= labelRect.top - 18 && rect.top <= labelRect.bottom + 18;
          const horizontalDistance = Math.abs(rect.left - labelRect.right);
          const dropdownScore = this.isDropdownLike(element) ? -100 : 0;
          const rightScore = rect.left >= labelRect.right - 12 ? -30 : 40;
          const targetScore = optionText && compact.includes(compactOptionText(optionText)) ? -80 : 0;
          const placeholderScore = /选择|请选择|全部/.test(text) ? -40 : 0;
          return {
            element,
            rect,
            text,
            score: dropdownScore + rightScore + targetScore + placeholderScore + verticalDistance + horizontalDistance / 18
          };
        })
        .filter(({ rect, text }) => {
          const compact = compactOptionText(text);
          const verticalDistance = Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2));
          const overlapY = rect.bottom >= labelRect.top - 22 && rect.top <= labelRect.bottom + 22;
          return (
            rect.width >= 70 &&
            rect.width <= 760 &&
            rect.height >= 18 &&
            rect.height <= 92 &&
            rect.left > labelRect.left + 40 &&
            (overlapY || verticalDistance <= 56) &&
            !compact.includes(compactOptionText('新增媒体')) &&
            !compact.includes(compactOptionText('新增推广位')) &&
            !compact.includes(compactOptionText('文案素材')) &&
            !compact.includes(compactOptionText('复制文案')) &&
            !compact.includes(compactOptionText('复制链接'))
          );
        })
        .sort((a, b) => {
          if (a.score !== b.score) return a.score - b.score;
          if (a.rect.left !== b.rect.left) return a.rect.left - b.rect.left;
          return a.rect.width * a.rect.height - b.rect.width * b.rect.height;
        })
        .map((item) => item.element);

      candidates.push(...extra.slice(0, 8));
      return uniqueElements(candidates).filter((element) => DOM.isVisible(element) && !this.isDisabled(element));
    },

    findDropdownTrigger(group, label, modal, optionText = '') {
      const root = modal || this.currentModal || document.body;
      const layoutTrigger = this.findDropdownTriggerByLayout(label, root, optionText);
      if (layoutTrigger && !this.isDisabled(layoutTrigger)) return layoutTrigger;

      const selectors = [
        '[role="combobox"]',
        'select',
        'input[readonly]',
        'input[placeholder]',
        '[class*="select"]',
        '[class*="Select"]',
        '[class*="dropdown"]',
        '[class*="Dropdown"]',
        '[class*="picker"]',
        '[class*="Picker"]',
        '[class*="trigger"]',
        '[class*="Trigger"]'
      ];
      const scopedRoot = group || root;
      const scoped = uniqueElements(selectors.flatMap((selector) => DOM.all(selector, scopedRoot)))
        .filter((element) => DOM.isVisible(element))
        .filter((element) => element !== label && !label.contains(element) && !this.isDisabled(element));
      const usable = scoped.find((element) => this.isDropdownLike(element));
      if (!usable) return null;
      return this.normalizeDropdownClickable(usable, label, root) || usable;
    },

    findDropdownTriggerByLayout(label, modal, optionText = '') {
      if (!label || !modal) return null;
      const labelRect = label.getBoundingClientRect();
      const compactTarget = compactOptionText(optionText);
      const rawCandidates = DOM.all('input,select,button,[role="button"],[role="combobox"],div,span', modal)
        .filter((element) => DOM.isVisible(element))
        .filter((element) => !label.contains(element) && !this.isDisabled(element))
        .filter((element) => !element.closest('#mtamc-panel'));

      const candidates = uniqueElements(
        rawCandidates
          .map((element) => this.normalizeDropdownClickable(element, label, modal))
          .filter(Boolean)
      )
        .filter((element) => DOM.isVisible(element) && !this.isDisabled(element))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = DOM.visibleText(element) || (element.value || '');
          const style = window.getComputedStyle(element);
          const verticalDistance = Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2));
          const horizontalDistance = Math.abs(rect.left - labelRect.right);
          const textScore = compactTarget && compactOptionText(text).includes(compactTarget) ? -100 : 0;
          const classScore = this.isDropdownLike(element) ? -30 : 0;
          const borderScore = /solid|rgb|rgba/.test(style.borderLeftStyle + style.borderLeftColor) ? -8 : 0;
          return {
            element,
            rect,
            text,
            score: textScore + classScore + borderScore + verticalDistance + horizontalDistance / 20
          };
        })
        .filter(({ rect, text }) => {
          const verticalDistance = Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2));
          const overlapY = rect.bottom >= labelRect.top - 18 && rect.top <= labelRect.bottom + 18;
          const compactText = compactOptionText(text);
          return (
            rect.width >= 70 &&
            rect.width <= 760 &&
            rect.height >= 20 &&
            rect.height <= 86 &&
            rect.left > labelRect.right - 12 &&
            (overlapY || verticalDistance <= 46) &&
            !compactText.includes(compactOptionText('新增媒体')) &&
            !compactText.includes(compactOptionText('新增推广位')) &&
            !compactText.includes(compactOptionText('选择推广媒体')) &&
            !compactText.includes(compactOptionText('选择推广位'))
          );
        })
        .sort((a, b) => {
          if (a.score !== b.score) return a.score - b.score;
          if (a.rect.left !== b.rect.left) return a.rect.left - b.rect.left;
          return a.rect.width * a.rect.height - b.rect.width * b.rect.height;
        });

      return candidates[0] ? candidates[0].element : null;
    },

    normalizeDropdownClickable(element, label, modal) {
      if (!element || !label || !modal) return null;
      const labelRect = label.getBoundingClientRect();
      let current = element;
      const candidates = [];
      while (current && current !== modal.parentElement && candidates.length < 8) {
        if (DOM.isVisible(current) && !this.isDisabled(current)) {
          const rect = current.getBoundingClientRect();
          const verticalDistance = Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2));
          const text = DOM.visibleText(current) || current.value || '';
          if (
            rect.width >= 70 &&
            rect.width <= 760 &&
            rect.height >= 20 &&
            rect.height <= 86 &&
            rect.left > labelRect.right - 12 &&
            verticalDistance <= 56 &&
            !DOM.visibleText(current).includes('文案素材') &&
            !DOM.visibleText(current).includes('复制')
          ) {
            const area = rect.width * rect.height;
            const score = (this.isDropdownLike(current) ? -100000 : 0) + area;
            candidates.push({ element: current, score, text });
          }
        }
        if (current === modal) break;
        current = current.parentElement;
      }
      candidates.sort((a, b) => a.score - b.score);
      return candidates[0] ? candidates[0].element : element;
    },

    isDropdownLike(element) {
      if (!element) return false;
      const tag = element.tagName ? element.tagName.toLowerCase() : '';
      const role = element.getAttribute('role') || '';
      const className = String(element.className || '');
      const ariaHasPopup = element.getAttribute('aria-haspopup') || '';
      return (
        tag === 'select' ||
        tag === 'input' ||
        role === 'combobox' ||
        /listbox|menu/.test(ariaHasPopup) ||
        /(select|dropdown|picker|trigger|combobox|mtd-select|ant-select)/i.test(className)
      );
    },

    getDropdownDiagnostics(labelText, optionText, modal) {
      if (!modal) return '未识别到推广面板';
      const label = this.findFieldLabel(labelText, modal);
      if (!label) return `未找到字段文案：${labelText}`;
      const labelRect = label.getBoundingClientRect();
      const nearby = DOM.all('input,select,button,[role="button"],[role="combobox"],div,span', modal)
        .filter((element) => DOM.isVisible(element))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const verticalDistance = Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2));
          return rect.left > labelRect.right - 12 && verticalDistance <= 60 && rect.width >= 40 && rect.height >= 16;
        })
        .slice(0, 5)
        .map((element) => DOM.visibleText(element) || element.value || element.tagName)
        .filter(Boolean)
        .join(' / ');
      return nearby ? `字段右侧识别到：${nearby}` : `字段右侧没有可点击候选，目标选项：${optionText}`;
    },

    getOpenDropdownDiagnostics(optionText = '') {
      const compactTarget = compactOptionText(optionText);
      const visibleTexts = DOM.all('[role="option"],li,div,span,ul', document)
        .filter((element) => DOM.isVisible(element))
        .filter((element) => !element.closest('#mtamc-panel'))
        .map((element) => DOM.visibleText(element))
        .filter(Boolean)
        .filter((text) => {
          const compact = compactOptionText(text);
          return (
            compact.includes(compactTarget.slice(0, Math.min(10, compactTarget.length))) ||
            compact.includes('干饭吧') ||
            compact.includes('美团红包') ||
            compact.includes('1000') ||
            compact.includes('红包')
          );
        })
        .slice(0, 8);
      return visibleTexts.length ? `可见候选：${visibleTexts.join(' / ')}` : '未识别到任何可见下拉候选';
    },

    sendEscape() {
      const eventOptions = { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27, which: 27 };
      [document.activeElement, document.body, document, window].filter(Boolean).forEach((target) => {
        try {
          target.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
          target.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
        } catch (error) {
          // ignore
        }
      });
    },

    isDisabled(element) {
      if (!element) return true;
      const disabledNode = element.closest('[disabled],[aria-disabled="true"],.disabled,[class*="disabled"],[class*="Disabled"]');
      if (disabledNode) return true;
      return Boolean(element.disabled);
    },

    findDropdownOption(optionText, options = {}) {
      const target = DOM.normalizeText(optionText);
      const compactTarget = compactOptionText(target);
      const candidates = DOM.all('[role="option"],li,div,span')
        .filter((element) => DOM.isVisible(element))
        .filter((element) => !element.closest('#mtamc-panel'))
        .filter((element) => {
          const text = DOM.visibleText(element);
          if (!text) return false;
          if (text === target) return true;
          if (!options.fuzzy) return false;
          const compactText = compactOptionText(text);
          return compactText.includes(compactTarget) || compactTarget.includes(compactText);
        });
      const optionElements = candidates
        .map((element) => this.findOptionClickableElement(element, target, options))
        .filter(Boolean)
        .filter((element) => !this.isDisabled(element));
      const sorted = uniqueElements(optionElements).sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        if (rectA.top !== rectB.top) return rectA.top - rectB.top;
        if (rectA.left !== rectB.left) return rectA.left - rectB.left;
        return rectA.width * rectA.height - rectB.width * rectB.height;
      });
      if (sorted.length) return options.preferLast ? sorted[sorted.length - 1] : sorted[0];

      const fallback = DOM.all('body *')
        .filter((element) => DOM.isVisible(element))
        .filter((element) => !element.closest('#mtamc-panel'))
        .filter((element) => {
          const text = DOM.visibleText(element);
          if (!text) return false;
          const compactText = compactOptionText(text);
          return compactText === compactTarget || (options.fuzzy && compactText.includes(compactTarget));
        })
        .map((element) => this.findOptionClickableElement(element, target, { ...options, fuzzy: true }) || element)
        .filter((element) => element && DOM.isVisible(element) && !this.isDisabled(element))
        .sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          const textA = DOM.visibleText(a);
          const textB = DOM.visibleText(b);
          if (textA.length !== textB.length) return textA.length - textB.length;
          if (rectA.height !== rectB.height) return rectA.height - rectB.height;
          return rectA.width * rectA.height - rectB.width * rectB.height;
        });
      return options.preferLast ? fallback[fallback.length - 1] : fallback[0];
    },

    findOptionClickableElement(element, targetText, options = {}) {
      const compactTarget = compactOptionText(targetText);
      const ancestors = [];
      let current = element;
      while (current && current !== document.body && ancestors.length < 8) {
        if (DOM.isVisible(current)) {
          const text = DOM.visibleText(current);
          const compactText = compactOptionText(text);
          const rect = current.getBoundingClientRect();
          const looksLikeOption =
            current.matches('[role="option"],li,[role="menuitem"]') ||
            /(option|item|menu|dropdown|select)/i.test(current.className || '');
          const textMatches =
            compactText === compactTarget ||
            (options.fuzzy && (compactText.includes(compactTarget) || compactTarget.includes(compactText)));
          const notWholeMenu = text.length <= Math.max(targetText.length + 20, targetText.length * 1.8);
          if (textMatches && notWholeMenu && rect.width >= 80 && rect.height >= 20 && rect.height <= 90) {
            ancestors.push({ element: current, looksLikeOption, area: rect.width * rect.height });
          }
        }
        current = current.parentElement;
      }
      const roleOption = ancestors.find((item) => item.looksLikeOption);
      if (roleOption) return roleOption.element;
      ancestors.sort((a, b) => b.area - a.area);
      return ancestors[0] ? ancestors[0].element : DOM.findClickableAncestor(element);
    },

    async scrollOpenDropdown() {
      const dropdowns = DOM.all('[role="listbox"],[class*="dropdown"],[class*="Select"],[class*="menu"],ul,div')
        .filter((element) => DOM.isVisible(element))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.height >= 80 && rect.width >= 120 && /(auto|scroll)/.test(window.getComputedStyle(element).overflowY);
        });
      const dropdown = dropdowns.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
      if (!dropdown) return;
      dropdown.scrollTop = dropdown.scrollTop + dropdown.clientHeight;
      await DOM.sleep(150);
    },

    async selectMaterialType(typeName) {
      const modal = this.currentModal || (await this.waitForPromotionModal());
      const label = DOM.findSmallestByText(typeName, modal, true);
      if (!label) return false;
      const target = label.closest('label') || label.closest('[role="radio"]') || DOM.findClickableAncestor(label, modal);
      await DOM.clickElement(target || label, `素材类型 ${typeName}`);
      await DOM.delay('materialSwitch');
      Logger.info(`已切换素材类型：${typeName}`);
      return true;
    },

    async readMaterialText() {
      const modal = this.currentModal || (await this.waitForPromotionModal());
      for (let attempt = 1; attempt <= CONFIG.textareaRetry; attempt += 1) {
        const textareas = DOM.all('textarea', modal).filter((element) => DOM.isVisible(element));
        const values = textareas.map((textarea) => (textarea.value || textarea.textContent || '').trim());
        const nonEmpty = values.filter(Boolean);
        if (nonEmpty.length) {
          return {
            materialText: values[0] || '',
            pureLinkText: values[1] || '',
            copyButtonText: this.getCopyButtonText(modal)
          };
        }

        const contentEditable = DOM.all('[contenteditable="true"]', modal)
          .filter((element) => DOM.isVisible(element))
          .map((element) => DOM.visibleText(element))
          .filter(Boolean);
        if (contentEditable.length) {
          return {
            materialText: contentEditable[0] || '',
            pureLinkText: contentEditable[1] || '',
            copyButtonText: this.getCopyButtonText(modal)
          };
        }

        Logger.warn(`textarea 为空，等待重试 ${attempt}/${CONFIG.textareaRetry}`);
        await DOM.delay('retry');
      }

      return {
        materialText: '',
        pureLinkText: '',
        copyButtonText: this.getCopyButtonText(modal)
      };
    },

    getCopyButtonText(modal) {
      const button = DOM.all('button,a,[role="button"]', modal)
        .filter((element) => DOM.isVisible(element))
        .find((element) => /复制/.test(DOM.visibleText(element)));
      return button ? DOM.visibleText(button) : '';
    },

    async closePromotionModal() {
      const modal = this.currentModal || this.findModal();
      if (!modal) return;

      const tryWaitClosed = async (timeout = 1600) => Boolean(await DOM.waitFor(() => !this.findModal(), timeout, 160));
      const closeButton = this.findCloseButton(modal);

      if (closeButton) {
        await DOM.clickElement(closeButton, '关闭推广面板');
        if (await tryWaitClosed()) {
          this.currentModal = null;
          Logger.info('已关闭推广面板');
          return;
        }
      }

      this.sendEscape();
      if (await tryWaitClosed()) {
        this.currentModal = null;
        Logger.info('已通过 ESC 关闭推广面板');
        return;
      }

      const mask = this.findMaskElement();
      if (mask) {
        await DOM.clickElement(mask, '推广面板遮罩层');
        if (await tryWaitClosed()) {
          this.currentModal = null;
          Logger.info('已通过遮罩层关闭推广面板');
          return;
        }
      }

      this.currentModal = this.findModal();
      throw new Error('推广面板仍未关闭，请手动关闭后继续');
    },

    findCloseButton(modal) {
      const candidates = DOM.all('button,[role="button"],a,i,svg,span,div', modal)
        .filter((element) => DOM.isVisible(element))
        .filter((element) => {
          const text = DOM.visibleText(element);
          const aria = element.getAttribute('aria-label') || '';
          const title = element.getAttribute('title') || '';
          const className = String(element.className || '');
          const rect = element.getBoundingClientRect();
          const modalRect = modal.getBoundingClientRect();
          const isNearTopRight = rect.top <= modalRect.top + 80 && rect.left >= modalRect.right - 120;
          const looksClose =
            /^(×|x|X|关闭)$/.test(text) ||
            /close|关闭/i.test(aria) ||
            /close|关闭/i.test(title) ||
            /close|icon-close|mtdicon-close/i.test(className);
          return looksClose && rect.width <= 80 && rect.height <= 80 && (isNearTopRight || /close|关闭/i.test(aria + title + className));
        });
      candidates.sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        if (rectA.top !== rectB.top) return rectA.top - rectB.top;
        return rectB.left - rectA.left;
      });
      return candidates[0] || null;
    },

    findMaskElement() {
      return DOM.all('[class*="mask"],[class*="Mask"],[class*="overlay"],[class*="Overlay"],[class*="modal"],[class*="drawer"]', document)
        .filter((element) => DOM.isVisible(element))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const text = DOM.visibleText(element);
          return rect.left <= 2 && rect.top <= 2 && rect.width >= window.innerWidth * 0.4 && rect.height >= window.innerHeight * 0.4 && text.length < 30;
        })[0] || null;
    }
  };

  const Collector = {
    async start() {
      if (State.running) {
        Logger.warn('采集正在运行中');
        return;
      }
      State.running = true;
      State.stopped = false;
      State.paused = false;
      State.setStatus('运行中');

      try {
        State.rows = TableParser.parseActivityRows();
        State.totalRows = State.rows.length;
        if (!State.rows.length) {
          Logger.warn('当前页面没有识别到活动行，请确认在「物料推广 > 活动推广」页面');
          State.setStatus('已停止');
          return;
        }

        Logger.info(`识别到 ${State.rows.length} 行活动，开始采集当前页`);
        for (let index = 0; index < State.rows.length; index += 1) {
          if (State.stopped) break;
          await this.waitIfPaused();
          const row = State.rows[index];
          const base = TableParser.parseActivityRow(row, index);
          State.setCurrent(index + 1, State.rows.length, base.activity_name);
          await this.processRow(row, base);
          await DOM.delay('nextRow');
        }

        State.setStatus(State.stopped ? '已停止' : '已完成');
        Logger.info(State.stopped ? '采集已停止' : '当前页采集完成');
      } catch (error) {
        Logger.error(`采集流程异常：${error.message || error}`);
        State.setStatus('已停止');
      } finally {
        State.running = false;
      }
    },

    pause() {
      if (!State.running) return;
      State.paused = true;
      State.setStatus('已暂停');
      Logger.info('已暂停采集');
    },

    resume() {
      if (!State.running) return;
      State.paused = false;
      State.setStatus('运行中');
      Logger.info('继续采集');
    },

    stop() {
      State.stopped = true;
      State.paused = false;
      State.setStatus('已停止');
      Logger.warn('收到停止指令，当前步骤完成后停止');
    },

    async waitIfPaused() {
      while (State.paused && !State.stopped) {
        await DOM.sleep(300);
      }
    },

    async processRow(row, base) {
      Logger.info(`处理第 ${base.row_index} 行：${base.activity_name || base.material_id || '未知活动'}`);
      const needTypes = CONFIG.materialTypes.filter((type) => !Storage.hasSuccess(base, type));
      if (!needTypes.length) {
        Logger.info(`第 ${base.row_index} 行已存在成功缓存，跳过`);
        return;
      }

      try {
        await this.openModalWithRetry(row);
        await PromotionModal.selectDropdownByLabel('选择推广媒体', CONFIG.mediaName, {
          preferLast: CONFIG.mediaOptionPreferLast,
          fuzzy: true
        });
        await PromotionModal.selectDropdownByLabel('选择推广位', CONFIG.promotionPositionName);

        for (const typeName of CONFIG.materialTypes) {
          await this.waitIfPaused();
          if (State.stopped) break;
          if (Storage.hasSuccess(base, typeName)) {
            Logger.info(`已采集过 ${base.material_id} / ${typeName}，跳过`);
            continue;
          }
          await this.collectMaterialType(base, typeName);
        }
      } catch (error) {
        Logger.error(`第 ${base.row_index} 行失败：${error.message || error}`);
        this.saveFailureForTypes(base, needTypes, error.message || String(error));
      } finally {
        try {
          await PromotionModal.closePromotionModal();
        } catch (closeError) {
          Logger.warn(`关闭推广面板失败：${closeError.message || closeError}`);
        }
      }
    },

    async openModalWithRetry(row) {
      let lastError = null;
      for (let attempt = 1; attempt <= CONFIG.modalOpenRetry; attempt += 1) {
        try {
          await PromotionModal.clickPromote(row);
          await DOM.delay('modalOpen');
          return await PromotionModal.waitForPromotionModal();
        } catch (error) {
          lastError = error;
          Logger.warn(`打开推广面板失败，重试 ${attempt}/${CONFIG.modalOpenRetry}：${error.message || error}`);
          await DOM.delay('retry');
        }
      }
      throw lastError || new Error('推广面板未打开');
    },

    async collectMaterialType(base, typeName) {
      const now = new Date().toISOString();
      try {
        const exists = await PromotionModal.selectMaterialType(typeName);
        if (!exists) {
          Storage.upsertRecord(this.buildRecord(base, typeName, 'skipped', '', '', '', '', `素材类型不存在：${typeName}`, now));
          Logger.warn(`素材类型不存在，已跳过：${typeName}`);
          return;
        }

        const content = await PromotionModal.readMaterialText();
        const combinedText = [content.materialText, content.pureLinkText].filter(Boolean).join('\n');
        const links = extractLinks(combinedText);
        const status = content.materialText || content.pureLinkText ? 'success' : 'failed';
        const error = status === 'success' ? '' : 'textarea 为空';
        const record = this.buildRecord(
          base,
          typeName,
          status,
          content.materialText,
          links[0] || '',
          content.pureLinkText,
          content.copyButtonText,
          error,
          now
        );
        record.links = links;
        Storage.upsertRecord(record);
        Logger.info(`${typeName} 采集${status === 'success' ? '成功' : '失败'}：${base.activity_name || base.material_id}`);
      } catch (error) {
        Storage.upsertRecord(this.buildRecord(base, typeName, 'failed', '', '', '', '', error.message || String(error), now));
        Logger.error(`${typeName} 采集失败：${error.message || error}`);
      }
    },

    buildRecord(base, materialType, status, materialText, materialLink, pureLinkText, copyButtonText, errorMessage, collectedAt) {
      return {
        material_id: base.material_id || '',
        activity_name: base.activity_name || '',
        activity_intro: base.activity_intro || '',
        commission_info: base.commission_info || '',
        activity_time: base.activity_time || '',
        start_date: base.start_date || '',
        end_date: base.end_date || '',
        banner_url: base.banner_url || '',
        media_name: CONFIG.mediaName,
        promotion_position_name: CONFIG.promotionPositionName,
        material_type: materialType || '',
        material_text: materialText || '',
        material_link: materialLink || '',
        pure_link_text: pureLinkText || '',
        copy_button_text: copyButtonText || '',
        status,
        error_message: errorMessage || '',
        page_index: base.page_index || 1,
        row_index: base.row_index || '',
        collected_at: collectedAt || new Date().toISOString()
      };
    },

    saveFailureForTypes(base, materialTypes, errorMessage) {
      materialTypes.forEach((typeName) => {
        Storage.upsertRecord(
          this.buildRecord(base, typeName, 'failed', '', '', '', '', errorMessage || '行处理失败', new Date().toISOString())
        );
      });
    },

    async goNextPage() {
      Logger.warn('自动翻页接口已预留，当前稳定版默认不执行自动翻页');
      return false;
    }
  };

  const Exporter = {
    exportCSV() {
      if (!State.records.length) {
        Logger.warn('没有可导出的数据');
        return;
      }
      const rows = State.records.map((record) => CSV_FIELDS.map((field) => csvEscape(record[field])).join(','));
      const content = `\uFEFF${CSV_FIELDS.join(',')}\n${rows.join('\n')}`;
      this.download(content, `${CONFIG.exportFilePrefix}_${timestampForFile()}.csv`, 'text/csv;charset=utf-8');
      Logger.info(`已导出 CSV：${State.records.length} 条`);
    },

    exportJSON() {
      if (!State.records.length) {
        Logger.warn('没有可导出的数据');
        return;
      }
      const content = JSON.stringify(State.records, null, 2);
      this.download(content, `${CONFIG.exportFilePrefix}_${timestampForFile()}.json`, 'application/json;charset=utf-8');
      Logger.info(`已导出 JSON：${State.records.length} 条`);
    },

    download(content, filename, type) {
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };


  /*
   * v0.1.3 针对美团后台 Select / Drawer 的稳定性补丁
   * 目的：
   * 1. 不再把字段所在的大容器误判为“已选择”。
   * 2. 不再点击输入框左侧导致只有光标闪烁，而是优先点击下拉框右侧箭头区域。
   * 3. 下拉选项只匹配小尺寸、真实可见的候选项，避免命中整页文本。
   * 4. 关闭面板时过滤已滑出屏幕但 DOM 仍存在的抽屉。
   */
  function applyMeituanCollectorV013Patch() {
    const oldFindModal = PromotionModal.findModal.bind(PromotionModal);

    const isInViewport = (element, margin = 2) => {
      if (!element || element.nodeType !== 1) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > margin &&
        rect.bottom > margin &&
        rect.left < window.innerWidth - margin &&
        rect.top < window.innerHeight - margin
      );
    };

    const dispatchPointerMouse = (element, x, y) => {
      if (!element) return;
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y
      };
      if (window.PointerEvent) {
        element.dispatchEvent(new PointerEvent('pointerover', eventOptions));
        element.dispatchEvent(new PointerEvent('pointerenter', eventOptions));
        element.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
        element.dispatchEvent(new PointerEvent('pointerup', eventOptions));
      }
      element.dispatchEvent(new MouseEvent('mouseover', eventOptions));
      element.dispatchEvent(new MouseEvent('mouseenter', eventOptions));
      element.dispatchEvent(new MouseEvent('mousemove', eventOptions));
      element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      element.dispatchEvent(new MouseEvent('click', eventOptions));
    };

    const clickPoint = async (x, y, reason = '') => {
      const safeX = Math.max(4, Math.min(window.innerWidth - 4, Math.round(x)));
      const safeY = Math.max(4, Math.min(window.innerHeight - 4, Math.round(y)));
      const target = document.elementFromPoint(safeX, safeY) || document.body;
      Logger.info(`点击坐标：${reason || target.tagName} x=${safeX}, y=${safeY}, 命中=${target.tagName} ${DOM.visibleText(target).slice(0, 40)}`);
      dispatchPointerMouse(target, safeX, safeY);
      if (typeof target.click === 'function') {
        try { target.click(); } catch (error) { /* ignore */ }
      }
      await DOM.sleep(120);
      return target;
    };

    const exactLabel = (labelText, modal) => {
      const compactTarget = compactOptionText(labelText);
      return DOM.all('label,span,div,p,td', modal)
        .filter((element) => isInViewport(element))
        .filter((element) => {
          const compact = compactOptionText(DOM.visibleText(element));
          return compact === compactTarget || compact.includes(compactTarget);
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.width * ra.height - rb.width * rb.height;
        })[0] || null;
    };

    const isBadText = (text) => /新增媒体|新增推广位|文案素材|复制文案|复制链接|首页|使用帮助|消息中心|账户管理|推广管理|效果报表/.test(text || '');

    const selectedNearLabelStrict = (label, optionText, modal) => {
      if (!label || !optionText || !modal) return null;
      const labelRect = label.getBoundingClientRect();
      const compactTarget = compactOptionText(optionText);
      return DOM.all('input,select,button,[role="button"],[role="combobox"],span,div,p', modal)
        .filter((element) => isInViewport(element))
        .filter((element) => !element.closest('#mtamc-panel'))
        .filter((element) => !label.contains(element))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const value = element.tagName && element.tagName.toLowerCase() === 'input' ? element.value : DOM.visibleText(element);
          const verticalDistance = Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2));
          return { element, rect, value: DOM.normalizeText(value), compact: compactOptionText(value), verticalDistance };
        })
        .filter(({ rect, value, compact, verticalDistance }) => (
          value &&
          !isBadText(value) &&
          rect.left > labelRect.right - 8 &&
          rect.width >= 80 &&
          rect.width <= 520 &&
          rect.height >= 18 &&
          rect.height <= 70 &&
          verticalDistance <= 42 &&
          (compact === compactTarget || compact.includes(compactTarget))
        ))
        .sort((a, b) => {
          if (a.verticalDistance !== b.verticalDistance) return a.verticalDistance - b.verticalDistance;
          return a.rect.left - b.rect.left;
        })[0]?.element || null;
    };

    const normalizeClickBox = (element, label, modal) => {
      if (!element || !label || !modal) return null;
      const labelRect = label.getBoundingClientRect();
      let current = element;
      const candidates = [];
      while (current && current !== modal.parentElement && candidates.length < 10) {
        if (isInViewport(current) && !PromotionModal.isDisabled(current)) {
          const rect = current.getBoundingClientRect();
          const text = DOM.visibleText(current) || current.value || '';
          const verticalDistance = Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2));
          const className = String(current.className || '');
          const role = current.getAttribute('role') || '';
          const dropdownLike = /select|dropdown|picker|trigger|combobox|mtd-select|ant-select/i.test(className) || role === 'combobox';
          if (
            rect.left > labelRect.right - 12 &&
            rect.width >= 80 && rect.width <= 620 &&
            rect.height >= 24 && rect.height <= 78 &&
            verticalDistance <= 48 &&
            !isBadText(text)
          ) {
            candidates.push({
              element: current,
              rect,
              text,
              score: (dropdownLike ? -100000 : 0) + rect.width * rect.height + verticalDistance * 100
            });
          }
        }
        if (current === modal) break;
        current = current.parentElement;
      }
      candidates.sort((a, b) => a.score - b.score);
      return candidates[0]?.element || element;
    };

    const getFieldClickTargets = (labelText, optionText, modal) => {
      const label = exactLabel(labelText, modal);
      if (!label) return { label: null, targets: [] };
      const labelRect = label.getBoundingClientRect();
      const rootCandidates = DOM.all('input,select,button,[role="button"],[role="combobox"],div,span', modal)
        .filter((element) => isInViewport(element))
        .filter((element) => !element.closest('#mtamc-panel'))
        .filter((element) => !label.contains(element) && !PromotionModal.isDisabled(element))
        .map((element) => normalizeClickBox(element, label, modal))
        .filter(Boolean);

      const boxes = uniqueElements(rootCandidates)
        .filter((element) => isInViewport(element))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = DOM.visibleText(element) || element.value || '';
          const compact = compactOptionText(text);
          const verticalDistance = Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2));
          const overlapY = rect.bottom >= labelRect.top - 18 && rect.top <= labelRect.bottom + 18;
          const dropdownScore = PromotionModal.isDropdownLike(element) ? -120 : 0;
          const targetScore = optionText && compact.includes(compactOptionText(optionText)) ? -80 : 0;
          const placeholderScore = /选择|请选择/.test(text) ? -60 : 0;
          const className = String(element.className || '');
          const classScore = /select|dropdown|picker|mtd-select|ant-select/i.test(className) ? -60 : 0;
          return {
            element,
            rect,
            text,
            score: dropdownScore + targetScore + placeholderScore + classScore + verticalDistance * 5 + Math.max(0, rect.left - labelRect.right) / 8
          };
        })
        .filter(({ rect, text }) => (
          rect.left > labelRect.right - 14 &&
          rect.width >= 90 && rect.width <= 620 &&
          rect.height >= 22 && rect.height <= 82 &&
          (rect.bottom >= labelRect.top - 22 && rect.top <= labelRect.bottom + 22 || Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2)) <= 52) &&
          !isBadText(text)
        ))
        .sort((a, b) => {
          if (a.score !== b.score) return a.score - b.score;
          return a.rect.left - b.rect.left;
        });

      const targets = [];
      boxes.slice(0, 5).forEach(({ element, rect, text }) => {
        targets.push({ element, rect, text, x: rect.right - 18, y: rect.top + rect.height / 2, desc: `右侧箭头区域：${text || element.tagName}` });
        targets.push({ element, rect, text, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, desc: `中间区域：${text || element.tagName}` });
      });

      // 坐标兜底：页面结构变化时，直接点击标签右侧常见下拉框区域，优先点右侧箭头。
      const y = labelRect.top + labelRect.height / 2;
      targets.push({ x: labelRect.right + 300, y, desc: '坐标兜底-右侧箭头' });
      targets.push({ x: labelRect.right + 170, y, desc: '坐标兜底-中间' });
      return { label, targets };
    };

    const findOptionStrict = (optionText) => {
      const target = DOM.normalizeText(optionText);
      const compactTarget = compactOptionText(target);
      const candidates = DOM.all('[role="option"],li,div,span,p')
        .filter((element) => isInViewport(element))
        .filter((element) => !element.closest('#mtamc-panel'))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = DOM.visibleText(element);
          const compact = compactOptionText(text);
          const className = String(element.className || '');
          const role = element.getAttribute('role') || '';
          const isExact = text === target || compact === compactTarget;
          const isContains = compact.includes(compactTarget) || compactTarget.includes(compact);
          return { element, rect, text, compact, className, role, isExact, isContains };
        })
        .filter(({ rect, text, compact, isExact, isContains }) => (
          text &&
          !isBadText(text) &&
          rect.width >= 70 && rect.width <= 720 &&
          rect.height >= 18 && rect.height <= 86 &&
          compact.length <= Math.max(compactTarget.length + 18, compactTarget.length * 1.6) &&
          (isExact || isContains)
        ))
        .sort((a, b) => {
          const roleA = a.role === 'option' || /option|item|menu|dropdown|select/i.test(a.className) ? -1000 : 0;
          const roleB = b.role === 'option' || /option|item|menu|dropdown|select/i.test(b.className) ? -1000 : 0;
          const exactA = a.isExact ? -500 : 0;
          const exactB = b.isExact ? -500 : 0;
          const scoreA = roleA + exactA + a.rect.width * a.rect.height;
          const scoreB = roleB + exactB + b.rect.width * b.rect.height;
          return scoreA - scoreB;
        });

      const raw = candidates[0]?.element || null;
      if (!raw) return null;

      // 选项文本常在 span 内，点击其最近的 option/li/menu item 父级；没有则点自身。
      let current = raw;
      while (current && current !== document.body) {
        if (!isInViewport(current)) break;
        const rect = current.getBoundingClientRect();
        const text = DOM.visibleText(current);
        const compact = compactOptionText(text);
        const className = String(current.className || '');
        const role = current.getAttribute('role') || '';
        if (
          rect.width >= 70 && rect.width <= 760 &&
          rect.height >= 20 && rect.height <= 90 &&
          !isBadText(text) &&
          (compact === compactTarget || compact.includes(compactTarget)) &&
          (role === 'option' || current.tagName === 'LI' || /option|item|menu|dropdown|select/i.test(className))
        ) {
          return current;
        }
        current = current.parentElement;
      }
      return raw;
    };

    const waitForOptionFast = async (optionText, timeout = 1800) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const option = findOptionStrict(optionText);
        if (option) return option;
        await DOM.sleep(80);
      }
      return null;
    };

    const clickOptionStrict = async (option, optionText) => {
      const rect = option.getBoundingClientRect();
      const x = rect.left + Math.min(Math.max(rect.width / 2, 18), Math.max(rect.width - 18, 18));
      const y = rect.top + rect.height / 2;
      await clickPoint(x, y, `下拉选项：${optionText}`);
      // 某些组件把 onClick 绑在父级，再补一次元素级事件。
      dispatchPointerMouse(option, x, y);
      if (typeof option.click === 'function') {
        try { option.click(); } catch (error) { /* ignore */ }
      }
      await DOM.sleep(260);
    };

    const verifySelectedStrict = async (labelText, optionText, modal) => {
      const start = Date.now();
      while (Date.now() - start < 3500) {
        const activeModal = PromotionModal.findModal() || modal;
        const label = activeModal ? exactLabel(labelText, activeModal) : null;
        const selected = label ? selectedNearLabelStrict(label, optionText, activeModal) : null;
        if (selected) {
          if (labelText.includes('推广媒体')) {
            const positionLabel = exactLabel('选择推广位', activeModal);
            if (positionLabel) return true;
          } else if (labelText.includes('推广位')) {
            const materialLabel = exactLabel('文案素材', activeModal);
            const promoteMaterial = exactLabel('推广物料', activeModal);
            if (materialLabel || promoteMaterial) return true;
          } else {
            return true;
          }
        }
        await DOM.sleep(160);
      }
      return false;
    };

    const setActiveInputAndSearch = async (labelText, optionText, modal) => {
      const { label, targets } = getFieldClickTargets(labelText, optionText, modal);
      if (!label || !targets.length) return null;
      const first = targets[0];
      await clickPoint(first.x, first.y, `${labelText} 搜索兜底`);
      await DOM.sleep(120);
      const input = document.activeElement && document.activeElement.tagName === 'INPUT' ? document.activeElement : null;
      if (!input) return null;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, optionText);
      else input.value = optionText;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await DOM.sleep(260);
      return waitForOptionFast(optionText, 2000);
    };

    const openAndPick = async (labelText, optionText, modal) => {
      const { label, targets } = getFieldClickTargets(labelText, optionText, modal);
      if (!label) throw new Error(`未找到字段文案：${labelText}`);
      if (!targets.length) throw new Error(`未找到「${labelText}」右侧可点击区域`);

      let lastDesc = '';
      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i];
        lastDesc = target.desc || target.text || '未知候选';
        await clickPoint(target.x, target.y, `${labelText} ${i + 1}/${targets.length} ${lastDesc}`);
        const option = await waitForOptionFast(optionText, 1700);
        if (option) return { option, lastDesc };
        // 不主动 ESC，避免“闪一下就被关闭”。直接尝试下一个点击点。
        await DOM.sleep(120);
      }

      const searched = await setActiveInputAndSearch(labelText, optionText, modal);
      if (searched) return { option: searched, lastDesc: `${lastDesc} + 搜索兜底` };

      const diag = PromotionModal.getOpenDropdownDiagnostics(optionText);
      throw new Error(`找不到下拉选项：${optionText}${diag ? `（${diag}，最近点击：${lastDesc}）` : ''}`);
    };

    PromotionModal.findModal = function patchedFindModal() {
      const candidates = DOM.all('aside,section,div,[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]', document)
        .filter((element) => isInViewport(element, 4))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const text = DOM.visibleText(element);
          return (
            rect.width >= 280 &&
            rect.height >= 160 &&
            rect.right > window.innerWidth * 0.48 &&
            rect.left < window.innerWidth - 80 &&
            text.includes('立即推广') &&
            text.includes('选择推广媒体')
          );
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          // 右侧抽屉通常是面积较小且更靠右的容器。
          const scoreA = ra.width * ra.height + Math.max(0, window.innerWidth - ra.left) * 2;
          const scoreB = rb.width * rb.height + Math.max(0, window.innerWidth - rb.left) * 2;
          return scoreA - scoreB;
        });
      return candidates[0] || oldFindModal();
    };

    PromotionModal.findSelectedValueNearLabel = selectedNearLabelStrict;

    PromotionModal.isSelectionAccepted = function patchedIsSelectionAccepted(labelText, group, optionText, modal) {
      const activeModal = modal || this.currentModal || this.findModal();
      const label = activeModal ? exactLabel(labelText, activeModal) : null;
      const selected = label ? selectedNearLabelStrict(label, optionText, activeModal) : null;
      if (!selected) return false;
      if (labelText.includes('推广媒体')) return Boolean(exactLabel('选择推广位', activeModal));
      if (labelText.includes('推广位')) return Boolean(exactLabel('文案素材', activeModal) || exactLabel('推广物料', activeModal));
      return true;
    };

    PromotionModal.isSelectedText = function patchedIsSelectedText(group, optionText) {
      // 禁止用大容器文本判断“已选择”，避免把整页文本/隐藏下拉选项误判为选中态。
      if (!group || !optionText) return false;
      const rect = group.getBoundingClientRect();
      if (rect.height > 90 || rect.width > 620) return false;
      const text = DOM.visibleText(group) || group.value || '';
      if (!text || isBadText(text)) return false;
      const compactText = compactOptionText(text);
      const compactTarget = compactOptionText(optionText);
      return compactText === compactTarget || compactText.includes(compactTarget);
    };

    PromotionModal.findDropdownOption = function patchedFindDropdownOption(optionText) {
      return findOptionStrict(optionText);
    };

    PromotionModal.selectDropdownByLabel = async function patchedSelectDropdownByLabel(labelText, optionText) {
      let modal = this.currentModal || this.findModal();
      if (!modal) modal = await this.waitForPromotionModal();
      const label = exactLabel(labelText, modal);
      if (!label) throw new Error(`未找到字段文案：${labelText}`);

      const already = selectedNearLabelStrict(label, optionText, modal);
      if (already && await verifySelectedStrict(labelText, optionText, modal)) {
        Logger.info(`「${labelText}」已是 ${optionText}`);
        return true;
      }

      Logger.info(`准备选择「${labelText}」：${optionText}`);
      const { option, lastDesc } = await openAndPick(labelText, optionText, modal);
      await clickOptionStrict(option, optionText);
      const ok = await verifySelectedStrict(labelText, optionText, modal);
      if (!ok) {
        const diagLabel = exactLabel(labelText, this.findModal() || modal);
        const selectedText = diagLabel ? (selectedNearLabelStrict(diagLabel, optionText, this.findModal() || modal) ? DOM.visibleText(selectedNearLabelStrict(diagLabel, optionText, this.findModal() || modal)) : '') : '';
        throw new Error(`选择「${labelText}」后未生效，最近点击：${lastDesc}，当前识别选中值：${selectedText || '空'}`);
      }
      Logger.info(`已选择「${labelText}」：${optionText}`);
      return true;
    };

    PromotionModal.clickDropdownOptionElement = async function patchedClickDropdownOptionElement(option, optionText) {
      await clickOptionStrict(option, optionText);
    };

    PromotionModal.closePromotionModal = async function patchedClosePromotionModal() {
      let modal = this.currentModal || this.findModal();
      if (!modal) {
        this.currentModal = null;
        Logger.info('推广面板已关闭');
        return;
      }

      const waitClosed = async (timeout = 2600) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (!this.findModal()) return true;
          await DOM.sleep(140);
        }
        return false;
      };

      const closeButton = this.findCloseButton(modal);
      if (closeButton) {
        const rect = closeButton.getBoundingClientRect();
        await clickPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, '关闭按钮');
        if (await waitClosed()) {
          this.currentModal = null;
          Logger.info('已关闭推广面板');
          return;
        }
      }

      this.sendEscape();
      if (await waitClosed()) {
        this.currentModal = null;
        Logger.info('已通过 ESC 关闭推广面板');
        return;
      }

      const mask = this.findMaskElement();
      if (mask) {
        const rect = mask.getBoundingClientRect();
        await clickPoint(Math.max(20, rect.left + 20), Math.max(20, rect.top + 20), '遮罩层');
        if (await waitClosed()) {
          this.currentModal = null;
          Logger.info('已通过遮罩层关闭推广面板');
          return;
        }
      }

      // 如果抽屉实际已经离开视口，但旧 DOM 仍残留，也视为关闭成功。
      modal = this.findModal();
      if (!modal || !isInViewport(modal, 16)) {
        this.currentModal = null;
        Logger.info('推广面板已关闭');
        return;
      }
      throw new Error('推广面板仍未关闭，请手动关闭后继续');
    };

    // 历史补丁日志已合并到 V1.0.0，不再单独输出。
  }

  applyMeituanCollectorV013Patch();


  /*
   * v0.1.4 结果态校验补丁
   * 观察视频后确认：美团 Select 已经实际选中媒体位，但字段内文本会被组件截断/隐藏，
   * v0.1.3 用字段文本做严格校验，导致“页面已选中、脚本仍报未生效”。
   *
   * 新策略：
   * 1. 选择推广媒体后，只要页面出现「选择推广位」，即可视为媒体位选择生效。
   * 2. 选择推广位后，只要页面出现「推广物料」或「文案素材」，即可视为推广位选择生效。
   * 3. 保留原来的下拉点击与选项选择逻辑，只替换最终生效判断，避免回退已修好的点击问题。
   */
  function applyMeituanCollectorV014Patch() {
    const previousSelectDropdownByLabel = PromotionModal.selectDropdownByLabel.bind(PromotionModal);
    const previousClosePromotionModal = PromotionModal.closePromotionModal.bind(PromotionModal);

    const isVisibleInViewport = (element, margin = 4) => {
      if (!element || element.nodeType !== 1) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > margin &&
        rect.bottom > margin &&
        rect.left < window.innerWidth - margin &&
        rect.top < window.innerHeight - margin
      );
    };

    const exactLabelV014 = (labelText, modal) => {
      if (!modal) return null;
      const compactTarget = compactOptionText(labelText);
      return DOM.all('label,span,div,p,td', modal)
        .filter((element) => isVisibleInViewport(element))
        .filter((element) => {
          const compact = compactOptionText(DOM.visibleText(element));
          return compact === compactTarget || compact.includes(compactTarget);
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          const exactA = compactOptionText(DOM.visibleText(a)) === compactTarget ? -100000 : 0;
          const exactB = compactOptionText(DOM.visibleText(b)) === compactTarget ? -100000 : 0;
          return exactA + ra.width * ra.height - (exactB + rb.width * rb.height);
        })[0] || null;
    };

    const fieldDisplayTextV014 = (labelText, optionText, modal) => {
      const label = exactLabelV014(labelText, modal);
      if (!label) return '';
      const labelRect = label.getBoundingClientRect();
      const optionPrefix = String(optionText || '').split('-')[0];
      const compactPrefix = compactOptionText(optionPrefix);
      const candidates = DOM.all('input,select,button,[role="button"],[role="combobox"],span,div,p', modal)
        .filter((element) => isVisibleInViewport(element))
        .filter((element) => !element.closest('#mtamc-panel'))
        .filter((element) => !label.contains(element))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const rawValue = element.tagName && element.tagName.toLowerCase() === 'input'
            ? (element.value || element.getAttribute('placeholder') || '')
            : (DOM.visibleText(element) || element.getAttribute('title') || element.getAttribute('aria-label') || '');
          const value = DOM.normalizeText(rawValue);
          const compact = compactOptionText(value);
          const verticalDistance = Math.abs(rect.top + rect.height / 2 - (labelRect.top + labelRect.height / 2));
          const looksLikeValue =
            value &&
            !/请输入|请选择|新增|文案素材|复制文案|复制链接|首页|使用帮助|消息中心|账户管理|推广管理|效果报表/.test(value) &&
            (
              compact.includes(compactOptionText(optionText)) ||
              (compactPrefix && compact.includes(compactPrefix)) ||
              /干饭吧|美团红包|红包/.test(value)
            );
          return { value, rect, verticalDistance, looksLikeValue };
        })
        .filter(({ rect, verticalDistance, looksLikeValue }) => (
          looksLikeValue &&
          rect.left > labelRect.right - 18 &&
          rect.width >= 60 &&
          rect.width <= 640 &&
          rect.height >= 16 &&
          rect.height <= 90 &&
          verticalDistance <= 58
        ))
        .sort((a, b) => {
          if (a.verticalDistance !== b.verticalDistance) return a.verticalDistance - b.verticalDistance;
          return a.rect.left - b.rect.left;
        });
      return candidates[0]?.value || '';
    };

    const outcomeReadyV014 = (labelText, optionText, modal) => {
      const activeModal = PromotionModal.findModal() || modal || PromotionModal.currentModal;
      if (!activeModal) return false;

      if (labelText.includes('推广媒体')) {
        // 用户视频中已经证实：媒体位选择成功后，页面才会渲染「选择推广位」。
        const positionLabel = exactLabelV014('选择推广位', activeModal);
        if (positionLabel) return true;
        return false;
      }

      if (labelText.includes('推广位')) {
        // 推广位选择成功后，页面才会渲染「推广物料」和「文案素材」。
        const materialLabel = exactLabelV014('文案素材', activeModal);
        const promoteMaterialLabel = exactLabelV014('推广物料', activeModal);
        if (materialLabel || promoteMaterialLabel) return true;
        return false;
      }

      const displayText = fieldDisplayTextV014(labelText, optionText, activeModal);
      return Boolean(displayText);
    };

    const waitOutcomeReadyV014 = async (labelText, optionText, modal, timeout = 5200) => {
      const start = Date.now();
      let lastState = '';
      while (Date.now() - start < timeout) {
        const activeModal = PromotionModal.findModal() || modal || PromotionModal.currentModal;
        const displayText = activeModal ? fieldDisplayTextV014(labelText, optionText, activeModal) : '';
        lastState = displayText || lastState;
        if (outcomeReadyV014(labelText, optionText, activeModal)) {
          return { ok: true, displayText };
        }
        await DOM.sleep(160);
      }
      return { ok: false, displayText: lastState };
    };

    PromotionModal.selectDropdownByLabel = async function patchedSelectDropdownByLabelV014(labelText, optionText, options = {}) {
      let modal = this.currentModal || this.findModal();
      if (!modal) modal = await this.waitForPromotionModal();

      // 如果已经处于后续结果态，直接认为已选中。
      const before = await waitOutcomeReadyV014(labelText, optionText, modal, 500);
      if (before.ok) {
        const value = before.displayText || fieldDisplayTextV014(labelText, optionText, this.findModal() || modal);
        Logger.info(`「${labelText}」已生效${value ? `：${value}` : ''}`);
        return true;
      }

      try {
        await previousSelectDropdownByLabel(labelText, optionText, options);
        const after = await waitOutcomeReadyV014(labelText, optionText, this.findModal() || modal, 1200);
        if (after.ok) return true;
        // 原函数可能返回成功但结果区还未完全渲染，继续等待一小段，避免后续马上找不到字段。
        await DOM.sleep(500);
        return true;
      } catch (error) {
        const after = await waitOutcomeReadyV014(labelText, optionText, this.findModal() || modal, 5600);
        if (after.ok) {
          Logger.warn(`原校验提示失败，但页面结果态已生效，继续执行「${labelText}」${after.displayText ? `，当前显示：${after.displayText}` : ''}`);
          return true;
        }
        throw error;
      }
    };

    PromotionModal.closePromotionModal = async function patchedClosePromotionModalV014() {
      try {
        await previousClosePromotionModal();
      } catch (error) {
        // 抽屉关闭动画结束后，旧 DOM 可能残留；再用可视结果态复核一次。
        await DOM.sleep(500);
        const modal = this.findModal();
        if (!modal || !isVisibleInViewport(modal, 12)) {
          this.currentModal = null;
          Logger.info('推广面板已关闭');
          return;
        }
        throw error;
      }
    };

    // 历史补丁日志已合并到 V1.0.0，不再单独输出。
  }

  applyMeituanCollectorV014Patch();




  /*
   * v0.1.5 容错校验补丁
   * 处理美团后台 Select 已经完成选择，但字段 value / innerText 读取为空导致脚本误报的问题。
   * 核心原则：旧选择函数负责“点击并选择”，本补丁只在旧函数报错后，通过页面结果态兜底放行。
   */
  function applyMeituanCollectorV015Patch() {
    const previousSelectDropdownByLabel = PromotionModal.selectDropdownByLabel.bind(PromotionModal);

    const isVisibleElementV015 = (element) => {
      if (!element || element.nodeType !== 1) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    };

    const getActiveModalV015 = () => {
      const modal = PromotionModal.findModal() || PromotionModal.currentModal;
      if (modal && isVisibleElementV015(modal)) return modal;
      // 兜底：从右侧可视区域中找包含“立即推广 / 选择推广媒体”的容器，避免旧 findModal 因抽屉动画或 DOM 残留失效。
      const candidates = DOM.all('aside,section,div,[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]', document)
        .filter(isVisibleElementV015)
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const text = DOM.visibleText(element);
          return rect.width >= 300 && rect.height >= 180 && rect.right > window.innerWidth * 0.45 && text.includes('立即推广') && text.includes('选择推广媒体');
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return (ra.width * ra.height) - (rb.width * rb.height);
        });
      return candidates[0] || null;
    };

    const visibleTextV015 = (root) => {
      if (!root) return '';
      // 不直接使用 body.innerText，避免把左侧菜单、隐藏下拉缓存、历史列表文本误纳入判断。
      return DOM.all('label,span,div,p,button,a,input,textarea,select', root)
        .filter(isVisibleElementV015)
        .map((element) => {
          if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
            return element.value || element.getAttribute('placeholder') || '';
          }
          return DOM.visibleText(element) || element.getAttribute('title') || element.getAttribute('aria-label') || '';
        })
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const resultStateReadyV015 = (labelText) => {
      const modal = getActiveModalV015();
      if (!modal) return { ok: false, text: '' };
      const text = visibleTextV015(modal);

      if (labelText.includes('推广媒体')) {
        // 媒体位真正生效后，推广位输入框会变成可操作状态，并出现“请输入推广位名称 / 新增推广位”。
        const ok = (
          text.includes('选择推广位') &&
          (text.includes('请输入推广位名称') || text.includes('新增推广位') || text.includes('美团红包01'))
        );
        return { ok, text };
      }

      if (labelText.includes('推广位')) {
        // 推广位真正生效后，才会出现推广物料、文案素材和复制区域。
        const ok = text.includes('推广物料') || text.includes('文案素材') || text.includes('复制文案') || text.includes('复制链接');
        return { ok, text };
      }

      return { ok: false, text };
    };

    const waitResultStateV015 = async (labelText, timeout = 6500) => {
      const start = Date.now();
      let last = { ok: false, text: '' };
      while (Date.now() - start < timeout) {
        last = resultStateReadyV015(labelText);
        if (last.ok) return last;
        await DOM.sleep(180);
      }
      return last;
    };

    PromotionModal.selectDropdownByLabel = async function patchedSelectDropdownByLabelV015(labelText, optionText, options = {}) {
      try {
        const result = await previousSelectDropdownByLabel(labelText, optionText, options);
        // 旧函数返回成功后，再等待一下结果区，避免刚选完马上进入下一步。
        if (labelText.includes('推广媒体') || labelText.includes('推广位')) {
          const state = await waitResultStateV015(labelText, 1800);
          if (state.ok) return true;
        }
        return result;
      } catch (error) {
        // 关键修复：旧函数常见误报“当前识别选中值：空”，但页面实际已经进入下一步。
        const state = await waitResultStateV015(labelText, 7200);
        if (state.ok) {
          Logger.warn(`旧校验提示「${labelText}」失败，但页面结果态已生效，继续执行。原错误：${error.message || error}`);
          return true;
        }
        const brief = (state.text || '').slice(0, 260);
        throw new Error(`${error.message || error}${brief ? `；结果态文本片段：${brief}` : ''}`);
      }
    };

    // 历史补丁日志已合并到 V1.0.0，不再单独输出。
  }

  applyMeituanCollectorV015Patch();




  /*
   * v0.1.6 强制跳过 Select 字段值误校验补丁
   * 现象：美团 Select 已经完成选择并渲染后续字段，但 input.value / innerText 仍读取为空，旧校验抛出“选择后未生效”。
   * 处理：保留旧函数的点击和选项选择能力；只在“选择后未生效 / 当前识别选中值为空”这类误报时放行。
   */
  function applyMeituanCollectorV016Patch() {
    const previousSelectDropdownByLabel = PromotionModal.selectDropdownByLabel.bind(PromotionModal);

    const isVisibleV016 = (element) => {
      if (!element || element.nodeType !== 1) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    };

    const getActiveModalV016 = () => {
      const direct = PromotionModal.findModal && PromotionModal.findModal();
      if (direct && isVisibleV016(direct)) return direct;
      if (PromotionModal.currentModal && isVisibleV016(PromotionModal.currentModal)) return PromotionModal.currentModal;

      const candidates = DOM.all('aside,section,div,[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]', document)
        .filter(isVisibleV016)
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const text = DOM.visibleText(element);
          return rect.width >= 300 && rect.height >= 160 && rect.right > window.innerWidth * 0.42 && text.includes('立即推广') && text.includes('选择推广媒体');
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return (ra.width * ra.height) - (rb.width * rb.height);
        });
      return candidates[0] || null;
    };

    const visiblePanelTextV016 = () => {
      const modal = getActiveModalV016();
      if (!modal) return '';
      return DOM.all('label,span,div,p,button,a,input,textarea,select', modal)
        .filter(isVisibleV016)
        .map((element) => {
          const tag = element.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            return element.value || element.getAttribute('placeholder') || '';
          }
          return DOM.visibleText(element) || element.getAttribute('title') || element.getAttribute('aria-label') || '';
        })
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const isFalseNegativeAfterClickV016 = (labelText, error) => {
      const message = String(error && (error.message || error) || '');
      if (!/未生效|当前识别选中值|旧校验提示/.test(message)) return false;
      if (labelText.includes('推广媒体')) return true;
      if (labelText.includes('推广位')) return true;
      return false;
    };

    const hasExpectedNextStateV016 = (labelText) => {
      const text = visiblePanelTextV016();
      if (!text) return false;
      if (labelText.includes('推广媒体')) {
        // 媒体位选中后，至少会看到推广位字段/占位/新增推广位。字段值读不到也允许继续。
        return text.includes('选择推广位') || text.includes('请输入推广位名称') || text.includes('新增推广位');
      }
      if (labelText.includes('推广位')) {
        // 推广位选中后才会出现推广物料和文案素材区。
        return text.includes('推广物料') || text.includes('文案素材') || text.includes('复制文案') || text.includes('复制链接');
      }
      return false;
    };

    const waitExpectedNextStateV016 = async (labelText, timeout = 2600) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (hasExpectedNextStateV016(labelText)) return true;
        await DOM.sleep(160);
      }
      return false;
    };

    PromotionModal.selectDropdownByLabel = async function patchedSelectDropdownByLabelV016(labelText, optionText, options = {}) {
      try {
        const result = await previousSelectDropdownByLabel(labelText, optionText, options);
        // 旧函数成功时不再进行字段值强校验，避免再次误判。
        if (labelText.includes('推广媒体')) {
          await DOM.sleep(500);
          Logger.info(`已完成「${labelText}」选择动作，跳过字段值读取校验，继续选择推广位`);
        }
        if (labelText.includes('推广位')) {
          await DOM.sleep(700);
          Logger.info(`已完成「${labelText}」选择动作，继续读取文案素材`);
        }
        return result;
      } catch (error) {
        if (isFalseNegativeAfterClickV016(labelText, error)) {
          const ok = await waitExpectedNextStateV016(labelText, labelText.includes('推广媒体') ? 4500 : 6500);
          // 对媒体位更宽松：当前已确认页面确实会成功选中，但 Select 字段读取为空；放行后由推广位选择来验证结果。
          if (ok || labelText.includes('推广媒体')) {
            const text = visiblePanelTextV016().slice(0, 180);
            Logger.warn(`忽略「${labelText}」字段值误校验，继续后续步骤。原错误：${error.message || error}${text ? `；当前面板：${text}` : ''}`);
            return true;
          }
        }
        throw error;
      }
    };

    // 历史补丁日志已合并到 V1.0.0，不再单独输出。
  }

  applyMeituanCollectorV016Patch();



  /*
   * v0.1.7 抽屉识别 + 推广位结果态 + 文案素材遍历补丁
   * 修复点：
   * 1) 彻底排除采集助手自身面板，避免把脚本控制台误当成“推广面板”。
   * 2) 下拉选择不再调用旧链路的字段 value 校验，直接按坐标点击右侧 Select 箭头并选择真实选项。
   * 3) 推广位选择后，只要出现“推广物料 / 文案素材 / 素材单选项”，就认为已生效并继续采集。
   * 4) 文案素材默认遍历所有常见单选项；textarea 为空时尝试采集当前素材区域图片 URL。
   */
  function applyMeituanCollectorV017Patch() {
    CONFIG.materialTypes = ['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令'];

    const panelSelectorV017 = '#mtamc-panel';

    const isVisibleV017 = (element) => {
      if (!element || element.nodeType !== 1) return false;
      if (element.closest && element.closest(panelSelectorV017)) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    };

    const normalizeV017 = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const compactV017 = (value) => normalizeV017(value).replace(/[\s>*：:，,。；;｜|]/g, '');

    const visibleTextV017 = (element) => {
      if (!element) return '';
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
        return normalizeV017(element.value || element.getAttribute('placeholder') || element.textContent || '');
      }
      return normalizeV017(element.innerText || element.textContent || element.getAttribute('title') || element.getAttribute('aria-label') || '');
    };

    const allVisibleV017 = (selector, root = document) => DOM.all(selector, root).filter(isVisibleV017);

    const dispatchPointV017 = (x, y, reason = '') => {
      const safeX = Math.max(4, Math.min(window.innerWidth - 4, Math.round(x)));
      const safeY = Math.max(4, Math.min(window.innerHeight - 4, Math.round(y)));
      const target = document.elementFromPoint(safeX, safeY) || document.body;
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: safeX,
        clientY: safeY
      };
      Logger.info(`点击坐标：${reason || target.tagName} x=${safeX}, y=${safeY}, 命中=${target.tagName} ${visibleTextV017(target).slice(0, 40)}`);
      const targets = uniqueElements([target, target.parentElement, target.closest && target.closest('a,button,label,li,[role="option"],[role="button"],[role="combobox"]')].filter(Boolean));
      for (const element of targets) {
        try {
          if (window.PointerEvent) {
            element.dispatchEvent(new PointerEvent('pointerover', eventOptions));
            element.dispatchEvent(new PointerEvent('pointerenter', eventOptions));
            element.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
            element.dispatchEvent(new PointerEvent('pointerup', eventOptions));
          }
          element.dispatchEvent(new MouseEvent('mouseover', eventOptions));
          element.dispatchEvent(new MouseEvent('mouseenter', eventOptions));
          element.dispatchEvent(new MouseEvent('mousemove', eventOptions));
          element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
          element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
          element.dispatchEvent(new MouseEvent('click', eventOptions));
          if (typeof element.click === 'function') element.click();
        } catch (error) {
          // ignore individual event errors
        }
      }
      return target;
    };

    const clickPointV017 = async (x, y, reason = '') => {
      dispatchPointV017(x, y, reason);
      await DOM.sleep(180);
    };

    const getPromotionDrawerV017 = () => {
      const candidates = allVisibleV017('aside,section,div,[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]', document)
        .filter((element) => {
          if (element.id === 'mtamc-panel' || element.closest(panelSelectorV017)) return false;
          const rect = element.getBoundingClientRect();
          const text = visibleTextV017(element);
          if (!text.includes('选择推广媒体')) return false;
          if (!(text.includes('立即推广') || text.includes('选择推广位') || text.includes('新增媒体'))) return false;
          // 过滤整页大容器和左侧主页面：真正抽屉基本在屏幕右侧，宽度也不会接近整页。
          if (rect.width > window.innerWidth * 0.86 && rect.left < 80) return false;
          if (rect.right < window.innerWidth * 0.46) return false;
          if (rect.width < 320 || rect.height < 140) return false;
          return true;
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          // 优先更靠右、面积更小的抽屉/表单容器，避免命中整页遮罩。
          if (Math.abs(rb.left - ra.left) > 20) return rb.left - ra.left;
          return (ra.width * ra.height) - (rb.width * rb.height);
        });
      return candidates[0] || null;
    };

    PromotionModal.findModal = function patchedFindModalV017() {
      const drawer = getPromotionDrawerV017();
      if (drawer) return drawer;
      return null;
    };

    const getModalTextV017 = () => {
      const modal = getPromotionDrawerV017();
      if (!modal) return '';
      return allVisibleV017('label,span,div,p,button,a,input,textarea,select', modal)
        .map(visibleTextV017)
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const findLabelV017 = (labelText, modal) => {
      const compactTarget = compactV017(labelText);
      return allVisibleV017('label,span,div,p,td', modal)
        .filter((element) => {
          const compact = compactV017(visibleTextV017(element));
          return compact === compactTarget || compact.includes(compactTarget);
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return (ra.width * ra.height) - (rb.width * rb.height);
        })[0] || null;
    };

    const getFieldRectNearLabelV017 = (labelText, optionText, modal) => {
      const label = findLabelV017(labelText, modal);
      if (!label) return null;
      const labelRect = label.getBoundingClientRect();
      const optionCompact = compactV017(optionText);
      const nodes = allVisibleV017('input,select,div,span,a,i,button,[role="combobox"]', modal)
        .filter((element) => !element.closest(panelSelectorV017))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = visibleTextV017(element);
          const cls = String(element.className || '');
          const role = element.getAttribute('role') || '';
          const placeholder = element.getAttribute('placeholder') || '';
          const verticalDistance = Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2));
          const looksSelect = /select|dropdown|picker|arrow|caret/i.test(cls) || role === 'combobox' || element.tagName === 'INPUT' || /请选择|请输入|推广位|美团红包|干饭吧/.test(text + placeholder) || (optionCompact && compactV017(text).includes(optionCompact));
          return { element, rect, text, verticalDistance, looksSelect };
        })
        .filter(({ rect, verticalDistance, looksSelect, text }) => {
          if (!looksSelect) return false;
          if (/新增媒体|新增推广位|复制文案|复制链接|文案素材|推广物料/.test(text)) return false;
          return (
            rect.left > labelRect.right - 12 &&
            rect.left < window.innerWidth - 80 &&
            rect.width >= 18 &&
            rect.width <= 520 &&
            rect.height >= 14 &&
            rect.height <= 76 &&
            verticalDistance <= 42
          );
        })
        .sort((a, b) => {
          // 优先选整个 select 外框，其次才是箭头 i / 内部 span。
          const score = (item) => {
            let value = 0;
            const cls = String(item.element.className || '');
            if (/select|picker|dropdown/i.test(cls)) value += 20;
            if (item.element.getAttribute('role') === 'combobox') value += 15;
            if (item.element.tagName === 'INPUT') value += 10;
            if (item.rect.width >= 120) value += 8;
            if (item.rect.height >= 28) value += 5;
            value -= item.verticalDistance / 10;
            return value;
          };
          const diff = score(b) - score(a);
          if (Math.abs(diff) > 0.01) return diff;
          return (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height);
        });

      const best = nodes[0];
      if (best) {
        // 如果命中的是输入框/箭头内部元素，向上找一个更像下拉框外壳的父级。
        let current = best.element;
        while (current && current !== modal && current.parentElement) {
          const parent = current.parentElement;
          const r = parent.getBoundingClientRect();
          const parentText = visibleTextV017(parent);
          const vdist = Math.abs((r.top + r.height / 2) - (labelRect.top + labelRect.height / 2));
          if (
            isVisibleV017(parent) &&
            r.left > labelRect.right - 20 &&
            r.width >= best.rect.width &&
            r.width <= 540 &&
            r.height >= best.rect.height &&
            r.height <= 86 &&
            vdist <= 46 &&
            !/新增媒体|新增推广位|复制文案|复制链接|文案素材|推广物料/.test(parentText)
          ) {
            current = parent;
            continue;
          }
          break;
        }
        return current.getBoundingClientRect();
      }
      return null;
    };

    const findDropdownOptionV017 = (optionText, fieldRect) => {
      const targetCompact = compactV017(optionText);
      const candidates = allVisibleV017('a,li,div,span,[role="option"],[role="menuitem"]', document)
        .filter((element) => !element.closest(panelSelectorV017))
        .map((element) => {
          const text = visibleTextV017(element);
          const compact = compactV017(text);
          const rect = element.getBoundingClientRect();
          const exact = compact === targetCompact;
          const includes = compact.includes(targetCompact) || targetCompact.includes(compact);
          const role = element.getAttribute('role') || '';
          const cls = String(element.className || '');
          const isOptionLike = role === 'option' || role === 'menuitem' || element.tagName === 'A' || element.tagName === 'LI' || /option|menu|item|dropdown|select/i.test(cls);
          const belowField = fieldRect ? rect.top >= fieldRect.top - 6 : true;
          const nearField = fieldRect ? Math.abs((rect.left + rect.width / 2) - (fieldRect.left + fieldRect.width / 2)) <= Math.max(260, fieldRect.width) : true;
          return { element, text, compact, rect, exact, includes, isOptionLike, belowField, nearField };
        })
        .filter(({ text, compact, rect, exact, includes, belowField, nearField }) => {
          if (!text || !compact) return false;
          if (!(exact || includes)) return false;
          if (!belowField || !nearField) return false;
          if (rect.width < 40 || rect.width > 620 || rect.height < 16 || rect.height > 92) return false;
          // 过滤把整页/菜单文本拼在一起的大容器。
          if (text.length > Math.max(optionText.length + 30, optionText.length * 2.4)) return false;
          return true;
        })
        .sort((a, b) => {
          if (a.exact !== b.exact) return a.exact ? -1 : 1;
          if (a.isOptionLike !== b.isOptionLike) return a.isOptionLike ? -1 : 1;
          if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
          return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
        });
      return candidates[0] || null;
    };

    const stateReadyV017 = (labelText) => {
      const text = getModalTextV017();
      if (!text) return false;
      if (labelText.includes('推广媒体')) {
        return text.includes('选择推广位') && (text.includes('请输入推广位名称') || text.includes('新增推广位') || text.includes(CONFIG.promotionPositionName));
      }
      if (labelText.includes('推广位')) {
        return text.includes('文案素材') && (text.includes('短链接') || text.includes('长链接') || text.includes('复制文案') || text.includes('推广物料'));
      }
      return false;
    };

    const waitStateV017 = async (labelText, timeout = 8000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (stateReadyV017(labelText)) return true;
        await DOM.sleep(180);
      }
      return false;
    };

    const openAndChooseV017 = async (labelText, optionText) => {
      let modal = PromotionModal.findModal();
      if (!modal) modal = await PromotionModal.waitForPromotionModal();
      const fieldRect = getFieldRectNearLabelV017(labelText, optionText, modal);
      if (!fieldRect) throw new Error(`找不到「${labelText}」右侧下拉框`);

      const clickX = fieldRect.right - Math.min(24, Math.max(12, fieldRect.width * 0.12));
      const clickY = fieldRect.top + fieldRect.height / 2;
      await clickPointV017(clickX, clickY, `${labelText} 右侧箭头区域`);
      await DOM.sleep(450);

      let option = null;
      const start = Date.now();
      while (Date.now() - start < 5200) {
        option = findDropdownOptionV017(optionText, fieldRect);
        if (option) break;
        // 有些下拉第一次点击只聚焦 input，再点一次箭头才展开。
        if (Date.now() - start > 1000 && Date.now() - start < 1600) {
          await clickPointV017(clickX, clickY, `${labelText} 右侧箭头区域二次点击`);
        }
        await DOM.sleep(180);
      }

      if (!option) {
        const visibleOptions = allVisibleV017('a,li,div,span,[role="option"]', document)
          .map((element) => visibleTextV017(element))
          .filter(Boolean)
          .filter((text) => /干饭吧|美团红包|红包|1000|1000519381|1000475357/.test(text))
          .slice(0, 12)
          .join(' / ');
        throw new Error(`找不到下拉选项：${optionText}${visibleOptions ? `（可见候选：${visibleOptions}）` : ''}`);
      }

      const r = option.rect;
      await clickPointV017(r.left + Math.min(Math.max(r.width / 2, 24), Math.max(r.width - 24, 24)), r.top + r.height / 2, `下拉选项：${optionText}`);
    };

    PromotionModal.selectDropdownByLabel = async function patchedSelectDropdownByLabelV017(labelText, optionText) {
      Logger.info(`准备选择「${labelText}」：${optionText}`);

      // 推广位如果已经出现素材区，说明已经选过了，直接进入后续素材采集。
      if (labelText.includes('推广位') && stateReadyV017(labelText)) {
        Logger.info(`「${labelText}」已进入文案素材区，继续采集`);
        return true;
      }

      await openAndChooseV017(labelText, optionText);
      const ok = await waitStateV017(labelText, labelText.includes('推广位') ? 9000 : 6500);
      if (!ok) {
        const text = getModalTextV017().slice(0, 320);
        // 媒体位允许宽松放行：后续能否找到推广位会继续验证。
        if (labelText.includes('推广媒体') && text.includes('选择推广位')) {
          Logger.warn(`「${labelText}」结果态未完全确认，但已出现推广位字段，继续执行`);
          return true;
        }
        throw new Error(`选择「${labelText}」后未进入预期结果态；当前推广面板文本：${text || '空'}`);
      }
      Logger.info(`已选择「${labelText}」：${optionText}`);
      return true;
    };

    PromotionModal.selectMaterialType = async function patchedSelectMaterialTypeV017(typeName) {
      const modal = PromotionModal.findModal() || PromotionModal.currentModal || (await PromotionModal.waitForPromotionModal());
      const targetCompact = compactV017(typeName);
      const label = allVisibleV017('label,span,div,p', modal)
        .filter((element) => {
          const text = visibleTextV017(element);
          const compact = compactV017(text);
          return compact === targetCompact || compact.includes(targetCompact);
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return (ra.width * ra.height) - (rb.width * rb.height);
        })[0] || null;
      if (!label) return false;

      const labelRect = label.getBoundingClientRect();
      const radioX = Math.max(8, labelRect.left - 22);
      const radioY = labelRect.top + labelRect.height / 2;
      const beforeText = DOM.all('textarea', modal).map((el) => el.value || '').join('\n');

      // 优先点文字左侧的圆形 radio；如果组件支持 label 点击，再补一次 label 点击。
      await clickPointV017(radioX, radioY, `素材单选：${typeName}`);
      await DOM.sleep(120);
      try {
        await DOM.clickElement(label.closest('label') || label, `素材标签：${typeName}`);
      } catch (error) {
        // ignore
      }

      // 等待 textarea / 图片区域刷新。
      const start = Date.now();
      while (Date.now() - start < 1800) {
        const currentModal = PromotionModal.findModal() || modal;
        const currentText = DOM.all('textarea', currentModal).map((el) => el.value || '').join('\n');
        const hasImage = allVisibleV017('img', currentModal).some((img) => {
          const r = img.getBoundingClientRect();
          return r.width >= 80 && r.height >= 80;
        });
        if (currentText !== beforeText || currentText.trim() || hasImage) break;
        await DOM.sleep(160);
      }
      Logger.info(`已切换素材类型：${typeName}`);
      return true;
    };

    const oldReadMaterialTextV017 = PromotionModal.readMaterialText.bind(PromotionModal);
    PromotionModal.readMaterialText = async function patchedReadMaterialTextV017() {
      const modal = PromotionModal.findModal() || PromotionModal.currentModal || (await PromotionModal.waitForPromotionModal());
      for (let attempt = 1; attempt <= Math.max(CONFIG.textareaRetry, 4); attempt += 1) {
        const textareas = allVisibleV017('textarea', modal);
        const values = textareas.map((textarea) => (textarea.value || textarea.textContent || '').trim());
        const nonEmpty = values.filter(Boolean);
        if (nonEmpty.length) {
          return {
            materialText: values[0] || '',
            pureLinkText: values[1] || '',
            copyButtonText: this.getCopyButtonText(modal)
          };
        }

        const imageUrls = allVisibleV017('img', modal)
          .filter((img) => {
            const r = img.getBoundingClientRect();
            return r.width >= 80 && r.height >= 80;
          })
          .map((img) => img.currentSrc || img.src || img.getAttribute('data-src') || '')
          .filter(Boolean)
          .filter((src) => !/logo|avatar|icon/i.test(src));
        if (imageUrls.length) {
          return {
            materialText: `图片素材：${imageUrls.join('\n')}`,
            pureLinkText: imageUrls[0] || '',
            copyButtonText: this.getCopyButtonText(modal)
          };
        }

        await DOM.sleep(500);
      }

      // 保留旧读取逻辑作为兜底。
      return oldReadMaterialTextV017();
    };

    PromotionModal.closePromotionModal = async function patchedClosePromotionModalV017() {
      const modal = PromotionModal.findModal() || PromotionModal.currentModal;
      if (!modal) return;
      const closeButton = allVisibleV017('button,a,span,i,[role="button"]', modal)
        .filter((element) => {
          const text = visibleTextV017(element);
          const aria = element.getAttribute('aria-label') || element.getAttribute('title') || '';
          return /关闭|close|×|x/i.test(text) || /关闭|close/i.test(aria);
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          // 右上角关闭按钮优先。
          return (rb.right - ra.right) || (ra.top - rb.top);
        })[0] || null;

      if (closeButton) {
        const r = closeButton.getBoundingClientRect();
        await clickPointV017(r.left + r.width / 2, r.top + r.height / 2, '关闭推广面板');
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', code: 'Escape' }));
        document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Escape', code: 'Escape' }));
      }

      const start = Date.now();
      while (Date.now() - start < 3600) {
        if (!PromotionModal.findModal()) {
          PromotionModal.currentModal = null;
          Logger.info('已关闭推广面板');
          return;
        }
        await DOM.sleep(180);
      }
      // 页面上通常已经关闭，DOM 有残留时不阻断下一行，但给出提示。
      PromotionModal.currentModal = null;
      Logger.warn('关闭推广面板后仍检测到残留 DOM，继续后续采集');
    };

    // 历史补丁日志已合并到 V1.0.0，不再单独输出。
  }

  applyMeituanCollectorV017Patch();


  /*
   * V1.0.0 可用稳定版优化：
   * 1) 默认跳过“搜索密令”，避免进入需要额外填写搜索词/有效期的审核流程。
   * 2) CSV 导出改为“一活动一行”，将短链接、长链接、呼起协议、小程序路径、二维码、团口令横向展开。
   * 3) 历史补丁日志不再输出，仅保留当前脚本版本。
   */
  function applyMeituanCollectorV100Patch() {
    CONFIG.materialTypes = ['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令'];
    CONFIG.optionalMaterialTypes = [];
    CONFIG.exportFilePrefix = 'meituan_activity_materials_v100';

    const WIDE_MATERIAL_TYPES = ['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令'];
    const WIDE_CSV_FIELDS = [
      ['material_id', '物料ID'],
      ['activity_name', '活动名称'],
      ['activity_intro', '活动介绍'],
      ['commission_info', '预估收入率'],
      ['activity_time', '活动时间'],
      ['start_date', '开始时间'],
      ['end_date', '结束时间'],
      ['banner_url', 'Banner图片'],
      ['media_name', '推广媒体'],
      ['promotion_position_name', '推广位'],
      ['short_text', '短链接-完整文案'],
      ['short_link', '短链接-链接'],
      ['short_pure_link', '短链接-纯链接'],
      ['long_text', '长链接-完整文案'],
      ['long_link', '长链接-链接'],
      ['long_pure_link', '长链接-纯链接'],
      ['scheme_text', '呼起协议-完整文案'],
      ['scheme_link', '呼起协议-链接'],
      ['mini_path_text', '小程序路径-完整内容'],
      ['mini_path_link', '小程序路径'],
      ['h5_qr_text', 'H5链接二维码-素材内容'],
      ['h5_qr_link', 'H5链接二维码-图片/链接'],
      ['mini_qr_text', '小程序二维码-素材内容'],
      ['mini_qr_link', '小程序二维码-图片/链接'],
      ['kouling_text', '团口令-完整文案'],
      ['kouling_link', '团口令-链接'],
      ['collected_material_types', '已采集素材类型'],
      ['missing_material_types', '未采集素材类型'],
      ['status_summary', '采集状态汇总'],
      ['error_message', '失败/跳过原因'],
      ['page_index', '页码'],
      ['row_index', '行号'],
      ['collected_at', '采集时间']
    ];

    const typeKeyMap = {
      '短链接': { text: 'short_text', link: 'short_link', pure: 'short_pure_link' },
      '长链接': { text: 'long_text', link: 'long_link', pure: 'long_pure_link' },
      '呼起协议': { text: 'scheme_text', link: 'scheme_link' },
      '小程序路径': { text: 'mini_path_text', link: 'mini_path_link' },
      'H5链接二维码': { text: 'h5_qr_text', link: 'h5_qr_link' },
      '小程序二维码': { text: 'mini_qr_text', link: 'mini_qr_link' },
      '团口令': { text: 'kouling_text', link: 'kouling_link' }
    };

    const preferBetterRecord = (current, next) => {
      if (!current) return next;
      const score = (record) => {
        let value = 0;
        if (record.status === 'success') value += 100;
        if (record.material_text) value += 20;
        if (record.material_link) value += 15;
        if (record.pure_link_text) value += 10;
        return value;
      };
      return score(next) >= score(current) ? next : current;
    };

    const makeWideGroupKey = (record) => [
      record.material_id || '',
      record.activity_name || '',
      record.media_name || '',
      record.promotion_position_name || ''
    ].join('::');

    const buildWideRows = (records) => {
      const groups = new Map();
      (records || [])
        .filter((record) => record && record.material_type !== '搜索密令')
        .forEach((record) => {
          const key = makeWideGroupKey(record);
          if (!groups.has(key)) {
            groups.set(key, {
              base: record,
              materials: {},
              statuses: [],
              errors: []
            });
          }
          const group = groups.get(key);
          group.base = preferBetterRecord(group.base, record);
          if (record.material_type) {
            group.materials[record.material_type] = preferBetterRecord(group.materials[record.material_type], record);
          }
          if (record.status) group.statuses.push(`${record.material_type || '未知'}:${record.status}`);
          if (record.error_message) group.errors.push(`${record.material_type || '未知'}:${record.error_message}`);
        });

      return Array.from(groups.values()).map((group) => {
        const base = group.base || {};
        const row = {
          material_id: base.material_id || '',
          activity_name: base.activity_name || '',
          activity_intro: base.activity_intro || '',
          commission_info: base.commission_info || '',
          activity_time: base.activity_time || '',
          start_date: base.start_date || '',
          end_date: base.end_date || '',
          banner_url: base.banner_url || '',
          media_name: base.media_name || CONFIG.mediaName || '',
          promotion_position_name: base.promotion_position_name || CONFIG.promotionPositionName || '',
          page_index: base.page_index || '',
          row_index: base.row_index || '',
          collected_at: base.collected_at || '',
          status_summary: uniqueText(group.statuses).join('；'),
          error_message: uniqueText(group.errors).join('；')
        };

        const collected = [];
        WIDE_MATERIAL_TYPES.forEach((typeName) => {
          const record = group.materials[typeName];
          const map = typeKeyMap[typeName];
          if (!map) return;
          if (record && record.status === 'success') collected.push(typeName);
          row[map.text] = record ? (record.material_text || '') : '';
          row[map.link] = record ? (record.material_link || record.pure_link_text || '') : '';
          if (map.pure) row[map.pure] = record ? (record.pure_link_text || '') : '';
        });
        row.collected_material_types = collected.join('、');
        row.missing_material_types = WIDE_MATERIAL_TYPES.filter((typeName) => !collected.includes(typeName)).join('、');
        return row;
      }).sort((a, b) => {
        const pageA = Number(a.page_index || 0);
        const pageB = Number(b.page_index || 0);
        if (pageA !== pageB) return pageA - pageB;
        return Number(a.row_index || 0) - Number(b.row_index || 0);
      });
    };

    function uniqueText(values) {
      return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
    }

    Exporter.exportCSV = function exportWideCSVV100() {
      const sourceRecords = (State.records || []).filter((record) => record && record.material_type !== '搜索密令');
      if (!sourceRecords.length) {
        Logger.warn('没有可导出的数据');
        return;
      }
      const wideRows = buildWideRows(sourceRecords);
      const headers = WIDE_CSV_FIELDS.map(([, label]) => label);
      const rows = wideRows.map((row) => WIDE_CSV_FIELDS.map(([field]) => csvEscape(row[field])).join(','));
      const csvContent = `\uFEFF${headers.join(',')}\n${rows.join('\n')}`;
      this.download(csvContent, `${CONFIG.exportFilePrefix}_${timestampForFile()}_one_row_per_activity.csv`, 'text/csv;charset=utf-8');
      Logger.info(`已导出 CSV：${wideRows.length} 个活动，${sourceRecords.length} 条素材记录已横向合并`);
    };

    Exporter.exportJSON = function exportWideJSONV100() {
      const sourceRecords = (State.records || []).filter((record) => record && record.material_type !== '搜索密令');
      if (!sourceRecords.length) {
        Logger.warn('没有可导出的数据');
        return;
      }
      const wideRows = buildWideRows(sourceRecords);
      this.download(JSON.stringify(wideRows, null, 2), `${CONFIG.exportFilePrefix}_${timestampForFile()}_one_row_per_activity.json`, 'application/json;charset=utf-8');
      Logger.info(`已导出 JSON：${wideRows.length} 个活动，已横向合并素材字段`);
    };
  }

  applyMeituanCollectorV100Patch();


  /*
   * V1.0.1 可用稳定版优化：
   * 1) 遇到当前活动不可用/置灰的文案素材选项时，直接 skipped，不再等待 textarea 重试。
   * 2) 继续默认跳过“搜索密令”。
   * 3) 保持“一活动一行”的 CSV / JSON 导出格式。
   */
  function applyMeituanCollectorV101Patch() {
    CONFIG.materialTypes = ['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令'];
    CONFIG.optionalMaterialTypes = [];
    CONFIG.exportFilePrefix = 'meituan_activity_materials_v101';

    const panelSelector = '#mtamc-panel';

    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const compact = (value) => normalize(value).replace(/[\s>*：:，,。；;｜|]/g, '');

    const isVisible = (element) => {
      if (!element || element.nodeType !== 1) return false;
      if (element.closest && element.closest(panelSelector)) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    };

    const visibleText = (element) => {
      if (!element) return '';
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
        return normalize(element.value || element.getAttribute('placeholder') || element.textContent || '');
      }
      return normalize(element.innerText || element.textContent || element.getAttribute('title') || element.getAttribute('aria-label') || '');
    };

    const allVisible = (selector, root = document) => DOM.all(selector, root).filter(isVisible);

    const parseRGB = (color) => {
      const match = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!match) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };

    const isDisabledByColor = (element) => {
      const rgb = parseRGB(window.getComputedStyle(element).color);
      if (!rgb) return false;
      const [r, g, b] = rgb;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      // 美团后台置灰文案通常为浅灰色；正常可选文案接近黑色。
      return min >= 155 && max - min <= 55;
    };

    const getPromotionDrawer = () => {
      const candidates = allVisible('aside,section,div,[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]', document)
        .filter((element) => {
          if (element.id === 'mtamc-panel' || element.closest(panelSelector)) return false;
          const rect = element.getBoundingClientRect();
          const text = visibleText(element);
          if (!text.includes('选择推广媒体')) return false;
          if (!(text.includes('立即推广') || text.includes('选择推广位') || text.includes('新增媒体'))) return false;
          if (rect.width > window.innerWidth * 0.86 && rect.left < 80) return false;
          if (rect.right < window.innerWidth * 0.46) return false;
          if (rect.width < 320 || rect.height < 140) return false;
          return true;
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          if (Math.abs(rb.left - ra.left) > 20) return rb.left - ra.left;
          return (ra.width * ra.height) - (rb.width * rb.height);
        });
      return candidates[0] || PromotionModal.findModal() || PromotionModal.currentModal || null;
    };

    const getMaterialLabels = (modal) => {
      return allVisible('label,span,div,p', modal)
        .map((element) => {
          const text = visibleText(element);
          const rect = element.getBoundingClientRect();
          return { element, text, compactText: compact(text), rect };
        })
        .filter((item) => item.text && item.rect.width > 8 && item.rect.height > 8)
        .filter((item) => CONFIG.materialTypes.some((typeName) => item.compactText === compact(typeName)))
        .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
    };

    const findMaterialLabel = (typeName, modal) => {
      const target = compact(typeName);
      return getMaterialLabels(modal).filter((item) => item.compactText === target)[0] || null;
    };

    const findNearbyRadio = (labelItem, modal) => {
      if (!labelItem) return null;
      const labelRect = labelItem.rect;
      const candidates = allVisible('input[type="radio"],[role="radio"],span,div,i', modal)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const cls = String(element.className || '');
          const role = element.getAttribute('role') || '';
          const tag = element.tagName;
          const centerY = rect.top + rect.height / 2;
          const labelY = labelRect.top + labelRect.height / 2;
          const distanceY = Math.abs(centerY - labelY);
          const isRadioLike = tag === 'INPUT' || role === 'radio' || /radio|checkbox|circle/i.test(cls) || (rect.width >= 12 && rect.width <= 36 && rect.height >= 12 && rect.height <= 36);
          const isLeftNear = rect.right <= labelRect.left + 10 && rect.right >= labelRect.left - 80;
          return { element, rect, distanceY, isRadioLike, isLeftNear, cls, role, tag };
        })
        .filter((item) => item.isRadioLike && item.isLeftNear && item.distanceY <= 18)
        .sort((a, b) => {
          if (a.tag === 'INPUT' && b.tag !== 'INPUT') return -1;
          if (b.tag === 'INPUT' && a.tag !== 'INPUT') return 1;
          return a.distanceY - b.distanceY;
        });
      return candidates[0] || null;
    };

    const isDisabledMaterial = (labelItem, modal) => {
      if (!labelItem) return true;
      const element = labelItem.element;
      const nearbyRadio = findNearbyRadio(labelItem, modal);
      const related = [element, element.closest('label'), element.parentElement, nearbyRadio && nearbyRadio.element].filter(Boolean);
      if (related.some((node) => node.matches && node.matches('[disabled],[aria-disabled="true"],.disabled,[class*="disabled"],[class*="Disabled"]'))) return true;
      if (related.some((node) => node.closest && node.closest('[disabled],[aria-disabled="true"],.disabled,[class*="disabled"],[class*="Disabled"]'))) return true;
      if (nearbyRadio && nearbyRadio.element) {
        if (nearbyRadio.element.disabled || nearbyRadio.element.getAttribute('aria-disabled') === 'true') return true;
      }
      // 文案文字本身置灰，基本代表当前活动不支持该素材类型。
      if (isDisabledByColor(element)) return true;
      return false;
    };

    const getMaterialContentSnapshot = (modal) => {
      const text = allVisible('textarea,[contenteditable="true"]', modal)
        .map((element) => element.tagName === 'TEXTAREA' ? (element.value || element.textContent || '').trim() : visibleText(element))
        .filter(Boolean)
        .join('\n');
      const images = allVisible('img', modal)
        .filter((img) => {
          const rect = img.getBoundingClientRect();
          return rect.width >= 80 && rect.height >= 80;
        })
        .map((img) => img.currentSrc || img.src || img.getAttribute('data-src') || '')
        .filter(Boolean)
        .filter((src) => !/logo|avatar|icon/i.test(src))
        .join('\n');
      return [text, images].filter(Boolean).join('\n');
    };

    const clickMaterialLabel = async (labelItem, modal, typeName) => {
      const radio = findNearbyRadio(labelItem, modal);
      let x;
      let y;
      if (radio) {
        x = radio.rect.left + radio.rect.width / 2;
        y = radio.rect.top + radio.rect.height / 2;
      } else {
        x = Math.max(8, labelItem.rect.left - 22);
        y = labelItem.rect.top + labelItem.rect.height / 2;
      }

      const safeX = Math.max(4, Math.min(window.innerWidth - 4, Math.round(x)));
      const safeY = Math.max(4, Math.min(window.innerHeight - 4, Math.round(y)));
      const target = document.elementFromPoint(safeX, safeY) || labelItem.element;
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: safeX,
        clientY: safeY
      };
      Logger.info(`点击素材：${typeName} x=${safeX}, y=${safeY}, 命中=${target.tagName} ${visibleText(target).slice(0, 40)}`);
      const targets = uniqueElements([target, target.parentElement, target.closest && target.closest('label,[role="radio"],input,span,div')].filter(Boolean));
      for (const node of targets) {
        try {
          if (window.PointerEvent) {
            node.dispatchEvent(new PointerEvent('pointerover', eventOptions));
            node.dispatchEvent(new PointerEvent('pointerenter', eventOptions));
            node.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
            node.dispatchEvent(new PointerEvent('pointerup', eventOptions));
          }
          node.dispatchEvent(new MouseEvent('mouseover', eventOptions));
          node.dispatchEvent(new MouseEvent('mouseenter', eventOptions));
          node.dispatchEvent(new MouseEvent('mousedown', eventOptions));
          node.dispatchEvent(new MouseEvent('mouseup', eventOptions));
          node.dispatchEvent(new MouseEvent('click', eventOptions));
          if (typeof node.click === 'function') node.click();
        } catch (error) {
          // ignore
        }
      }
      await DOM.sleep(160);
      try {
        const clickTarget = labelItem.element.closest('label') || labelItem.element;
        await DOM.clickElement(clickTarget, `素材标签：${typeName}`);
      } catch (error) {
        // ignore
      }
    };

    PromotionModal.selectMaterialType = async function patchedSelectMaterialTypeV101(typeName) {
      if (typeName === '搜索密令') return false;
      const modal = getPromotionDrawer() || PromotionModal.currentModal || (await PromotionModal.waitForPromotionModal());
      const labelItem = findMaterialLabel(typeName, modal);
      if (!labelItem) {
        Logger.warn(`当前活动未展示素材类型，跳过：${typeName}`);
        return false;
      }
      if (isDisabledMaterial(labelItem, modal)) {
        Logger.info(`当前活动不支持素材类型，跳过：${typeName}`);
        return false;
      }

      const before = getMaterialContentSnapshot(modal);
      await clickMaterialLabel(labelItem, modal, typeName);

      const start = Date.now();
      while (Date.now() - start < 2600) {
        const currentModal = getPromotionDrawer() || modal;
        const after = getMaterialContentSnapshot(currentModal);
        if (after && after !== before) break;
        await DOM.sleep(180);
      }
      Logger.info(`已切换素材类型：${typeName}`);
      return true;
    };

    const oldCollectMaterialType = Collector.collectMaterialType.bind(Collector);
    Collector.collectMaterialType = async function collectMaterialTypeV101(base, typeName) {
      if (typeName === '搜索密令') {
        Logger.info('搜索密令需要额外填写审核信息，已跳过');
        return;
      }
      return oldCollectMaterialType(base, typeName);
    };
  }

  applyMeituanCollectorV101Patch();


  function applyMeituanCollectorV102Patch() {
    CONFIG.version = 'V1.0.2';

    const normalizeV102 = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visibleTextV102 = (element) => normalizeV102(element ? element.innerText || element.textContent || '' : '');
    const isVisibleV102 = (element) => {
      if (!element || element.nodeType !== 1) return false;
      if (element.closest && element.closest('#mtamc-panel')) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const allVisibleV102 = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(isVisibleV102);
    const compactV102 = (value) => normalizeV102(value).replace(/\s+/g, '').replace(/[：:，,。；;]/g, '');

    const getPromotionDrawerV102 = () => {
      const candidates = Array.from(document.querySelectorAll('aside,section,div,[role="dialog"],[class*="drawer"],[class*="modal"]'))
        .filter(isVisibleV102)
        .filter((element) => {
          const text = visibleTextV102(element);
          const rect = element.getBoundingClientRect();
          if (element.closest && element.closest('#mtamc-panel')) return false;
          return (
            text.includes('立即推广') &&
            text.includes('选择推广媒体') &&
            rect.width >= 420 &&
            rect.height >= 260 &&
            rect.left > window.innerWidth * 0.35 &&
            rect.right > window.innerWidth * 0.8
          );
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const areaA = ar.width * ar.height;
          const areaB = br.width * br.height;
          return areaA - areaB;
        });
      return candidates[0] || null;
    };

    const getMaterialLabelsV102 = (modal) => {
      if (!modal) return [];
      const allowed = CONFIG.materialTypes.filter((type) => type !== '搜索密令');
      return allVisibleV102('label,span,div,p', modal)
        .map((element) => ({ element, text: visibleTextV102(element), rect: element.getBoundingClientRect() }))
        .filter((item) => allowed.includes(item.text))
        .filter((item) => item.rect.width > 8 && item.rect.height > 8 && item.text.length <= 12)
        .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
    };

    const findMaterialLabelV102 = (typeName, modal) => {
      const target = compactV102(typeName);
      return getMaterialLabelsV102(modal).find((item) => compactV102(item.text) === target) || null;
    };

    const isGreyTextV102 = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const match = String(style.color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
      if (!match) return false;
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      const a = match[4] === undefined ? 1 : Number(match[4]);
      return a < 0.75 || (Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && r >= 150 && g >= 150 && b >= 150);
    };

    const findNearbyRadioV102 = (labelItem, modal) => {
      if (!labelItem || !modal) return null;
      const labelRect = labelItem.rect;
      const labelY = labelRect.top + labelRect.height / 2;
      const candidates = allVisibleV102('input[type="radio"],[role="radio"],span,div,i', modal)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const cls = String(element.className || '');
          const role = element.getAttribute('role') || '';
          const tag = element.tagName;
          const centerY = rect.top + rect.height / 2;
          const radioLike =
            tag === 'INPUT' ||
            role === 'radio' ||
            /radio|circle|checkbox/i.test(cls) ||
            (rect.width >= 12 && rect.width <= 34 && rect.height >= 12 && rect.height <= 34 && !visibleTextV102(element));
          const leftNear = rect.right <= labelRect.left + 12 && rect.right >= labelRect.left - 90;
          return { element, rect, tag, role, cls, distanceY: Math.abs(centerY - labelY), radioLike, leftNear };
        })
        .filter((item) => item.radioLike && item.leftNear && item.distanceY <= 20)
        .sort((a, b) => {
          if (a.tag === 'INPUT' && b.tag !== 'INPUT') return -1;
          if (b.tag === 'INPUT' && a.tag !== 'INPUT') return 1;
          return a.distanceY - b.distanceY;
        });
      return candidates[0] || null;
    };

    const materialIsDisabledV102 = (labelItem, modal) => {
      if (!labelItem) return true;
      if (labelItem.text === '搜索密令') return true;
      const radio = findNearbyRadioV102(labelItem, modal);
      const nodes = [labelItem.element, labelItem.element.closest('label'), labelItem.element.parentElement, radio && radio.element].filter(Boolean);
      if (nodes.some((node) => node.disabled || node.getAttribute('aria-disabled') === 'true')) return true;
      if (nodes.some((node) => node.matches && node.matches('[disabled],[aria-disabled="true"],.disabled,[class*="disabled"],[class*="Disabled"]'))) return true;
      if (nodes.some((node) => node.closest && node.closest('[disabled],[aria-disabled="true"],.disabled,[class*="disabled"],[class*="Disabled"]'))) return true;
      if (isGreyTextV102(labelItem.element)) return true;
      return false;
    };

    const materialSnapshotV102 = (modal) => {
      if (!modal) return '';
      const textareas = allVisibleV102('textarea', modal)
        .map((element) => (element.value || element.textContent || '').trim())
        .filter(Boolean)
        .join('\n');
      const editables = allVisibleV102('[contenteditable="true"]', modal)
        .map((element) => visibleTextV102(element))
        .filter(Boolean)
        .join('\n');
      const images = allVisibleV102('img', modal)
        .filter((img) => {
          const rect = img.getBoundingClientRect();
          return rect.width >= 80 && rect.height >= 80;
        })
        .map((img) => img.currentSrc || img.src || img.getAttribute('data-src') || '')
        .filter(Boolean)
        .filter((src) => !/logo|avatar|icon/i.test(src))
        .join('\n');
      return [textareas, editables, images].filter(Boolean).join('\n');
    };

    const clickAtV102 = async (x, y, reason) => {
      const safeX = Math.max(4, Math.min(window.innerWidth - 4, Math.round(x)));
      const safeY = Math.max(4, Math.min(window.innerHeight - 4, Math.round(y)));
      const target = document.elementFromPoint(safeX, safeY);
      if (!target) throw new Error(`${reason} 点击坐标无命中元素`);
      const eventOptions = { bubbles: true, cancelable: true, composed: true, view: window, clientX: safeX, clientY: safeY };
      Logger.info(`点击素材：${reason} x=${safeX}, y=${safeY}, 命中=${target.tagName} ${visibleTextV102(target).slice(0, 30)}`);
      if (window.PointerEvent) {
        target.dispatchEvent(new PointerEvent('pointerover', eventOptions));
        target.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
        await DOM.sleep(60);
        target.dispatchEvent(new PointerEvent('pointerup', eventOptions));
      }
      target.dispatchEvent(new MouseEvent('mouseover', eventOptions));
      target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      await DOM.sleep(60);
      target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      target.dispatchEvent(new MouseEvent('click', eventOptions));
      await DOM.sleep(220);
    };

    const clickMaterialSafelyV102 = async (labelItem, modal, typeName) => {
      const radio = findNearbyRadioV102(labelItem, modal);
      if (radio) {
        await clickAtV102(radio.rect.left + radio.rect.width / 2, radio.rect.top + radio.rect.height / 2, typeName);
        return;
      }
      const label = labelItem.element.closest('label') || labelItem.element;
      try {
        label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        label.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        if (typeof label.click === 'function') label.click();
        Logger.info(`点击素材标签：${typeName}`);
      } catch (error) {
        await clickAtV102(labelItem.rect.left + 8, labelItem.rect.top + labelItem.rect.height / 2, typeName);
      }
      await DOM.sleep(220);
    };

    const waitMaterialContentV102 = async (typeName, timeout = 6500) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const modal = getPromotionDrawerV102();
        if (!modal) return { modalClosed: true, materialText: '', pureLinkText: '', imageText: '' };
        const textareas = allVisibleV102('textarea', modal).map((element) => (element.value || element.textContent || '').trim());
        const nonEmptyTextareas = textareas.filter(Boolean);
        if (nonEmptyTextareas.length) {
          return {
            modalClosed: false,
            materialText: nonEmptyTextareas[0] || '',
            pureLinkText: nonEmptyTextareas[1] || '',
            imageText: ''
          };
        }
        const images = allVisibleV102('img', modal)
          .filter((img) => {
            const rect = img.getBoundingClientRect();
            return rect.width >= 100 && rect.height >= 100;
          })
          .map((img) => img.currentSrc || img.src || img.getAttribute('data-src') || '')
          .filter(Boolean)
          .filter((src) => !/logo|avatar|icon/i.test(src));
        if (images.length) {
          return { modalClosed: false, materialText: images[0], pureLinkText: images.join('\n'), imageText: images.join('\n') };
        }
        await DOM.sleep(220);
      }
      return { modalClosed: false, materialText: '', pureLinkText: '', imageText: '' };
    };

    const ensurePromotionReadyV102 = async (collector, row) => {
      let modal = getPromotionDrawerV102();
      if (!modal) {
        await collector.openModalWithRetry(row);
        modal = getPromotionDrawerV102() || PromotionModal.currentModal;
      }
      await PromotionModal.selectDropdownByLabel('选择推广媒体', CONFIG.mediaName, {
        preferLast: CONFIG.mediaOptionPreferLast,
        fuzzy: true
      });
      await PromotionModal.selectDropdownByLabel('选择推广位', CONFIG.promotionPositionName);
      await DOM.waitFor(() => {
        const drawer = getPromotionDrawerV102();
        if (!drawer) return null;
        const text = visibleTextV102(drawer);
        return text.includes('文案素材') ? drawer : null;
      }, 8000, 250);
      PromotionModal.currentModal = getPromotionDrawerV102() || PromotionModal.currentModal;
    };

    PromotionModal.selectMaterialType = async function selectMaterialTypeV102(typeName) {
      if (typeName === '搜索密令') return false;
      const modal = getPromotionDrawerV102() || PromotionModal.currentModal || (await PromotionModal.waitForPromotionModal());
      const labelItem = findMaterialLabelV102(typeName, modal);
      if (!labelItem) {
        Logger.info(`当前活动未展示素材类型，跳过：${typeName}`);
        return false;
      }
      if (materialIsDisabledV102(labelItem, modal)) {
        Logger.info(`当前活动不支持素材类型，跳过：${typeName}`);
        return false;
      }
      await clickMaterialSafelyV102(labelItem, modal, typeName);
      await DOM.sleep(380);
      if (!getPromotionDrawerV102()) {
        throw new Error(`推广面板在点击「${typeName}」后意外关闭`);
      }
      Logger.info(`已切换素材类型：${typeName}`);
      return true;
    };

    Collector.collectMaterialType = async function collectMaterialTypeV102(base, typeName) {
      const now = new Date().toISOString();
      if (typeName === '搜索密令') {
        Logger.info('搜索密令需要额外填写审核信息，已跳过');
        return 'skipped';
      }
      try {
        const exists = await PromotionModal.selectMaterialType(typeName);
        if (!exists) {
          Storage.upsertRecord(this.buildRecord(base, typeName, 'skipped', '', '', '', '', `当前活动不支持或未展示素材类型：${typeName}`, now));
          return 'skipped';
        }
        const content = await waitMaterialContentV102(typeName, 6800);
        if (content.modalClosed) {
          Storage.upsertRecord(this.buildRecord(base, typeName, 'failed', '', '', '', '', '推广面板意外关闭，等待重试', now));
          return 'modal_closed';
        }
        const combinedText = [content.materialText, content.pureLinkText, content.imageText].filter(Boolean).join('\n');
        const links = extractLinks(combinedText);
        const status = combinedText ? 'success' : 'failed';
        const record = this.buildRecord(
          base,
          typeName,
          status,
          content.materialText || content.imageText || '',
          links[0] || '',
          content.pureLinkText || content.imageText || '',
          '',
          status === 'success' ? '' : '素材内容为空或生成超时',
          now
        );
        record.links = links;
        if (content.imageText) record.image_urls = content.imageText.split('\n').filter(Boolean);
        Storage.upsertRecord(record);
        Logger.info(`${typeName} 采集${status === 'success' ? '成功' : '失败'}：${base.activity_name || base.material_id}`);
        return status;
      } catch (error) {
        const message = error.message || String(error);
        Storage.upsertRecord(this.buildRecord(base, typeName, 'failed', '', '', '', '', message, now));
        Logger.error(`${typeName} 采集失败：${message}`);
        if (/意外关闭|未打开|找不到推广面板/.test(message)) return 'modal_closed';
        return 'failed';
      }
    };

    Collector.processRow = async function processRowV102(row, base) {
      Logger.info(`处理第 ${base.row_index} 行：${base.activity_name || base.material_id || '未知活动'}`);
      const needTypes = CONFIG.materialTypes.filter((type) => type !== '搜索密令' && !Storage.hasSuccess(base, type));
      if (!needTypes.length) {
        Logger.info(`第 ${base.row_index} 行已存在成功缓存，跳过`);
        return;
      }

      try {
        await ensurePromotionReadyV102(this, row);
        for (const typeName of CONFIG.materialTypes) {
          if (typeName === '搜索密令') continue;
          await this.waitIfPaused();
          if (State.stopped) break;
          if (Storage.hasSuccess(base, typeName)) {
            Logger.info(`已采集过 ${base.material_id} / ${typeName}，跳过`);
            continue;
          }

          let result = await this.collectMaterialType(base, typeName);
          if (result === 'modal_closed') {
            Logger.warn(`第 ${base.row_index} 行采集「${typeName}」时推广面板关闭，重新打开后重试一次`);
            await DOM.sleep(900);
            await ensurePromotionReadyV102(this, row);
            result = await this.collectMaterialType(base, typeName);
          }
        }
      } catch (error) {
        Logger.error(`第 ${base.row_index} 行失败：${error.message || error}`);
        this.saveFailureForTypes(base, needTypes, error.message || String(error));
      } finally {
        try {
          if (getPromotionDrawerV102()) await PromotionModal.closePromotionModal();
        } catch (closeError) {
          Logger.warn(`关闭推广面板失败：${closeError.message || closeError}`);
        }
      }
    };
  }

  applyMeituanCollectorV102Patch();


  function applyMeituanCollectorV103Patch() {
    CONFIG.version = 'V1.0.3';
    CONFIG.materialTypes = ['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令'];
    CONFIG.delay.materialSwitch = Math.max(CONFIG.delay.materialSwitch || 1000, 1200);

    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const compact = (value) => normalize(value).replace(/\s+/g, '').replace(/[：:，,。；;]/g, '');
    const panelSelector = '#mtamc-panel';

    const isVisible = (element) => {
      if (!element || element.nodeType !== 1) return false;
      if (element.closest && element.closest(panelSelector)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };

    const allVisible = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(isVisible);
    const visibleText = (element) => normalize(element ? element.innerText || element.textContent || '' : '');

    const getPromotionDrawer = () => {
      const candidates = Array.from(document.querySelectorAll('aside,section,div,[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]'))
        .filter(isVisible)
        .filter((element) => {
          if (element.closest && element.closest(panelSelector)) return false;
          const text = visibleText(element);
          const rect = element.getBoundingClientRect();
          return (
            text.includes('立即推广') &&
            text.includes('选择推广媒体') &&
            text.includes('选择推广位') &&
            rect.width >= 420 &&
            rect.height >= 260 &&
            rect.left > window.innerWidth * 0.32 &&
            rect.right > window.innerWidth * 0.78
          );
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (ar.width * ar.height) - (br.width * br.height);
        });
      return candidates[0] || null;
    };

    const getMaterialLabels = (modal) => {
      if (!modal) return [];
      const allowed = CONFIG.materialTypes.filter((type) => type !== '搜索密令');
      return allVisible('label,span,div,p', modal)
        .map((element) => ({ element, text: visibleText(element), rect: element.getBoundingClientRect() }))
        .filter((item) => allowed.some((typeName) => compact(typeName) === compact(item.text)))
        .filter((item) => item.rect.width > 8 && item.rect.height > 8 && item.text.length <= 16)
        .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
    };

    const findMaterialLabel = (typeName, modal) => {
      const target = compact(typeName);
      return getMaterialLabels(modal).find((item) => compact(item.text) === target) || null;
    };

    const parseRGB = (color) => {
      const match = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
      if (!match) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
    };

    const isGreyText = (element) => {
      if (!element) return false;
      const rgb = parseRGB(window.getComputedStyle(element).color);
      if (!rgb) return false;
      const [r, g, b, a] = rgb;
      return a < 0.72 || (Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r >= 145 && g >= 145 && b >= 145);
    };

    const findNearbyRadio = (labelItem, modal) => {
      if (!labelItem || !modal) return null;
      const labelRect = labelItem.rect;
      const labelY = labelRect.top + labelRect.height / 2;
      const candidates = allVisible('input[type="radio"],[role="radio"],span,div,i', modal)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const cls = String(element.className || '');
          const role = element.getAttribute('role') || '';
          const tag = element.tagName;
          const text = visibleText(element);
          const radioLike =
            tag === 'INPUT' ||
            role === 'radio' ||
            /radio|circle|checkbox/i.test(cls) ||
            (rect.width >= 12 && rect.width <= 34 && rect.height >= 12 && rect.height <= 34 && !text);
          const leftNear = rect.right <= labelRect.left + 16 && rect.right >= labelRect.left - 96;
          return { element, rect, tag, role, cls, distanceY: Math.abs((rect.top + rect.height / 2) - labelY), radioLike, leftNear };
        })
        .filter((item) => item.radioLike && item.leftNear && item.distanceY <= 22)
        .sort((a, b) => {
          if (a.tag === 'INPUT' && b.tag !== 'INPUT') return -1;
          if (b.tag === 'INPUT' && a.tag !== 'INPUT') return 1;
          return a.distanceY - b.distanceY;
        });
      return candidates[0] || null;
    };

    const materialIsDisabled = (labelItem, modal) => {
      if (!labelItem || labelItem.text === '搜索密令') return true;
      const radio = findNearbyRadio(labelItem, modal);
      const nodes = [labelItem.element, labelItem.element.closest('label'), labelItem.element.parentElement, radio && radio.element].filter(Boolean);
      if (nodes.some((node) => node.disabled || node.getAttribute('aria-disabled') === 'true')) return true;
      if (nodes.some((node) => node.matches && node.matches('[disabled],[aria-disabled="true"],.disabled,[class*="disabled"],[class*="Disabled"]'))) return true;
      if (nodes.some((node) => node.closest && node.closest('[disabled],[aria-disabled="true"],.disabled,[class*="disabled"],[class*="Disabled"]'))) return true;
      if (isGreyText(labelItem.element)) return true;
      return false;
    };

    const getMaterialContent = (modal) => {
      if (!modal) return { textareas: [], imageUrls: [], content: '' };
      const textareas = allVisible('textarea', modal)
        .map((element) => (element.value || element.textContent || '').trim())
        .filter(Boolean);
      const editables = allVisible('[contenteditable="true"]', modal)
        .map((element) => visibleText(element))
        .filter(Boolean);
      const imageUrls = allVisible('img', modal)
        .filter((img) => {
          const rect = img.getBoundingClientRect();
          return rect.width >= 100 && rect.height >= 100;
        })
        .map((img) => img.currentSrc || img.src || img.getAttribute('data-src') || '')
        .filter(Boolean)
        .filter((src) => !/logo|avatar|icon/i.test(src));
      const content = [textareas.join('\n'), editables.join('\n'), imageUrls.join('\n')].filter(Boolean).join('\n').trim();
      return { textareas, imageUrls, content };
    };

    const expectedContent = (typeName, contentInfo) => {
      const content = contentInfo.content || '';
      if (!content) return false;
      if (typeName === '短链接') return /dpurl\.cn|https?:\/\//i.test(content);
      if (typeName === '长链接') return /https?:\/\//i.test(content);
      if (typeName === '呼起协议') return /\b(?:imeituan|meituan|dianping|mt|meituanwaimai):\/\//i.test(content) || /inner_url=/i.test(content);
      if (typeName === '小程序路径') return /pages\//i.test(content) || /appid|gh_|path=|miniProgram|小程序/i.test(content) || /https?:\/\//i.test(content) || /\b(?:imeituan|meituan|dianping|mt):\/\//i.test(content);
      if (typeName === 'H5链接二维码' || typeName === '小程序二维码') return contentInfo.imageUrls.length > 0 || /https?:\/\//i.test(content);
      if (typeName === '团口令') return contentInfo.imageUrls.length > 0 || /团|口令|复制|https?:\/\//i.test(content);
      return Boolean(content);
    };

    const clickAt = async (x, y, reason) => {
      const safeX = Math.max(4, Math.min(window.innerWidth - 4, Math.round(x)));
      const safeY = Math.max(4, Math.min(window.innerHeight - 4, Math.round(y)));
      const target = document.elementFromPoint(safeX, safeY);
      if (!target) throw new Error(`${reason} 点击坐标无命中元素`);
      const eventOptions = { bubbles: true, cancelable: true, composed: true, view: window, clientX: safeX, clientY: safeY };
      Logger.info(`点击素材：${reason} x=${safeX}, y=${safeY}, 命中=${target.tagName} ${visibleText(target).slice(0, 30)}`);
      if (window.PointerEvent) {
        target.dispatchEvent(new PointerEvent('pointerover', eventOptions));
        target.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
        await DOM.sleep(80);
        target.dispatchEvent(new PointerEvent('pointerup', eventOptions));
      }
      target.dispatchEvent(new MouseEvent('mouseover', eventOptions));
      target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      await DOM.sleep(80);
      target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      target.dispatchEvent(new MouseEvent('click', eventOptions));
      await DOM.sleep(260);
    };

    const clickMaterialOnce = async (labelItem, modal, typeName) => {
      const radio = findNearbyRadio(labelItem, modal);
      if (radio) {
        await clickAt(radio.rect.left + radio.rect.width / 2, radio.rect.top + radio.rect.height / 2, typeName);
        return;
      }
      const label = labelItem.element.closest('label') || labelItem.element;
      label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, view: window }));
      await DOM.sleep(60);
      label.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, view: window }));
      label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
      Logger.info(`点击素材标签：${typeName}`);
      await DOM.sleep(260);
    };

    const waitFreshMaterialContent = async (typeName, beforeContent, timeout = 12000) => {
      const before = normalize(beforeContent || '');
      const start = Date.now();
      let last = null;
      while (Date.now() - start < timeout) {
        const modal = getPromotionDrawer();
        if (!modal) return { modalClosed: true, stale: false, materialText: '', pureLinkText: '', imageText: '', content: '' };
        const current = getMaterialContent(modal);
        last = current;
        const now = normalize(current.content);
        const changed = now && now !== before;
        const firstContent = now && !before;
        if ((changed || firstContent) && expectedContent(typeName, current)) {
          return {
            modalClosed: false,
            stale: false,
            materialText: current.textareas[0] || current.imageUrls[0] || current.content || '',
            pureLinkText: current.textareas[1] || current.imageUrls.join('\n') || '',
            imageText: current.imageUrls.join('\n'),
            content: current.content
          };
        }
        await DOM.sleep(260);
      }
      const now = normalize(last && last.content);
      return {
        modalClosed: false,
        stale: Boolean(now && before && now === before),
        materialText: last ? (last.textareas[0] || last.imageUrls[0] || last.content || '') : '',
        pureLinkText: last ? (last.textareas[1] || last.imageUrls.join('\n') || '') : '',
        imageText: last ? last.imageUrls.join('\n') : '',
        content: last ? last.content : ''
      };
    };

    PromotionModal.selectMaterialType = async function selectMaterialTypeV103(typeName) {
      if (typeName === '搜索密令') return false;
      const modal = getPromotionDrawer() || PromotionModal.currentModal || (await PromotionModal.waitForPromotionModal());
      const labelItem = findMaterialLabel(typeName, modal);
      if (!labelItem) {
        Logger.info(`当前活动未展示素材类型，跳过：${typeName}`);
        return false;
      }
      if (materialIsDisabled(labelItem, modal)) {
        Logger.info(`当前活动不支持素材类型，跳过：${typeName}`);
        return false;
      }
      await clickMaterialOnce(labelItem, modal, typeName);
      if (!getPromotionDrawer()) {
        throw new Error(`推广面板在点击「${typeName}」后意外关闭`);
      }
      Logger.info(`已切换素材类型：${typeName}`);
      return true;
    };

    Collector.collectMaterialType = async function collectMaterialTypeV103(base, typeName) {
      const now = new Date().toISOString();
      if (typeName === '搜索密令') {
        Logger.info('搜索密令需要额外填写审核信息，已跳过');
        return 'skipped';
      }
      try {
        const modal = getPromotionDrawer() || PromotionModal.currentModal || (await PromotionModal.waitForPromotionModal());
        const before = getMaterialContent(modal).content;
        const exists = await PromotionModal.selectMaterialType(typeName);
        if (!exists) {
          Storage.upsertRecord(this.buildRecord(base, typeName, 'skipped', '', '', '', '', `当前活动不支持或未展示素材类型：${typeName}`, now));
          return 'skipped';
        }
        const content = await waitFreshMaterialContent(typeName, before, 12000);
        if (content.modalClosed) {
          Storage.upsertRecord(this.buildRecord(base, typeName, 'failed', '', '', '', '', '推广面板意外关闭，等待重试', now));
          return 'modal_closed';
        }
        if (content.stale) {
          const staleMessage = `素材内容未更新，疑似仍为上一个素材内容：${typeName}`;
          Storage.upsertRecord(this.buildRecord(base, typeName, 'failed', '', '', '', '', staleMessage, now));
          Logger.warn(staleMessage);
          return 'failed';
        }
        const combinedText = [content.materialText, content.pureLinkText, content.imageText].filter(Boolean).join('\n');
        const links = extractLinks(combinedText);
        const status = combinedText ? 'success' : 'failed';
        const record = this.buildRecord(
          base,
          typeName,
          status,
          content.materialText || content.imageText || '',
          links[0] || '',
          content.pureLinkText || content.imageText || '',
          '',
          status === 'success' ? '' : '素材内容为空或生成超时',
          now
        );
        record.links = links;
        if (content.imageText) record.image_urls = content.imageText.split('\n').filter(Boolean);
        Storage.upsertRecord(record);
        Logger.info(`${typeName} 采集${status === 'success' ? '成功' : '失败'}：${base.activity_name || base.material_id}`);
        return status;
      } catch (error) {
        const message = error.message || String(error);
        Storage.upsertRecord(this.buildRecord(base, typeName, 'failed', '', '', '', '', message, now));
        Logger.error(`${typeName} 采集失败：${message}`);
        if (/意外关闭|未打开|找不到推广面板/.test(message)) return 'modal_closed';
        return 'failed';
      }
    };

    const oldProcessRow = Collector.processRow.bind(Collector);
    Collector.processRow = async function processRowV103(row, base) {
      try {
        return await oldProcessRow(row, base);
      } finally {
        // 当前补丁只覆盖素材采集等待逻辑，行级流程继续复用 V1.0.2 的稳定打开/重试逻辑。
      }
    };
  }

  applyMeituanCollectorV103Patch();


  /**
   * V1.0.4 修复：
   * 1) 严格按“文字左侧最近圆点”匹配素材单选框，避免小程序二维码误点到 H5 二维码。
   * 2) 点击素材后校验选中态；未选中时换用文字/label 轻量点击重试。
   * 3) 点击后不再直接记录“已切换”，必须确认选中或内容变化后再继续。
   */
  function applyMeituanCollectorV104Patch() {
    CONFIG.version = 'V1.0.4';
    CONFIG.materialSwitchVerifyTimeout = 5000;

    const panelSelector = '#mtamc-panel';
    const allowedTypes = () => (CONFIG.materialTypes || []).filter((type) => type !== '搜索密令');

    const normalizeTextV104 = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const compactV104 = (value) => normalizeTextV104(value).replace(/[\s>*：:，,。；;（）()\-_/]/g, '').trim();

    const isVisibleV104 = (element) => {
      if (!element || element.nodeType !== 1) return false;
      if (element.closest && element.closest(panelSelector)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };

    const allVisibleV104 = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(isVisibleV104);
    const visibleTextV104 = (element) => normalizeTextV104(element ? element.innerText || element.textContent || '' : '');

    const parseRGBV104 = (color) => {
      const match = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
      if (!match) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
    };

    const isDarkColorV104 = (color) => {
      const rgb = parseRGBV104(color);
      if (!rgb) return false;
      const [r, g, b, a] = rgb;
      return a > 0.45 && r < 90 && g < 90 && b < 90;
    };

    const isGreyTextV104 = (element) => {
      if (!element) return false;
      const rgb = parseRGBV104(window.getComputedStyle(element).color);
      if (!rgb) return false;
      const [r, g, b, a] = rgb;
      return a < 0.72 || (Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r >= 145 && g >= 145 && b >= 145);
    };

    const getPromotionDrawerV104 = () => {
      const candidates = Array.from(document.querySelectorAll('aside,section,div,[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]'))
        .filter(isVisibleV104)
        .filter((element) => {
          if (element.closest && element.closest(panelSelector)) return false;
          const text = visibleTextV104(element);
          const rect = element.getBoundingClientRect();
          return (
            text.includes('立即推广') &&
            text.includes('选择推广媒体') &&
            text.includes('选择推广位') &&
            rect.width >= 420 &&
            rect.height >= 260 &&
            rect.left > window.innerWidth * 0.32 &&
            rect.right > window.innerWidth * 0.78
          );
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.width * ar.height - br.width * br.height;
        });
      return candidates[0] || null;
    };

    const getMaterialContentV104 = (modal) => {
      if (!modal) return { textareas: [], imageUrls: [], content: '' };
      const textareas = allVisibleV104('textarea', modal)
        .map((element) => (element.value || element.textContent || '').trim())
        .filter(Boolean);
      const editables = allVisibleV104('[contenteditable="true"]', modal)
        .map((element) => visibleTextV104(element))
        .filter(Boolean);
      const imageUrls = allVisibleV104('img', modal)
        .filter((img) => {
          const rect = img.getBoundingClientRect();
          return rect.width >= 100 && rect.height >= 100;
        })
        .map((img) => img.currentSrc || img.src || img.getAttribute('data-src') || '')
        .filter(Boolean)
        .filter((src) => !/logo|avatar|icon/i.test(src));
      const content = [textareas.join('\n'), editables.join('\n'), imageUrls.join('\n')].filter(Boolean).join('\n').trim();
      return { textareas, imageUrls, content };
    };

    const expectedContentV104 = (typeName, contentInfo) => {
      const content = contentInfo.content || '';
      if (!content) return false;
      if (typeName === '短链接') return /dpurl\.cn|https?:\/\//i.test(content);
      if (typeName === '长链接') return /https?:\/\//i.test(content);
      if (typeName === '呼起协议') return /\b(?:imeituan|meituan|dianping|mt|meituanwaimai):\/\//i.test(content) || /inner_url=/i.test(content);
      if (typeName === '小程序路径') return /pages\//i.test(content) || /appid|gh_|path=|miniProgram|小程序/i.test(content) || /https?:\/\//i.test(content) || /\b(?:imeituan|meituan|dianping|mt):\/\//i.test(content);
      if (typeName === 'H5链接二维码' || typeName === '小程序二维码') return contentInfo.imageUrls.length > 0 || /https?:\/\//i.test(content);
      if (typeName === '团口令') return contentInfo.imageUrls.length > 0 || /团|口令|复制|https?:\/\//i.test(content);
      return Boolean(content);
    };

    const getMaterialLabelsV104 = (modal) => {
      if (!modal) return [];
      const allowed = allowedTypes();
      const candidates = allVisibleV104('label,span,div,p', modal)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = visibleTextV104(element);
          const typeName = allowed.find((type) => compactV104(type) === compactV104(text));
          return { element, text, typeName, rect, area: rect.width * rect.height };
        })
        .filter((item) => item.typeName && item.rect.width > 8 && item.rect.height > 8 && item.text.length <= 16);

      const byType = new Map();
      candidates
        .sort((a, b) => a.area - b.area)
        .forEach((item) => {
          if (!byType.has(item.typeName)) byType.set(item.typeName, item);
        });
      return Array.from(byType.values()).sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
    };

    const findMaterialLabelV104 = (typeName, modal) => {
      const target = compactV104(typeName);
      return getMaterialLabelsV104(modal).find((item) => compactV104(item.typeName || item.text) === target) || null;
    };

    const looksRadioLikeV104 = (element, rect) => {
      const cls = String(element.className || '');
      const role = element.getAttribute('role') || '';
      const tag = element.tagName;
      const text = visibleTextV104(element);
      return (
        tag === 'INPUT' ||
        role === 'radio' ||
        /radio|circle|checkbox/i.test(cls) ||
        (rect.width >= 12 && rect.width <= 34 && rect.height >= 12 && rect.height <= 34 && !text)
      );
    };

    const findNearbyRadioV104 = (labelItem, modal) => {
      if (!labelItem || !modal) return null;
      const labelRect = labelItem.rect;
      const labelY = labelRect.top + labelRect.height / 2;
      const directLabel = labelItem.element.closest('label');
      if (directLabel) {
        const directCandidates = allVisibleV104('input[type="radio"],[role="radio"],span,div,i', directLabel)
          .map((element) => ({ element, rect: element.getBoundingClientRect() }))
          .filter(({ element, rect }) => looksRadioLikeV104(element, rect));
        if (directCandidates.length) {
          directCandidates.sort((a, b) => Math.abs((a.rect.top + a.rect.height / 2) - labelY) - Math.abs((b.rect.top + b.rect.height / 2) - labelY));
          return { ...directCandidates[0], source: 'direct-label' };
        }
      }

      const candidates = allVisibleV104('input[type="radio"],[role="radio"],span,div,i', modal)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const horizontalGap = labelRect.left - centerX;
          const verticalGap = Math.abs(centerY - labelY);
          return { element, rect, centerX, centerY, horizontalGap, verticalGap };
        })
        .filter(({ element, rect, horizontalGap, verticalGap }) => {
          return (
            looksRadioLikeV104(element, rect) &&
            horizontalGap >= 8 &&
            horizontalGap <= 78 &&
            verticalGap <= 18
          );
        })
        .sort((a, b) => {
          const scoreA = Math.abs(a.horizontalGap - 32) + a.verticalGap * 2;
          const scoreB = Math.abs(b.horizontalGap - 32) + b.verticalGap * 2;
          return scoreA - scoreB;
        });
      return candidates[0] || null;
    };

    const radioIsSelectedV104 = (radioItem) => {
      if (!radioItem || !radioItem.element) return false;
      const nodes = [radioItem.element, radioItem.element.parentElement, radioItem.element.closest('label')].filter(Boolean);
      for (const node of nodes) {
        if (node.checked === true) return true;
        if (node.getAttribute && node.getAttribute('aria-checked') === 'true') return true;
        if (/(checked|active|selected)/i.test(String(node.className || ''))) return true;
      }
      const visualNodes = [];
      nodes.forEach((node) => {
        if (!node) return;
        visualNodes.push(node);
        visualNodes.push(...Array.from(node.querySelectorAll ? node.querySelectorAll('*') : []));
      });
      for (const node of visualNodes.slice(0, 20)) {
        const style = window.getComputedStyle(node);
        if (isDarkColorV104(style.backgroundColor) || isDarkColorV104(style.color)) return true;
        const before = window.getComputedStyle(node, '::before');
        const after = window.getComputedStyle(node, '::after');
        if (isDarkColorV104(before.backgroundColor) || isDarkColorV104(after.backgroundColor)) return true;
      }
      return false;
    };

    const getActiveMaterialTypeV104 = (modal) => {
      const labels = getMaterialLabelsV104(modal);
      for (const item of labels) {
        const radio = findNearbyRadioV104(item, modal);
        if (radioIsSelectedV104(radio)) return item.typeName;
      }
      return '';
    };

    const materialIsDisabledV104 = (labelItem, modal) => {
      if (!labelItem || labelItem.typeName === '搜索密令') return true;
      const radio = findNearbyRadioV104(labelItem, modal);
      const nodes = [labelItem.element, labelItem.element.closest('label'), labelItem.element.parentElement, radio && radio.element].filter(Boolean);
      if (nodes.some((node) => node.disabled || node.getAttribute('aria-disabled') === 'true')) return true;
      if (nodes.some((node) => node.matches && node.matches('[disabled],[aria-disabled="true"],.disabled,[class*="disabled"],[class*="Disabled"]'))) return true;
      if (nodes.some((node) => node.closest && node.closest('[disabled],[aria-disabled="true"],.disabled,[class*="disabled"],[class*="Disabled"]'))) return true;
      if (isGreyTextV104(labelItem.element)) return true;
      return false;
    };

    const clickAtV104 = async (x, y, reason) => {
      const safeX = Math.max(4, Math.min(window.innerWidth - 4, Math.round(x)));
      const safeY = Math.max(4, Math.min(window.innerHeight - 4, Math.round(y)));
      const target = document.elementFromPoint(safeX, safeY);
      if (!target) throw new Error(`${reason} 点击坐标无命中元素`);
      const eventOptions = { bubbles: true, cancelable: true, composed: true, view: window, clientX: safeX, clientY: safeY };
      Logger.info(`点击素材：${reason} x=${safeX}, y=${safeY}, 命中=${target.tagName} ${visibleTextV104(target).slice(0, 30)}`);
      if (window.PointerEvent) {
        target.dispatchEvent(new PointerEvent('pointerover', eventOptions));
        target.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
        await DOM.sleep(70);
        target.dispatchEvent(new PointerEvent('pointerup', eventOptions));
      }
      target.dispatchEvent(new MouseEvent('mouseover', eventOptions));
      target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      await DOM.sleep(70);
      target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      target.dispatchEvent(new MouseEvent('click', eventOptions));
      await DOM.sleep(360);
    };

    const dispatchClickElementV104 = async (element, reason) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      await clickAtV104(x, y, reason);
      return true;
    };

    const verifyMaterialSelectedV104 = async (typeName, beforeContent, timeout = CONFIG.materialSwitchVerifyTimeout || 5000) => {
      const before = normalizeTextV104(beforeContent || '');
      const start = Date.now();
      let lastActive = '';
      let lastContent = '';
      while (Date.now() - start < timeout) {
        const modal = getPromotionDrawerV104();
        if (!modal) return { ok: false, modalClosed: true, activeType: lastActive, changed: false, contentInfo: null };
        lastActive = getActiveMaterialTypeV104(modal);
        const contentInfo = getMaterialContentV104(modal);
        lastContent = normalizeTextV104(contentInfo.content);
        const changed = Boolean(lastContent && lastContent !== before);
        if (lastActive === typeName) {
          return { ok: true, modalClosed: false, activeType: lastActive, changed, contentInfo };
        }
        if (changed && expectedContentV104(typeName, contentInfo)) {
          return { ok: true, modalClosed: false, activeType: lastActive, changed, contentInfo };
        }
        await DOM.sleep(220);
      }
      return { ok: false, modalClosed: false, activeType: lastActive, changed: Boolean(lastContent && lastContent !== before), contentInfo: null };
    };

    const clickMaterialRobustV104 = async (typeName, modal, beforeContent) => {
      const labelItem = findMaterialLabelV104(typeName, modal);
      if (!labelItem) return { exists: false, selected: false, reason: `当前活动未展示素材类型：${typeName}` };
      if (materialIsDisabledV104(labelItem, modal)) return { exists: false, selected: false, reason: `当前活动不支持素材类型：${typeName}` };

      const attempts = [];
      const radio = findNearbyRadioV104(labelItem, modal);
      if (radio) attempts.push({ kind: 'radio', element: radio.element, rect: radio.rect });
      const closestLabel = labelItem.element.closest('label');
      if (closestLabel) attempts.push({ kind: 'label', element: closestLabel, rect: closestLabel.getBoundingClientRect() });
      attempts.push({ kind: 'text', element: labelItem.element, rect: labelItem.rect });
      const parent = labelItem.element.parentElement;
      if (parent) attempts.push({ kind: 'parent', element: parent, rect: parent.getBoundingClientRect() });

      const used = new Set();
      for (const attempt of attempts) {
        if (!attempt.element || used.has(attempt.element)) continue;
        used.add(attempt.element);
        const latestModal = getPromotionDrawerV104();
        if (!latestModal) throw new Error(`推广面板在点击「${typeName}」前已关闭`);
        const latestLabel = findMaterialLabelV104(typeName, latestModal) || labelItem;
        const latestRadio = findNearbyRadioV104(latestLabel, latestModal);
        let rect = attempt.rect;
        if (attempt.kind === 'radio' && latestRadio) rect = latestRadio.rect;
        if (attempt.kind === 'text') rect = latestLabel.rect;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        await clickAtV104(x, y, `${typeName}/${attempt.kind}`);
        const verified = await verifyMaterialSelectedV104(typeName, beforeContent, 2600);
        if (verified.modalClosed) throw new Error(`推广面板在点击「${typeName}」后意外关闭`);
        if (verified.ok) return { exists: true, selected: true, reason: '', activeType: verified.activeType };
        Logger.warn(`点击「${typeName}/${attempt.kind}」后未确认选中，当前选中：${verified.activeType || '未知'}，继续重试`);
      }
      const finalModal = getPromotionDrawerV104();
      const active = finalModal ? getActiveMaterialTypeV104(finalModal) : '';
      return { exists: true, selected: false, reason: `点击后未切换到「${typeName}」，当前选中：${active || '未知'}`, activeType: active };
    };

    const waitFreshMaterialContentV104 = async (typeName, beforeContent, timeout = 14000) => {
      const before = normalizeTextV104(beforeContent || '');
      const start = Date.now();
      let last = null;
      while (Date.now() - start < timeout) {
        const modal = getPromotionDrawerV104();
        if (!modal) return { modalClosed: true, stale: false, materialText: '', pureLinkText: '', imageText: '', content: '' };
        const current = getMaterialContentV104(modal);
        last = current;
        const now = normalizeTextV104(current.content);
        const activeType = getActiveMaterialTypeV104(modal);
        const changed = Boolean(now && now !== before);
        const firstContent = Boolean(now && !before);
        if ((activeType === typeName || changed || firstContent) && expectedContentV104(typeName, current)) {
          return {
            modalClosed: false,
            stale: false,
            materialText: current.textareas[0] || current.imageUrls[0] || current.content || '',
            pureLinkText: current.textareas[1] || current.imageUrls.join('\n') || '',
            imageText: current.imageUrls.join('\n'),
            content: current.content
          };
        }
        await DOM.sleep(260);
      }
      const now = normalizeTextV104(last && last.content);
      return {
        modalClosed: false,
        stale: Boolean(now && before && now === before),
        materialText: last ? (last.textareas[0] || last.imageUrls[0] || last.content || '') : '',
        pureLinkText: last ? (last.textareas[1] || last.imageUrls.join('\n') || '') : '',
        imageText: last ? last.imageUrls.join('\n') : '',
        content: last ? last.content : ''
      };
    };

    PromotionModal.selectMaterialType = async function selectMaterialTypeV104(typeName) {
      if (typeName === '搜索密令') return false;
      const modal = getPromotionDrawerV104() || PromotionModal.currentModal || (await PromotionModal.waitForPromotionModal());
      const before = getMaterialContentV104(modal).content;
      const result = await clickMaterialRobustV104(typeName, modal, before);
      if (!result.exists) {
        Logger.info(result.reason);
        return false;
      }
      if (!result.selected) {
        throw new Error(result.reason || `点击后未切换到「${typeName}」`);
      }
      Logger.info(`已确认切换素材类型：${typeName}`);
      return true;
    };

    Collector.collectMaterialType = async function collectMaterialTypeV104(base, typeName) {
      const now = new Date().toISOString();
      if (typeName === '搜索密令') {
        Logger.info('搜索密令需要额外填写审核信息，已跳过');
        return 'skipped';
      }
      try {
        const modal = getPromotionDrawerV104() || PromotionModal.currentModal || (await PromotionModal.waitForPromotionModal());
        const before = getMaterialContentV104(modal).content;
        const exists = await PromotionModal.selectMaterialType(typeName);
        if (!exists) {
          Storage.upsertRecord(this.buildRecord(base, typeName, 'skipped', '', '', '', '', `当前活动不支持或未展示素材类型：${typeName}`, now));
          return 'skipped';
        }
        const content = await waitFreshMaterialContentV104(typeName, before, 14000);
        if (content.modalClosed) {
          Storage.upsertRecord(this.buildRecord(base, typeName, 'failed', '', '', '', '', '推广面板意外关闭，等待重试', now));
          return 'modal_closed';
        }
        if (content.stale) {
          const staleMessage = `素材内容未更新，疑似仍为上一个素材内容：${typeName}`;
          Storage.upsertRecord(this.buildRecord(base, typeName, 'failed', '', '', '', '', staleMessage, now));
          Logger.warn(staleMessage);
          return 'failed';
        }
        const combinedText = [content.materialText, content.pureLinkText, content.imageText].filter(Boolean).join('\n');
        const links = extractLinks(combinedText);
        const status = combinedText ? 'success' : 'failed';
        const record = this.buildRecord(
          base,
          typeName,
          status,
          content.materialText || content.imageText || '',
          links[0] || '',
          content.pureLinkText || content.imageText || '',
          '',
          status === 'success' ? '' : '素材内容为空或生成超时',
          now
        );
        record.links = links;
        if (content.imageText) record.image_urls = content.imageText.split('\n').filter(Boolean);
        Storage.upsertRecord(record);
        Logger.info(`${typeName} 采集${status === 'success' ? '成功' : '失败'}：${base.activity_name || base.material_id}`);
        return status;
      } catch (error) {
        const message = error.message || String(error);
        Storage.upsertRecord(this.buildRecord(base, typeName, 'failed', '', '', '', '', message, now));
        Logger.error(`${typeName} 采集失败：${message}`);
        if (/意外关闭|未打开|找不到推广面板/.test(message)) return 'modal_closed';
        return 'failed';
      }
    };
  }

  applyMeituanCollectorV104Patch();


  /**
   * V1.0.5 修复：
   * 1) 每一行采集前强制关闭旧推广抽屉，避免旧活动抽屉残留导致“当前活动”和页面推广物料不一致。
   * 2) 打开新行后必须校验「推广物料」与当前活动名称匹配，不匹配则关闭重开。
   * 3) 关闭推广面板使用强校验：真实可见抽屉消失后才算关闭成功。
   */
  function applyMeituanCollectorV105Patch() {
    CONFIG.version = 'V1.0.5';
    CONFIG.materialTypes = ['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令'];

    const panelSelector = '#mtamc-panel';

    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const compact = (value) => normalize(value).replace(/[\s>*：:，,。；;（）()\-_/【】\[\]]/g, '').trim();

    const isVisible = (element) => {
      if (!element || element.nodeType !== 1) return false;
      if (element.closest && element.closest(panelSelector)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };

    const allVisible = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(isVisible);
    const textOf = (element) => normalize(element ? element.innerText || element.textContent || '' : '');

    const clickAt = async (x, y, reason) => {
      const safeX = Math.max(4, Math.min(window.innerWidth - 4, Math.round(x)));
      const safeY = Math.max(4, Math.min(window.innerHeight - 4, Math.round(y)));
      const target = document.elementFromPoint(safeX, safeY);
      if (!target) throw new Error(`${reason} 点击坐标无命中元素`);
      const eventOptions = { bubbles: true, cancelable: true, composed: true, view: window, clientX: safeX, clientY: safeY };
      if (window.PointerEvent) {
        target.dispatchEvent(new PointerEvent('pointerover', eventOptions));
        target.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
        await DOM.sleep(60);
        target.dispatchEvent(new PointerEvent('pointerup', eventOptions));
      }
      target.dispatchEvent(new MouseEvent('mouseover', eventOptions));
      target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      await DOM.sleep(60);
      target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      target.dispatchEvent(new MouseEvent('click', eventOptions));
      await DOM.sleep(420);
    };

    const getPromotionDrawer = () => {
      const candidates = Array.from(document.querySelectorAll('aside,section,div,[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]'))
        .filter(isVisible)
        .filter((element) => {
          if (element.closest && element.closest(panelSelector)) return false;
          const text = textOf(element);
          const rect = element.getBoundingClientRect();
          return (
            text.includes('立即推广') &&
            text.includes('选择推广媒体') &&
            text.includes('选择推广位') &&
            rect.width >= 420 &&
            rect.height >= 260 &&
            rect.left > window.innerWidth * 0.30 &&
            rect.right > window.innerWidth * 0.74
          );
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.width * ar.height - br.width * br.height;
        });
      return candidates[0] || null;
    };

    const getDrawerMaterialName = (drawer) => {
      const text = textOf(drawer);
      if (!text) return '';
      const match = text.match(/推广物料\s+(.+?)\s+文案素材/);
      if (match && match[1]) return normalize(match[1]);

      const lines = String(drawer.innerText || drawer.textContent || '')
        .split(/\n+/)
        .map(normalize)
        .filter(Boolean);
      const idx = lines.findIndex((line) => line === '推广物料' || line.includes('推广物料'));
      if (idx >= 0) {
        const sameLine = lines[idx].replace(/^推广物料\s*/, '').trim();
        if (sameLine && sameLine !== '推广物料') return sameLine;
        for (let i = idx + 1; i < Math.min(lines.length, idx + 4); i += 1) {
          if (lines[i] && !/文案素材|选择推广|新增|复制/.test(lines[i])) return lines[i];
        }
      }
      return '';
    };

    const materialMatchesBase = (drawer, base) => {
      if (!drawer || !base) return false;
      const drawerName = getDrawerMaterialName(drawer);
      const baseName = normalize(base.activity_name || '');
      if (!baseName || !drawerName) return true;
      const a = compact(drawerName);
      const b = compact(baseName);
      if (!a || !b) return true;
      return a.includes(b) || b.includes(a) || a.slice(0, 8) === b.slice(0, 8);
    };

    const waitDrawerClosed = async (timeout = 3500) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (!getPromotionDrawer()) return true;
        await DOM.sleep(180);
      }
      return !getPromotionDrawer();
    };

    const forceCloseDrawer = async (reason = '') => {
      let drawer = getPromotionDrawer();
      if (!drawer) {
        PromotionModal.currentModal = null;
        return true;
      }
      if (reason) Logger.info(reason);

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        drawer = getPromotionDrawer();
        if (!drawer) break;
        const rect = drawer.getBoundingClientRect();
        const closeButton = allVisible('button,a,[role="button"],i,span,div', drawer)
          .map((element) => ({ element, rect: element.getBoundingClientRect(), text: textOf(element), aria: element.getAttribute('aria-label') || element.getAttribute('title') || '' }))
          .filter((item) => {
            const nearTopRight = item.rect.top <= rect.top + 80 && item.rect.left >= rect.right - 90;
            return nearTopRight && (/关闭|close|×|x/i.test(item.text) || /关闭|close/i.test(item.aria) || (item.rect.width <= 40 && item.rect.height <= 40));
          })
          .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];

        try {
          if (closeButton) {
            const r = closeButton.rect;
            await clickAt(r.left + r.width / 2, r.top + r.height / 2, `关闭推广面板 ${attempt}/3`);
          } else {
            await clickAt(rect.right - 34, rect.top + 34, `关闭推广面板右上角 ${attempt}/3`);
          }
        } catch (error) {
          Logger.warn(`点击关闭按钮失败：${error.message || error}`);
        }

        if (await waitDrawerClosed(1800)) {
          PromotionModal.currentModal = null;
          Logger.info('已关闭推广面板');
          return true;
        }

        document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', code: 'Escape' }));
        document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Escape', code: 'Escape' }));
        if (await waitDrawerClosed(1200)) {
          PromotionModal.currentModal = null;
          Logger.info('已关闭推广面板');
          return true;
        }
      }

      const stillOpen = getPromotionDrawer();
      if (stillOpen) {
        const name = getDrawerMaterialName(stillOpen);
        Logger.warn(`推广面板仍未关闭，当前残留物料：${name || '未知'}`);
        return false;
      }
      PromotionModal.currentModal = null;
      return true;
    };

    const openFreshDrawerForRow = async (collector, row, base) => {
      // 关键：开始新活动前必须先把旧抽屉关掉。否则 clickPromote 可能被遮罩拦截，脚本却继续复用旧抽屉。
      if (getPromotionDrawer()) {
        await forceCloseDrawer('开始新活动前检测到旧推广面板，先关闭后再打开当前活动');
        await DOM.sleep(650);
      }

      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          if (getPromotionDrawer()) await forceCloseDrawer(`重试打开当前活动前关闭旧面板 ${attempt}/3`);
          await DOM.sleep(250);
          await PromotionModal.clickPromote(row);
          await DOM.delay('modalOpen');
          await PromotionModal.waitForPromotionModal();

          await PromotionModal.selectDropdownByLabel('选择推广媒体', CONFIG.mediaName, {
            preferLast: CONFIG.mediaOptionPreferLast,
            fuzzy: true
          });
          await PromotionModal.selectDropdownByLabel('选择推广位', CONFIG.promotionPositionName);

          const drawer = await DOM.waitFor(() => {
            const item = getPromotionDrawer();
            if (!item) return null;
            const text = textOf(item);
            return text.includes('文案素材') && text.includes('推广物料') ? item : null;
          }, 9000, 250);

          if (!drawer) throw new Error('推广位选择后未出现文案素材区域');
          PromotionModal.currentModal = drawer;

          const drawerName = getDrawerMaterialName(drawer);
          if (!materialMatchesBase(drawer, base)) {
            const message = `推广面板物料与当前活动不一致，页面物料：「${drawerName || '未知'}」，当前活动：「${base.activity_name || base.material_id || '未知'}」`;
            Logger.warn(`${message}，关闭后重试 ${attempt}/3`);
            await forceCloseDrawer('关闭不匹配的旧推广面板');
            lastError = new Error(message);
            await DOM.sleep(900);
            continue;
          }

          Logger.info(`已确认当前推广物料：${drawerName || base.activity_name || base.material_id || '未知活动'}`);
          return drawer;
        } catch (error) {
          lastError = error;
          Logger.warn(`打开并校验当前活动推广面板失败 ${attempt}/3：${error.message || error}`);
          await forceCloseDrawer('打开失败后清理推广面板');
          await DOM.sleep(900);
        }
      }
      throw lastError || new Error('无法打开当前活动推广面板');
    };

    PromotionModal.closePromotionModal = async function closePromotionModalV105() {
      const ok = await forceCloseDrawer('准备关闭推广面板');
      if (!ok) throw new Error('推广面板仍未关闭，请手动关闭后继续');
      return true;
    };

    Collector.processRow = async function processRowV105(row, base) {
      Logger.info(`处理第 ${base.row_index} 行：${base.activity_name || base.material_id || '未知活动'}`);
      const needTypes = CONFIG.materialTypes.filter((type) => type !== '搜索密令' && !Storage.hasSuccess(base, type));
      if (!needTypes.length) {
        Logger.info(`第 ${base.row_index} 行已存在成功缓存，跳过`);
        return;
      }

      try {
        await openFreshDrawerForRow(this, row, base);
        for (const typeName of CONFIG.materialTypes) {
          if (typeName === '搜索密令') continue;
          await this.waitIfPaused();
          if (State.stopped) break;
          if (Storage.hasSuccess(base, typeName)) {
            Logger.info(`已采集过 ${base.material_id} / ${typeName}，跳过`);
            continue;
          }

          let result = await this.collectMaterialType(base, typeName);
          if (result === 'modal_closed') {
            Logger.warn(`第 ${base.row_index} 行采集「${typeName}」时推广面板关闭，重新打开后重试一次`);
            await DOM.sleep(900);
            await openFreshDrawerForRow(this, row, base);
            result = await this.collectMaterialType(base, typeName);
          }
        }
      } catch (error) {
        Logger.error(`第 ${base.row_index} 行失败：${error.message || error}`);
        this.saveFailureForTypes(base, needTypes, error.message || String(error));
      } finally {
        try {
          await forceCloseDrawer('当前活动采集结束，关闭推广面板');
        } catch (closeError) {
          Logger.warn(`关闭推广面板失败：${closeError.message || closeError}`);
        }
      }
    };
  }

  applyMeituanCollectorV105Patch();


  /**
   * V1.1.0 发布版：
   * 1) 保留 V1.0.6 的文案素材选中态校验与稳定采集逻辑。
   * 2) 优化素材切换速度：每个活动仅首次进入文案素材区域等待加载，后续短链接/长链接/呼起协议等切换走快速模式。
   * 3) 继续跳过搜索密令，继续保持一个活动一行导出。
   */
  function applyMeituanCollectorV110Patch() {
    CONFIG.version = 'V1.1.0';
    CONFIG.materialTypes = ['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令'];
    CONFIG.materialAreaWarmupDelay = 1400;
    CONFIG.materialAreaFastDelay = 80;
    CONFIG.materialClickRetry = 4;
    CONFIG.materialSwitchVerifyTimeout = 9000;

    const panelSelector = '#mtamc-panel';

    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const compact = (value) => normalize(value).replace(/[\s>*：:，,。；;（）()\-_/【】\[\]]/g, '').trim();

    const isVisible = (element) => {
      if (!element || element.nodeType !== 1) return false;
      if (element.closest && element.closest(panelSelector)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };

    const allVisible = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(isVisible);
    const textOf = (element) => normalize(element ? element.innerText || element.textContent || '' : '');

    const parseRGB = (color) => {
      const match = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
      if (!match) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
    };

    const isDark = (color) => {
      const rgb = parseRGB(color);
      if (!rgb) return false;
      const [r, g, b, a] = rgb;
      return a > 0.45 && r < 90 && g < 90 && b < 90;
    };

    const isGrey = (color) => {
      const rgb = parseRGB(color);
      if (!rgb) return false;
      const [r, g, b, a] = rgb;
      return a < 0.72 || (Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && r >= 145 && g >= 145 && b >= 145);
    };

    const getPromotionDrawer = () => {
      const candidates = Array.from(document.querySelectorAll('aside,section,div,[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]'))
        .filter(isVisible)
        .filter((element) => {
          const text = textOf(element);
          const rect = element.getBoundingClientRect();
          return (
            text.includes('立即推广') &&
            text.includes('选择推广媒体') &&
            text.includes('选择推广位') &&
            rect.width >= 420 &&
            rect.height >= 260 &&
            rect.left > window.innerWidth * 0.30 &&
            rect.right > window.innerWidth * 0.74
          );
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.width * ar.height - br.width * br.height;
        });
      return candidates[0] || null;
    };

    const getMaterialContent = (modal) => {
      if (!modal) return { textareas: [], imageUrls: [], content: '' };
      const textareas = allVisible('textarea', modal)
        .map((element) => (element.value || element.textContent || '').trim())
        .filter(Boolean);
      const editables = allVisible('[contenteditable="true"]', modal)
        .map((element) => textOf(element))
        .filter(Boolean);
      const imageUrls = allVisible('img', modal)
        .filter((img) => {
          const rect = img.getBoundingClientRect();
          return rect.width >= 100 && rect.height >= 100;
        })
        .map((img) => img.currentSrc || img.src || img.getAttribute('data-src') || '')
        .filter(Boolean)
        .filter((src) => !/logo|avatar|icon/i.test(src));
      const content = [textareas.join('\n'), editables.join('\n'), imageUrls.join('\n')].filter(Boolean).join('\n').trim();
      return { textareas, imageUrls, content };
    };

    const expectedContent = (typeName, contentInfo) => {
      const content = contentInfo.content || '';
      if (!content) return false;
      if (typeName === '短链接') return /dpurl\.cn/i.test(content) || /https?:\/\//i.test(content);
      if (typeName === '长链接') return /https?:\/\//i.test(content);
      if (typeName === '呼起协议') return /\b(?:imeituan|meituan|dianping|mt|meituanwaimai):\/\//i.test(content) || /inner_url=|launch/i.test(content);
      if (typeName === '小程序路径') return /\/index\/pages|pages\//i.test(content) || /weburl=|appid|gh_|path=|miniProgram|小程序/i.test(content) || /https?:\/\//i.test(content);
      if (typeName === 'H5链接二维码' || typeName === '小程序二维码') return contentInfo.imageUrls.length > 0 || /https?:\/\//i.test(content);
      if (typeName === '团口令') return contentInfo.imageUrls.length > 0 || /团|口令|https?:\/\//i.test(content);
      return Boolean(content);
    };

    const getMaterialLabels = (modal) => {
      if (!modal) return [];
      const allowed = (CONFIG.materialTypes || []).filter((type) => type !== '搜索密令');
      const candidates = allVisible('label,span,div,p', modal)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = textOf(element);
          const typeName = allowed.find((type) => compact(type) === compact(text));
          return { element, text, typeName, rect, area: rect.width * rect.height };
        })
        .filter((item) => item.typeName && item.rect.width > 8 && item.rect.height > 8 && item.text.length <= 18);

      const byType = new Map();
      candidates.sort((a, b) => a.area - b.area).forEach((item) => {
        if (!byType.has(item.typeName)) byType.set(item.typeName, item);
      });
      return Array.from(byType.values()).sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
    };

    const findMaterialLabel = (typeName, modal) => {
      const target = compact(typeName);
      return getMaterialLabels(modal).find((item) => compact(item.typeName || item.text) === target) || null;
    };

    const looksLikeRadio = (element, rect) => {
      const cls = String(element.className || '');
      const role = element.getAttribute('role') || '';
      const tag = element.tagName;
      const text = textOf(element);
      return (
        tag === 'INPUT' ||
        role === 'radio' ||
        /radio|circle/i.test(cls) ||
        (rect.width >= 12 && rect.width <= 34 && rect.height >= 12 && rect.height <= 34 && !text)
      );
    };

    const findNearbyRadio = (labelItem, modal) => {
      if (!labelItem || !modal) return null;
      const labelRect = labelItem.rect;
      const labelY = labelRect.top + labelRect.height / 2;
      const directLabel = labelItem.element.closest('label');
      if (directLabel) {
        const direct = allVisible('input[type="radio"],[role="radio"],span,div,i', directLabel)
          .map((element) => ({ element, rect: element.getBoundingClientRect() }))
          .filter(({ element, rect }) => looksLikeRadio(element, rect));
        if (direct.length) {
          direct.sort((a, b) => Math.abs((a.rect.top + a.rect.height / 2) - labelY) - Math.abs((b.rect.top + b.rect.height / 2) - labelY));
          return { ...direct[0], source: 'direct-label' };
        }
      }

      const candidates = allVisible('input[type="radio"],[role="radio"],span,div,i', modal)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const horizontalGap = labelRect.left - centerX;
          const verticalGap = Math.abs(centerY - labelY);
          return { element, rect, centerX, centerY, horizontalGap, verticalGap };
        })
        .filter(({ element, rect, horizontalGap, verticalGap }) => (
          looksLikeRadio(element, rect) && horizontalGap >= 6 && horizontalGap <= 72 && verticalGap <= 16
        ))
        .sort((a, b) => {
          const scoreA = Math.abs(a.horizontalGap - 28) + a.verticalGap * 3;
          const scoreB = Math.abs(b.horizontalGap - 28) + b.verticalGap * 3;
          return scoreA - scoreB;
        });
      return candidates[0] || null;
    };

    const radioIsSelected = (radioItem) => {
      if (!radioItem || !radioItem.element) return false;
      const radio = radioItem.element;
      if (radio.checked === true) return true;
      if (radio.getAttribute && radio.getAttribute('aria-checked') === 'true') return true;

      const nodes = [radio, radio.parentElement].filter(Boolean);
      for (const node of nodes) {
        const cls = String(node.className || '');
        if (/\b(is-)?(checked|active|selected)\b/i.test(cls) && !/uncheck|unchecked/i.test(cls)) return true;
      }

      const visualNodes = [];
      nodes.forEach((node) => {
        visualNodes.push(node);
        visualNodes.push(...Array.from(node.querySelectorAll ? node.querySelectorAll('*') : []));
      });

      for (const node of visualNodes.slice(0, 30)) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 40 || rect.height > 40) continue;
        const style = window.getComputedStyle(node);
        if (isDark(style.backgroundColor)) return true;
        const before = window.getComputedStyle(node, '::before');
        const after = window.getComputedStyle(node, '::after');
        if (isDark(before.backgroundColor) || isDark(after.backgroundColor)) return true;
        if (isDark(before.borderColor) || isDark(after.borderColor)) return true;
      }
      return false;
    };

    const getActiveMaterialType = (modal) => {
      const labels = getMaterialLabels(modal);
      for (const item of labels) {
        const radio = findNearbyRadio(item, modal);
        if (radioIsSelected(radio)) return item.typeName;
      }
      return '';
    };

    const materialIsDisabled = (labelItem, modal) => {
      if (!labelItem || labelItem.typeName === '搜索密令') return true;
      const radio = findNearbyRadio(labelItem, modal);
      const nodes = [labelItem.element, labelItem.element.closest('label'), labelItem.element.parentElement, radio && radio.element, radio && radio.element.parentElement].filter(Boolean);
      if (nodes.some((node) => node.disabled || node.getAttribute('aria-disabled') === 'true')) return true;
      if (nodes.some((node) => node.matches && node.matches('[disabled],[aria-disabled="true"],.disabled,[class*="disabled"],[class*="Disabled"]'))) return true;
      if (nodes.some((node) => node.closest && node.closest('[disabled],[aria-disabled="true"],.disabled,[class*="disabled"],[class*="Disabled"]'))) return true;
      const color = window.getComputedStyle(labelItem.element).color;
      if (isGrey(color)) return true;
      return false;
    };

    const clickAt = async (x, y, reason) => {
      const safeX = Math.max(4, Math.min(window.innerWidth - 4, Math.round(x)));
      const safeY = Math.max(4, Math.min(window.innerHeight - 4, Math.round(y)));
      const target = document.elementFromPoint(safeX, safeY);
      if (!target) throw new Error(`${reason} 点击坐标无命中元素`);
      const eventOptions = { bubbles: true, cancelable: true, composed: true, view: window, clientX: safeX, clientY: safeY };
      Logger.info(`点击素材：${reason} x=${safeX}, y=${safeY}, 命中=${target.tagName} ${textOf(target).slice(0, 30)}`);
      if (window.PointerEvent) {
        target.dispatchEvent(new PointerEvent('pointerover', eventOptions));
        target.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
        await DOM.sleep(90);
        target.dispatchEvent(new PointerEvent('pointerup', eventOptions));
      }
      target.dispatchEvent(new MouseEvent('mouseover', eventOptions));
      target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      await DOM.sleep(90);
      target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      target.dispatchEvent(new MouseEvent('click', eventOptions));
      await DOM.sleep(520);
    };

    const materialAreaWarmedKeys = new Set();

    const getMaterialAreaWarmupKey = (drawer) => {
      const drawerText = textOf(drawer);
      const materialName = (drawerText.match(/推广物料\s*([^文案素材]{1,80})\s*文案素材/) || [])[1] || '';
      return [State.currentIndex || '', State.currentActivityName || '', normalize(materialName)].join('::');
    };

    const waitMaterialAreaReady = async (timeout = 10000) => {
      const start = Date.now();
      let firstReadyAt = 0;
      let lastCount = 0;
      while (Date.now() - start < timeout) {
        const drawer = getPromotionDrawer();
        if (!drawer) return null;
        const text = textOf(drawer);
        const labels = getMaterialLabels(drawer).filter((item) => item.typeName !== '搜索密令');
        lastCount = labels.length;
        if (text.includes('文案素材') && labels.length > 0) {
          const warmupKey = getMaterialAreaWarmupKey(drawer);
          const alreadyWarmed = materialAreaWarmedKeys.has(warmupKey);
          const requiredDelay = alreadyWarmed ? (CONFIG.materialAreaFastDelay || 80) : (CONFIG.materialAreaWarmupDelay || 1200);
          if (!firstReadyAt) firstReadyAt = Date.now();
          if (Date.now() - firstReadyAt >= requiredDelay) {
            if (!alreadyWarmed) {
              materialAreaWarmedKeys.add(warmupKey);
              Logger.info('首次文案素材区域加载完成，后续素材切换使用快速模式');
            }
            return drawer;
          }
        } else {
          firstReadyAt = 0;
        }
        await DOM.sleep(240);
      }
      Logger.warn(`等待文案素材区域可交互超时，当前识别素材数：${lastCount}`);
      return getPromotionDrawer();
    };

    const verifySelectedOrContent = async (typeName, beforeContent, timeout = CONFIG.materialSwitchVerifyTimeout || 9000) => {
      const before = normalize(beforeContent || '');
      const start = Date.now();
      let lastActive = '';
      let lastContent = null;
      while (Date.now() - start < timeout) {
        const drawer = getPromotionDrawer();
        if (!drawer) return { ok: false, modalClosed: true, activeType: lastActive, contentInfo: lastContent };
        lastActive = getActiveMaterialType(drawer);
        const contentInfo = getMaterialContent(drawer);
        lastContent = contentInfo;
        const now = normalize(contentInfo.content);
        const changed = Boolean(now && now !== before);
        const firstContent = Boolean(now && !before);
        if (lastActive === typeName) return { ok: true, modalClosed: false, activeType: lastActive, contentInfo };
        if ((changed || firstContent) && expectedContent(typeName, contentInfo)) return { ok: true, modalClosed: false, activeType: lastActive, contentInfo };
        await DOM.sleep(260);
      }
      return { ok: false, modalClosed: false, activeType: lastActive, contentInfo: lastContent };
    };

    const clickMaterialRobust = async (typeName, beforeContent) => {
      let modal = await waitMaterialAreaReady(10000);
      if (!modal) throw new Error('推广面板未打开，无法选择素材');

      const labelItem = findMaterialLabel(typeName, modal);
      if (!labelItem) return { exists: false, selected: false, reason: `当前活动未展示素材类型：${typeName}` };
      if (materialIsDisabled(labelItem, modal)) return { exists: false, selected: false, reason: `当前活动不支持素材类型：${typeName}` };

      for (let round = 1; round <= (CONFIG.materialClickRetry || 4); round += 1) {
        modal = await waitMaterialAreaReady(6000);
        if (!modal) throw new Error(`推广面板在点击「${typeName}」前已关闭`);
        const latestLabel = findMaterialLabel(typeName, modal) || labelItem;
        const radio = findNearbyRadio(latestLabel, modal);
        const attempts = [];
        if (radio) attempts.push({ kind: 'radio', rect: radio.rect });
        const closestLabel = latestLabel.element.closest('label');
        if (closestLabel) attempts.push({ kind: 'label', rect: closestLabel.getBoundingClientRect() });
        attempts.push({ kind: 'text', rect: latestLabel.rect });

        for (const attempt of attempts) {
          const rect = attempt.rect;
          await clickAt(rect.left + rect.width / 2, rect.top + rect.height / 2, `${typeName}/${attempt.kind} ${round}/${CONFIG.materialClickRetry || 4}`);
          const verified = await verifySelectedOrContent(typeName, beforeContent, 2600);
          if (verified.modalClosed) throw new Error(`推广面板在点击「${typeName}」后意外关闭`);
          if (verified.ok) return { exists: true, selected: true, reason: '', activeType: verified.activeType };
          Logger.warn(`点击「${typeName}/${attempt.kind}」后未生效，当前选中：${verified.activeType || '无'}，等待后重试`);
          await DOM.sleep(480);
        }
      }

      const finalDrawer = getPromotionDrawer();
      const active = finalDrawer ? getActiveMaterialType(finalDrawer) : '';
      return { exists: true, selected: false, reason: `点击后未切换到「${typeName}」，当前选中：${active || '无'}`, activeType: active };
    };

    const waitFreshContent = async (typeName, beforeContent, timeout = 15000) => {
      const before = normalize(beforeContent || '');
      const start = Date.now();
      let last = null;
      while (Date.now() - start < timeout) {
        const modal = getPromotionDrawer();
        if (!modal) return { modalClosed: true, stale: false, materialText: '', pureLinkText: '', imageText: '', content: '' };
        const current = getMaterialContent(modal);
        last = current;
        const now = normalize(current.content);
        const activeType = getActiveMaterialType(modal);
        const changed = Boolean(now && now !== before);
        const firstContent = Boolean(now && !before);
        if ((activeType === typeName || changed || firstContent) && expectedContent(typeName, current)) {
          return {
            modalClosed: false,
            stale: false,
            materialText: current.textareas[0] || current.imageUrls[0] || current.content || '',
            pureLinkText: current.textareas[1] || current.imageUrls.join('\n') || '',
            imageText: current.imageUrls.join('\n'),
            content: current.content
          };
        }
        await DOM.sleep(260);
      }
      const now = normalize(last && last.content);
      return {
        modalClosed: false,
        stale: Boolean(now && before && now === before),
        materialText: last ? (last.textareas[0] || last.imageUrls[0] || last.content || '') : '',
        pureLinkText: last ? (last.textareas[1] || last.imageUrls.join('\n') || '') : '',
        imageText: last ? last.imageUrls.join('\n') : '',
        content: last ? last.content : ''
      };
    };

    PromotionModal.selectMaterialType = async function selectMaterialTypeV106(typeName) {
      if (typeName === '搜索密令') return false;
      const modal = await waitMaterialAreaReady(10000);
      if (!modal) throw new Error('推广面板未打开，无法选择素材');
      const before = getMaterialContent(modal).content;
      const result = await clickMaterialRobust(typeName, before);
      if (!result.exists) {
        Logger.info(result.reason);
        return false;
      }
      if (!result.selected) throw new Error(result.reason || `点击后未切换到「${typeName}」`);
      Logger.info(`已确认切换素材类型：${typeName}`);
      return true;
    };

    Collector.collectMaterialType = async function collectMaterialTypeV106(base, typeName) {
      const now = new Date().toISOString();
      if (typeName === '搜索密令') return 'skipped';
      try {
        const modal = await waitMaterialAreaReady(10000);
        if (!modal) throw new Error('推广面板未打开，无法采集素材');
        const before = getMaterialContent(modal).content;
        const exists = await PromotionModal.selectMaterialType(typeName);
        if (!exists) {
          Storage.upsertRecord(this.buildRecord(base, typeName, 'skipped', '', '', '', '', `当前活动不支持或未展示素材类型：${typeName}`, now));
          return 'skipped';
        }
        const content = await waitFreshContent(typeName, before, 15000);
        if (content.modalClosed) {
          Storage.upsertRecord(this.buildRecord(base, typeName, 'failed', '', '', '', '', '推广面板意外关闭，等待重试', now));
          return 'modal_closed';
        }
        if (content.stale) {
          const staleMessage = `素材内容未更新，疑似仍为上一个素材内容：${typeName}`;
          Storage.upsertRecord(this.buildRecord(base, typeName, 'failed', '', '', '', '', staleMessage, now));
          Logger.warn(staleMessage);
          return 'failed';
        }
        const combinedText = [content.materialText, content.pureLinkText, content.imageText].filter(Boolean).join('\n');
        const links = extractLinks(combinedText);
        const status = combinedText ? 'success' : 'failed';
        const record = this.buildRecord(
          base,
          typeName,
          status,
          content.materialText || content.imageText || '',
          links[0] || '',
          content.pureLinkText || content.imageText || '',
          '',
          status === 'success' ? '' : '素材内容为空或生成超时',
          now
        );
        record.links = links;
        if (content.imageText) record.image_urls = content.imageText.split('\n').filter(Boolean);
        Storage.upsertRecord(record);
        Logger.info(`${typeName} 采集${status === 'success' ? '成功' : '失败'}：${base.activity_name || base.material_id}`);
        return status;
      } catch (error) {
        const message = error.message || String(error);
        Storage.upsertRecord(this.buildRecord(base, typeName, 'failed', '', '', '', '', message, now));
        Logger.error(`${typeName} 采集失败：${message}`);
        if (/意外关闭|未打开|找不到推广面板/.test(message)) return 'modal_closed';
        return 'failed';
      }
    };
  }

  applyMeituanCollectorV110Patch();


  /**
   * V1.1.2 修复：
   * 1) 进入文案素材采集前，准确识别当前活动真实可点击的素材类型。
   * 2) 对置灰/禁用素材直接记录 skipped，不再点击、不再等待、不再重试。
   * 3) 搜索密令继续按业务配置跳过，避免进入提交审核表单。
   */
  function applyMeituanCollectorV112Patch() {
    CONFIG.version = 'V1.1.4';
    CONFIG.skipMaterialTypes = ['搜索密令'];
    CONFIG.materialTypes = ['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令'];

    const panelSelector = '#mtamc-panel';
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const compact = (value) => normalize(value).replace(/[\s>*：:，,。；;（）()\-_/【】\[\]]/g, '').trim();

    const parseRGB = (color) => {
      const match = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
      if (!match) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
    };

    const isMutedColor = (color) => {
      const rgb = parseRGB(color);
      if (!rgb) return false;
      const [r, g, b, a] = rgb;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      return a < 0.72 || (max - min <= 28 && r >= 135 && g >= 135 && b >= 135);
    };

    const isDarkColor = (color) => {
      const rgb = parseRGB(color);
      if (!rgb) return false;
      const [r, g, b, a] = rgb;
      return a > 0.45 && r < 95 && g < 95 && b < 95;
    };

    const isVisible = (element) => {
      if (!element || element.nodeType !== 1) return false;
      if (element.closest && element.closest(panelSelector)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };

    const allVisible = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(isVisible);
    const textOf = (element) => normalize(element ? element.innerText || element.textContent || '' : '');

    const getPromotionDrawer = () => {
      const modal = PromotionModal.findModal && PromotionModal.findModal();
      if (modal && isVisible(modal) && textOf(modal).includes('文案素材')) return modal;

      const candidates = Array.from(document.querySelectorAll('aside,section,div,[role="dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]'))
        .filter(isVisible)
        .filter((element) => {
          const text = textOf(element);
          const rect = element.getBoundingClientRect();
          return (
            text.includes('立即推广') &&
            text.includes('选择推广媒体') &&
            text.includes('选择推广位') &&
            text.includes('文案素材') &&
            rect.width >= 420 &&
            rect.height >= 260 &&
            rect.left > window.innerWidth * 0.28 &&
            rect.right > window.innerWidth * 0.70
          );
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.width * ar.height - br.width * br.height;
        });
      return candidates[0] || PromotionModal.currentModal || null;
    };

    const getMaterialTypeList = () => {
      const configured = (CONFIG.materialTypes || []).concat(CONFIG.optionalMaterialTypes || []);
      return Array.from(new Set(configured.concat(['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令', '搜索密令'])));
    };

    const getMaterialTextNodes = (typeName, modal) => {
      const target = compact(typeName);
      return allVisible('label,span,div,p', modal)
        .filter((element) => {
          const text = textOf(element);
          if (!text || text.length > 24) return false;
          return compact(text) === target;
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (ar.width * ar.height) - (br.width * br.height);
        });
    };

    const findMaterialLabel = (typeName, modal = getPromotionDrawer()) => {
      if (!modal) return null;
      const nodes = getMaterialTextNodes(typeName, modal);
      if (!nodes.length) return null;
      const element = nodes[0];
      return { typeName, element, rect: element.getBoundingClientRect() };
    };

    const looksLikeRadio = (element, rect) => {
      if (!element || !rect) return false;
      const cls = String(element.className || '');
      const role = element.getAttribute && (element.getAttribute('role') || '');
      const tag = element.tagName;
      const elementText = textOf(element);
      return (
        tag === 'INPUT' ||
        role === 'radio' ||
        /radio|circle|dot/i.test(cls) ||
        (rect.width >= 12 && rect.width <= 36 && rect.height >= 12 && rect.height <= 36 && !elementText)
      );
    };

    const findNearbyRadio = (labelItem, modal) => {
      if (!labelItem || !modal) return null;
      const labelRect = labelItem.rect || labelItem.element.getBoundingClientRect();
      const labelY = labelRect.top + labelRect.height / 2;
      const directLabel = labelItem.element.closest('label');
      if (directLabel) {
        const direct = allVisible('input[type="radio"],[role="radio"],span,div,i', directLabel)
          .map((element) => ({ element, rect: element.getBoundingClientRect() }))
          .filter(({ element, rect }) => looksLikeRadio(element, rect));
        if (direct.length) {
          direct.sort((a, b) => Math.abs((a.rect.top + a.rect.height / 2) - labelY) - Math.abs((b.rect.top + b.rect.height / 2) - labelY));
          return direct[0];
        }
      }

      const candidates = allVisible('input[type="radio"],[role="radio"],span,div,i', modal)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const horizontalGap = labelRect.left - centerX;
          const verticalGap = Math.abs(centerY - labelY);
          return { element, rect, centerX, centerY, horizontalGap, verticalGap };
        })
        .filter(({ element, rect, horizontalGap, verticalGap }) => (
          looksLikeRadio(element, rect) && horizontalGap >= 4 && horizontalGap <= 82 && verticalGap <= 18
        ))
        .sort((a, b) => {
          const scoreA = Math.abs(a.horizontalGap - 28) + a.verticalGap * 3;
          const scoreB = Math.abs(b.horizontalGap - 28) + b.verticalGap * 3;
          return scoreA - scoreB;
        });
      return candidates[0] || null;
    };

    const radioIsSelected = (radioItem) => {
      if (!radioItem || !radioItem.element) return false;
      const radio = radioItem.element;
      if (radio.checked === true) return true;
      if (radio.getAttribute && radio.getAttribute('aria-checked') === 'true') return true;

      const nodes = [radio, radio.parentElement].filter(Boolean);
      for (const node of nodes) {
        const cls = String(node.className || '');
        if (/\b(is-)?(checked|active|selected)\b/i.test(cls) && !/uncheck|unchecked/i.test(cls)) return true;
      }

      const visualNodes = [];
      nodes.forEach((node) => {
        visualNodes.push(node);
        visualNodes.push(...Array.from(node.querySelectorAll ? node.querySelectorAll('*') : []));
      });

      for (const node of visualNodes.slice(0, 30)) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 42 || rect.height > 42) continue;
        const style = window.getComputedStyle(node);
        if (isDarkColor(style.backgroundColor) || isDarkColor(style.borderColor)) return true;
        const before = window.getComputedStyle(node, '::before');
        const after = window.getComputedStyle(node, '::after');
        if (isDarkColor(before.backgroundColor) || isDarkColor(after.backgroundColor)) return true;
        if (isDarkColor(before.borderColor) || isDarkColor(after.borderColor)) return true;
      }
      return false;
    };

    const getMaterialContainerNodes = (labelItem, modal) => {
      if (!labelItem) return [];
      const label = labelItem.element;
      const radio = findNearbyRadio(labelItem, modal);
      const nodes = [
        label,
        label.closest('label'),
        label.parentElement,
        label.parentElement && label.parentElement.parentElement,
        radio && radio.element,
        radio && radio.element.parentElement,
        radio && radio.element.parentElement && radio.element.parentElement.parentElement
      ].filter(Boolean);

      const labelRect = labelItem.rect || label.getBoundingClientRect();
      const labelY = labelRect.top + labelRect.height / 2;
      let current = label.parentElement;
      while (current && current !== modal && nodes.length < 12) {
        const rect = current.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        if (rect.width <= 260 && rect.height <= 70 && Math.abs(centerY - labelY) <= 24) nodes.push(current);
        current = current.parentElement;
      }
      return Array.from(new Set(nodes));
    };

    const elementDisabledByState = (element) => {
      if (!element || element.nodeType !== 1) return false;
      if (element.disabled === true) return true;
      if (element.getAttribute('disabled') !== null) return true;
      if (element.getAttribute('aria-disabled') === 'true') return true;
      const cls = String(element.className || '');
      if (/(^|\s|_|-)(disabled|is-disabled|mtd-radio-disabled|ant-radio-disabled|radio-disabled)(\s|_|-|$)/i.test(cls)) return true;
      const style = window.getComputedStyle(element);
      if (style.pointerEvents === 'none') return true;
      if (Number(style.opacity) > 0 && Number(style.opacity) < 0.65) return true;
      if (style.cursor === 'not-allowed') return true;
      return false;
    };

    const materialDisabledReason = (typeName, modal = getPromotionDrawer()) => {
      if ((CONFIG.skipMaterialTypes || []).includes(typeName) || typeName === '搜索密令') return '业务配置不采集';
      if (!modal) return '推广面板未打开';

      const labelItem = findMaterialLabel(typeName, modal);
      if (!labelItem) return '当前活动未展示该素材类型';

      const radio = findNearbyRadio(labelItem, modal);
      if (radioIsSelected(radio)) return '';

      const nodes = getMaterialContainerNodes(labelItem, modal);
      if (nodes.some(elementDisabledByState)) return '素材类型置灰不可用';

      const exactTextNodes = getMaterialTextNodes(typeName, modal);
      const textNodes = exactTextNodes.length ? exactTextNodes : [labelItem.element];
      const mutedTextNodes = textNodes.filter((node) => {
        const style = window.getComputedStyle(node);
        return isMutedColor(style.color) || style.pointerEvents === 'none' || style.cursor === 'not-allowed' || (Number(style.opacity) > 0 && Number(style.opacity) < 0.65);
      });

      // 文案文字本身呈灰色，基本可以判断为不可点击；不要用 radio 圆圈边框颜色判断，避免误判未选中但可点击的正常圆圈。
      if (mutedTextNodes.length > 0) return '素材类型置灰不可用';

      const inputRadio = nodes.find((node) => node.matches && node.matches('input[type="radio"]'));
      if (inputRadio && inputRadio.disabled) return '素材类型置灰不可用';

      return '';
    };

    const getAvailableMaterialTypes = (modal = getPromotionDrawer()) => {
      const materialTypes = getMaterialTypeList().filter((type) => !(CONFIG.skipMaterialTypes || []).includes(type) && type !== '搜索密令');
      return materialTypes.filter((type) => !materialDisabledReason(type, modal));
    };

    PromotionModal.getAvailableMaterialTypes = function getAvailableMaterialTypesV112() {
      return getAvailableMaterialTypes(getPromotionDrawer());
    };

    PromotionModal.isMaterialTypeEnabled = function isMaterialTypeEnabledV112(typeName) {
      return !materialDisabledReason(typeName, getPromotionDrawer());
    };

    const previousSelectMaterialType = PromotionModal.selectMaterialType.bind(PromotionModal);
    PromotionModal.selectMaterialType = async function selectMaterialTypeV112(typeName) {
      const modal = getPromotionDrawer() || PromotionModal.currentModal || (await PromotionModal.waitForPromotionModal());
      const reason = materialDisabledReason(typeName, modal);
      if (reason) {
        Logger.info(`素材类型不可用，跳过：${typeName}（${reason}）`);
        return false;
      }
      return previousSelectMaterialType(typeName);
    };

    const previousCollectMaterialType = Collector.collectMaterialType.bind(Collector);
    Collector.collectMaterialType = async function collectMaterialTypeV112(base, typeName) {
      const now = new Date().toISOString();
      const modal = getPromotionDrawer() || PromotionModal.currentModal;
      const reason = materialDisabledReason(typeName, modal);
      if (reason) {
        Storage.upsertRecord(this.buildRecord(base, typeName, 'skipped', '', '', '', '', reason, now));
        Logger.info(`${typeName} 跳过：${reason}`);
        return 'skipped';
      }
      return previousCollectMaterialType(base, typeName);
    };

    const previousProcessRow = Collector.processRow.bind(Collector);
    Collector.processRow = async function processRowV112(row, base) {
      return previousProcessRow(row, base);
    };
  }

  applyMeituanCollectorV112Patch();

  /**
   * V1.1.3 修复：
   * 1) 不再把“颜色灰/截图观感”作为唯一依据。
   * 2) 素材点击后必须严格检测目标 radio 是否真实选中；未选中即按置灰不可用跳过。
   * 3) 对不可用素材只做一次轻量探测，不再反复点 radio/label/text，避免误关抽屉。
   */
  function applyMeituanCollectorV113Patch() {
    CONFIG.version = 'V1.1.4';
    CONFIG.materialClickRetry = 1;
    CONFIG.skipMaterialTypes = Array.from(new Set([...(CONFIG.skipMaterialTypes || []), '搜索密令']));
    CONFIG.materialTypes = ['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令'];

    const PANEL_SELECTOR = '#mtamc-panel';
    const MATERIAL_TYPES = ['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令', '搜索密令'];
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

    const visible = (element) => {
      if (!element || element.nodeType !== 1) return false;
      if (element.closest && element.closest(PANEL_SELECTOR)) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const all = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(visible);
    const textOf = (element) => normalize(element ? element.innerText || element.textContent || '' : '');

    const getPromotionDrawer = () => {
      const current = PromotionModal.currentModal;
      if (current && visible(current)) {
        const currentText = textOf(current);
        if (currentText.includes('文案素材') || currentText.includes('选择推广媒体')) return current;
      }

      const candidates = all('aside,section,div,[role="dialog"],[class*="drawer"],[class*="modal"]', document)
        .filter((element) => {
          const t = textOf(element);
          const rect = element.getBoundingClientRect();
          return (
            rect.width >= 360 &&
            rect.height >= 220 &&
            rect.right > window.innerWidth * 0.45 &&
            t.includes('选择推广媒体') &&
            (t.includes('文案素材') || t.includes('选择推广位') || t.includes('推广物料'))
          );
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.width * ra.height - rb.width * rb.height;
        });
      return candidates[0] || null;
    };

    const getMaterialArea = (modal) => {
      if (!modal) return null;
      const label = all('label,span,div,p,td', modal).find((node) => textOf(node) === '文案素材');
      if (!label) return modal;
      const labelRect = label.getBoundingClientRect();
      let current = label.parentElement;
      const candidates = [];
      while (current && current !== modal.parentElement) {
        if (visible(current)) {
          const rect = current.getBoundingClientRect();
          const t = textOf(current);
          if (
            t.includes('文案素材') &&
            MATERIAL_TYPES.some((type) => t.includes(type)) &&
            rect.height >= 48 &&
            rect.height <= 220 &&
            rect.width >= 420 &&
            Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2)) <= 90
          ) {
            candidates.push({ element: current, area: rect.width * rect.height });
          }
        }
        if (current === modal) break;
        current = current.parentElement;
      }
      candidates.sort((a, b) => a.area - b.area);
      return candidates[0] ? candidates[0].element : modal;
    };

    const findMaterialTextNode = (typeName, modal = getPromotionDrawer()) => {
      if (!modal) return null;
      const area = getMaterialArea(modal) || modal;
      const candidates = all('label,span,div,p', area)
        .filter((node) => textOf(node) === typeName)
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { node, rect, area: rect.width * rect.height };
        })
        .filter(({ rect }) => rect.width >= 18 && rect.width <= 180 && rect.height >= 14 && rect.height <= 48)
        .sort((a, b) => a.area - b.area);
      return candidates[0] || null;
    };

    const looksLikeRadio = (element, rect) => {
      if (!element || !rect) return false;
      if (element.matches && element.matches('input[type="radio"],[role="radio"]')) return true;
      const className = String(element.className || '');
      const style = window.getComputedStyle(element);
      const radius = parseFloat(style.borderRadius || '0');
      const isRound = radius >= Math.min(rect.width, rect.height) * 0.35 || /radio|circle|dot/i.test(className);
      return rect.width >= 12 && rect.width <= 34 && rect.height >= 12 && rect.height <= 34 && isRound;
    };

    const findNearbyRadio = (labelItem, modal = getPromotionDrawer()) => {
      if (!labelItem || !modal) return null;
      const labelRect = labelItem.rect || labelItem.node.getBoundingClientRect();
      const labelY = labelRect.top + labelRect.height / 2;
      const area = getMaterialArea(modal) || modal;
      const candidates = all('input[type="radio"],[role="radio"],span,div,i', area)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const horizontalGap = labelRect.left - centerX;
          const verticalGap = Math.abs(centerY - labelY);
          return { element, rect, centerX, centerY, horizontalGap, verticalGap };
        })
        .filter(({ element, rect, horizontalGap, verticalGap }) => looksLikeRadio(element, rect) && horizontalGap >= -6 && horizontalGap <= 82 && verticalGap <= 20)
        .sort((a, b) => {
          const scoreA = Math.abs(a.horizontalGap - 26) + a.verticalGap * 3;
          const scoreB = Math.abs(b.horizontalGap - 26) + b.verticalGap * 3;
          return scoreA - scoreB;
        });
      return candidates[0] || null;
    };

    const colorIsDark = (color) => {
      const match = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
      if (!match) return false;
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      const a = match[4] === undefined ? 1 : Number(match[4]);
      if (a < 0.55) return false;
      return r < 80 && g < 80 && b < 80;
    };

    const radioIsSelected = (radioItem) => {
      if (!radioItem || !radioItem.element) return false;
      const radio = radioItem.element;
      if (radio.checked === true) return true;
      if (radio.getAttribute && radio.getAttribute('aria-checked') === 'true') return true;
      const nodes = [radio, radio.parentElement, radio.parentElement && radio.parentElement.parentElement].filter(Boolean);
      for (const node of nodes) {
        const cls = String(node.className || '');
        if (/(^|\s|-|_)(checked|selected|active|is-checked)(\s|-|_|$)/i.test(cls) && !/uncheck|unchecked/i.test(cls)) return true;
      }
      const visualNodes = [];
      nodes.forEach((node) => {
        visualNodes.push(node);
        visualNodes.push(...Array.from(node.querySelectorAll ? node.querySelectorAll('*') : []));
      });
      for (const node of visualNodes.slice(0, 28)) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 42 || rect.height > 42) continue;
        const style = window.getComputedStyle(node);
        if (colorIsDark(style.backgroundColor) || colorIsDark(style.borderColor)) return true;
        const before = window.getComputedStyle(node, '::before');
        const after = window.getComputedStyle(node, '::after');
        if (colorIsDark(before.backgroundColor) || colorIsDark(after.backgroundColor)) return true;
        if (colorIsDark(before.borderColor) || colorIsDark(after.borderColor)) return true;
      }
      return false;
    };

    const getActiveMaterialType = (modal = getPromotionDrawer()) => {
      if (!modal) return '';
      for (const typeName of MATERIAL_TYPES) {
        const labelItem = findMaterialTextNode(typeName, modal);
        if (!labelItem) continue;
        const radio = findNearbyRadio(labelItem, modal);
        if (radioIsSelected(radio)) return typeName;
      }
      return '';
    };

    const hasObviousDisabledState = (typeName, modal = getPromotionDrawer()) => {
      if (typeName === '搜索密令' || (CONFIG.skipMaterialTypes || []).includes(typeName)) return '业务配置不采集';
      const labelItem = findMaterialTextNode(typeName, modal);
      if (!labelItem) return '当前活动未展示该素材类型';
      const radio = findNearbyRadio(labelItem, modal);
      const nodes = [
        labelItem.node,
        labelItem.node.closest && labelItem.node.closest('label'),
        labelItem.node.parentElement,
        radio && radio.element,
        radio && radio.element.parentElement,
        radio && radio.element.parentElement && radio.element.parentElement.parentElement
      ].filter(Boolean);
      for (const node of nodes) {
        if (node.disabled === true) return '素材类型置灰不可用';
        if (node.getAttribute && node.getAttribute('disabled') !== null) return '素材类型置灰不可用';
        if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') return '素材类型置灰不可用';
        const cls = String(node.className || '');
        if (/(^|\s|_|-)(disabled|is-disabled|mtd-radio-disabled|ant-radio-disabled|radio-disabled)(\s|_|-|$)/i.test(cls)) return '素材类型置灰不可用';
        const style = window.getComputedStyle(node);
        if (style.pointerEvents === 'none' || style.cursor === 'not-allowed') return '素材类型置灰不可用';
      }
      return '';
    };

    const clickAt = async (x, y, reason = '') => {
      const target = document.elementFromPoint(x, y);
      if (!target) throw new Error(`点击素材失败：坐标无元素 ${reason}`);
      const eventOptions = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      Logger.info(`点击素材：${reason} x=${Math.round(x)}, y=${Math.round(y)}, 命中=${target.tagName} ${textOf(target).slice(0, 18)}`);
      if (window.PointerEvent) {
        target.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
        target.dispatchEvent(new PointerEvent('pointerup', eventOptions));
      }
      target.dispatchEvent(new MouseEvent('mouseover', eventOptions));
      target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      target.dispatchEvent(new MouseEvent('click', eventOptions));
      if (typeof target.click === 'function') {
        try { target.click(); } catch (error) { /* ignore */ }
      }
      await DOM.sleep(CONFIG.materialFastSwitchDelay || 260);
    };

    const waitActiveType = async (typeName, timeout = 900) => {
      const start = Date.now();
      let active = '';
      while (Date.now() - start < timeout) {
        const drawer = getPromotionDrawer();
        if (!drawer) return { modalClosed: true, activeType: active };
        active = getActiveMaterialType(drawer);
        if (active === typeName) return { ok: true, activeType: active, modalClosed: false };
        await DOM.sleep(120);
      }
      return { ok: false, activeType: active, modalClosed: false };
    };

    PromotionModal.getActiveMaterialType = getActiveMaterialType;
    PromotionModal.isMaterialTypeEnabled = function isMaterialTypeEnabledV113(typeName) {
      if (hasObviousDisabledState(typeName, getPromotionDrawer())) return false;
      return Boolean(findMaterialTextNode(typeName, getPromotionDrawer()));
    };

    PromotionModal.selectMaterialType = async function selectMaterialTypeV113(typeName) {
      if (typeName === '搜索密令' || (CONFIG.skipMaterialTypes || []).includes(typeName)) {
        Logger.info(`素材类型不可用，跳过：${typeName}（业务配置不采集）`);
        return false;
      }

      let modal = getPromotionDrawer() || PromotionModal.currentModal || (await PromotionModal.waitForPromotionModal());
      if (!modal) throw new Error('推广面板未打开，无法选择素材');

      const obviousReason = hasObviousDisabledState(typeName, modal);
      if (obviousReason) {
        Logger.info(`素材类型不可用，跳过：${typeName}（${obviousReason}）`);
        return false;
      }

      const beforeActive = getActiveMaterialType(modal);
      if (beforeActive === typeName) {
        Logger.info(`已确认切换素材类型：${typeName}`);
        return true;
      }

      const labelItem = findMaterialTextNode(typeName, modal);
      if (!labelItem) {
        Logger.info(`素材类型不可用，跳过：${typeName}（当前活动未展示该素材类型）`);
        return false;
      }
      const radio = findNearbyRadio(labelItem, modal);
      const targetRect = radio ? radio.rect : labelItem.rect;
      await clickAt(targetRect.left + targetRect.width / 2, targetRect.top + targetRect.height / 2, `${typeName}/probe`);
      const verified = await waitActiveType(typeName, CONFIG.materialProbeVerifyTimeout || 1200);
      if (verified.modalClosed) throw new Error(`推广面板在点击「${typeName}」后意外关闭`);
      if (verified.ok) {
        Logger.info(`已确认切换素材类型：${typeName}`);
        return true;
      }

      // 这里不再继续点 label/text。目标没有真实选中，就按“置灰不可用/当前活动不支持”处理，避免反复误点导致抽屉关闭。
      Logger.info(`素材类型不可用，跳过：${typeName}（点击后未选中，当前选中：${verified.activeType || beforeActive || '无'}）`);
      return false;
    };
  }

  applyMeituanCollectorV113Patch();

  /**
   * V1.1.4 修复：
   * 1. 不再用“文字节点附近任意深色边框/父级 active 类”判断素材已选中；
   * 2. 只认目标素材自己的 radio/input/label 选中态，或点击后素材内容真实刷新；
   * 3. 点击不可选素材后如果没有真实选中，立即跳过，不再输出“已确认切换”。
   */
  function applyMeituanCollectorV114Patch() {
    CONFIG.version = 'V1.1.4';
    CONFIG.materialStrictSelectVerify = true;

    const MATERIAL_TYPES_V114 = ['短链接', '长链接', '呼起协议', '小程序路径', 'H5链接二维码', '小程序二维码', '团口令', '搜索密令'];

    const allV114 = (selector, root = document) => Array.from((root || document).querySelectorAll(selector));
    const textV114 = (element) => DOM.normalizeText(element ? element.innerText || element.textContent || '' : '');
    const compactV114 = (value) => compactOptionText(String(value || ''));

    const getDrawerV114 = () => {
      const modal = PromotionModal.currentModal || PromotionModal.findModal && PromotionModal.findModal();
      if (modal && DOM.isVisible(modal) && !modal.closest('#mtamc-panel')) return modal;
      return allV114('aside,section,div,[role="dialog"], [class*="drawer"], [class*="modal"]')
        .filter((element) => DOM.isVisible(element) && !element.closest('#mtamc-panel'))
        .filter((element) => {
          const content = textV114(element);
          const rect = element.getBoundingClientRect();
          return content.includes('选择推广媒体') && content.includes('文案素材') && rect.width > 380 && rect.height > 180 && rect.right > window.innerWidth * 0.45;
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.width * ra.height - rb.width * rb.height;
        })[0] || null;
    };

    const getMaterialAreaV114 = (modal = getDrawerV114()) => {
      if (!modal) return null;
      const label = DOM.findSmallestByText('文案素材', modal, true) || DOM.findSmallestByText('文案素材', modal, false);
      if (!label) return modal;
      let current = label.parentElement;
      const candidates = [];
      while (current && current !== modal.parentElement) {
        if (DOM.isVisible(current)) {
          const content = textV114(current);
          const rect = current.getBoundingClientRect();
          const count = MATERIAL_TYPES_V114.filter((type) => content.includes(type)).length;
          if (content.includes('文案素材') && count >= 2 && rect.width >= 360 && rect.height >= 45 && rect.height <= 260) {
            candidates.push({ element: current, area: rect.width * rect.height, count });
          }
        }
        if (current === modal) break;
        current = current.parentElement;
      }
      candidates.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.area - b.area;
      });
      return candidates[0] ? candidates[0].element : modal;
    };

    const findTextNodeV114 = (typeName, area) => {
      const target = compactV114(typeName);
      const nodes = allV114('label,span,div,p,i,b,strong', area)
        .filter((node) => DOM.isVisible(node) && !node.closest('#mtamc-panel'))
        .map((node) => {
          const txt = textV114(node);
          const rect = node.getBoundingClientRect();
          return { node, txt, compact: compactV114(txt), rect, area: rect.width * rect.height };
        })
        .filter((item) => item.compact === target || item.txt === typeName)
        .sort((a, b) => a.area - b.area);
      return nodes[0] || null;
    };

    const nodeLooksRadioV114 = (node, rect = node && node.getBoundingClientRect()) => {
      if (!node || !rect) return false;
      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      const role = node.getAttribute && node.getAttribute('role');
      const cls = String(node.className || '');
      if (tag === 'input' && node.type === 'radio') return true;
      if (role === 'radio') return true;
      if (/radio/i.test(cls) && rect.width <= 42 && rect.height <= 42) return true;
      const style = window.getComputedStyle(node);
      const radius = parseFloat(style.borderRadius || '0');
      return rect.width >= 10 && rect.width <= 34 && rect.height >= 10 && rect.height <= 34 && radius >= Math.min(rect.width, rect.height) * 0.35;
    };

    const findMaterialItemV114 = (typeName, modal = getDrawerV114()) => {
      const area = getMaterialAreaV114(modal);
      if (!area) return null;
      const labelNode = findTextNodeV114(typeName, area);
      if (!labelNode) return null;
      const labelRect = labelNode.rect;
      const labelY = labelRect.top + labelRect.height / 2;

      let root = labelNode.node.closest && labelNode.node.closest('label,[role="radio"]');
      if (!root || !area.contains(root)) {
        let current = labelNode.node.parentElement;
        const rootCandidates = [];
        while (current && current !== area.parentElement) {
          if (DOM.isVisible(current)) {
            const content = textV114(current);
            const rect = current.getBoundingClientRect();
            const typeCount = MATERIAL_TYPES_V114.filter((type) => content.includes(type)).length;
            if (content.includes(typeName) && typeCount <= 1 && rect.height <= 60 && rect.width <= 260) {
              rootCandidates.push({ element: current, area: rect.width * rect.height });
            }
          }
          if (current === area) break;
          current = current.parentElement;
        }
        rootCandidates.sort((a, b) => a.area - b.area);
        root = rootCandidates[0] ? rootCandidates[0].element : labelNode.node.parentElement;
      }

      const radioFromRoot = root ? allV114('input[type="radio"],[role="radio"],span,div,i', root)
        .filter((node) => DOM.isVisible(node))
        .map((node) => ({ element: node, rect: node.getBoundingClientRect() }))
        .filter(({ element, rect }) => nodeLooksRadioV114(element, rect))
        .sort((a, b) => {
          const ax = a.rect.left + a.rect.width / 2;
          const bx = b.rect.left + b.rect.width / 2;
          return Math.abs((labelRect.left - ax) - 24) - Math.abs((labelRect.left - bx) - 24);
        })[0] : null;

      const radioFromArea = allV114('input[type="radio"],[role="radio"],span,div,i', area)
        .filter((node) => DOM.isVisible(node) && !node.closest('#mtamc-panel'))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          return { element: node, rect, centerX, centerY, horizontalGap: labelRect.left - centerX, verticalGap: Math.abs(centerY - labelY) };
        })
        .filter((item) => nodeLooksRadioV114(item.element, item.rect) && item.horizontalGap >= -4 && item.horizontalGap <= 92 && item.verticalGap <= 18)
        .sort((a, b) => {
          const sa = Math.abs(a.horizontalGap - 26) + a.verticalGap * 4;
          const sb = Math.abs(b.horizontalGap - 26) + b.verticalGap * 4;
          return sa - sb;
        })[0];

      const radio = radioFromRoot || radioFromArea || null;
      return { typeName, area, root, labelNode: labelNode.node, labelRect, radio };
    };

    const hasDisabledV114 = (item) => {
      if (!item) return '当前活动未展示该素材类型';
      if (item.typeName === '搜索密令' || (CONFIG.skipMaterialTypes || []).includes(item.typeName)) return '业务配置不采集';
      const nodes = [item.root, item.labelNode, item.radio && item.radio.element].filter(Boolean);
      for (const node of nodes) {
        if (node.disabled === true) return '素材类型不可用';
        if (node.getAttribute && node.getAttribute('disabled') !== null) return '素材类型不可用';
        if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') return '素材类型不可用';
        const disabledAncestor = node.closest && node.closest('[disabled],[aria-disabled="true"],.disabled,.is-disabled,[class*="Disabled"],[class*="disabled"]');
        if (disabledAncestor && item.area && item.area.contains(disabledAncestor)) return '素材类型不可用';
        const cls = String(node.className || '');
        if (/(^|\s|_|-)(disabled|is-disabled|radio-disabled|mtd-radio-disabled|ant-radio-disabled)(\s|_|-|$)/i.test(cls)) return '素材类型不可用';
        const style = window.getComputedStyle(node);
        if (style.pointerEvents === 'none' || style.cursor === 'not-allowed') return '素材类型不可用';
        if (Number(style.opacity) > 0 && Number(style.opacity) < 0.45) return '素材类型不可用';
      }
      return '';
    };

    const isDarkBackgroundV114 = (value) => {
      const m = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
      if (!m) return false;
      const r = Number(m[1]);
      const g = Number(m[2]);
      const b = Number(m[3]);
      const a = m[4] === undefined ? 1 : Number(m[4]);
      if (a < 0.65) return false;
      return r < 90 && g < 90 && b < 90;
    };

    const visualSelectedV114 = (item) => {
      if (!item || !item.radio || !item.radio.element) return false;
      const radio = item.radio.element;
      const radioRect = item.radio.rect || radio.getBoundingClientRect();
      const nodes = [radio, ...allV114('*', radio)].filter((node) => DOM.isVisible(node));
      for (const node of nodes.slice(0, 30)) {
        const rect = node.getBoundingClientRect();
        // 只认“内点”的深色背景，不认外圈 border，避免把未选中圆圈误判为选中。
        if (rect.width > radioRect.width * 0.75 || rect.height > radioRect.height * 0.75) continue;
        if (rect.width < 3 || rect.height < 3) continue;
        const style = window.getComputedStyle(node);
        if (isDarkBackgroundV114(style.backgroundColor)) return true;
      }
      for (const pseudo of ['::before', '::after']) {
        const style = window.getComputedStyle(radio, pseudo);
        if (style && isDarkBackgroundV114(style.backgroundColor)) return true;
      }
      return false;
    };

    const selectedByOwnStateV114 = (item) => {
      if (!item) return false;
      const radio = item.radio && item.radio.element;
      const root = item.root;
      const input = (root && root.querySelector && root.querySelector('input[type="radio"]')) || (radio && radio.matches && radio.matches('input[type="radio"]') ? radio : null);
      if (input && input.checked === true) return true;
      for (const node of [radio, root, item.labelNode].filter(Boolean)) {
        if (node.getAttribute && node.getAttribute('aria-checked') === 'true') return true;
      }
      // 只看目标素材自己的短层级，不看大面积父容器，避免被其他选中项污染。
      for (const node of [radio, radio && radio.parentElement, root].filter(Boolean)) {
        const cls = String(node.className || '');
        if (/(^|\s|_|-)(checked|is-checked|mtd-radio-checked|ant-radio-checked)(\s|_|-|$)/i.test(cls) && !/uncheck|unchecked/i.test(cls)) return true;
      }
      return visualSelectedV114(item);
    };

    const getActiveMaterialTypeV114 = (modal = getDrawerV114()) => {
      if (!modal) return '';
      for (const typeName of MATERIAL_TYPES_V114) {
        if (typeName === '搜索密令') continue;
        const item = findMaterialItemV114(typeName, modal);
        if (selectedByOwnStateV114(item)) return typeName;
      }
      return '';
    };

    const materialContentSnapshotV114 = (modal = getDrawerV114()) => {
      if (!modal) return '';
      const values = [];
      allV114('textarea,input,[contenteditable="true"],img', modal)
        .filter((node) => DOM.isVisible(node) && !node.closest('#mtamc-panel'))
        .forEach((node) => {
          const tag = node.tagName ? node.tagName.toLowerCase() : '';
          if (tag === 'img') {
            const src = node.currentSrc || node.src || node.getAttribute('data-src') || '';
            if (src) values.push(src);
          } else {
            const value = node.value || textV114(node);
            if (value) values.push(value);
          }
        });
      return values.join('\n').trim();
    };

    const clickMaterialItemV114 = async (item, reason) => {
      const target = (item.radio && item.radio.element) || item.root || item.labelNode;
      const rect = (item.radio && item.radio.rect) || target.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const point = document.elementFromPoint(x, y) || target;
      const eventOptions = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      Logger.info(`点击素材：${reason} x=${Math.round(x)}, y=${Math.round(y)}, 命中=${point.tagName} ${textV114(point).slice(0, 18)}`);
      const targets = uniqueElements([point, target]).filter(Boolean);
      targets.forEach((node) => {
        if (window.PointerEvent) {
          node.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
          node.dispatchEvent(new PointerEvent('pointerup', eventOptions));
        }
        node.dispatchEvent(new MouseEvent('mouseover', eventOptions));
        node.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        node.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        node.dispatchEvent(new MouseEvent('click', eventOptions));
        if (typeof node.click === 'function') {
          try { node.click(); } catch (error) { /* ignore */ }
        }
      });
      await DOM.sleep(CONFIG.materialFastSwitchDelay || 260);
    };

    const waitMaterialSelectedV114 = async (typeName, beforeSnapshot, timeout = 1100) => {
      const start = Date.now();
      let activeType = '';
      let changed = false;
      while (Date.now() - start < timeout) {
        const modal = getDrawerV114();
        if (!modal) return { modalClosed: true, activeType, changed };
        const item = findMaterialItemV114(typeName, modal);
        activeType = getActiveMaterialTypeV114(modal);
        const snapshot = materialContentSnapshotV114(modal);
        changed = Boolean(snapshot && snapshot !== beforeSnapshot);
        if (selectedByOwnStateV114(item)) return { ok: true, activeType: typeName, changed, modalClosed: false };
        // 某些组件选中态类不稳定，但内容真实刷新，可以视为切换成功；不能用空内容放行。
        if (changed && snapshot.length > 8) return { ok: true, activeType: typeName, changed, modalClosed: false };
        await DOM.sleep(120);
      }
      const modal = getDrawerV114();
      activeType = modal ? getActiveMaterialTypeV114(modal) : '';
      return { ok: false, modalClosed: !modal, activeType, changed };
    };

    PromotionModal.getActiveMaterialType = getActiveMaterialTypeV114;
    PromotionModal.isMaterialTypeEnabled = function isMaterialTypeEnabledV114(typeName) {
      const item = findMaterialItemV114(typeName, getDrawerV114());
      return !hasDisabledV114(item);
    };

    PromotionModal.selectMaterialType = async function selectMaterialTypeV114(typeName) {
      let modal = getDrawerV114() || PromotionModal.currentModal || (await PromotionModal.waitForPromotionModal());
      if (!modal) throw new Error('推广面板未打开，无法选择素材');

      const item = findMaterialItemV114(typeName, modal);
      const disabledReason = hasDisabledV114(item);
      if (disabledReason) {
        Logger.info(`素材类型不可用，跳过：${typeName}（${disabledReason}）`);
        return false;
      }

      if (selectedByOwnStateV114(item)) {
        Logger.info(`已确认切换素材类型：${typeName}`);
        return true;
      }

      const beforeSnapshot = materialContentSnapshotV114(modal);
      await clickMaterialItemV114(item, `${typeName}/strict-radio`);
      let result = await waitMaterialSelectedV114(typeName, beforeSnapshot, CONFIG.materialProbeVerifyTimeout || 1200);
      if (result.modalClosed) throw new Error(`推广面板在点击「${typeName}」后意外关闭`);
      if (result.ok) {
        Logger.info(`已确认切换素材类型：${typeName}`);
        return true;
      }

      // 只做一次轻量补点 label，不再 radio/label/text 多轮轰炸，防止不可用素材把抽屉点关闭。
      if (item.root && item.root !== ((item.radio && item.radio.element) || item.labelNode)) {
        await clickMaterialItemV114({ ...item, radio: null }, `${typeName}/strict-label`);
        result = await waitMaterialSelectedV114(typeName, beforeSnapshot, 800);
        if (result.modalClosed) throw new Error(`推广面板在点击「${typeName}」后意外关闭`);
        if (result.ok) {
          Logger.info(`已确认切换素材类型：${typeName}`);
          return true;
        }
      }

      Logger.info(`素材类型不可用，跳过：${typeName}（点击后未真实选中，当前选中：${result.activeType || getActiveMaterialTypeV114(getDrawerV114()) || '无'}）`);
      return false;
    };
  }

  applyMeituanCollectorV114Patch();


  function extractLinks(text) {
    const source = String(text || '');
    const patterns = [
      /https?:\/\/[^\s"'<>，。；、]+/gi,
      /(?:^|[\s，。；、])((?:www\.)?dpurl\.cn\/[A-Za-z0-9._~/?#%&=+-]+)/gi,
      /\b((?:imeituan|meituan|dianping|mt|meituanwaimai):\/\/[^\s"'<>，。；、]+)/gi,
      /\b(pages\/[A-Za-z0-9_./-]+(?:\?[A-Za-z0-9_./?%&=:+-]+)?)/gi
    ];
    const links = [];
    patterns.forEach((pattern) => {
      let match = pattern.exec(source);
      while (match) {
        const value = (match[1] || match[0] || '').trim();
        if (value && !links.includes(value)) links.push(value);
        match = pattern.exec(source);
      }
    });
    return links;
  }

  function parseDateRange(text) {
    const source = String(text || '');
    const match = source.match(
      /(\d{4})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?\s*[-~至]\s*(?:(\d{4})[.\-/年])?(\d{1,2})[.\-/月](\d{1,2})日?/
    );
    if (!match) return { start: '', end: '' };
    const startYear = match[1];
    const endYear = match[4] || startYear;
    return {
      start: `${startYear}-${pad2(match[2])}-${pad2(match[3])}`,
      end: `${endYear}-${pad2(match[5])}-${pad2(match[6])}`
    };
  }

  function pad2(value) {
    return String(value || '').padStart(2, '0');
  }

  function splitLines(text) {
    return String(text || '')
      .split(/\n+/)
      .map((line) => DOM.normalizeText(line))
      .filter(Boolean);
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements.filter(Boolean)));
  }

  function compactOptionText(text) {
    return String(text || '')
      .replace(/\s+/g, '')
      .replace(/[>*：:，,。；;]/g, '')
      .trim();
  }

  function compactMediaDisplayText(text) {
    return compactOptionText(text)
      .replace(/-\d+$/, '')
      .replace(/-\d+C$/i, '');
  }

  function escapeHTML(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    return `"${text.replace(/"/g, '""')}"`;
  }

  function timestampForFile() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
  }

  function init() {
    State.init();
    UI.createControlPanel();
    Logger.info('脚本版本 V1.1.4 已加载，请在活动推广页点击「开始采集」');
    window.MeituanActivityMaterialCollector = {
      CONFIG,
      State,
      Storage,
      Logger,
      UI,
      DOM,
      TableParser,
      PromotionModal,
      Collector,
      Exporter,
      extractLinks
    };
  }

  init();

  /*
   * 使用说明
   * 1. 安装脚本：在 Tampermonkey / 油猴中新建脚本，粘贴本文件全部内容并保存。
   * 2. 配置媒体位和推广位：修改 CONFIG.mediaName 和 CONFIG.promotionPositionName。
   * 3. 配置素材类型：修改 CONFIG.materialTypes。可加入 CONFIG.optionalMaterialTypes 中的项目。
   * 4. 开始采集：登录美团联盟后台，进入「物料推广 > 活动推广」，点击右下角「开始采集」。
   * 5. 导出数据：点击「导出 CSV」或「导出 JSON」。CSV 已加 BOM，Excel 打开中文不易乱码。
   * 6. 常见问题：
   *    - 找不到「立即推广」：确认当前页列表已加载，且按钮文字未变化。
   *    - 找不到媒体位：确认 CONFIG.mediaName 与下拉选项文字完全一致。
   *    - 找不到推广位：确认已选媒体下存在 CONFIG.promotionPositionName。
   *    - textarea 为空：脚本会自动重试 3 次；仍为空时会记录 failed。
   *    - 弹窗未打开：脚本会重试点击最多 2 次；仍失败时记录该行失败。
   *    - 导出为空：先确认控制面板记录数大于 0，或检查是否已清空缓存。
   */
})();
