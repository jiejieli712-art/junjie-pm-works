// ==UserScript==
// @name         淘宝闪购会场推广采集助手
// @namespace    https://ganfanba.local/userscripts
// @version      1.0.5
// @description  在淘宝闪购联盟「会场推广」页面批量采集会场活动及各推广链路文案，导出 CSV / JSON。
// @author       Codex
// @match        https://union.ele.me/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = 'V1.0.5';

  const TARGET_HASH = '#/alliance-child-mine-promotion/activity-ele-promotion';

  const CONFIG = {
    promotionPositionName: '自有平台/小程序/快应用/干饭吧智能决策管家/testlocationv1',
    linkTypes: ['微信', '支付宝', '淘宝', '淘宝闪购', 'H5'],
    skipDisabledLinkTypes: true,
    delay: {
      click: 650,
      page: 1500,
      dropdown: 700,
      linkSwitch: 900,
      nextCard: 1000,
      retry: 600
    },
    maxClickRetry: 2,
    storageKey: 'taobao_shangou_venue_collector_cache',
    stateKey: 'taobao_shangou_venue_collector_state',
    panelPositionKey: 'taobao_shangou_venue_collector_panel_position',
    panelMinimizedKey: 'taobao_shangou_venue_collector_panel_minimized',
    exportFilePrefix: 'taobao_shangou_venue_materials'
  };

  const LINK_TYPE_META = {
    微信: { prefix: 'wechat' },
    支付宝: { prefix: 'alipay' },
    淘宝: { prefix: 'taobao' },
    淘宝闪购: { prefix: 'taobao_shangou' },
    H5: { prefix: 'h5' }
  };

  const BASE_FIELDS = [
    'activity_venue_id',
    'activity_name',
    'activity_status',
    'activity_desc',
    'start_date',
    'end_date',
    'commission_rate',
    'banner_url',
    'promotion_position_name'
  ];

  const LINK_FIELD_SUFFIXES = [
    'available',
    'text',
    'link',
    'links',
    'appid',
    'mini_program_link',
    'image_url',
    'status',
    'error'
  ];

  const CSV_FIELDS = [
    ...BASE_FIELDS,
    ...CONFIG.linkTypes.flatMap((type) => LINK_FIELD_SUFFIXES.map((suffix) => `${LINK_TYPE_META[type].prefix}_${suffix}`)),
    'status',
    'error_message',
    'page_index',
    'row_index',
    'collected_at'
  ];

  const BASE_FIELD_LABELS = {
    activity_venue_id: '活动会场ID',
    activity_name: '活动名称',
    activity_status: '活动状态',
    activity_desc: '活动描述',
    start_date: '开始日期',
    end_date: '结束日期',
    commission_rate: '预估佣金',
    banner_url: '活动图片地址',
    promotion_position_name: '推广位',
    status: '整体采集状态',
    error_message: '整体失败原因',
    page_index: '页码',
    row_index: '活动序号',
    collected_at: '采集时间'
  };

  const LINK_FIELD_LABELS = {
    available: '是否可用',
    text: '文案内容',
    link: '主链接',
    links: '全部链接',
    appid: 'APPID',
    mini_program_link: '小程序链接',
    image_url: '图片地址',
    status: '采集状态',
    error: '失败原因'
  };

  const CSV_HEADER_LABELS = buildCsvHeaderLabels();

  const State = {
    status: '未开始',
    records: [],
    logs: [],
    currentIndex: 0,
    total: 0,
    currentPage: 1,
    totalPages: 1,
    currentTaskIndex: 0,
    totalTasks: 0,
    currentActivityName: '-',
    currentLinkType: '-',
    running: false,
    paused: false,
    stopped: false,

    init() {
      this.records = Storage.loadRecords();
      const saved = Storage.loadState();
      this.currentIndex = saved.currentIndex || 0;
    },

    setStatus(status) {
      this.status = status;
      UI.update();
    },

    setProgress(index, total, activityName, linkType) {
      this.currentIndex = index;
      this.total = total;
      this.currentActivityName = activityName || '-';
      if (linkType !== undefined) this.currentLinkType = linkType || '-';
      Storage.saveState({ currentIndex: index });
      UI.update();
    },

    setPageProgress(currentPage, totalPages) {
      this.currentPage = currentPage || 1;
      this.totalPages = totalPages || 1;
      UI.update();
    },

    setTaskProgress(currentTaskIndex, totalTasks) {
      this.currentTaskIndex = currentTaskIndex || 0;
      this.totalTasks = totalTasks || 0;
      Storage.saveState({ currentTaskIndex: this.currentTaskIndex, totalTasks: this.totalTasks });
      UI.update();
    },

    counts() {
      return this.records.reduce(
        (acc, record) => {
          if (record.status === 'success') acc.success += 1;
          else if (record.status === 'failed') acc.failed += 1;
          else if (record.status === 'partial') acc.partial += 1;
          CONFIG.linkTypes.forEach((type) => {
            const prefix = LINK_TYPE_META[type].prefix;
            if (record[`${prefix}_status`] === 'skipped') acc.skipped += 1;
          });
          return acc;
        },
        { success: 0, partial: 0, failed: 0, skipped: 0 }
      );
    }
  };

  const Storage = {
    loadRecords() {
      try {
        const raw = localStorage.getItem(CONFIG.storageKey);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        console.warn('[淘宝闪购会场采集助手] 缓存读取失败', error);
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

    saveState(partial) {
      localStorage.setItem(CONFIG.stateKey, JSON.stringify({ ...this.loadState(), ...partial }));
    },

    makeKey(record) {
      const position = record.promotion_position_name || CONFIG.promotionPositionName || '';
      if (record.activity_venue_id) return `${record.activity_venue_id}::${position}`;
      return `${record.activity_name || ''}::${record.start_date || ''}::${record.end_date || ''}::${position}`;
    },

    hasRecord(base) {
      const key = this.makeKey({ ...base, promotion_position_name: CONFIG.promotionPositionName });
      return State.records.some((record) => this.makeKey(record) === key && record.status === 'success');
    },

    upsertRecord(record) {
      const key = this.makeKey(record);
      const index = State.records.findIndex((item) => this.makeKey(item) === key);
      if (index >= 0) State.records.splice(index, 1, record);
      else State.records.push(record);
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
        level,
        time: new Date().toLocaleTimeString(),
        message: String(message || '')
      };
      State.logs.unshift(item);
      State.logs = State.logs.slice(0, 30);
      const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[method](`[淘宝闪购会场采集助手] ${item.message}`);
      UI.update();
    },

    info(message) {
      this.push('info', message);
    },

    success(message) {
      this.push('success', message);
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
      if (document.getElementById('tbsg-panel')) return;
      const style = document.createElement('style');
      style.id = 'tbsg-style';
      style.textContent = `
        #tbsg-panel {
          position: fixed;
          right: 18px;
          bottom: 18px;
          z-index: 2147483647;
          width: 370px;
          box-sizing: border-box;
          background: #fff;
          color: #1f2329;
          border: 1px solid #d9dde6;
          border-radius: 8px;
          box-shadow: 0 12px 34px rgba(15, 23, 42, 0.18);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          font-size: 13px;
          line-height: 1.5;
          overflow: hidden;
        }
        #tbsg-panel * { box-sizing: border-box; }
        .tbsg-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          background: #ff6a00;
          color: #fff;
          cursor: move;
          user-select: none;
          font-weight: 700;
        }
        .tbsg-title {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .tbsg-tools {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 0 0 auto;
        }
        .tbsg-mini-btn {
          width: 24px;
          height: 24px;
          padding: 0;
          border: 0;
          border-radius: 5px;
          background: rgba(255, 255, 255, 0.22);
          color: #fff;
          cursor: pointer;
          font-size: 16px;
          line-height: 22px;
          font-weight: 700;
        }
        .tbsg-body { padding: 12px; }
        #tbsg-panel.tbsg-minimized { width: 310px; }
        #tbsg-panel.tbsg-minimized .tbsg-body { display: none; }
        .tbsg-row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 6px;
        }
        .tbsg-label { color: #697386; white-space: nowrap; }
        .tbsg-value {
          min-width: 0;
          text-align: right;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .tbsg-progress {
          height: 8px;
          border-radius: 999px;
          background: #eef1f5;
          overflow: hidden;
          margin: 8px 0 10px;
        }
        .tbsg-progress > span {
          display: block;
          height: 100%;
          width: 0;
          background: #ff6a00;
          transition: width 0.2s ease;
        }
        .tbsg-actions {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          margin: 10px 0;
        }
        .tbsg-actions button {
          height: 32px;
          border: 1px solid #c9ced8;
          background: #fff;
          color: #1f2329;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12px;
        }
        .tbsg-actions button:hover { background: #f6f7f9; }
        .tbsg-actions button[data-primary="true"] {
          background: #1f2329;
          color: #fff;
          border-color: #1f2329;
        }
        .tbsg-log {
          height: 180px;
          overflow: auto;
          padding: 8px;
          background: #f6f7f9;
          border: 1px solid #eceff3;
          border-radius: 6px;
          color: #414957;
          font-size: 12px;
          user-select: text;
        }
        .tbsg-log-item { padding-bottom: 5px; word-break: break-word; }
        .tbsg-log-item[data-level="error"] { color: #b42318; }
        .tbsg-log-item[data-level="warn"] { color: #b54708; }
        .tbsg-log-item[data-level="success"] { color: #027a48; }
      `;
      document.head.appendChild(style);

      const root = document.createElement('div');
      root.id = 'tbsg-panel';
      root.innerHTML = `
        <div class="tbsg-head">
          <span class="tbsg-title">淘宝闪购会场采集助手 <small>${VERSION}</small></span>
          <span class="tbsg-tools">
            <span id="tbsg-record-count">0 条</span>
            <button class="tbsg-mini-btn" id="tbsg-minimize" type="button" title="最小化/展开">−</button>
          </span>
        </div>
        <div class="tbsg-body">
          <div class="tbsg-row"><span class="tbsg-label">状态</span><span class="tbsg-value" id="tbsg-status">未开始</span></div>
          <div class="tbsg-row"><span class="tbsg-label">当前页</span><span class="tbsg-value" id="tbsg-page-progress">1 / 1</span></div>
          <div class="tbsg-row"><span class="tbsg-label">当前任务</span><span class="tbsg-value" id="tbsg-task-progress">0 / 0</span></div>
          <div class="tbsg-row"><span class="tbsg-label">进度</span><span class="tbsg-value" id="tbsg-progress-text">0 / 0</span></div>
          <div class="tbsg-row"><span class="tbsg-label">成功 / 失败 / 跳过</span><span class="tbsg-value" id="tbsg-counts">0 / 0 / 0</span></div>
          <div class="tbsg-row"><span class="tbsg-label">当前活动</span><span class="tbsg-value" id="tbsg-current">-</span></div>
          <div class="tbsg-row"><span class="tbsg-label">当前链路</span><span class="tbsg-value" id="tbsg-link-type">-</span></div>
          <div class="tbsg-progress"><span id="tbsg-progress-bar"></span></div>
          <div class="tbsg-actions">
            <button id="tbsg-start" data-primary="true">开始采集</button>
            <button id="tbsg-pause">暂停</button>
            <button id="tbsg-stop">停止</button>
            <button id="tbsg-export-csv">导出 CSV</button>
            <button id="tbsg-export-json">导出 JSON</button>
            <button id="tbsg-clear">清空缓存</button>
          </div>
          <div class="tbsg-log" id="tbsg-log"></div>
        </div>
      `;
      document.body.appendChild(root);
      this.root = root;
      this.fields = {
        recordCount: root.querySelector('#tbsg-record-count'),
        status: root.querySelector('#tbsg-status'),
        pageProgress: root.querySelector('#tbsg-page-progress'),
        taskProgress: root.querySelector('#tbsg-task-progress'),
        progressText: root.querySelector('#tbsg-progress-text'),
        counts: root.querySelector('#tbsg-counts'),
        current: root.querySelector('#tbsg-current'),
        linkType: root.querySelector('#tbsg-link-type'),
        progressBar: root.querySelector('#tbsg-progress-bar'),
        log: root.querySelector('#tbsg-log'),
        pause: root.querySelector('#tbsg-pause')
      };

      root.querySelector('#tbsg-start').addEventListener('click', () => Collector.start());
      root.querySelector('#tbsg-pause').addEventListener('click', () => Collector.togglePause());
      root.querySelector('#tbsg-stop').addEventListener('click', () => Collector.stop());
      root.querySelector('#tbsg-export-csv').addEventListener('click', () => Exporter.exportCSV());
      root.querySelector('#tbsg-export-json').addEventListener('click', () => Exporter.exportJSON());
      root.querySelector('#tbsg-clear').addEventListener('click', () => {
        if (window.confirm('确认清空本地缓存的采集数据？')) Storage.clear();
      });
      root.querySelector('#tbsg-minimize').addEventListener('click', (event) => {
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
      const progressTotal = State.totalTasks || State.total;
      const progressCurrent = State.currentTaskIndex || State.currentIndex;
      const progressPercent = progressTotal ? Math.round((Math.min(progressCurrent, progressTotal) / progressTotal) * 100) : 0;
      this.fields.recordCount.textContent = `${State.records.length} 条`;
      this.fields.status.textContent = State.status;
      this.fields.pageProgress.textContent = `${State.currentPage || 1} / ${State.totalPages || 1}`;
      this.fields.taskProgress.textContent = `${State.currentTaskIndex || 0} / ${State.totalTasks || 0}`;
      this.fields.progressText.textContent = `${Math.min(State.currentIndex, State.total)} / ${State.total}`;
      this.fields.counts.textContent = `${counts.success + counts.partial} / ${counts.failed} / ${counts.skipped}`;
      this.fields.current.textContent = State.currentActivityName || '-';
      this.fields.linkType.textContent = State.currentLinkType || '-';
      this.fields.progressBar.style.width = `${progressPercent}%`;
      this.fields.pause.textContent = State.paused ? '继续' : '暂停';
      this.fields.log.innerHTML = State.logs
        .map(
          (item) =>
            `<div class="tbsg-log-item" data-level="${escapeHTML(item.level)}">[${escapeHTML(item.time)}] ${escapeHTML(
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
      const header = this.root.querySelector('.tbsg-head');
      header.addEventListener('mousedown', (event) => {
        if (event.button !== 0 || event.target.closest('button')) return;
        const rect = this.root.getBoundingClientRect();
        this.dragState = { startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
        document.addEventListener('mousemove', this.handleDragMove);
        document.addEventListener('mouseup', this.handleDragEnd);
        event.preventDefault();
      });
    },

    handleDragMove: (event) => {
      if (!UI.dragState) return;
      UI.setPanelPosition(
        UI.dragState.left + event.clientX - UI.dragState.startX,
        UI.dragState.top + event.clientY - UI.dragState.startY
      );
    },

    handleDragEnd: () => {
      UI.dragState = null;
      UI.savePanelPosition();
      document.removeEventListener('mousemove', UI.handleDragMove);
      document.removeEventListener('mouseup', UI.handleDragEnd);
    },

    setPanelPosition(left, top) {
      const rect = this.root.getBoundingClientRect();
      const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
      const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
      this.root.style.left = `${Math.min(Math.max(8, left), maxLeft)}px`;
      this.root.style.top = `${Math.min(Math.max(8, top), maxTop)}px`;
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
      this.root.classList.toggle('tbsg-minimized', this.minimized);
      const button = this.root.querySelector('#tbsg-minimize');
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
      if (!element || element.nodeType !== 1 || element.closest('#tbsg-panel')) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },

    isDisabled(element) {
      if (!element) return true;
      const style = window.getComputedStyle(element);
      return Boolean(
        element.disabled ||
          element.getAttribute('aria-disabled') === 'true' ||
          element.closest('[disabled],[aria-disabled="true"],.disabled,[class*="disabled"],[class*="Disabled"]') ||
          style.pointerEvents === 'none' ||
          Number(style.opacity) < 0.45
      );
    },

    all(selector, root = document) {
      return Array.from(root.querySelectorAll(selector)).filter((element) => !element.closest('#tbsg-panel'));
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

    findByText(text, root = document, exact = true, selectors = 'button,a,span,div,label,p,li') {
      const target = this.normalizeText(text);
      const candidates = this.all(selectors, root).filter((element) => this.isVisible(element));
      candidates.sort((a, b) => area(a) - area(b));
      return candidates.find((element) => {
        const current = this.visibleText(element);
        return exact ? current === target : current.includes(target);
      });
    },

    findClickableByText(text, root = document, exact = true) {
      const found = this.findByText(text, root, exact, 'button,a,span,div,label,li,[role="button"],[role="option"]');
      return found ? this.clickableAncestor(found, root) : null;
    },

    clickableAncestor(element, boundary = document.body) {
      let current = element;
      while (current && current !== boundary.parentElement) {
        if (
          current.matches &&
          current.matches('button,a,label,li,[role="button"],[role="option"],[role="menuitem"],[role="combobox"]')
        ) {
          return current;
        }
        current = current.parentElement;
      }
      return element;
    },

    async clickElement(element, reason) {
      if (!element) throw new Error(`无法点击：${reason || '目标不存在'}`);
      element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      await this.delay('click');
      const rect = element.getBoundingClientRect();
      const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      };
      if (window.PointerEvent) {
        element.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
        element.dispatchEvent(new PointerEvent('pointerup', eventOptions));
      }
      element.dispatchEvent(new MouseEvent('mouseover', eventOptions));
      element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      element.dispatchEvent(new MouseEvent('click', eventOptions));
      if (typeof element.click === 'function') element.click();
    }
  };

  const ListParser = {
    parseVenueCards() {
      const promoteButtons = DOM.all('button,a,[role="button"]')
        .filter((element) => DOM.isVisible(element))
        .filter((element) => DOM.visibleText(element) === '立即推广');
      const cards = promoteButtons.map((button) => this.closestVenueCard(button)).filter(Boolean);
      return uniqueElements(cards);
    },

    closestVenueCard(button) {
      let current = button;
      while (current && current !== document.body) {
        const text = DOM.visibleText(current);
        const rect = current.getBoundingClientRect();
        if (
          text.includes('立即推广') &&
          (text.includes('活动会场ID') || text.includes('预估佣金') || text.includes('会场推广规则')) &&
          rect.width >= 260 &&
          rect.height >= 120 &&
          rect.height <= Math.max(560, window.innerHeight * 0.85)
        ) {
          return current;
        }
        current = current.parentElement;
      }
      return button.parentElement;
    },

    parseVenueCard(card, index) {
      const text = DOM.visibleText(card);
      const lines = splitLines(card.innerText || card.textContent || '');
      const venueId = (text.match(/活动会场ID[:：]?\s*([A-Za-z0-9_-]+)/) || [])[1] || '';
      const start = (text.match(/起[:：]?\s*(\d{4}-\d{1,2}-\d{1,2})/) || [])[1] || '';
      const end = (text.match(/止[:：]?\s*(\d{4}-\d{1,2}-\d{1,2})/) || [])[1] || '';
      const commission = (text.match(/预估佣金\s*([0-9.]+%?)/) || [])[1] || '';
      const status = lines.find((line) => /即将开始|进行中|已结束|未开始|已下线/.test(line)) || '';
      const image = card.querySelector('img');
      const name =
        lines.find(
          (line) =>
            line.length >= 3 &&
            !/立即推广|会场推广规则|活动会场ID|预估佣金|起[:：]|止[:：]|即将开始|进行中|已结束/.test(line)
        ) || '';
      const desc =
        lines.find(
          (line) =>
            line !== name &&
            line.length >= 3 &&
            !/立即推广|会场推广规则|活动会场ID|预估佣金|起[:：]|止[:：]|即将开始|进行中|已结束/.test(line)
        ) || '';
      return {
        activity_name: name,
        activity_status: status,
        activity_desc: desc,
        activity_venue_id: venueId,
        start_date: normalizeDate(start),
        end_date: normalizeDate(end),
        commission_rate: commission,
        banner_url: image ? image.currentSrc || image.src || image.getAttribute('data-src') || '' : '',
        row_index: index + 1,
        page_index: this.getPageIndex(),
        collected_at: new Date().toISOString()
      };
    },

    getPromoteButton(card) {
      return DOM.all('button,a,[role="button"]', card).find((element) => DOM.isVisible(element) && DOM.visibleText(element) === '立即推广');
    },

    findCardByBase(cards, base) {
      return cards.find((card, index) => {
        const parsed = this.parseVenueCard(card, index);
        if (base.activity_venue_id && parsed.activity_venue_id === base.activity_venue_id) return true;
        return parsed.activity_name === base.activity_name && parsed.start_date === base.start_date && parsed.end_date === base.end_date;
      });
    },

    getPageIndex() {
      return this.getCurrentPageIndex();
    },

    getPaginationInfo() {
      const rangeText = this.getPaginationRangeText();
      if (!rangeText) {
        const currentCards = this.parseVenueCards().length;
        return {
          currentPage: this.getCurrentPageIndex() || 1,
          pageSize: currentCards || 20,
          totalCount: currentCards || 0,
          totalPages: currentCards ? 1 : 0,
          fallback: true
        };
      }
      const match = rangeText.match(/(\d+)\s*-\s*(\d+)\s*of\s*(\d+)\s*条/);
      if (!match) return null;
      const start = Number(match[1]);
      const end = Number(match[2]);
      const totalCount = Number(match[3]);
      const activePage = this.getActivePageIndexFromRoot(this.findPaginationRoot());
      const currentRangeSize = Math.max(1, end - start + 1);
      const pageSize = activePage > 1 ? Math.max(currentRangeSize, Math.round((start - 1) / (activePage - 1))) : currentRangeSize;
      return {
        currentPage: activePage || Math.max(1, Math.ceil(start / pageSize)),
        pageSize,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
        fallback: false
      };
    },

    buildTaskQueue() {
      const info = this.getPaginationInfo();
      const currentCards = this.parseVenueCards();
      if (!info || !info.totalCount) {
        return currentCards.map((_, index) => ({
          pageIndex: this.getCurrentPageIndex() || 1,
          rowIndex: index + 1,
          taskKey: `page_${this.getCurrentPageIndex() || 1}_row_${index + 1}`,
          status: 'pending'
        }));
      }

      const tasks = [];
      for (let pageIndex = 1; pageIndex <= info.totalPages; pageIndex += 1) {
        const rowsOnPage =
          pageIndex < info.totalPages ? info.pageSize : Math.max(0, info.totalCount - info.pageSize * (info.totalPages - 1));
        for (let rowIndex = 1; rowIndex <= rowsOnPage; rowIndex += 1) {
          tasks.push({
            pageIndex,
            rowIndex,
            taskKey: `page_${pageIndex}_row_${rowIndex}`,
            status: 'pending'
          });
        }
      }
      return tasks;
    },

    findPaginationRangeElement() {
      const candidates = DOM.all('span,div,p')
        .filter((element) => DOM.isVisible(element))
        .map((element) => ({ element, text: DOM.visibleText(element), rect: element.getBoundingClientRect() }))
        .filter((item) => /\d+\s*-\s*\d+\s*of\s*\d+\s*条/.test(item.text))
        .filter((item) => item.rect.width >= 80 && item.rect.height >= 16 && item.rect.height <= 220)
        .sort((a, b) => {
          const exactA = /^\s*\d+\s*-\s*\d+\s*of\s*\d+\s*条\s*$/.test(a.text) ? 0 : 1;
          const exactB = /^\s*\d+\s*-\s*\d+\s*of\s*\d+\s*条\s*$/.test(b.text) ? 0 : 1;
          if (exactA !== exactB) return exactA - exactB;
          if (a.text.length !== b.text.length) return a.text.length - b.text.length;
          return area(a.element) - area(b.element);
        });
      return candidates[0] ? candidates[0].element : null;
    },

    getPaginationRangeText() {
      const rangeElement = this.findPaginationRangeElement();
      const elementText = rangeElement ? DOM.visibleText(rangeElement) : '';
      const elementMatch = elementText.match(/\d+\s*-\s*\d+\s*of\s*\d+\s*条/);
      if (elementMatch) return elementMatch[0];

      const pageText = DOM.all('span,div,p,li')
        .filter((element) => DOM.isVisible(element))
        .map((element) => DOM.visibleText(element))
        .find((text) => /\d+\s*-\s*\d+\s*of\s*\d+\s*条/.test(text));
      const pageMatch = pageText ? pageText.match(/\d+\s*-\s*\d+\s*of\s*\d+\s*条/) : null;
      return pageMatch ? pageMatch[0] : '';
    },

    findPaginationRoot() {
      const rangeElement = this.findPaginationRangeElement();
      if (!rangeElement) return document.body;
      let current = rangeElement.parentElement;
      while (current && current !== document.body) {
        const text = DOM.visibleText(current);
        const rect = current.getBoundingClientRect();
        if (/\d+\s*-\s*\d+\s*of\s*\d+\s*条/.test(text) && /\b1\b/.test(text) && rect.width >= 220 && rect.height <= 180) {
          return current;
        }
        current = current.parentElement;
      }
      return rangeElement.parentElement || document.body;
    },

    getCurrentPageIndex() {
      const root = this.findPaginationRoot();
      const activePage = this.getActivePageIndexFromRoot(root);
      if (activePage) return activePage;
      const info = this.getPaginationInfoFromRangeOnly();
      return info ? info.currentPage : 1;
    },

    getActivePageIndexFromRoot(root) {
      const active = DOM.all('[aria-current="page"], .active, .current, .selected, [class*="active"], [class*="selected"], li, button, a, div, span', root)
        .filter((element) => DOM.isVisible(element))
        .find((element) => /^\d+$/.test(DOM.visibleText(element)) && /active|current|selected/i.test(element.className || ''));
      return active ? Number(DOM.visibleText(active)) || 0 : 0;
    },

    getPaginationInfoFromRangeOnly() {
      const text = this.getPaginationRangeText();
      const match = text.match(/(\d+)\s*-\s*(\d+)\s*of\s*(\d+)\s*条/);
      if (!match) return null;
      const start = Number(match[1]);
      const end = Number(match[2]);
      const pageSize = Math.max(1, end - start + 1);
      return { currentPage: Math.max(1, Math.ceil(start / pageSize)), pageSize, totalCount: Number(match[3]) };
    },

    async goToPage(pageIndex) {
      const targetPage = Number(pageIndex) || 1;
      let currentPage = this.getCurrentPageIndex();
      if (currentPage === targetPage) {
        State.setPageProgress(currentPage, State.totalPages || this.getPaginationInfo().totalPages || 1);
        return true;
      }

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const previousSnapshot = this.getListSnapshot();
        const root = this.findPaginationRoot();
        const pageButton = this.findPageButton(targetPage, root);
        if (pageButton) {
          await DOM.clickElement(pageButton, `页码 ${targetPage}`);
        } else {
          const stepButton = this.findStepPageButton(targetPage > currentPage ? 'next' : 'prev', root);
          if (!stepButton) throw new Error(`无法跳转到第 ${targetPage} 页：找不到页码或翻页按钮`);
          await DOM.clickElement(stepButton, targetPage > currentPage ? '下一页' : '上一页');
        }

        await this.waitListStable(previousSnapshot);
        currentPage = this.getCurrentPageIndex();
        State.setPageProgress(currentPage, State.totalPages || this.getPaginationInfo().totalPages || 1);
        if (currentPage === targetPage) {
          Logger.info(`已跳转到第 ${targetPage} 页`);
          return true;
        }
        Logger.warn(`跳转第 ${targetPage} 页未确认，重试 ${attempt}/3，当前页 ${currentPage}`);
      }
      throw new Error(`无法跳转到第 ${targetPage} 页`);
    },

    findPageButton(pageIndex, root) {
      const target = String(pageIndex);
      const candidates = DOM.all('button,a,li,div,span,[role="button"]', root)
        .filter((element) => DOM.isVisible(element))
        .filter((element) => DOM.visibleText(element) === target)
        .map((element) => DOM.clickableAncestor(element, root))
        .filter((element) => !DOM.isDisabled(element));
      return uniqueElements(candidates).sort((a, b) => area(a) - area(b))[0] || null;
    },

    findStepPageButton(direction, root) {
      const buttons = DOM.all('button,a,li,div,span,[role="button"]', root)
        .filter((element) => DOM.isVisible(element))
        .map((element) => DOM.clickableAncestor(element, root))
        .filter((element) => !DOM.isDisabled(element));
      const unique = uniqueElements(buttons).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      const numericButtons = unique.filter((element) => /^\d+$/.test(DOM.visibleText(element)));
      if (!numericButtons.length) {
        return unique.find((element) => this.isStepButton(element, direction)) || null;
      }
      const firstPageButton = numericButtons[0].getBoundingClientRect();
      const lastPageButton = numericButtons[numericButtons.length - 1].getBoundingClientRect();
      if (direction === 'next') {
        return (
          unique.find((element) => this.isStepButton(element, direction)) ||
          unique.find((element) => element.getBoundingClientRect().left > lastPageButton.right && !/^\d+$/.test(DOM.visibleText(element))) ||
          null
        );
      }
      return (
        unique.find((element) => this.isStepButton(element, direction)) ||
        unique
          .slice()
          .reverse()
          .find((element) => element.getBoundingClientRect().right < firstPageButton.left && !/^\d+$/.test(DOM.visibleText(element))) ||
        null
      );
    },

    isStepButton(element, direction) {
      const text = DOM.visibleText(element);
      const aria = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`;
      if (direction === 'next') return /下一页|next|>|›|»/i.test(`${text} ${aria}`);
      return /上一页|prev|previous|<|‹|«/i.test(`${text} ${aria}`);
    },

    async waitListStable(previousSnapshot) {
      await DOM.waitFor(() => this.parseVenueCards().length > 0, 10000, 250);
      const changed = await DOM.waitFor(() => {
        const nextSnapshot = this.getListSnapshot();
        return nextSnapshot && nextSnapshot !== previousSnapshot;
      }, 1600, 200);
      if (!changed) await DOM.sleep(900);
      return true;
    },

    getListSnapshot() {
      return this.parseVenueCards()
        .map((card, index) => {
          const base = this.parseVenueCard(card, index);
          return `${base.activity_venue_id || ''}:${base.activity_name || ''}`;
        })
        .join('|');
    }
  };

  const DetailPage = {
    async clickPromote(card) {
      const button = ListParser.getPromoteButton(card);
      if (!button) throw new Error('找不到「立即推广」按钮');
      await DOM.clickElement(button, '立即推广');
      Logger.info('已点击「立即推广」');
    },

    async waitForDetailPage() {
      const detail = await DOM.waitFor(() => this.isDetailPage() && this.getDetailRoot(), 15000, 250);
      if (!detail) throw new Error('推广详情页未加载完成');
      await DOM.delay('page');
      return detail;
    },

    isDetailPage() {
      return Boolean(DOM.findByText('推广详情', document, false));
    },

    getDetailRoot() {
      const title = DOM.findByText('推广详情', document, false);
      if (!title) return null;
      let current = title;
      while (current && current !== document.body) {
        const text = DOM.visibleText(current);
        const rect = current.getBoundingClientRect();
        if (text.includes('推广详情') && (text.includes('推广位') || text.includes('推广链路')) && rect.width > 500 && rect.height > 300) {
          return current;
        }
        current = current.parentElement;
      }
      return document.body;
    },

    getRightPanel() {
      const root = this.getDetailRoot() || document.body;
      const anchor = DOM.findByText('推广位', root, false) || DOM.findByText('推广链路', root, false);
      if (!anchor) return root;
      let current = anchor;
      while (current && current !== root.parentElement) {
        const text = DOM.visibleText(current);
        const rect = current.getBoundingClientRect();
        if (text.includes('推广位') && (text.includes('推广链路') || text.includes('文案字段')) && rect.width >= 300 && rect.height >= 180) {
          return current;
        }
        current = current.parentElement;
      }
      return root;
    },

    async selectPromotionPosition(positionName) {
      const panel = await DOM.waitFor(() => this.getRightPanel(), 10000, 250);
      const label = DOM.findByText('推广位', panel, false);
      if (!label) throw new Error('找不到「推广位」字段');

      const group = this.findFieldGroup(label, panel);
      if (group && this.groupHasValue(group, positionName)) {
        Logger.info(`推广位已是：${positionName}`);
        return DOM.visibleText(group);
      }

      const trigger = await DOM.waitFor(() => this.findDropdownTrigger(group || panel, label, panel), 10000, 250);
      if (!trigger) throw new Error('找不到推广位下拉框');

      await DOM.clickElement(trigger, '推广位下拉框');
      await DOM.delay('dropdown');

      const option = await DOM.waitFor(() => this.findDropdownOption(positionName), 8000, 250);
      if (!option) throw new Error(`找不到推广位：${positionName}`);
      await DOM.clickElement(option, `推广位 ${positionName}`);
      await DOM.delay('dropdown');

      const selected = await DOM.waitFor(() => {
        const nextLabel = DOM.findByText('推广位', this.getRightPanel(), false);
        const nextGroup = nextLabel ? this.findFieldGroup(nextLabel, this.getRightPanel()) : null;
        return nextGroup && this.groupHasValue(nextGroup, positionName) ? nextGroup : null;
      }, 6000, 250);
      if (!selected) throw new Error(`选择推广位后未生效：${positionName}`);
      Logger.success(`已选择推广位：${positionName}`);
      return DOM.visibleText(selected);
    },

    findFieldGroup(label, panel) {
      let current = label.parentElement;
      while (current && current !== panel.parentElement) {
        const text = DOM.visibleText(current);
        if (text.includes('推广位') && current.querySelector('input,select,[role="combobox"],[class*="select"],[class*="Select"]')) return current;
        current = current.parentElement;
      }
      return label.parentElement;
    },

    groupHasValue(group, value) {
      const groupText = compactText(DOM.visibleText(group));
      const target = compactText(value);
      return groupText.includes(target) || target.includes(groupText.replace(/推广位/g, ''));
    },

    findDropdownTrigger(group, label, panel) {
      const selectors = ['[role="combobox"]', 'select', 'input[readonly]', 'input[placeholder]', '[class*="select"]', '[class*="Select"]'];
      const scoped = selectors.flatMap((selector) => DOM.all(selector, group)).filter((element) => DOM.isVisible(element) && !DOM.isDisabled(element));
      if (scoped.length) {
        const item = scoped[0];
        return item.tagName && item.tagName.toLowerCase() === 'input'
          ? item.closest('[role="combobox"],[class*="select"],[class*="Select"],div') || item
          : item;
      }

      const labelRect = label.getBoundingClientRect();
      const candidates = selectors
        .flatMap((selector) => DOM.all(selector, panel))
        .filter((element) => DOM.isVisible(element) && !DOM.isDisabled(element))
        .map((element) => {
          const clickable =
            element.tagName && element.tagName.toLowerCase() === 'input'
              ? element.closest('[role="combobox"],[class*="select"],[class*="Select"],div') || element
              : element;
          return { element: clickable, rect: clickable.getBoundingClientRect() };
        })
        .filter(({ rect }) => rect.left > labelRect.left && Math.abs(rect.top - labelRect.top) < 100)
        .sort((a, b) => Math.abs(a.rect.top - labelRect.top) - Math.abs(b.rect.top - labelRect.top));
      return candidates[0] ? candidates[0].element : null;
    },

    findDropdownOption(optionText) {
      const target = compactText(optionText);
      const candidates = DOM.all('[role="option"],li,div,span')
        .filter((element) => DOM.isVisible(element))
        .filter((element) => {
          const text = DOM.visibleText(element);
          const compact = compactText(text);
          return text && (compact === target || compact.includes(target) || target.includes(compact));
        })
        .map((element) => this.findOptionElement(element, optionText))
        .filter(Boolean);
      return uniqueElements(candidates).sort((a, b) => area(a) - area(b))[0] || null;
    },

    findOptionElement(element, targetText) {
      let current = element;
      const target = compactText(targetText);
      while (current && current !== document.body) {
        const text = DOM.visibleText(current);
        const rect = current.getBoundingClientRect();
        const compact = compactText(text);
        const textMatches = compact === target || compact.includes(target) || target.includes(compact);
        if (textMatches && rect.width >= 80 && rect.height >= 20 && rect.height <= 100) {
          if (current.matches('[role="option"],li,[role="menuitem"]') || /(option|item|menu|select)/i.test(current.className || '')) return current;
        }
        current = current.parentElement;
      }
      return DOM.clickableAncestor(element);
    },

    async backToListPage() {
      const backButton =
        DOM.findClickableByText('返回', document, false) ||
        DOM.all('button,a,[role="button"],span,div')
          .filter((element) => DOM.isVisible(element))
          .find((element) => {
            const text = DOM.visibleText(element);
            const aria = element.getAttribute('aria-label') || element.getAttribute('title') || '';
            return text === '‹' || text === '<' || /返回|back/i.test(text) || /返回|back/i.test(aria);
          });

      if (backButton) await DOM.clickElement(DOM.clickableAncestor(backButton), '返回列表');
      else history.back();

      const ok = await DOM.waitFor(() => ListParser.parseVenueCards().length > 0 && !this.isDetailPage(), 12000, 300);
      if (!ok) {
        history.back();
        const retry = await DOM.waitFor(() => ListParser.parseVenueCards().length > 0, 8000, 300);
        if (!retry) throw new Error('返回列表失败');
      }
      await DOM.delay('page');
      Logger.info('已返回会场推广列表页');
    }
  };

  const LinkTypeCollector = {
    async collectLinkType(record, linkTypeName) {
      const prefix = LINK_TYPE_META[linkTypeName].prefix;
      State.setProgress(State.currentIndex, State.total, record.activity_name, linkTypeName);

      try {
        const button = this.findLinkTypeButton(linkTypeName);
        if (!button) return this.writeSkipped(record, prefix, `${linkTypeName} 不存在`);
        if (CONFIG.skipDisabledLinkTypes && DOM.isDisabled(button)) return this.writeSkipped(record, prefix, `${linkTypeName} 不可用`);

        const snapshot = this.snapshotContent();
        const selected = await this.selectLinkType(button, linkTypeName, snapshot);
        if (!selected) throw new Error(`${linkTypeName} 点击后未进入选中态`);

        const content = await this.readCurrentPromotionContent();
        const links = extractLinks([content.text, content.copyText, content.inputText].filter(Boolean).join('\n'));
        record[`${prefix}_available`] = 'yes';
        record[`${prefix}_text`] = content.text || content.inputText || '';
        record[`${prefix}_link`] = links[0] || '';
        record[`${prefix}_links`] = links.join('|');
        record[`${prefix}_appid`] = content.appid || '';
        record[`${prefix}_mini_program_link`] = content.miniProgramLink || '';
        record[`${prefix}_copy_text`] = content.copyText || '';
        record[`${prefix}_image_url`] = content.imageUrl || '';
        record[`${prefix}_status`] = record[`${prefix}_text`] || links.length || content.appid ? 'success' : 'failed';
        record[`${prefix}_error`] = record[`${prefix}_status`] === 'success' ? '' : '文案字段为空';
        Logger.success(`${linkTypeName} 采集${record[`${prefix}_status`] === 'success' ? '成功' : '失败'}`);
      } catch (error) {
        record[`${prefix}_available`] = record[`${prefix}_available`] || 'yes';
        record[`${prefix}_status`] = 'failed';
        record[`${prefix}_error`] = error.message || String(error);
        Logger.error(`${linkTypeName} 采集失败：${record[`${prefix}_error`]}`);
      }
    },

    writeSkipped(record, prefix, reason) {
      record[`${prefix}_available`] = 'no';
      record[`${prefix}_text`] = '';
      record[`${prefix}_link`] = '';
      record[`${prefix}_links`] = '';
      record[`${prefix}_appid`] = '';
      record[`${prefix}_mini_program_link`] = '';
      record[`${prefix}_copy_text`] = '';
      record[`${prefix}_image_url`] = '';
      record[`${prefix}_status`] = 'skipped';
      record[`${prefix}_error`] = reason;
      Logger.warn(reason);
    },

    getAvailableLinkTypes() {
      return CONFIG.linkTypes.filter((type) => {
        const button = this.findLinkTypeButton(type);
        return button && !DOM.isDisabled(button);
      });
    },

    getLinkTypeRoot() {
      const panel = DetailPage.getRightPanel();
      const anchor = DOM.findByText('推广链路', panel, false);
      return anchor ? this.findLinkTypeGroup(anchor, panel) : panel;
    },

    getVisibleConfiguredLinkButtons() {
      const root = this.getLinkTypeRoot();
      return CONFIG.linkTypes
        .map((type) => ({ type, button: this.findLinkTypeButton(type, root) }))
        .filter((item) => item.button && DOM.isVisible(item.button) && !DOM.isDisabled(item.button));
    },

    isOnlyVisibleLinkType(linkTypeName) {
      const visibleButtons = this.getVisibleConfiguredLinkButtons();
      return visibleButtons.length === 1 && visibleButtons[0].type === linkTypeName;
    },

    findLinkTypeButton(linkTypeName, rootOverride) {
      const root = rootOverride || this.getLinkTypeRoot();
      const candidates = DOM.all('button,a,span,div,[role="button"]', root)
        .filter((element) => DOM.isVisible(element))
        .filter((element) => DOM.visibleText(element) === linkTypeName)
        .map((element) => DOM.clickableAncestor(element, root));
      return uniqueElements(candidates).sort((a, b) => area(a) - area(b))[0] || null;
    },

    findLinkTypeGroup(anchor, panel) {
      let current = anchor.parentElement;
      while (current && current !== panel.parentElement) {
        const text = DOM.visibleText(current);
        if (text.includes('推广链路') && CONFIG.linkTypes.some((type) => text.includes(type))) return current;
        current = current.parentElement;
      }
      return panel;
    },

    async selectLinkType(button, linkTypeName, snapshot) {
      if (this.isOnlyVisibleLinkType(linkTypeName)) {
        Logger.info(`${linkTypeName} 是当前唯一可用推广链路，直接按已选中处理`);
        return true;
      }

      for (let attempt = 1; attempt <= CONFIG.maxClickRetry; attempt += 1) {
        await DOM.clickElement(button, `推广链路 ${linkTypeName}`);
        await DOM.delay('linkSwitch');
        const ok = await DOM.waitFor(() => {
          const nextButton = this.findLinkTypeButton(linkTypeName);
          if (!nextButton) return false;
          if (this.isButtonSelected(nextButton)) return true;
          const current = this.snapshotContent();
          return current && current !== snapshot;
        }, 2500, 200);
        if (ok) return true;
        Logger.warn(`${linkTypeName} 未确认选中，重试 ${attempt}/${CONFIG.maxClickRetry}`);
      }
      return false;
    },

    isButtonSelected(button) {
      const className = String(button.className || '');
      const style = window.getComputedStyle(button);
      const border = `${style.borderColor} ${style.backgroundColor} ${style.color}`;
      return /active|selected|checked|current/i.test(className) || /255,\s*106,\s*0|orange|#ff6a00/i.test(border);
    },

    snapshotContent() {
      const panel = DetailPage.getRightPanel();
      const text = DOM.visibleText(panel);
      const inputs = DOM.all('input,textarea,[contenteditable="true"]', panel)
        .filter((element) => DOM.isVisible(element))
        .map((element) => element.value || element.textContent || '')
        .join('\n');
      return `${text}\n${inputs}`.trim();
    },

    async readCurrentPromotionContent() {
      const panel = DetailPage.getRightPanel();
      await DOM.waitFor(() => DOM.findByText('文案字段', panel, false) || /【标题】|【唤端链接】|mp:\/\/|https?:\/\//.test(DOM.visibleText(panel)), 8000, 250);

      const textBlock = this.findCopyTextBlock(panel);
      const inputValues = this.readInputs(panel);
      const joinedInput = inputValues.map((item) => item.value).filter(Boolean).join('\n');
      const allText = [textBlock, joinedInput].filter(Boolean).join('\n');
      const appid = this.extractAppId(allText, inputValues);
      const miniProgramLink = this.extractMiniProgramLink(allText, inputValues);
      const copyText = this.readCopyAreaText(panel);
      const imageUrl = this.readImageUrl(panel);

      return {
        text: textBlock,
        inputText: joinedInput,
        appid,
        miniProgramLink,
        copyText,
        imageUrl
      };
    },

    findCopyTextBlock(panel) {
      const blocks = DOM.all('textarea,pre,code,div,p,span,[contenteditable="true"]', panel)
        .filter((element) => DOM.isVisible(element))
        .map((element) => ({
          element,
          text: element.value || DOM.visibleText(element)
        }))
        .filter((item) => /【标题】|【唤端链接】|mp:\/\/|https?:\/\/|tbopen:\/\/|taobao:\/\/|alipays?:\/\//.test(item.text))
        .filter((item) => item.text.length < 5000)
        .sort((a, b) => {
          const scoreA = contentScore(a.text) - area(a.element) / 100000;
          const scoreB = contentScore(b.text) - area(b.element) / 100000;
          return scoreB - scoreA;
        });
      return blocks[0] ? blocks[0].text.trim() : '';
    },

    readInputs(panel) {
      return DOM.all('input,textarea,[contenteditable="true"]', panel)
        .filter((element) => DOM.isVisible(element))
        .map((element) => {
          const value = element.value || element.textContent || '';
          const label = findNearbyLabel(element, panel);
          return { label, value: String(value).trim() };
        })
        .filter((item) => item.value);
    },

    extractAppId(text, inputValues) {
      const labeled = inputValues.find((item) => /appid|app id|小程序id|应用id/i.test(item.label));
      if (labeled) return labeled.value;
      return (String(text || '').match(/\b(?:wx|app|tb|alipay)[A-Za-z0-9_-]{8,}\b/i) || [])[0] || '';
    },

    extractMiniProgramLink(text, inputValues) {
      const labeled = inputValues.find((item) => /小程序链接|小程序路径|唤端链接|链接/i.test(item.label));
      if (labeled) return labeled.value;
      return (extractLinks(text).find((link) => /mp:\/\/|pages\/|ad-bdlm-sub\/pages/.test(link)) || '');
    },

    readCopyAreaText(panel) {
      const copyButtons = DOM.all('button,a,[role="button"],span,div', panel)
        .filter((element) => DOM.isVisible(element))
        .filter((element) => /复制APPID|复制小程序链接|一键复制|复制/.test(DOM.visibleText(element)));
      const values = copyButtons
        .map((button) => {
          const parent = button.parentElement;
          if (!parent) return '';
          const input = parent.querySelector('input,textarea,[contenteditable="true"]');
          return input ? input.value || input.textContent || '' : DOM.visibleText(parent);
        })
        .filter(Boolean);
      return uniqueStrings(values).join('\n');
    },

    readImageUrl(panel) {
      const images = DOM.all('img', panel)
        .filter((img) => DOM.isVisible(img))
        .map((img) => img.currentSrc || img.src || img.getAttribute('data-src') || '')
        .filter(Boolean)
        .filter((url) => !/^data:image\/svg/.test(url));
      return images[0] || '';
    }
  };

  const Collector = {
    async start() {
      if (State.running) {
        Logger.warn('采集正在运行中');
        return;
      }
      State.running = true;
      State.paused = false;
      State.stopped = false;
      State.setStatus('运行中');

      try {
        await this.ensureListPage();
        const pagination = ListParser.getPaginationInfo();
        const tasks = ListParser.buildTaskQueue();
        State.total = tasks.length;
        State.setTaskProgress(0, tasks.length);
        State.setPageProgress(pagination.currentPage || 1, pagination.totalPages || 1);

        if (!tasks.length) {
          State.setStatus('已停止');
          Logger.warn('找不到活动卡片，请确认当前在「会场推广」列表页');
          return;
        }

        if (pagination && !pagination.fallback) {
          Logger.info(`已识别分页：共 ${pagination.totalCount} 条，每页 ${pagination.pageSize} 条，共 ${pagination.totalPages} 页`);
        } else {
          Logger.warn(`未识别到分页总数，退化为采集当前页 ${tasks.length} 条`);
        }

        for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
          if (State.stopped) break;
          await this.waitIfPaused();

          const task = tasks[taskIndex];
          State.setTaskProgress(taskIndex + 1, tasks.length);
          State.setProgress(taskIndex + 1, tasks.length, `第 ${task.pageIndex} 页第 ${task.rowIndex} 条`, '-');
          Logger.info(`准备采集：第 ${task.pageIndex} 页第 ${task.rowIndex} 条`);

          try {
            await this.ensureListPage();
            await ListParser.goToPage(task.pageIndex);
            const cards = ListParser.parseVenueCards();
            const card = cards[task.rowIndex - 1];
            if (!card) {
              Logger.warn(`第 ${task.pageIndex} 页第 ${task.rowIndex} 条不存在，跳过`);
              continue;
            }

            const base = ListParser.parseVenueCard(card, task.rowIndex - 1);
            base.page_index = task.pageIndex;
            base.row_index = task.rowIndex;
            State.setProgress(taskIndex + 1, tasks.length, base.activity_name, '-');
            State.setPageProgress(task.pageIndex, pagination.totalPages || State.totalPages || 1);

            if (Storage.hasRecord(base)) {
              Logger.info(`已采集成功，跳过：第 ${task.pageIndex} 页第 ${task.rowIndex} 条 ${base.activity_name || base.activity_venue_id}`);
              continue;
            }

            await this.processVenue(card, base);
            const returnedPage = ListParser.getCurrentPageIndex();
            Logger.info(`返回列表页，当前回到第 ${returnedPage} 页，后续会自动重新翻页`);
            Logger.success(`第 ${task.pageIndex} 页第 ${task.rowIndex} 条采集完成`);
          } catch (taskError) {
            Logger.error(`第 ${task.pageIndex} 页第 ${task.rowIndex} 条任务失败：${taskError.message || taskError}`);
            try {
              await this.ensureListPage();
            } catch (ensureError) {
              Logger.warn(`任务失败后恢复列表页失败：${ensureError.message || ensureError}`);
            }
          }
          await DOM.delay('nextCard');
        }

        State.setStatus(State.stopped ? '已停止' : '已完成');
        Logger.success(State.stopped ? '采集已停止' : '全部分页采集完成');
      } catch (error) {
        State.setStatus('已停止');
        Logger.error(`采集流程异常：${error.message || error}`);
      } finally {
        State.running = false;
      }
    },

    togglePause() {
      if (!State.running) return;
      State.paused = !State.paused;
      State.setStatus(State.paused ? '已暂停' : '运行中');
      Logger.info(State.paused ? '已暂停采集' : '继续采集');
    },

    stop() {
      State.stopped = true;
      State.paused = false;
      State.setStatus('已停止');
      Logger.warn('收到停止指令，当前步骤完成后停止');
    },

    async waitIfPaused() {
      while (State.paused && !State.stopped) await DOM.sleep(300);
    },

    async ensureListPage() {
      if (DetailPage.isDetailPage()) {
        await DetailPage.backToListPage();
        const currentPage = ListParser.getCurrentPageIndex();
        Logger.info(`返回列表页，当前回到第 ${currentPage} 页，后续会自动重新翻页`);
      }
      const ok = await DOM.waitFor(() => ListParser.parseVenueCards().length > 0, 12000, 300);
      if (!ok) {
        history.back();
        const retry = await DOM.waitFor(() => ListParser.parseVenueCards().length > 0, 8000, 300);
        if (!retry) throw new Error('无法确认当前为会场推广列表页');
      }
      return true;
    },

    async processVenue(card, base) {
      const record = this.createBaseRecord(base);
      try {
        Logger.info(`处理第 ${base.row_index} 个活动：${base.activity_name || base.activity_venue_id || '未知活动'}`);
        await DetailPage.clickPromote(card);
        await DetailPage.waitForDetailPage();
        record.promotion_position_name = await DetailPage.selectPromotionPosition(CONFIG.promotionPositionName);

        for (const linkType of CONFIG.linkTypes) {
          if (State.stopped) break;
          await this.waitIfPaused();
          await LinkTypeCollector.collectLinkType(record, linkType);
        }

        record.status = this.resolveStatus(record);
        record.error_message = record.status === 'success' ? '' : this.collectRecordErrors(record);
        Storage.upsertRecord(record);
        Logger.success(`活动采集完成：${base.activity_name || base.activity_venue_id}`);
      } catch (error) {
        record.status = 'failed';
        record.error_message = error.message || String(error);
        Storage.upsertRecord(record);
        Logger.error(`活动失败：${record.error_message}`);
      } finally {
        try {
          if (DetailPage.isDetailPage()) await DetailPage.backToListPage();
        } catch (backError) {
          Logger.error(`返回列表失败：${backError.message || backError}`);
        }
      }
    },

    createBaseRecord(base) {
      const record = {
        activity_venue_id: base.activity_venue_id || '',
        activity_name: base.activity_name || '',
        activity_status: base.activity_status || '',
        activity_desc: base.activity_desc || '',
        start_date: base.start_date || '',
        end_date: base.end_date || '',
        commission_rate: base.commission_rate || '',
        banner_url: base.banner_url || '',
        promotion_position_name: CONFIG.promotionPositionName,
        status: 'failed',
        error_message: '',
        page_index: base.page_index || 1,
        row_index: base.row_index || '',
        collected_at: new Date().toISOString()
      };
      CONFIG.linkTypes.forEach((type) => {
        const prefix = LINK_TYPE_META[type].prefix;
        LINK_FIELD_SUFFIXES.forEach((suffix) => {
          record[`${prefix}_${suffix}`] = suffix === 'available' ? 'no' : '';
        });
      });
      return record;
    },

    resolveStatus(record) {
      const statuses = CONFIG.linkTypes.map((type) => record[`${LINK_TYPE_META[type].prefix}_status`]).filter(Boolean);
      if (statuses.some((status) => status === 'success') && statuses.some((status) => status === 'failed')) return 'partial';
      if (statuses.some((status) => status === 'success')) return 'success';
      if (statuses.every((status) => status === 'skipped')) return 'partial';
      return 'failed';
    },

    collectRecordErrors(record) {
      return CONFIG.linkTypes
        .map((type) => {
          const prefix = LINK_TYPE_META[type].prefix;
          return record[`${prefix}_error`] ? `${type}: ${record[`${prefix}_error`]}` : '';
        })
        .filter(Boolean)
        .join('；');
    }
  };

  const Exporter = {
    exportCSV() {
      if (!State.records.length) {
        Logger.warn('没有可导出的数据');
        return;
      }
      const rows = State.records.map((record) => CSV_FIELDS.map((field) => csvEscape(record[field])).join(','));
      const content = `\uFEFF${CSV_HEADER_LABELS.map(csvEscape).join(',')}\n${rows.join('\n')}`;
      this.download(content, `${CONFIG.exportFilePrefix}_${timestampForFile()}.csv`, 'text/csv;charset=utf-8');
      Logger.success(`已导出 CSV：${State.records.length} 条`);
    },

    exportJSON() {
      if (!State.records.length) {
        Logger.warn('没有可导出的数据');
        return;
      }
      this.download(JSON.stringify(State.records, null, 2), `${CONFIG.exportFilePrefix}_${timestampForFile()}.json`, 'application/json;charset=utf-8');
      Logger.success(`已导出 JSON：${State.records.length} 条`);
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

  function extractLinks(text) {
    const source = String(text || '');
    const patterns = [
      /https?:\/\/[^\s"'<>，。；、]+/gi,
      /\b(?:mp|tbopen|taobao|alipays?|alipay):\/\/[^\s"'<>，。；、]+/gi,
      /\bpages\/[A-Za-z0-9_./-]+(?:\?[A-Za-z0-9_./?%&=:+-]+)?/gi,
      /\bad-bdlm-sub\/pages\/[A-Za-z0-9_./-]+(?:\?[A-Za-z0-9_./?%&=:+-]+)?/gi
    ];
    const links = [];
    patterns.forEach((pattern) => {
      let match = pattern.exec(source);
      while (match) {
        const value = (match[0] || '').trim();
        if (value && !links.includes(value)) links.push(value);
        match = pattern.exec(source);
      }
    });
    return links;
  }

  function findNearbyLabel(element, panel) {
    let current = element.parentElement;
    while (current && current !== panel.parentElement) {
      const text = DOM.visibleText(current).replace(DOM.visibleText(element), '').trim();
      if (text && text.length <= 80) return text;
      current = current.parentElement;
    }
    return '';
  }

  function contentScore(text) {
    let score = 0;
    if (/【标题】/.test(text)) score += 6;
    if (/【唤端链接】/.test(text)) score += 6;
    if (/mp:\/\/|https?:\/\//.test(text)) score += 4;
    if (/复制|推广链路|推广位/.test(text)) score -= 5;
    return score;
  }

  function splitLines(text) {
    return String(text || '')
      .split(/\n+/)
      .map((line) => DOM.normalizeText(line))
      .filter(Boolean);
  }

  function normalizeDate(date) {
    return String(date || '').replace(/\//g, '-');
  }

  function compactText(text) {
    return String(text || '').replace(/\s+/g, '').replace(/[>*：:，,。；;]/g, '');
  }

  function area(element) {
    const rect = element.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements.filter(Boolean)));
  }

  function uniqueStrings(values) {
    return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
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
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  function buildCsvHeaderLabels() {
    const prefixToName = Object.fromEntries(CONFIG.linkTypes.map((type) => [LINK_TYPE_META[type].prefix, type]));
    return CSV_FIELDS.map((field) => {
      if (BASE_FIELD_LABELS[field]) return BASE_FIELD_LABELS[field];
      const matchedPrefix = Object.keys(prefixToName)
        .sort((a, b) => b.length - a.length)
        .find((prefix) => field.startsWith(`${prefix}_`));
      if (!matchedPrefix) return field;
      const suffix = field.slice(matchedPrefix.length + 1);
      return `${prefixToName[matchedPrefix]}_${LINK_FIELD_LABELS[suffix] || suffix}`;
    });
  }

  function timestampForFile() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
  }

  function init() {
    if (location.hostname !== 'union.ele.me' || !location.hash.startsWith(TARGET_HASH)) return;
    State.init();
    UI.createControlPanel();
    Logger.success(`${VERSION} 脚本加载成功，请在淘宝闪购会场推广列表页点击「开始采集」`);
    window.TaobaoShangouVenueCollector = {
      VERSION,
      CONFIG,
      State,
      Storage,
      Logger,
      UI,
      DOM,
      ListParser,
      DetailPage,
      LinkTypeCollector,
      Collector,
      Exporter,
      extractLinks
    };
  }

  init();

  /*
   * 使用说明
   * 1. 安装脚本：在 Tampermonkey / 油猴中新建脚本，粘贴本文件全部内容并保存。
   * 2. 配置推广位：修改 CONFIG.promotionPositionName，需与详情页推广位选项文字一致。
   * 3. 配置推广链路：修改 CONFIG.linkTypes，可保留 ['微信', '支付宝', '淘宝', '淘宝闪购', 'H5'] 的子集。
   * 4. 开始采集：登录淘宝闪购联盟后台，进入「我要推广 > 淘宝闪购 > 会场推广」，点击右下角「开始采集」。
   * 5. 导出数据：点击「导出 CSV」或「导出 JSON」。CSV 已加 BOM，Excel 打开中文不易乱码。
   * 6. 常见问题：
   *    - 找不到活动卡片：确认在会场推广列表页，且卡片上有「立即推广」。
   *    - 找不到立即推广：页面可能未加载完成，先手动滚动或刷新。
   *    - 找不到推广位：确认 CONFIG.promotionPositionName 与下拉选项一致。
   *    - 推广链路按钮不可用：脚本会记录 skipped 并继续其他链路。
   *    - 文案字段为空：脚本会记录 failed，通常是链路未生成内容或页面仍在加载。
   *    - 返回列表失败：脚本会先点返回，再尝试 history.back()。
   *    - 导出为空：确认已成功采集至少 1 条，或未误点「清空缓存」。
   */
})();
