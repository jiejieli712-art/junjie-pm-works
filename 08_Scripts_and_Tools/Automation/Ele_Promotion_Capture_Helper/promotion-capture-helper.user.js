// ==UserScript==
// @name         推广采集助手
// @namespace    tb-ele-test
// @version      1.3.3
// @match        *://union.ele.me/*
// @match        *://*.ele.me/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  console.log('[Tampermonkey Test] 已注入：', location.href);

  const CONFIG = {
    cardSelector: '.product-promotion-item',
    buttonSelector: '.item-layer span',
    batchSize: 20,
    minDelayMs: 6000,
    maxDelayMs: 12000,
    detailTimeoutMs: 25000,
    blockUrlChange: false,
    fullPageMaxSafetyPages: 300,
    fastPageDelayMs: 700,
    regionCategoryNames: ['地方菜', '特色菜', '甜品', '烘焙', '奶茶果汁', '咖啡', '便当简餐', '米粉/捞烫'],
    storageLogLimit: 80,
  };

  const STORE_KEY = '__TB_ELE_PROMOTION_CAPTURE_WORKING__';

  const state = {
    shops: [],
    details: [],
    logs: [],
    running: false,
    navLock: false,
    lockedHref: '',

    //保存列表页查询条件
    searchSnapshot: null,

    // 当前列表页接口返回的店铺顺序，用于精确绑定 DOM 卡片，避免同品牌多门店误点
    currentPageShopKeys: [],

    // 最近一次列表接口捕获时间，用于判断“查询/翻页”是否真的刷新了列表
    lastListCapturedAt: 0,

    // 最近一次 DOM 卡片同步时间/签名，用于手动翻页但接口未被 hook 捕获时的兜底
    lastDomSyncedAt: 0,
    lastDomSignature: '',

    // 当前正在点击采集的店铺 key，用于把详情接口结果精准写回当前店铺，避免同品牌多门店写错
    currentCollectingShopKey: '',

    // 自动化控制
    stopRequested: false,
    batchRunning: false,
    autoRunning: false,
    currentMode: '',

    // 区域采集控制
    regionKeyword: '',
    selectedCategoryName: '',
    lastListTotalCount: 0,
    currentRegionMode: '',

    // 列表采集保护：锁定区域后，只允许采集当前页面城市筛选命中的列表，避免清空查询时误采全部列表
    lastRejectedListSignature: '',

    // 多区域批量采集控制
    multiRegionText: '',
    multiRegionRunning: false,
    currentBatchIndex: 0,
    currentBatchTotal: 0,
    currentBatchFileBaseName: '',
  };

  function now() {
    return new Date().toISOString();
  }

  function clean(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randomDelay() {
    return Math.floor(CONFIG.minDelayMs + Math.random() * (CONFIG.maxDelayMs - CONFIG.minDelayMs));
  }

  function safeJoin(value) {
    if (Array.isArray(value)) return value.map(clean).filter(Boolean).join('、');
    return clean(value);
  }

  function omitHeavyFields(row, compactLevel = 0) {
    if (!row || typeof row !== 'object') return row;

    const copy = { ...row };

    // 这些字段体积最大，且不参与继续采集/CSV核心字段，禁止写入 localStorage。
    delete copy.raw_shop_json;
    delete copy.raw_detail_json;
    delete copy.item_list_json;
    delete copy.raw_detail;
    delete copy.raw_shop;

    if (compactLevel >= 1) {
      // localStorage 接近上限时，进一步去掉图片/二维码/海报类长 URL。
      delete copy.logo_url;
      delete copy.item_img_url;
      delete copy.item_1_image;
      delete copy.item_2_image;
      delete copy.item_3_image;
      delete copy.wx_qrcode;
      delete copy.wx_poster;
      delete copy.taobao_qrcode;
      delete copy.share_image_list;
      delete copy.share_poster_list;
      delete copy.wx_img_url;
    }

    if (compactLevel >= 2) {
      // 极限兜底：只保留继续采集、去重、导出最关键的字段。
      const keep = [
        'dom_key', 'shop_name', 'rate', 'monthly_sale', 'monthly_sale_text', 'monthly_sale_number',
        'delivery_price', 'delivery_price_yuan', 'commission_rate', 'commission',
        'en_ele_shop_id', 'shop_id', 'md5_shop_id', 'ad_store_id', 'origin_store_id',
        'source_type', 'source_page', 'source_index', 'export_region', 'locked_region', 'source_category',
        'promotion_status', 'promotion_short_code', 'wx_appid', 'wx_app_path',
        'share_text_title', 'share_text_right_desc', 'taobao_scheme_url',
        'captured_at', 'promotion_captured_at'
      ];

      Object.keys(copy).forEach(key => {
        if (!keep.includes(key)) {
          delete copy[key];
        }
      });
    }

    return copy;
  }

  function buildStoragePayload(compactLevel = 0) {
    const logLimit = compactLevel >= 1 ? 20 : CONFIG.storageLogLimit;

    return {
      shops: state.shops.map(item => omitHeavyFields(item, compactLevel)),
      details: compactLevel >= 2 ? [] : state.details.map(item => omitHeavyFields(item, compactLevel + 1)),
      logs: state.logs.slice(-logLimit).map(item => ({
        time: item.time,
        message: item.message,
        // 日志 data 可能包含 currentPageKeys / 大对象，持久化时只保留简短文本，避免把 localStorage 撑爆。
        data: compactLevel >= 1
          ? null
          : (typeof item.data === 'string' ? item.data.slice(0, 300) : null),
      })),
      searchSnapshot: state.searchSnapshot,
      currentPageShopKeys: state.currentPageShopKeys,
      lastListCapturedAt: state.lastListCapturedAt,
      lastListTotalCount: state.lastListTotalCount,
      regionKeyword: state.regionKeyword,
      selectedCategoryName: state.selectedCategoryName,
      currentRegionMode: state.currentRegionMode,
      multiRegionText: state.multiRegionText,
      currentBatchFileBaseName: state.currentBatchFileBaseName,
      lastRejectedListSignature: state.lastRejectedListSignature,
      lastDomSyncedAt: state.lastDomSyncedAt,
      lastDomSignature: state.lastDomSignature,
      currentCollectingShopKey: state.currentCollectingShopKey,
      storageCompactLevel: compactLevel,
      updatedAt: now(),
    };
  }

  function safeLocalStorageSet(key, payload) {
    const text = JSON.stringify(payload);
    localStorage.setItem(key, text);
    return text.length;
  }

  function saveState() {
    // 之前 1000 条左右会卡住，主要原因是 localStorage 持久化了 raw_shop_json / 图片 / 日志大对象后触发容量上限。
    // 这里采用分级压缩保存：内存里仍保留完整数据，持久化时只保存可继续采集所需的轻量字段。
    for (let level = 0; level <= 2; level++) {
      try {
        const size = safeLocalStorageSet(STORE_KEY, buildStoragePayload(level));

        if (level > 0) {
          console.warn(`[推广采集助手] localStorage 已启用压缩保存 level=${level}，大小约 ${Math.round(size / 1024)}KB`);
        }

        return true;
      } catch (error) {
        if (level === 2) {
          console.warn('[推广采集助手] localStorage 保存失败，已跳过本次持久化，但内存数据仍可继续采集/导出。', error);
          return false;
        }
      }
    }

    return false;
  }

  function restoreState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (Array.isArray(saved.shops)) state.shops = saved.shops;
      if (Array.isArray(saved.details)) state.details = saved.details;
      if (Array.isArray(saved.logs)) state.logs = saved.logs;
      if (saved.searchSnapshot) state.searchSnapshot = saved.searchSnapshot;
      if (Array.isArray(saved.currentPageShopKeys)) state.currentPageShopKeys = saved.currentPageShopKeys;
      if (typeof saved.lastListCapturedAt === 'number') state.lastListCapturedAt = saved.lastListCapturedAt;
      if (typeof saved.lastListTotalCount === 'number') state.lastListTotalCount = saved.lastListTotalCount;
      if (typeof saved.regionKeyword === 'string') state.regionKeyword = saved.regionKeyword;
      if (typeof saved.selectedCategoryName === 'string') state.selectedCategoryName = saved.selectedCategoryName;
      if (typeof saved.currentRegionMode === 'string') state.currentRegionMode = saved.currentRegionMode;
      if (typeof saved.multiRegionText === 'string') state.multiRegionText = saved.multiRegionText;
      if (typeof saved.currentBatchFileBaseName === 'string') state.currentBatchFileBaseName = saved.currentBatchFileBaseName;
      if (typeof saved.lastRejectedListSignature === 'string') state.lastRejectedListSignature = saved.lastRejectedListSignature;
      if (typeof saved.lastDomSyncedAt === 'number') state.lastDomSyncedAt = saved.lastDomSyncedAt;
      if (typeof saved.lastDomSignature === 'string') state.lastDomSignature = saved.lastDomSignature;
      if (typeof saved.currentCollectingShopKey === 'string') state.currentCollectingShopKey = saved.currentCollectingShopKey;
    } catch (e) {}
  }

  function log(message, data) {
    state.logs.push({
      time: now(),
      message,
      data: data || null,
    });

    // 长时间整区采集会产生大量日志，保留最近 500 条即可，避免内存和持久化压力持续增大。
    if (state.logs.length > 500) {
      state.logs.splice(0, state.logs.length - 500);
    }

    console.log(`[推广采集助手] ${message}`, data || '');
    saveState();
    updatePanel();
  }

  function getShopKey(shop) {
    return (
      clean(shop.dom_key) ||
      clean(shop.shop_id) ||
      clean(shop.en_ele_shop_id) ||
      clean(shop.md5_shop_id) ||
      clean(shop.ad_store_id) ||
      clean(shop.origin_store_id) ||
      clean(shop.shop_name)
    );
  }

  function normalizeItemList(itemList) {
    if (!Array.isArray(itemList)) return [];

    return itemList.map(item => ({
      item_id: clean(item.itemId),
      item_name: clean(item.name),
      item_price: clean(item.price),
      item_original_price: clean(item.originalPrice),
      item_image: clean(item.image),
      consult_promo_info: clean(item.consultPromoInfo),
    }));
  }

  function normalizeShopItem(item) {
    const itemList = normalizeItemList(item.itemList);

    return {
      shop_name: clean(item.title),
      rate: clean(item.rate),
      monthly_sale: clean(item.monthlySale),
      monthly_sale_text: clean(item.monthlySaleText),
      monthly_sale_number: clean(item.monthlySaleNumber),

      delivery_price: clean(item.deliveryPrice),
      delivery_price_yuan: clean(item.deliveryPriceYuan),

      commission_rate: clean(item.commissionRate),
      commission: clean(item.commission),
      biz_type: clean(item.bizType),
      city_id: clean(item.cityId),
      first_category_id: clean(item.firstCategoryId),

      locked_region: clean(state.regionKeyword || getPageSelectedRegionText() || ''),
      source_category: clean(state.selectedCategoryName || ''),
      export_region: clean(state.currentBatchFileBaseName || state.regionKeyword || getPageSelectedRegionText() || ''),

      tag_list: safeJoin(item.tagList),
      recommend_reasons: safeJoin(item.recommendReasonList),

      wx_appid_base: clean(item.extendDTO?.wxAppid),
      wx_path_base: clean(item.extendDTO?.wxPath),

      en_ele_shop_id: clean(item.shortCodeExt?.enEleShopId),
      shop_id: clean(item.shopId),
      md5_shop_id: clean(item.md5ShopId),
      ad_store_id: clean(item.adStoreId),
      origin_store_id: clean(item.originStoreId),

      logo_url: clean(item.logoUrl),
      item_img_url: clean(item.itemImgUrl),

      item_1_name: clean(itemList[0]?.item_name),
      item_1_price: clean(itemList[0]?.item_price),
      item_1_image: clean(itemList[0]?.item_image),

      item_2_name: clean(itemList[1]?.item_name),
      item_2_price: clean(itemList[1]?.item_price),
      item_2_image: clean(itemList[1]?.item_image),

      item_3_name: clean(itemList[2]?.item_name),
      item_3_price: clean(itemList[2]?.item_price),
      item_3_image: clean(itemList[2]?.item_image),

      item_list_json: JSON.stringify(itemList),

      promotion_status: '',
      promotion_short_code: '',
      wx_appid: '',
      wx_app_path: '',
      wx_qrcode: '',
      wx_poster: '',
      share_text_title: '',
      share_text_right_desc: '',
      taobao_scheme_url: '',
      taobao_qrcode: '',

      captured_at: now(),
      raw_shop_json: JSON.stringify(item),
    };
  }

  function normalizePromotionDetail(result) {
    const wx = result.wxPromotion || {};
    const taobao = result.taobaoPromotion || {};
    const alipay = result.alipayPromotion || {};
    const eleApp = result.eleAppPromotion || {};
    const h5 = result.h5Promotion || {};

    const title =
      clean(wx.shareTextTitle) ||
      clean(taobao.shareTextTitle) ||
      clean(alipay.shareTextTitle) ||
      clean(eleApp.shareTextTitle) ||
      clean(h5.shareTextTitle);

    const rightDesc =
      clean(wx.shareTextRightDesc) ||
      clean(taobao.shareTextRightDesc) ||
      clean(alipay.shareTextRightDesc) ||
      clean(eleApp.shareTextRightDesc) ||
      clean(h5.shareTextRightDesc);

    return {
      shop_name: title,
      promotion_terminals: clean(result.promotionTerminals),
      promotion_short_code: clean(result.shortCode),

      wx_appid: clean(wx.appId || wx.wxAppId),
      wx_app_path: clean(wx.appPath || wx.wxPath),
      wx_qrcode: clean(wx.qrCode || wx.wxQrCode),
      wx_poster: Array.isArray(wx.sharePosterList) ? clean(wx.sharePosterList[0]) : '',
      wx_img_url: clean(wx.imgUrl),

      share_text_title: title,
      share_text_right_desc: rightDesc,
      share_image_list: safeJoin(wx.shareImageList),
      share_poster_list: safeJoin(wx.sharePosterList),

      taobao_scheme_url: clean(taobao.schemeUrl),
      taobao_qrcode: clean(taobao.qrCode || taobao.tbQrCode),

      promotion_captured_at: now(),
      raw_detail_json: JSON.stringify(result),
    };
  }

  function upsertShop(row) {
    const key = getShopKey(row);
    if (!key) return;

    const index = state.shops.findIndex(item => getShopKey(item) === key);

    if (index >= 0) {
      const old = state.shops[index];

      state.shops[index] = {
        ...old,
        ...row,
        promotion_status: old.promotion_status || row.promotion_status || '',
        promotion_short_code: old.promotion_short_code || row.promotion_short_code || '',
        wx_appid: old.wx_appid || row.wx_appid || '',
        wx_app_path: old.wx_app_path || row.wx_app_path || '',
        wx_qrcode: old.wx_qrcode || row.wx_qrcode || '',
        wx_poster: old.wx_poster || row.wx_poster || '',
        share_text_title: old.share_text_title || row.share_text_title || '',
        share_text_right_desc: old.share_text_right_desc || row.share_text_right_desc || '',
        taobao_scheme_url: old.taobao_scheme_url || row.taobao_scheme_url || '',
        taobao_qrcode: old.taobao_qrcode || row.taobao_qrcode || '',
      };
    } else {
      state.shops.push(row);
    }
  }

  function mergeDetail(detail) {
    if (!detail.wx_app_path && !detail.shop_name) return;

    const detailKey = detail.wx_app_path || detail.promotion_short_code || detail.shop_name;

    const detailIndex = state.details.findIndex(item => {
      const key = item.wx_app_path || item.promotion_short_code || item.shop_name;
      return key === detailKey;
    });

    if (detailIndex >= 0) {
      state.details[detailIndex] = {
        ...state.details[detailIndex],
        ...detail,
      };
    } else {
      state.details.push(detail);
    }

    let shopIndex = -1;

    // 1. 最优先：写回当前正在采集的店铺，避免同品牌多门店被写到第一家
    if (state.currentCollectingShopKey) {
      shopIndex = state.shops.findIndex(shop => getShopKey(shop) === state.currentCollectingShopKey);
    }

    // 2. 其次：标准化后的完整店名精确匹配
    if (shopIndex < 0) {
      shopIndex = state.shops.findIndex(shop => {
        return normalizeShopNameForCompare(shop.shop_name) === normalizeShopNameForCompare(detail.shop_name);
      });
    }

    // 3. 最后兜底：只有在唯一候选时才允许按门店名匹配，禁止仅按品牌名前缀匹配
    if (shopIndex < 0) {
      const branchName = clean(detail.shop_name).match(/[（(](.*?)[）)]/)?.[1];

      if (branchName) {
        const candidates = state.shops
          .map((shop, index) => ({ shop, index }))
          .filter(item => clean(item.shop.shop_name).includes(branchName));

        if (candidates.length === 1) {
          shopIndex = candidates[0].index;
        }
      }
    }

    if (shopIndex >= 0) {
      state.shops[shopIndex] = {
        ...state.shops[shopIndex],
        promotion_status: detail.wx_app_path ? '已获取' : '未获取',
        promotion_short_code: detail.promotion_short_code,
        wx_appid: detail.wx_appid,
        wx_app_path: detail.wx_app_path,
        wx_qrcode: detail.wx_qrcode,
        wx_poster: detail.wx_poster,
        share_text_title: detail.share_text_title,
        share_text_right_desc: detail.share_text_right_desc,
        taobao_scheme_url: detail.taobao_scheme_url,
        taobao_qrcode: detail.taobao_qrcode,
        raw_detail_json: detail.raw_detail_json,
        promotion_captured_at: detail.promotion_captured_at,
      };
    } else {
      console.warn('[推广采集助手] 详情接口已获取，但未能匹配到店铺，未写回列表：', detail);
    }

    saveState();
    updatePanel();
  }

  function processJson(json, url) {
    const result = json?.result || json?.data || json;
    if (!result || typeof result !== 'object') return;

    if (Array.isArray(result.shopPromotionList) && result.shopPromotionList.length > 0) {
      if (!shouldAcceptCurrentListPage('api-list')) {
        return;
      }

      const currentPageKeys = [];
      const apiTotalCount = Number(result.totalCount ?? result.totalStock ?? result.total ?? 0);
      const domTotalCount = getDomListTotalCount();
      const totalCount = Math.max(
        Number.isFinite(apiTotalCount) ? apiTotalCount : 0,
        Number.isFinite(domTotalCount) ? domTotalCount : 0
      );
      if (Number.isFinite(totalCount) && totalCount > 0) {
        state.lastListTotalCount = totalCount;
      }

      result.shopPromotionList.forEach(item => {
        const row = normalizeShopItem(item);
        row.source_url = url;
        upsertShop(row);
        const key = getShopKey(row);
        if (key) {
            currentPageKeys.push(key);
          }
      });

      // 关键：记录当前页接口顺序，后续按 index 对应 DOM 卡片，不再用店名前缀模糊匹配
      state.currentPageShopKeys = currentPageKeys;
      state.lastListCapturedAt = Date.now();
      state.lastDomSignature = getCurrentPageSignature();

      saveState();
      log(`捕获列表接口：本次 ${result.shopPromotionList.length} 条，累计 ${state.shops.length} 条`, {
        totalCount: state.lastListTotalCount,
        currentPageKeys,
      });
      return;
    }

    const wx = result.wxPromotion || {};

    if (wx.appPath || wx.wxPath || result.shortCode) {
      const detail = normalizePromotionDetail(result);
      detail.source_url = url;
      mergeDetail(detail);

      log(`捕获详情接口：${detail.shop_name || '未知店铺'}，链接 ${detail.wx_app_path ? '已获取' : '未获取'}`, {
        wx_app_path: detail.wx_app_path,
      });
    }
  }

  function hookNetwork() {
    // 使用版本化 hook 标记，避免旧版脚本残留导致新版 processJson 无法接管接口捕获
    if (window.__TB_ELE_PROMOTION_NETWORK_HOOKED_V120__) return;
    window.__TB_ELE_PROMOTION_NETWORK_HOOKED_V120__ = true;

    const originalFetch = window.fetch;

    if (typeof originalFetch === 'function') {
      window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

        const response = await originalFetch.apply(this, args);

        response.clone().text().then(text => {
          try {
            if (!text || !text.trim().startsWith('{')) return;
            processJson(JSON.parse(text), url);
          } catch (e) {}
        }).catch(() => {});

        return response;
      };
    }

    const XHR = window.XMLHttpRequest;

    if (XHR && XHR.prototype) {
      const originalOpen = XHR.prototype.open;
      const originalSend = XHR.prototype.send;

      XHR.prototype.open = function(method, url, ...rest) {
        this.__tb_capture_url__ = url;
        this.__tb_capture_method__ = method;
        return originalOpen.call(this, method, url, ...rest);
      };

      XHR.prototype.send = function(...args) {
        this.addEventListener('loadend', () => {
          try {
            const text = this.responseText;
            if (!text || !String(text).trim().startsWith('{')) return;
            processJson(JSON.parse(text), this.__tb_capture_url__ || '');
          } catch (e) {}
        });

        return originalSend.apply(this, args);
      };
    }
  }

  function hookHistory() {
    if (window.__TB_ELE_PROMOTION_HISTORY_HOOKED_V120__) return;
    window.__TB_ELE_PROMOTION_HISTORY_HOOKED_V120__ = true;

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(data, title, url) {
      if (state.navLock && CONFIG.blockUrlChange && url) {
        const next = new URL(url, location.href);

        if (next.href !== state.lockedHref) {
          console.warn('[推广采集助手] 已拦截 pushState 跳转：', next.href);
          return;
        }
      }

      return originalPushState.apply(this, arguments);
    };

    history.replaceState = function(data, title, url) {
      if (state.navLock && CONFIG.blockUrlChange && url) {
        const next = new URL(url, location.href);

        if (next.href !== state.lockedHref) {
          console.warn('[推广采集助手] 已拦截 replaceState 跳转：', next.href);
          return;
        }
      }

      return originalReplaceState.apply(this, arguments);
    };
  }

  function startNavLock() {
    state.lockedHref = location.href;
    state.navLock = true;
    updatePanel();
  }

  function stopNavLock() {
    state.navLock = false;
    updatePanel();
  }

  function findCards() {
    return Array.from(document.querySelectorAll(CONFIG.cardSelector))
      .filter(card => {
        const text = clean(card.innerText || card.textContent);
        return text.includes('预估收益') && text.includes('佣金');
      });
  }

  function getShopByKey(key) {
  return state.shops.find(shop => getShopKey(shop) === key) || null;
}

function normalizeShopNameForCompare(value) {
  return clean(value)
    .replace(/\s+/g, '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[·]/g, '')
    .trim();
}

function isSameShopNameStrict(a, b) {
  return normalizeShopNameForCompare(a) === normalizeShopNameForCompare(b);
}

function getCurrentPageShopsFromState() {
  const keys = Array.isArray(state.currentPageShopKeys) ? state.currentPageShopKeys : [];

  return keys
    .map(key => getShopByKey(key))
    .filter(Boolean);
}

function getCurrentPagePendingShops() {
  return getCurrentPageShopsFromState()
    .filter(shop => !shop.wx_app_path);
}

function isCurrentPageAllCollected() {
  const currentPageShops = getCurrentPageShopsFromState();

  if (!currentPageShops.length) {
    return false;
  }

  return currentPageShops.every(shop => !!shop.wx_app_path);
}


function getSearchSnapshotKeyForDom() {
  const snapshot = state.searchSnapshot || {};
  const selectPart = Array.isArray(snapshot.selects)
    ? snapshot.selects.map(item => clean(item.value)).filter(Boolean).join('_')
    : '';

  const inputPart = Array.isArray(snapshot.inputs)
    ? snapshot.inputs.map(item => clean(item.value)).filter(Boolean).join('_')
    : '';

  return normalizeSelectText(`${selectPart}_${inputPart}`) || 'all';
}

function extractShopNameFromCard(card, index) {
  const text = clean(card?.innerText || card?.textContent || '');
  const lines = String(card?.innerText || card?.textContent || '')
    .split(/\n+/)
    .map(clean)
    .filter(Boolean);

  const badLineReg = /(预估收益|佣金|实付金额|暂无评分|月售|起送|近一月|总计|人气|收藏|￥|元$|^\d+(\.\d+)?$|^\d+%$|减\d+)/;

  let name = '';

  const titleCandidate = card.querySelector('[title]');
  if (titleCandidate) {
    const t = clean(titleCandidate.getAttribute('title') || '');
    if (t && !badLineReg.test(t)) name = t;
  }

  if (!name) {
    name = lines.find(line => line && !badLineReg.test(line) && /[\u4e00-\u9fa5A-Za-z]/.test(line)) || '';
  }

  if (!name) {
    name = lines[0] || `DOM店铺${index + 1}`;
  }

  return clean(name);
}

function extractDomShopRowFromCard(card, index) {
  const text = clean(card?.innerText || card?.textContent || '');
  const pageNumber = getCurrentPageNumber() || 0;
  const searchKey = getSearchSnapshotKeyForDom();
  const shopName = extractShopNameFromCard(card, index);

  const rate = text.match(/(\d+(?:\.\d+)?)分/)?.[0] || (text.includes('暂无评分') ? '暂无评分' : '');
  const monthlySale = text.match(/月售\s*([\d+]+)/)?.[0] || '';
  const delivery = text.match(/起送\s*￥?\s*([\d.]+)/)?.[0] || '';
  const commissionRate = text.match(/实付金额\s*(\d+(?:\.\d+)?%)/)?.[1] || '';
  const commission = text.match(/预估收益\s*([\d.]+)\s*元/)?.[1] || '';

  const logo = card.querySelector('img')?.src || '';
  const normalizedName = normalizeShopNameForCompare(shopName) || `unknown_${index + 1}`;
  const domKey = `dom:${searchKey}:p${pageNumber}:i${index + 1}:${normalizedName}`;

  return {
    dom_key: domKey,
    shop_name: shopName,
    rate,
    monthly_sale: monthlySale,
    monthly_sale_text: monthlySale,
    monthly_sale_number: monthlySale.replace(/[^\d+]/g, ''),
    delivery_price: delivery,
    delivery_price_yuan: delivery.replace(/[^\d.]/g, ''),
    commission_rate: commissionRate.replace('%', ''),
    commission,
    logo_url: logo,
    source_url: location.href,
    source_type: 'dom_fallback',
    source_page: pageNumber,
    source_index: index + 1,
    locked_region: clean(state.regionKeyword || getPageSelectedRegionText() || ''),
    source_category: clean(state.selectedCategoryName || ''),
    export_region: clean(state.currentBatchFileBaseName || state.regionKeyword || getPageSelectedRegionText() || ''),
    promotion_status: '',
    promotion_short_code: '',
    wx_appid: '',
    wx_app_path: '',
    wx_qrcode: '',
    wx_poster: '',
    share_text_title: '',
    share_text_right_desc: '',
    taobao_scheme_url: '',
    taobao_qrcode: '',
    captured_at: now(),
    raw_shop_json: JSON.stringify({ source: 'dom_fallback', text: text.slice(0, 1000) }),
  };
}

function syncCurrentPageFromDom(reason = 'manual', options = {}) {
  if (!isListPage()) return false;

  const cards = findCards();
  if (!cards.length) return false;

  if (!shouldAcceptCurrentListPage(`dom-${reason}`)) {
    return false;
  }

  const signature = getCurrentPageSignature();
  const force = !!options.force;

  // 如果刚刚捕获过列表接口，优先使用接口数据，避免 DOM 兜底覆盖更完整的接口字段。
  if (!force && state.lastListCapturedAt && Date.now() - state.lastListCapturedAt < 3500) {
    return false;
  }

  if (!force && signature && signature === state.lastDomSignature) {
    return false;
  }

  const keys = [];
  const beforeCount = state.shops.length;

  cards.forEach((card, index) => {
    const row = extractDomShopRowFromCard(card, index);
    const key = getShopKey(row);
    if (key) {
      upsertShop(row);
      keys.push(key);
    }
  });

  if (!keys.length) return false;

  state.currentPageShopKeys = keys;
  state.lastDomSyncedAt = Date.now();
  state.lastDomSignature = signature;

  saveState();
  updatePanel();

  const added = state.shops.length - beforeCount;
  log(`DOM兜底同步当前页：本次 ${keys.length} 条，新增 ${added} 条，累计 ${state.shops.length} 条`, {
    reason,
    page: getCurrentPageNumber(),
    keys: keys.slice(0, 5),
  });

  return true;
}

function hookManualPageDomSync() {
  if (window.__TB_ELE_PROMOTION_DOM_SYNC_V124__) return;
  window.__TB_ELE_PROMOTION_DOM_SYNC_V124__ = true;

  document.addEventListener('click', event => {
    const target = event.target;
    const pagination = target?.closest?.('.ant-pagination');

    if (!pagination) return;

    setTimeout(() => syncCurrentPageFromDom('pagination-click-2s'), 2200);
    setTimeout(() => syncCurrentPageFromDom('pagination-click-5s'), 5200);
  }, true);

  let lastSeenSignature = '';

  setInterval(() => {
    if (!isListPage()) return;

    const signature = getCurrentPageSignature();
    if (!signature || signature === lastSeenSignature) return;

    lastSeenSignature = signature;
    setTimeout(() => syncCurrentPageFromDom('signature-change'), 800);
  }, 2500);
}

  function findPendingCard() {
  const cards = findCards();

  if (!cards.length) {
    return null;
  }

  if (!shouldAcceptCurrentListPage('find-pending-card')) {
    return null;
  }

  const currentPageShops = getCurrentPageShopsFromState();

  // 1. 最优先：按“当前页接口顺序 = 当前页 DOM 卡片顺序”绑定。
  // 说明：列表卡片标题经常被省略号截断，无法可靠用完整店名匹配；
  // 但接口返回顺序与页面卡片顺序一致，所以这里允许 index-only 兜底。
  if (currentPageShops.length) {
    const len = Math.min(currentPageShops.length, cards.length);

    for (let i = 0; i < len; i++) {
      const shop = currentPageShops[i];
      const card = cards[i];

      if (!shop || !card) continue;
      if (shop.wx_app_path) continue;

      const cardText = clean(card.innerText || card.textContent);
      const shopName = clean(shop.shop_name);
      const branchName = shopName.match(/[（(](.*?)[）)]/)?.[1];

      if (cardText.includes(shopName)) {
        return {
          shop,
          card,
          index: i,
          matchType: 'currentPageIndexExact',
        };
      }

      if (branchName && cardText.includes(branchName)) {
        return {
          shop,
          card,
          index: i,
          matchType: 'currentPageIndexBranch',
        };
      }

      // 关键修复：标题被截断时，仍按当前页接口顺序采集，避免手动翻页后无法继续采集。
      console.warn('[推广采集助手] 当前页卡片标题无法完整校验，已按接口顺序兜底采集：', {
        index: i + 1,
        expectShop: shopName,
        cardText: cardText.slice(0, 120),
      });

      return {
        shop,
        card,
        index: i,
        matchType: 'currentPageIndexOnly',
      };
    }
  }

  // 2. 兜底：只做完整店铺名称匹配，不再使用 shortName 前缀模糊匹配。
  const pendingShops = state.shops.filter(shop => !shop.wx_app_path);

  for (const shop of pendingShops) {
    const shopName = clean(shop.shop_name);
    if (!shopName) continue;

    const card = cards.find(el => {
      const text = clean(el.innerText || el.textContent);
      return text.includes(shopName);
    });

    if (card) {
      return {
        shop,
        card,
        matchType: 'fullNameExact',
      };
    }
  }

  return null;
}

  function getPromoteButton(card) {
    return (
      card.querySelector(CONFIG.buttonSelector) ||
      card.querySelector('.item-layer span') ||
      card.querySelector('.item-layer') ||
      Array.from(card.querySelectorAll('span, div, button, a')).find(el => clean(el.innerText || el.textContent) === '立即推广')
    );
  }

  function clickDomElement(el) {
    if (!el) return false;

    try {
      el.click();
      return true;
    } catch (e) {}

    try {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      const options = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      };

      el.dispatchEvent(new MouseEvent('mousedown', options));
      el.dispatchEvent(new MouseEvent('mouseup', options));
      el.dispatchEvent(new MouseEvent('click', options));

      return true;
    } catch (e) {
      return false;
    }
  }

  function waitForDetail(shop, timeoutMs = CONFIG.detailTimeoutMs) {
    const start = Date.now();
    const key = getShopKey(shop);
    const shopName = clean(shop.shop_name);

    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const found = state.shops.find(item => {
          const sameKey = key && getShopKey(item) === key;
          const sameName = shopName && clean(item.shop_name) === shopName;
          return (sameKey || sameName) && item.wx_app_path;
        });

        if (found) {
          clearInterval(timer);
          resolve(found);
          return;
        }

        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`等待详情接口超时：${shopName}`));
        }
      }, 800);
    });
  }

  function isListPage() {
    const cards = document.querySelectorAll(CONFIG.cardSelector);
    const text = clean(document.body?.innerText || '');

    return cards.length > 0 && text.includes('预估收益') && text.includes('佣金');
  }

  function isDetailPage() {
    const text = clean(document.body?.innerText || '');

    return (
      text.includes('推广详情') ||
      text.includes('复制小程序链接') ||
      text.includes('复制APPID') ||
      text.includes('文案字段')
    );
  }

  function waitUntil(checkFn, timeoutMs = 12000, intervalMs = 500) {
    const start = Date.now();

    return new Promise(resolve => {
      const timer = setInterval(() => {
        let ok = false;

        try {
          ok = !!checkFn();
        } catch (e) {
          ok = false;
        }

        if (ok) {
          clearInterval(timer);
          resolve(true);
          return;
        }

        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, intervalMs);
    });
  }

function isInAssistantPanel(el) {
  return !!(
    el &&
    el.closest &&
    (
      el.closest('#__tb_ele_promotion_panel__') ||
      el.closest('#__tb_promo_panel__')
    )
  );
}

function isElementVisible(el) {
  if (!el) return false;

  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0'
  );
}

function isElementMounted(el) {
  if (!el) return false;

  const style = window.getComputedStyle(el);

  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0'
  );
}

function setNativeInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;

  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
}

function getSearchContainer() {
  // 优先取页面真实筛选区，避免扫到底部分页
  const direct =
    document.querySelector('.promotion-product-search') ||
    document.querySelector('[class*="promotion-product-search"]') ||
    document.querySelector('[class*="product-search"]');

  if (direct) {
    return direct;
  }

  const candidates = Array.from(document.querySelectorAll('div, section, main'))
    .filter(el => {
      const text = clean(el.innerText || el.textContent);

      return (
        text.includes('城市') &&
        text.includes('店铺名称') &&
        text.includes('类目') &&
        text.includes('查询') &&
        el.querySelector('input')
      );
    });

  candidates.sort((a, b) => {
    return (a.innerText || '').length - (b.innerText || '').length;
  });

  return candidates[0] || document.body;
}

function getSelectLabelNear(selectEl) {
  const container = getSearchContainer();
  const text = clean(container.innerText || '');

  const rect = selectEl.getBoundingClientRect();

  const labels = Array.from(container.querySelectorAll('span, div, label'))
    .map(el => {
      const r = el.getBoundingClientRect();
      return {
        el,
        text: clean(el.innerText || el.textContent),
        dx: Math.abs(r.right - rect.left),
        dy: Math.abs(r.top - rect.top),
        left: r.left,
        right: r.right,
        top: r.top,
      };
    })
    .filter(item => {
      if (!item.text) return false;
      if (!['城市', '店铺名称', '类目', '结果'].includes(item.text)) return false;
      return item.left < rect.left && item.dy < 80;
    })
    .sort((a, b) => a.dy - b.dy || a.dx - b.dx);

  return labels[0]?.text || '';
}

function captureSearchState() {
  const container = getSearchContainer();

  // 1. 保存普通 input，例如“店铺名称”
  const inputs = Array.from(container.querySelectorAll('input'))
    .filter(input => !isInAssistantPanel(input))
    .filter(input => isElementMounted(input))
    .map((input, index) => ({
      index,
      type: input.type || '',
      value: input.value || '',
      placeholder: input.getAttribute('placeholder') || '',
      className: input.className || '',
      name: input.getAttribute('name') || '',
    }))
    .filter(item => {
      if (!item.value) return false;
      if (item.type === 'number') return false;
      if (/page|页码|limit|size|条\/页/i.test(item.placeholder)) return false;
      if (isPageSizeSelectValue(item.value)) return false;
      return true;
    });

  // 2. 保存 Ant Design Select 已选中的显示文本，例如“云龙区”
  const selects = Array.from(container.querySelectorAll('.ant-select'))
    .filter(el => !isInAssistantPanel(el))
    .filter(el => isElementMounted(el))
    .filter(el => !el.closest('.ant-pagination')) // 关键：排除分页区域
    .map((el, index) => {
      const selectedItem =
        el.querySelector('.ant-select-selection-item') ||
        el.querySelector('.ant-select-selection-placeholder');

      const value = clean(
        selectedItem?.getAttribute('title') ||
        selectedItem?.innerText ||
        selectedItem?.textContent ||
        ''
      );

      const placeholder = clean(
        el.querySelector('.ant-select-selection-placeholder')?.innerText ||
        el.querySelector('input')?.getAttribute('placeholder') ||
        ''
      );

      return {
        index,
        label: getSelectLabelNear(el),
        value,
        placeholder,
        className: el.className || '',
      };
    })
    .filter(isSearchSelectSnapshot);

  const snapshot = {
    inputs,
    selects,
    pageNumber: getCurrentPageNumber(),
    pageSignature: getCurrentPageSignature(),
    categoryName: state.selectedCategoryName || '',
    capturedAt: now(),
    url: location.href,
  };

  state.searchSnapshot = snapshot;
  saveState();

  console.log('[推广采集助手] 已保存查询条件：', snapshot);
  log(`已保存查询条件：input ${inputs.length} 个，select ${selects.length} 个`);

  return snapshot;
}

async function openSelect(selectEl) {
  const selector =
    selectEl.querySelector('.ant-select-selector') ||
    selectEl;

  selector.click();
  await sleep(500);

  const input = selectEl.querySelector('input');

  if (input) {
    input.focus();
  }

  return input;
}

function normalizeSelectText(value) {
  return clean(value)
    .replace(/[×xX]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function isPageSizeSelectValue(value) {
  const text = normalizeSelectText(value);

  return (
    /条\/页/.test(text) ||
    /^\d+条$/.test(text) ||
    /^\d+\/页$/.test(text) ||
    text.includes('跳至') ||
    text.includes('页')
  );
}

function isSearchSelectSnapshot(item) {
  const value = clean(item.value);
  const label = clean(item.label);
  const placeholder = clean(item.placeholder);

  if (!value) return false;
  if (['请选择城市', '全部类目', '全部', ''].includes(value)) return false;

  // 关键：排除底部分页的 20条/页
  if (isPageSizeSelectValue(value)) return false;
  if (isPageSizeSelectValue(placeholder)) return false;

  // 当前主要只恢复城市筛选
  if (label === '城市') return true;
  if (placeholder.includes('城市')) return true;

  // 兜底：像“云龙区 / 徐州 / 江苏”这种已选城市值也保留
  if (/省|市|区|县|镇|街道/.test(value)) return true;

  return false;
}

function getVisibleDropdownOptions() {
  const result = [];

  // 1. 普通 Select
  const normalOptions = Array.from(
    document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
  )
    .filter(el => isElementVisible(el))
    .map(el => ({
      el,
      text: clean(
        el.getAttribute('title') ||
        el.innerText ||
        el.textContent ||
        ''
      ),
      type: 'normal-option',
    }))
    .filter(item => item.text);

  result.push(...normalOptions);

  // 2. TreeSelect：城市树，例如 江苏 / 徐州 / 云龙区
  const treeTitleOptions = Array.from(
    document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-tree-title')
  )
    .filter(el => isElementVisible(el))
    .map(el => {
      const treeNode = el.closest('.ant-select-tree-treenode');

      const checkbox =
        treeNode?.querySelector('.ant-select-tree-checkbox') ||
        treeNode?.querySelector('.ant-select-tree-checkbox-inner');

      const contentWrapper =
        treeNode?.querySelector('.ant-select-tree-node-content-wrapper') ||
        el;

      return {
        el: checkbox || contentWrapper || el,
        text: clean(
          el.getAttribute('title') ||
          el.innerText ||
          el.textContent ||
          ''
        ),
        type: 'tree-title',
      };
    })
    .filter(item => item.text);

  result.push(...treeTitleOptions);

  // 3. 兜底
  const treeNodeOptions = Array.from(
    document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-tree-node-content-wrapper')
  )
    .filter(el => isElementVisible(el))
    .map(el => {
      const treeNode = el.closest('.ant-select-tree-treenode');

      const checkbox =
        treeNode?.querySelector('.ant-select-tree-checkbox') ||
        treeNode?.querySelector('.ant-select-tree-checkbox-inner');

      return {
        el: checkbox || el,
        text: clean(
          el.getAttribute('title') ||
          el.innerText ||
          el.textContent ||
          ''
        ),
        type: 'tree-wrapper',
      };
    })
    .filter(item => item.text);

  result.push(...treeNodeOptions);

  const seen = new Set();

  return result.filter(item => {
    const key = `${item.type}:${normalizeSelectText(item.text)}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

async function restoreSelectByText(item) {
  // 关键：跳过分页下拉，例如 20条/页
  if (!isSearchSelectSnapshot(item)) {
    log(`跳过非筛选下拉框：${item.value || item.placeholder || item.index}`);
    return true;
  }

  const container = getSearchContainer();

  try {
    container.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  } catch (e) {}

  await sleep(800);

  const selects = Array.from(container.querySelectorAll('.ant-select'))
    .filter(el => !isInAssistantPanel(el))
    .filter(el => isElementMounted(el))
    .filter(el => !el.closest('.ant-pagination'));

  let target = null;

  if (item.label) {
    target = selects.find(el => getSelectLabelNear(el) === item.label);
  }

  if (!target && item.placeholder) {
    target = selects.find(el => {
      const placeholder = clean(
        el.querySelector('.ant-select-selection-placeholder')?.innerText ||
        el.querySelector('input')?.getAttribute('placeholder') ||
        ''
      );

      return placeholder === item.placeholder || placeholder.includes('城市');
    });
  }

  if (!target) {
    target = selects.find(el => {
      const text = clean(el.innerText || el.textContent);
      return text.includes('请选择城市') || text.includes(item.value);
    });
  }

  if (!target) {
    target = selects[item.index];
  }

  if (!target) {
    log(`未找到可恢复的下拉框：${item.label || item.placeholder || item.index}`);
    return false;
  }

  const input = await openSelect(target);

  if (input) {
    setNativeInputValue(input, item.value);
    await sleep(1500);
  }

  const options = getVisibleDropdownOptions();
  const targetText = normalizeSelectText(item.value);

  let option = options.find(opt => normalizeSelectText(opt.text) === targetText);

  if (!option) {
    option = options.find(opt => {
      const optionText = normalizeSelectText(opt.text);
      return optionText.includes(targetText) || targetText.includes(optionText);
    });
  }

  if (!option && item.value.length >= 2) {
    const shortValue = normalizeSelectText(item.value).replace(/市|区|县|省/g, '');

    option = options.find(opt => {
      const optionText = normalizeSelectText(opt.text).replace(/市|区|县|省/g, '');
      return optionText.includes(shortValue) || shortValue.includes(optionText);
    });
  }

  if (!option) {
    log(`没有在下拉选项中找到：${item.value}`, {
      当前下拉选项: options.map(opt => `${opt.text}(${opt.type})`).slice(0, 50),
    });

    return false;
  }

  const clicked = clickDomElement(option.el);

  if (!clicked) {
    try {
      option.el.click();
    } catch (e) {
      log(`点击下拉选项失败：${option.text}`);
      return false;
    }
  }

  log(`已恢复下拉框：${item.label || item.placeholder || item.index} = ${option.text}`);

  // 选中城市后关闭下拉框，否则会遮住“查询”按钮
  await closeAllSelectDropdowns();

  await sleep(1000);
  return true;
}

function hasOpenSelectDropdown() {
  return Array.from(document.querySelectorAll('.ant-select-dropdown'))
    .some(dropdown => {
      const style = window.getComputedStyle(dropdown);
      const rect = dropdown.getBoundingClientRect();

      return (
        !dropdown.classList.contains('ant-select-dropdown-hidden') &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
}

async function closeAllSelectDropdowns() {
  // 1. 先用 ESC 关闭 Ant Design 下拉框
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    }));

    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    }));
  } catch (e) {}

  await sleep(300);

  // 2. blur 当前输入框
  try {
    if (document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
  } catch (e) {}

  await sleep(300);

  // 3. 点击页面空白处，进一步关闭下拉层
  try {
    const pointTarget =
      document.elementFromPoint(20, 20) ||
      document.body;

    if (pointTarget) {
      pointTarget.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: 20,
        clientY: 20,
      }));

      pointTarget.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: 20,
        clientY: 20,
      }));

      pointTarget.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: 20,
        clientY: 20,
      }));
    }
  } catch (e) {}

  await sleep(600);

  // 4. 如果仍然有下拉，再发一次 ESC
  if (hasOpenSelectDropdown()) {
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      }));
    } catch (e) {}

    await sleep(500);
  }

  return !hasOpenSelectDropdown();
}

function normalizeButtonText(value) {
  return clean(value)
    .replace(/\s+/g, '')
    .replace(/　/g, '')
    .trim();
}

function isQueryButtonText(value) {
  const text = normalizeButtonText(value);
  return text === '查询' || text === '搜索';
}

function findSearchQueryButton() {
  function isBadArea(el) {
    return (
      isInAssistantPanel(el) ||
      el.closest('.ant-pagination') ||
      el.closest('.ant-select-dropdown') ||
      el.closest('.ant-dropdown') ||
      el.closest('.ant-picker-dropdown')
    );
  }

  function getText(el) {
    return normalizeButtonText(el.innerText || el.textContent);
  }

  function isUsableButton(btn) {
    if (!btn) return false;
    if (isBadArea(btn)) return false;
    if (!isElementMounted(btn)) return false;

    const text = getText(btn);
    if (!isQueryButtonText(text)) return false;

    return true;
  }

  // 1. 最优先：按真实 DOM 结构找
  const directSelectors = [
    '.promotion-product-search form button[type="submit"].ant-btn-primary',
    '.promotion-product-search button[type="submit"].ant-btn-primary',
    '.promotion-product-search form button[type="submit"]',
    '.promotion-product-search button[type="submit"]',
    '[class*="promotion-product-search"] form button[type="submit"].ant-btn-primary',
    '[class*="promotion-product-search"] button[type="submit"].ant-btn-primary',
    '[class*="promotion-product-search"] form button[type="submit"]',
    '[class*="promotion-product-search"] button[type="submit"]',
    '#alliance-child-nine-promotion__entry form button[type="submit"].ant-btn-primary',
    '#alliance-child-nine-promotion__entry button[type="submit"].ant-btn-primary',
    '#alliance-child-nine-promotion__entry form button[type="submit"]',
  ];

  for (const selector of directSelectors) {
    const btn = document.querySelector(selector);

    if (btn && !isBadArea(btn) && isElementMounted(btn)) {
      const text = getText(btn);

      if (isQueryButtonText(text)) {
        console.log('[推广采集助手] 已通过直接选择器找到查询按钮：', {
          selector,
          text,
          btn,
        });

        return btn;
      }
    }
  }

  // 2. 全页面找 type=submit 的查询按钮
  const submitButtons = Array.from(document.querySelectorAll('button[type="submit"]'))
    .filter(btn => !isBadArea(btn))
    .filter(btn => isElementMounted(btn))
    .map(btn => ({
      el: btn,
      text: getText(btn),
      rawText: clean(btn.innerText || btn.textContent),
      className: btn.className || '',
      rect: btn.getBoundingClientRect(),
      html: btn.outerHTML.slice(0, 200),
    }))
    .filter(item => isQueryButtonText(item.text))
    .filter(item => item.rect.top < window.innerHeight * 0.75);

  if (submitButtons.length) {
    const primary = submitButtons.find(item => {
      return String(item.className).includes('ant-btn-primary');
    });

    const chosen = primary || submitButtons[0];

    console.log('[推广采集助手] 已通过 submit button 找到查询按钮：', chosen);
    return chosen.el;
  }

  // 3. 兜底：所有 button 中找“查询 / 查 询”
  const allButtons = Array.from(document.querySelectorAll('button'))
    .filter(btn => !isBadArea(btn))
    .filter(btn => isElementMounted(btn))
    .map(btn => ({
      el: btn,
      text: getText(btn),
      rawText: clean(btn.innerText || btn.textContent),
      className: btn.className || '',
      rect: btn.getBoundingClientRect(),
      html: btn.outerHTML.slice(0, 200),
    }))
    .filter(item => isQueryButtonText(item.text))
    .filter(item => item.rect.top < window.innerHeight * 0.75);

  if (allButtons.length) {
    const primary = allButtons.find(item => {
      return String(item.className).includes('ant-btn-primary');
    });

    const chosen = primary || allButtons[0];

    console.log('[推广采集助手] 已通过全页面 button 找到查询按钮：', chosen);
    return chosen.el;
  }

  // 4. 兜底：span 文本是“查 询”，向上找 button
  const spanButtons = Array.from(document.querySelectorAll('span'))
    .filter(span => isQueryButtonText(span.innerText || span.textContent))
    .map(span => span.closest('button'))
    .filter(Boolean)
    .filter(btn => !isBadArea(btn))
    .filter(btn => isElementMounted(btn))
    .map(btn => ({
      el: btn,
      text: getText(btn),
      rawText: clean(btn.innerText || btn.textContent),
      className: btn.className || '',
      rect: btn.getBoundingClientRect(),
      html: btn.outerHTML.slice(0, 200),
    }))
    .filter(item => item.rect.top < window.innerHeight * 0.75);

  if (spanButtons.length) {
    const primary = spanButtons.find(item => {
      return String(item.className).includes('ant-btn-primary');
    });

    const chosen = primary || spanButtons[0];

    console.log('[推广采集助手] 已通过 span.closest(button) 找到查询按钮：', chosen);
    return chosen.el;
  }

  console.warn('[推广采集助手] 查询按钮候选为空，当前页面 button 列表：',
    Array.from(document.querySelectorAll('button')).map(btn => ({
      rawText: clean(btn.innerText || btn.textContent),
      normalizedText: normalizeButtonText(btn.innerText || btn.textContent),
      type: btn.getAttribute('type'),
      className: btn.className,
      mounted: isElementMounted(btn),
      inPagination: !!btn.closest('.ant-pagination'),
      inDropdown: !!btn.closest('.ant-select-dropdown'),
      rect: btn.getBoundingClientRect(),
      html: btn.outerHTML.slice(0, 200),
    }))
  );

  return null;
}

async function clickSearchQueryButton() {
  await closeAllSelectDropdowns();
  await sleep(500);

  const queryButton = findSearchQueryButton();

  if (!queryButton) {
    log('没有找到“查询”按钮，请手动点击查询后继续');
    return false;
  }

  try {
    queryButton.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  } catch (e) {}

  await sleep(300);

  let clicked = false;

  try {
    clicked = clickDomElement(queryButton);
  } catch (e) {
    clicked = false;
  }

  if (!clicked) {
    try {
      queryButton.click();
      clicked = true;
    } catch (e) {
      clicked = false;
    }
  }

  // 兜底：触发表单 submit
  if (!clicked) {
    try {
      const form = queryButton.closest('form');

      if (form) {
        form.dispatchEvent(new Event('submit', {
          bubbles: true,
          cancelable: true,
        }));

        clicked = true;
      }
    } catch (e) {
      clicked = false;
    }
  }

  if (!clicked) {
    log('点击“查询”按钮失败，请手动点击查询后继续');
    return false;
  }

  log('已自动点击查询');
  return true;
}

  async function restoreSearchStateAndQuery() {
  const snapshot = state.searchSnapshot;

  const hasInputs = snapshot && Array.isArray(snapshot.inputs) && snapshot.inputs.length > 0;
  const hasSelects = snapshot && Array.isArray(snapshot.selects) && snapshot.selects.length > 0;
  const targetPage = parseInt(snapshot?.pageNumber || '', 10);
  const expectedCategoryName = clean(snapshot?.categoryName || state.selectedCategoryName || '');

  if (!hasInputs && !hasSelects) {
    log('没有保存的查询条件，跳过自动恢复');
    return true;
  }

  if (isSearchStateAlreadyApplied()) {
    // 区域转链按类目采集时，返回详情页后类目可能丢失；这里强制恢复当前类目，再回到原页。
    if (expectedCategoryName && expectedCategoryName !== '全部') {
      log(`查询条件已保留，准备确认类目：${expectedCategoryName}`);
      const categoryOk = await selectCategory(expectedCategoryName);
      if (!categoryOk) return false;

      if (Number.isFinite(targetPage) && targetPage > 0 && getCurrentPageNumber() !== targetPage) {
        return await goToPageNumber(targetPage);
      }

      log('查询条件和类目已恢复');
      return true;
    }

    if (Number.isFinite(targetPage) && targetPage > 0 && getCurrentPageNumber() !== targetPage) {
      log(`查询条件已保留，但页码需要恢复到第 ${targetPage} 页`);
      return await goToPageNumber(targetPage);
    }

    log('查询条件已保留，跳过自动查询');
    return true;
  }

  log('准备恢复查询条件');

  const container = getSearchContainer();

  try {
    container.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  } catch (e) {}

  await sleep(1000);

  // 1. 先恢复 Select，比如城市
  if (hasSelects) {
    for (const item of snapshot.selects) {
      const ok = await restoreSelectByText(item);

      if (!ok) {
        log('恢复下拉查询条件失败，已停止，避免采集错误列表', item);
        return false;
      }

      await sleep(500);
    }
  }

  // 2. 再恢复普通输入框，比如店铺名称
  if (hasInputs) {
    const latestContainer = getSearchContainer();

    const visibleInputs = Array.from(latestContainer.querySelectorAll('input'))
      .filter(input => !isInAssistantPanel(input))
      .filter(input => isElementMounted(input));

    for (const item of snapshot.inputs) {
      let target = null;

      if (item.placeholder) {
        target = visibleInputs.find(input => {
          return (input.getAttribute('placeholder') || '') === item.placeholder;
        });
      }

      if (!target && item.name) {
        target = visibleInputs.find(input => {
          return (input.getAttribute('name') || '') === item.name;
        });
      }

      if (!target) {
        target = visibleInputs[item.index];
      }

      if (target) {
        setNativeInputValue(target, item.value);
        log(`已恢复输入框：${item.placeholder || item.name || item.index} = ${item.value}`);
        await sleep(500);
      } else {
        log('恢复输入框失败，已停止，避免采集错误列表', item);
        return false;
      }
    }
  }

  await sleep(800);

  // 3. 点击查询，注意查询一般会回到第一页
  const beforeSignature = getCurrentPageSignature();
  const startTime = Date.now();
  const clickedQuery = await clickSearchQueryButton();

  if (!clickedQuery) {
    return false;
  }

  const listOk = await waitForFreshListSince(startTime, beforeSignature, 22000) ||
    await waitUntil(() => findCards().length > 0, 10000, 500);

  if (!listOk) {
    log('已点击查询，但没有检测到新的店铺列表，请手动确认页面');
    return false;
  }

  // 4. 如果当前处于类目拆分采集，查询城市后还必须恢复上一次类目。
  // 否则详情页返回后只恢复区县、不恢复类目，会错误回到“全部”类目继续采集。
  if (expectedCategoryName && expectedCategoryName !== '全部') {
    log(`准备恢复类目：${expectedCategoryName}`);
    const categoryOk = await selectCategory(expectedCategoryName);

    if (!categoryOk) {
      log(`恢复类目失败：${expectedCategoryName}，已停止，避免采集错误类目`);
      return false;
    }
  }

  // 5. 如果采集前在第 N 页，查询后可能回到第 1 页；这里恢复原页码
  if (Number.isFinite(targetPage) && targetPage > 0) {
    const pageOk = await goToPageNumber(targetPage);

    if (!pageOk) {
      log(`查询后未能恢复到第 ${targetPage} 页，已停止，避免从错误页继续采集`);
      return false;
    }
  }

  if (!isSearchStateAlreadyApplied()) {
    log('查询后校验查询条件失败，已停止，避免采集错误列表');
    return false;
  }

  log('查询结果已恢复');
  return true;
}

  async function returnToListPage() {
    if (isListPage()) {
      return true;
    }

    log('当前不在列表页，准备返回店铺列表');

    // 1. 优先点击页面里的“返回”按钮
    let clicked = false;

    try {
      const nodes = Array.from(document.querySelectorAll('button, span, div, a'));

      const backNode = nodes.find(el => {
        const text = clean(el.innerText || el.textContent);
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        return (
          text === '返回' &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top >= 0 &&
          rect.top < 160 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      });

      if (backNode) {
        backNode.click();
        clicked = true;
      }
    } catch (e) {}

    // 2. 如果没有找到文字“返回”，点击详情页左上角区域
    if (!clicked && isDetailPage()) {
      try {
        const target = document.elementFromPoint(36, 88);
        if (target) {
          target.click();
          clicked = true;
        }
      } catch (e) {}
    }

    // 3. 兜底：浏览器历史返回
    if (!clicked) {
      try {
        history.back();
        clicked = true;
      } catch (e) {}
    }

    await sleep(2500);

    let ok = await waitUntil(isListPage, 12000, 500);

    // 4. 如果第一次没回来，再试一次 history.back()
    if (!ok) {
      try {
        history.back();
      } catch (e) {}

      await sleep(2500);
      ok = await waitUntil(isListPage, 12000, 500);
    }

    if (ok) {
      log('已返回店铺列表页');

      // 关键：返回后必须恢复并校验查询条件，失败则停止，避免采集未筛选列表
      const restored = await restoreSearchStateAndQuery();

      if (!restored) {
        log('返回列表后查询条件恢复失败，已停止，避免采集错误列表');
        return false;
      }

      return true;
    }

    log('返回列表失败，请手动返回后继续采集');
    return false;
  }


async function sleepWithStop(ms, stepMs = 300) {
  const start = Date.now();

  while (Date.now() - start < ms) {
    if (state.stopRequested) {
      return false;
    }

    await sleep(Math.min(stepMs, ms - (Date.now() - start)));
  }

  return true;
}

function requestStopCollection() {
  state.stopRequested = true;
  state.currentMode = '正在停止';
  log('已请求停止采集：当前店铺完成后会停止');
  updatePanel();
}

function getCurrentPageNumber() {
  const active = document.querySelector('.ant-pagination .ant-pagination-item-active');
  const text = clean(
    active?.getAttribute('title') ||
    active?.innerText ||
    active?.textContent ||
    ''
  );

  const num = parseInt(text, 10);
  return Number.isFinite(num) ? num : null;
}

function getCurrentPageSignature() {
  const cards = findCards();

  return cards
    .slice(0, 3)
    .map(card => clean(card.innerText || card.textContent).slice(0, 80))
    .join('|');
}

function findNextPageButton() {
  const nextLi =
    document.querySelector('.ant-pagination .ant-pagination-next') ||
    document.querySelector('.ant-pagination-next');

  if (!nextLi) return null;

  const ariaDisabled = nextLi.getAttribute('aria-disabled');
  const disabled =
    ariaDisabled === 'true' ||
    nextLi.classList.contains('ant-pagination-disabled') ||
    nextLi.querySelector('button[disabled]');

  if (disabled) return null;

  const btn =
    nextLi.querySelector('button.ant-pagination-item-link') ||
    nextLi.querySelector('button') ||
    nextLi.querySelector('a') ||
    nextLi;

  return btn;
}

async function goToNextPage() {
  if (state.stopRequested) return false;

  const nextButton = findNextPageButton();

  if (!nextButton) {
    log('没有下一页，整区采集结束');
    return false;
  }

  const beforePage = getCurrentPageNumber();
  const beforeSignature = getCurrentPageSignature();
  const startTime = Date.now();

  try {
    nextButton.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  } catch (e) {}

  await sleep(800);

  if (state.stopRequested) return false;

  const clicked = clickDomElement(nextButton);

  if (!clicked) {
    try {
      nextButton.click();
    } catch (e) {
      log('点击下一页失败，已停止整区采集');
      return false;
    }
  }

  const expectedPage = beforePage ? beforePage + 1 : null;
  log(`已点击下一页${beforePage ? `：当前第 ${beforePage} 页` : ''}`);

  const changed = await waitUntil(() => {
    const nowPage = getCurrentPageNumber();
    const nowSignature = getCurrentPageSignature();

    if (expectedPage && nowPage === expectedPage) return true;
    if (beforePage && nowPage && nowPage !== beforePage) return true;
    if (state.lastListCapturedAt && state.lastListCapturedAt >= startTime) return true;
    if (beforeSignature && nowSignature && nowSignature !== beforeSignature) return true;

    return false;
  }, 22000, 500);

  await sleep(2000);

  if (!changed) {
    log('点击下一页后未检测到列表变化，请手动确认页面');
    return false;
  }

  const afterPage = getCurrentPageNumber();

  if (expectedPage && afterPage && afterPage !== expectedPage) {
    log(`下一页页码异常：期望第 ${expectedPage} 页，实际第 ${afterPage} 页，已停止，避免从错误页继续采集`);
    return false;
  }

  log(`已进入下一页${afterPage ? `：第 ${afterPage} 页` : ''}`);

  return true;
}

function hasVisiblePendingCard() {
  return !!findPendingCard();
}

function getSelectedTextFromSelect(selectEl) {
  if (!selectEl) return '';

  const selectedItems = Array.from(selectEl.querySelectorAll('.ant-select-selection-item'))
    .map(el => clean(
      el.getAttribute('title') ||
      el.innerText ||
      el.textContent ||
      ''
    ))
    .filter(Boolean);

  if (selectedItems.length) {
    return selectedItems.join('、');
  }

  const placeholder = selectEl.querySelector('.ant-select-selection-placeholder');
  return clean(placeholder?.innerText || placeholder?.textContent || '');
}

function findSearchSelectElement(item) {
  const container = getSearchContainer();

  const selects = Array.from(container.querySelectorAll('.ant-select'))
    .filter(el => !isInAssistantPanel(el))
    .filter(el => isElementMounted(el))
    .filter(el => !el.closest('.ant-pagination'));

  let target = null;

  if (item.label) {
    target = selects.find(el => getSelectLabelNear(el) === item.label);
  }

  if (!target && item.placeholder) {
    target = selects.find(el => {
      const placeholder = clean(
        el.querySelector('.ant-select-selection-placeholder')?.innerText ||
        el.querySelector('input')?.getAttribute('placeholder') ||
        ''
      );

      return placeholder === item.placeholder || placeholder.includes('城市');
    });
  }

  if (!target) {
    target = selects.find(el => {
      const text = clean(el.innerText || el.textContent);
      return text.includes(item.value) || text.includes('请选择城市');
    });
  }

  if (!target && Number.isInteger(item.index)) {
    target = selects[item.index];
  }

  return target || null;
}

function isSearchStateAlreadyApplied() {
  const snapshot = state.searchSnapshot;
  if (!snapshot) return false;
  if (!findCards().length) return false;

  const selects = Array.isArray(snapshot.selects) ? snapshot.selects.filter(isSearchSelectSnapshot) : [];
  const inputs = Array.isArray(snapshot.inputs) ? snapshot.inputs : [];
  const container = getSearchContainer();

  const selectOk = selects.every(item => {
    const expected = normalizeSelectText(item.value);
    if (!expected) return true;

    const target = findSearchSelectElement(item);
    if (!target) {
      console.warn('[推广采集助手] 查询条件校验失败：未找到下拉框', item);
      return false;
    }

    const actual = normalizeSelectText(getSelectedTextFromSelect(target));
    const ok = actual.includes(expected) || expected.includes(actual);

    if (!ok) {
      console.warn('[推广采集助手] 查询条件校验失败：下拉框值不一致', {
        expected: item.value,
        actual: getSelectedTextFromSelect(target),
      });
    }

    return ok;
  });

  const visibleInputs = Array.from(container.querySelectorAll('input'))
    .filter(input => !isInAssistantPanel(input))
    .filter(input => isElementMounted(input));

  const inputOk = inputs.every(item => {
    const expected = clean(item.value);
    if (!expected) return true;

    let target = null;

    if (item.placeholder) {
      target = visibleInputs.find(input => (input.getAttribute('placeholder') || '') === item.placeholder);
    }

    if (!target && item.name) {
      target = visibleInputs.find(input => (input.getAttribute('name') || '') === item.name);
    }

    if (!target && Number.isInteger(item.index)) {
      target = visibleInputs[item.index];
    }

    const actual = clean(target?.value || '');
    const ok = actual === expected;

    if (!ok) {
      console.warn('[推广采集助手] 查询条件校验失败：输入框值不一致', {
        expected,
        actual,
        item,
      });
    }

    return ok;
  });

  return selectOk && inputOk;
}

async function waitForFreshListSince(startTime, beforeSignature = '', timeoutMs = 20000) {
  return waitUntil(() => {
    if (!findCards().length) return false;

    const freshByApi = state.lastListCapturedAt && state.lastListCapturedAt >= startTime;
    const signatureChanged = beforeSignature && getCurrentPageSignature() !== beforeSignature;

    return !!freshByApi || !!signatureChanged;
  }, timeoutMs, 500);
}

function findPrevPageButton() {
  const prevLi =
    document.querySelector('.ant-pagination .ant-pagination-prev') ||
    document.querySelector('.ant-pagination-prev');

  if (!prevLi) return null;

  const ariaDisabled = prevLi.getAttribute('aria-disabled');
  const disabled =
    ariaDisabled === 'true' ||
    prevLi.classList.contains('ant-pagination-disabled') ||
    prevLi.querySelector('button[disabled]');

  if (disabled) return null;

  return (
    prevLi.querySelector('button.ant-pagination-item-link') ||
    prevLi.querySelector('button') ||
    prevLi.querySelector('a') ||
    prevLi
  );
}

function findPageNumberButton(pageNumber) {
  const candidates = Array.from(document.querySelectorAll('.ant-pagination-item'))
    .filter(el => {
      const text = clean(el.getAttribute('title') || el.innerText || el.textContent || '');
      return parseInt(text, 10) === pageNumber;
    });

  const li = candidates[0];
  if (!li) return null;

  return li.querySelector('button') || li.querySelector('a') || li;
}

function findPaginationJumperInput() {
  return (
    document.querySelector('.ant-pagination-options-quick-jumper input') ||
    Array.from(document.querySelectorAll('.ant-pagination input'))
      .filter(input => isElementMounted(input))
      .find(input => {
        const placeholder = clean(input.getAttribute('placeholder') || '');
        const value = clean(input.value || '');
        return !isPageSizeSelectValue(placeholder) && !isPageSizeSelectValue(value);
      }) ||
    null
  );
}


async function waitForPageListReady(targetPage, beforeSignature = '', startTime = Date.now(), timeoutMs = 22000) {
  targetPage = parseInt(targetPage, 10);

  return waitUntil(() => {
    const nowPage = getCurrentPageNumber();
    const nowSignature = getCurrentPageSignature();
    const pageOk = !Number.isFinite(targetPage) || targetPage <= 0 || nowPage === targetPage;

    const freshByApi = !!(state.lastListCapturedAt && state.lastListCapturedAt >= startTime);
    const signatureChanged = !!(beforeSignature && nowSignature && nowSignature !== beforeSignature);
    const hasCards = findCards().length > 0;

    // 页码按钮可能先变，卡片和接口稍后才刷新；必须等“页码正确 + 列表也刷新/有数据”才继续。
    return pageOk && hasCards && (freshByApi || signatureChanged || !beforeSignature);
  }, timeoutMs, 500);
}

async function refreshCurrentPageMapping(reason = 'refresh-current-page') {
  await sleep(700);

  if (!isListPage()) {
    return false;
  }

  // 接口数据优先；如果接口没有及时捕获，再用 DOM 兜底同步当前页，避免 currentPageShopKeys 停留在旧页。
  const synced = syncCurrentPageFromDom(reason, { force: false });
  return synced || getCurrentPageShopsFromState().length > 0;
}

async function goToPageNumber(targetPage) {
  targetPage = parseInt(targetPage, 10);

  if (!Number.isFinite(targetPage) || targetPage <= 0) {
    return true;
  }

  const currentPage = getCurrentPageNumber();

  if (currentPage === targetPage) {
    await refreshCurrentPageMapping('page-already-current');
    return true;
  }

  log(`准备恢复页码：目标第 ${targetPage} 页，当前第 ${currentPage || '未知'} 页`);

  // 1. 如果目标页码按钮可见，直接点页码；但必须等对应列表刷新后才返回 true。
  const directButton = findPageNumberButton(targetPage);

  if (directButton) {
    const beforeSignature = getCurrentPageSignature();
    const startTime = Date.now();

    clickDomElement(directButton) || directButton.click();

    const ok = await waitForPageListReady(targetPage, beforeSignature, startTime, 24000);

    if (ok && getCurrentPageNumber() === targetPage) {
      await refreshCurrentPageMapping('restore-page-direct');
      log(`已恢复到第 ${targetPage} 页`);
      return true;
    }
  }

  // 2. 优先使用“跳至 X 页”输入框，避免从第 1 页反复点击到第 N 页。
  const jumper = findPaginationJumperInput();

  if (jumper) {
    const beforeSignature = getCurrentPageSignature();
    const startTime = Date.now();

    try {
      jumper.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {}

    await sleep(300);

    setNativeInputValue(jumper, String(targetPage));

    try {
      jumper.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }));

      jumper.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }));
    } catch (e) {}

    try {
      jumper.blur();
    } catch (e) {}

    const ok = await waitForPageListReady(targetPage, beforeSignature, startTime, 26000);

    if (ok && getCurrentPageNumber() === targetPage) {
      await refreshCurrentPageMapping('restore-page-jumper');
      log(`已通过跳页框恢复到第 ${targetPage} 页`);
      return true;
    }
  }

  // 3. 最后兜底：用上一页/下一页逐步走到目标页。
  let guard = 0;

  while (!state.stopRequested && getCurrentPageNumber() !== targetPage && guard < 100) {
    guard += 1;

    const nowPage = getCurrentPageNumber();
    if (!nowPage) break;

    const btn = targetPage > nowPage ? findNextPageButton() : findPrevPageButton();
    if (!btn) break;

    const beforeSignature = getCurrentPageSignature();
    const startTime = Date.now();

    clickDomElement(btn) || btn.click();

    const expected = targetPage > nowPage ? nowPage + 1 : nowPage - 1;
    const moved = await waitForPageListReady(expected, beforeSignature, startTime, 18000);

    if (!moved) break;

    await refreshCurrentPageMapping('restore-page-step');
    await sleep(800);
  }

  if (getCurrentPageNumber() === targetPage) {
    await refreshCurrentPageMapping('restore-page-final');
    log(`已恢复到第 ${targetPage} 页`);
    return true;
  }

  log(`恢复页码失败：目标第 ${targetPage} 页，当前第 ${getCurrentPageNumber() || '未知'} 页`);
  return false;
}

async function collectNext(options = {}) {
  const keepStopFlag = !!options.keepStopFlag;

  if (!keepStopFlag) {
    state.stopRequested = false;
  }

  if (state.running) {
    log('当前正在采集中，请等待完成。');
    return false;
  }

  if (state.stopRequested) {
    log('已停止采集');
    return false;
  }

  state.running = true;
  state.currentMode = options.mode || state.currentMode || '单店采集';
  updatePanel();

  try {
    // 如果上一轮停在详情页，先返回列表页
    if (!isListPage()) {
      const returned = await returnToListPage();

      if (!returned) {
        state.running = false;
        state.currentMode = '';
        updatePanel();
        return false;
      }
    }

    if (state.stopRequested) {
      state.running = false;
      state.currentMode = '';
      updatePanel();
      return false;
    }

    // 如果用户是在页面原生城市筛选框里选择区域，而没有在助手输入框里填写，
    // 单店/转链采集前也自动锁定该区域，避免返回时清空查询后误采全部列表。
    if (!state.regionKeyword) {
      const pageRegionForLock = getPageSelectedRegionText();
      if (pageRegionForLock) {
        setPanelRegionKeyword(pageRegionForLock);
        log(`已从页面城市筛选框锁定区域：${pageRegionForLock}`);
      }
    }

    const target = findPendingCard();

    if (!target) {
      log('当前 DOM 中没有找到待采集店铺卡片。请先点击“查询”或滚动到店铺列表区域。');
      state.running = false;
      state.currentMode = '';
      updatePanel();
      return false;
    }

    const { shop, card } = target;
    const cardTextBeforeClick = clean(card.innerText || card.textContent);
    const shopNameBeforeClick = clean(shop.shop_name);
    const branchNameBeforeClick = shopNameBeforeClick.match(/[（(](.*?)[）)]/)?.[1];

    const safeMatched =
      cardTextBeforeClick.includes(shopNameBeforeClick) ||
      (branchNameBeforeClick && cardTextBeforeClick.includes(branchNameBeforeClick));

    const allowIndexOnly =
      target.matchType === 'currentPageIndexOnly' &&
      Number.isInteger(target.index) &&
      getCurrentPageShopsFromState().length > 0;

    if (!safeMatched && !allowIndexOnly) {
      log('安全校验失败：当前卡片文本与准备采集的店铺不一致，已跳过，避免误点', {
        expectShop: shopNameBeforeClick,
        cardText: cardTextBeforeClick.slice(0, 200),
        matchType: target.matchType,
        index: target.index,
      });

      state.running = false;
      updatePanel();
      return false;
    }

    if (!safeMatched && allowIndexOnly) {
      log('卡片标题被截断，已按当前页接口顺序继续采集', {
        expectShop: shopNameBeforeClick,
        cardText: cardTextBeforeClick.slice(0, 200),
        matchType: target.matchType,
        index: target.index,
      });
    }
    card.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });

    await sleep(1000);

    try {
      card.style.outline = '3px solid #ff4d00';
      card.style.outlineOffset = '2px';
    } catch (e) {}

    const button = getPromoteButton(card);

    if (!button) {
      throw new Error(`未找到 .item-layer span：${shop.shop_name}`);
    }

    const delay = randomDelay();

    log(`准备采集：${shop.shop_name}，等待 ${Math.round(delay / 1000)} 秒`, {
      matchType: target.matchType,
      index: target.index,
      shopKey: getShopKey(shop),
    });

    const delayOk = await sleepWithStop(delay);

    if (!delayOk || state.stopRequested) {
      log('已停止：尚未进入店铺详情');
      state.running = false;
      state.currentMode = '';
      updatePanel();
      return false;
    }

    // 进入详情页前，保存当前查询条件，并锁定当前采集店铺 key
    captureSearchState();
    state.currentCollectingShopKey = getShopKey(shop);
    saveState();

    const clicked = clickDomElement(button);

    if (!clicked) {
      throw new Error(`调用 click 失败：${shop.shop_name}`);
    }

    log(`已点击 .item-layer span：${shop.shop_name}，等待详情接口返回`);

    const detail = await waitForDetail(shop);

    log(`采集成功：${shop.shop_name}`, {
      wx_app_path: detail.wx_app_path,
    });

    state.currentCollectingShopKey = '';
    saveState();

    await sleep(1500);

    // 关键修复：采集成功后主动返回列表页
    const returned = await returnToListPage();

    if (!returned) {
      state.running = false;
      state.currentMode = '';
      updatePanel();
      return false;
    }

    await sleep(1500);

    try {
      card.style.outline = '';
      card.style.outlineOffset = '';
    } catch (e) {}

    state.running = false;
    state.currentMode = state.batchRunning ? '批量采集中' : (state.autoRunning ? '整区采集中' : '');
    updatePanel();
    return true;

  } catch (error) {
    state.currentCollectingShopKey = '';
    saveState();

    log('采集失败，已停止', {
      error: error.message,
    });

    // 出错后也尝试回到列表页，方便下一次继续
    await returnToListPage();

    state.running = false;
    state.currentMode = '';
    updatePanel();
    return false;
  }
}

async function collectBatch() {
  if (state.running || state.batchRunning || state.autoRunning) {
    log('当前正在采集中，请等待完成或先点击停止采集。');
    return;
  }

  state.stopRequested = false;
  state.batchRunning = true;
  state.currentMode = `批量采集${CONFIG.batchSize}家`;
  updatePanel();

  let collected = 0;

  try {
    for (let i = 0; i < CONFIG.batchSize; i++) {
      if (state.stopRequested) {
        log('批量采集已停止');
        break;
      }

      if (!hasVisiblePendingCard()) {
        log(`当前页已无待采集店铺，本轮批量结束；本轮成功 ${collected} 家`);
        break;
      }

      const ok = await collectNext({
        keepStopFlag: true,
        mode: `批量采集${CONFIG.batchSize}家`,
      });

      if (!ok) {
        log(`批量采集在第 ${i + 1} 家停止；本轮成功 ${collected} 家`);
        break;
      }

      collected += 1;

      if (i < CONFIG.batchSize - 1 && !state.stopRequested) {
        await sleepWithStop(randomDelay());
      }
    }
  } finally {
    state.batchRunning = false;
    state.currentMode = '';
    updatePanel();
  }

  log(`本轮批量采集结束：成功 ${collected} 家`);
}

async function recoverCurrentPageBeforeRetry(reason = 'collect-retry') {
  if (!isListPage()) {
    const returned = await returnToListPage();
    if (!returned) return false;
  }

  if (state.searchSnapshot) {
    const restored = await restoreSearchStateAndQuery();
    if (!restored) return false;
  }

  await refreshCurrentPageMapping(reason);
  await sleep(1000);
  return true;
}

async function collectCurrentPageAll() {
  let collected = 0;
  let completed = false;
  let failed = false;
  let retryCount = 0;
  const maxRetryCount = 3;
  const maxAttempts = CONFIG.batchSize + maxRetryCount;

  for (let i = 0; i < maxAttempts; i++) {
    if (state.stopRequested) {
      log('整区采集已收到停止请求');
      break;
    }

    // 每轮开始前尝试刷新当前页映射，防止恢复页码后 currentPageShopKeys 仍停留在旧页。
    await refreshCurrentPageMapping('before-current-page-collect');

    if (!hasVisiblePendingCard()) {
      // 再恢复一次，避免刚返回/刚跳页时 DOM 与接口未同步导致误判“无待采”。
      const recovered = await recoverCurrentPageBeforeRetry('no-pending-recheck');

      if (recovered && hasVisiblePendingCard()) {
        log('当前页待采集卡片已通过恢复流程重新识别，继续采集');
      } else {
        log(`当前页待采集店铺已完成：成功 ${collected} 家`);
        completed = true;
        break;
      }
    }

    const ok = await collectNext({
      keepStopFlag: true,
      mode: '整区采集中',
    });

    if (!ok) {
      if (state.stopRequested) {
        log('当前页采集收到停止请求');
        break;
      }

      retryCount += 1;
      log(`当前页单店采集异常，准备恢复后重试：第 ${retryCount}/${maxRetryCount} 次，已成功 ${collected} 家`);

      const recovered = await recoverCurrentPageBeforeRetry(`collect-next-failed-${retryCount}`);

      if (recovered && retryCount <= maxRetryCount && hasVisiblePendingCard()) {
        continue;
      }

      if (recovered && !hasVisiblePendingCard()) {
        log(`当前页恢复后已无待采集店铺，视为当前页完成：成功 ${collected} 家`);
        completed = true;
        break;
      }

      failed = true;
      log(`当前页采集提前停止：成功 ${collected} 家`);
      break;
    }

    retryCount = 0;
    collected += 1;

    if (collected >= CONFIG.batchSize) {
      completed = !hasVisiblePendingCard();
      if (!completed) {
        // 当前页理论上 20 条；如果页面出现少于/多于 20 条，这里再检查一次，避免错误翻页。
        await refreshCurrentPageMapping('batch-size-reached-recheck');
        completed = !hasVisiblePendingCard();
      }
      break;
    }

    if (!state.stopRequested) {
      await sleepWithStop(randomDelay());
    }
  }

  if (!completed && !failed && !state.stopRequested) {
    await refreshCurrentPageMapping('current-page-final-check');
    completed = !hasVisiblePendingCard();
  }

  return {
    collected,
    completed,
    failed,
  };
}

async function collectAllPages() {
  if (state.running || state.batchRunning || state.autoRunning) {
    log('当前正在采集中，请等待完成或先点击停止采集。');
    return;
  }

  state.stopRequested = false;
  state.autoRunning = true;
  state.currentMode = '整区采集中';
  updatePanel();

  let totalCollected = 0;
  let pageCount = 0;

  try {
    if (!isListPage()) {
      const returned = await returnToListPage();

      if (!returned) {
        log('整区采集启动失败：当前不在列表页');
        return;
      }
    }

    while (!state.stopRequested) {
      pageCount += 1;

      if (pageCount > CONFIG.fullPageMaxSafetyPages) {
        log(`已达到安全页数上限 ${CONFIG.fullPageMaxSafetyPages}，自动停止`);
        break;
      }

      if (state.searchSnapshot && !isSearchStateAlreadyApplied()) {
        log('开始当前页采集前发现查询条件不一致，准备恢复');
        const restored = await restoreSearchStateAndQuery();

        if (!restored) {
          log('当前页查询条件恢复失败，整区采集停止');
          break;
        }
      }

      const currentPage = getCurrentPageNumber();

      log(`开始采集当前页${currentPage ? `：第 ${currentPage} 页` : ''}`);

      const pageResult = await collectCurrentPageAll();
      totalCollected += pageResult.collected;

      if (state.stopRequested) {
        log('整区采集已停止');
        break;
      }

      if (!pageResult.completed) {
        log('当前页未完整采集，已停止翻页，避免漏采或错采', pageResult);
        break;
      }

      const moved = await goToNextPage();

      if (!moved) {
        break;
      }

      await sleepWithStop(randomDelay());
    }
  } finally {
    state.autoRunning = false;
    state.currentMode = '';
    updatePanel();
  }

  log(`整区采集结束：累计成功采集 ${totalCollected} 家`);
}


function getPanelRegionKeyword() {
  const input = document.getElementById('__tb_ele_region_input__');
  const rawValue = String(input?.value || '').trim();

  if (rawValue) {
    const first = parseRegionBatchText(rawValue)[0];
    if (first?.searchName) return first.searchName;
    const inputValue = normalizeRegionText(rawValue);
    if (inputValue) return inputValue;
  }

  // 支持直接在页面城市筛选框中选中区域后，从助手面板一键采集。
  const pageRegion = getPageSelectedRegionText();
  if (pageRegion) return pageRegion;

  return normalizeRegionText(state.regionKeyword || '');
}

function shouldPreserveMultiRegionInput(value) {
  const raw = String(value || '');
  if (!raw.trim()) return false;

  // 多行、多区域或“市：区1、区2”这类文本，都属于批量输入，不能被覆盖成首个区县。
  return (
    /[\n\r]/.test(raw) ||
    parseRegionBatchText(raw).length > 1
  );
}

function setPanelRegionKeyword(value, options = {}) {
  const syncInput = options.syncInput !== false;
  state.regionKeyword = clean(value);

  const input = document.getElementById('__tb_ele_region_input__');

  if (input && syncInput && input.value !== state.regionKeyword && !state.multiRegionRunning) {
    // 关键修复：如果输入框里是多个区域，禁止把 textarea 覆盖成第一个区域。
    if (!shouldPreserveMultiRegionInput(input.value)) {
      input.value = state.regionKeyword;
    }
  }

  saveState();
}

function normalizeRegionText(value) {
  return clean(value)
    .replace(/[×xX]/g, '')
    .replace(/\s+/g, '')
    .replace(/请选择城市/g, '')
    .replace(/全部类目/g, '')
    .trim();
}

function getCitySelectElement() {
  const container = getSearchContainer();

  const selects = Array.from(container.querySelectorAll('.ant-select'))
    .filter(el => !isInAssistantPanel(el))
    .filter(el => isElementMounted(el))
    .filter(el => !el.closest('.ant-pagination'));

  const byLabel = selects.find(el => getSelectLabelNear(el) === '城市');
  if (byLabel) return byLabel;

  const byPlaceholder = selects.find(el => {
    const placeholder = clean(
      el.querySelector('.ant-select-selection-placeholder')?.innerText ||
      el.querySelector('input')?.getAttribute('placeholder') ||
      ''
    );

    return placeholder.includes('城市');
  });

  if (byPlaceholder) return byPlaceholder;

  return selects[0] || null;
}

function getPageSelectedRegionText() {
  const citySelect = getCitySelectElement();
  if (!citySelect) return '';

  const text = getSelectedTextFromSelect(citySelect);
  const normalized = normalizeRegionText(text);

  if (!normalized) return '';
  if (normalized.includes('请选择城市')) return '';

  return normalized;
}

function getLockedRegionKeyword() {
  const input = document.getElementById('__tb_ele_region_input__');
  const inputValue = normalizeRegionText(input?.value || '');
  if (inputValue) return inputValue;

  const pageRegion = getPageSelectedRegionText();
  if (pageRegion) return pageRegion;

  return normalizeRegionText(state.regionKeyword || '');
}

function isRegionMatchedForCapture(lockedRegion, pageRegion) {
  const locked = normalizeRegionText(lockedRegion);
  const current = normalizeRegionText(pageRegion);

  if (!locked) return true;
  if (!current) return false;

  return current.includes(locked) || locked.includes(current);
}

function getCurrentListPageGuardSignature() {
  return `${normalizeRegionText(state.regionKeyword || '')}|${getPageSelectedRegionText() || 'EMPTY'}|${getCurrentPageNumber() || ''}|${getCurrentPageSignature()}`;
}

function shouldAcceptCurrentListPage(reason = 'list-capture') {
  const lockedRegion = normalizeRegionText(state.regionKeyword || '');

  // 没有锁定区域时，保留原来的自由采集能力。
  if (!lockedRegion) return true;

  const pageRegion = getPageSelectedRegionText();
  const ok = isRegionMatchedForCapture(lockedRegion, pageRegion);

  if (!ok) {
    const signature = getCurrentListPageGuardSignature();

    if (state.lastRejectedListSignature !== signature) {
      state.lastRejectedListSignature = signature;
      console.warn('[推广采集助手] 已拦截非锁定区域列表，避免误采集：', {
        reason,
        lockedRegion,
        pageRegion: pageRegion || '无查询状态',
        page: getCurrentPageNumber(),
        signature,
      });
    }

    return false;
  }

  return true;
}

function getDomListTotalCount() {
  const text = clean(document.body?.innerText || '');
  const matches = Array.from(text.matchAll(/共\s*(\d+)\s*家店铺/g));
  if (!matches.length) return 0;

  return Math.max(...matches.map(match => Number(match[1])).filter(num => Number.isFinite(num)));
}

function getCurrentListTotalCount() {
  const apiTotal = Number(state.lastListTotalCount || 0);
  const domTotal = getDomListTotalCount();

  // 部分接口会把 totalCount / totalStock 截断为 1000，但页面右侧显示真实总数，例如 1077 家。
  // 区域是否需要按类目拆分，应以两者中的最大值为准。
  return Math.max(
    Number.isFinite(apiTotal) ? apiTotal : 0,
    Number.isFinite(domTotal) ? domTotal : 0
  );
}

function buildRegionSearchSnapshot(regionKeyword) {
  const region = clean(regionKeyword);
  return {
    inputs: [],
    selects: region ? [{
      index: 0,
      label: '城市',
      value: region,
      placeholder: '请选择城市',
      className: '',
    }] : [],
    pageNumber: 1,
    pageSignature: getCurrentPageSignature(),
    categoryName: '全部',
    capturedAt: now(),
    url: location.href,
  };
}

async function ensureRegionSearch(regionKeyword, options = {}) {
  const region = clean(regionKeyword);
  if (!region) {
    log('请先在助手面板输入市或区县');
    return false;
  }

  setPanelRegionKeyword(region);
  state.lastRejectedListSignature = '';
  state.selectedCategoryName = '全部';
  state.searchSnapshot = buildRegionSearchSnapshot(region);
  saveState();

  if (!isListPage()) {
    const returned = await returnToListPage();
    if (!returned) return false;
  }

  log(`准备查询区域：${region}`);

  const beforeSignature = getCurrentPageSignature();
  const startTime = Date.now();

  const restored = await restoreSearchStateAndQuery();
  if (!restored) {
    log(`区域查询失败：${region}`);
    return false;
  }

  await waitForFreshListSince(startTime, beforeSignature, 15000);
  await sleep(500);
  syncCurrentPageFromDom('region-search-sync', { force: false });

  // 先恢复到“全部”类目，用于判断区域总量；后续超过 1000 时再按类目拆分。
  await selectCategory('全部');

  log(`区域查询完成：${region}，当前总数 ${getCurrentListTotalCount() || '未知'} 家`);
  return true;
}

function findCategoryOption(categoryName) {
  const name = clean(categoryName);
  if (!name) return null;

  const container = getSearchContainer();
  const candidates = Array.from(container.querySelectorAll('span, div, a, button'))
    .filter(el => !isInAssistantPanel(el))
    .filter(el => isElementMounted(el))
    .filter(el => !el.closest('.ant-pagination'))
    .filter(el => !el.closest('.ant-select-dropdown'))
    .map(el => ({
      el,
      text: clean(el.innerText || el.textContent),
      rect: el.getBoundingClientRect(),
    }))
    .filter(item => {
      if (!item.text) return false;
      if (item.text !== name) return false;
      // 类目行一般在页面上方，避免误选列表中的菜品文案。
      return item.rect.top < window.innerHeight * 0.45;
    });

  if (!candidates.length) return null;

  // 优先点击最小文本元素。
  candidates.sort((a, b) => (a.text.length - b.text.length) || (a.rect.top - b.rect.top));
  return candidates[0].el;
}

function removeSelectedCategoryTags() {
  const container = getSearchContainer();
  const categorySet = new Set(CONFIG.regionCategoryNames || []);
  let removed = 0;

  const tags = Array.from(container.querySelectorAll('.ant-tag, [class*="ant-tag"]'))
    .filter(el => !isInAssistantPanel(el))
    .filter(el => isElementMounted(el))
    .filter(el => {
      const text = clean(el.innerText || el.textContent).replace(/[×xX]/g, '').trim();
      return categorySet.has(text);
    });

  for (const tag of tags) {
    const closeEl =
      tag.querySelector('.ant-tag-close-icon') ||
      tag.querySelector('.anticon-close') ||
      tag.querySelector('[aria-label="close"]') ||
      tag.querySelector('svg') ||
      null;

    if (closeEl) {
      clickDomElement(closeEl) || closeEl.click();
      removed += 1;
    }
  }

  if (removed > 0) {
    log(`已移除已选类目标签 ${removed} 个`);
  }

  return removed;
}

async function clearCategorySelectionsToAll(options = {}) {
  const shouldQuery = options.query !== false;

  try {
    getSearchContainer().scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {}

  await sleep(250);

  // 先尝试移除结果区里的已选类目标签，避免“地方菜 + 特色菜”叠加。
  removeSelectedCategoryTags();
  await sleep(250);

  const allOption = findCategoryOption('全部');
  if (!allOption) {
    log('没有找到类目筛选：全部');
    return false;
  }

  clickDomElement(allOption) || allOption.click();
  log('已先切回全部类目，清空上一个类目筛选');
  await sleep(500);

  if (shouldQuery) {
    const clicked = await clickSearchQueryButton();
    if (!clicked) return false;
    await sleep(500);
    syncCurrentPageFromDom('category-all-clear', { force: false });
  }

  return true;
}

async function selectCategory(categoryName) {
  const name = clean(categoryName || '全部');

  try {
    getSearchContainer().scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {}

  await sleep(300);

  const beforeSignature = getCurrentPageSignature();
  const startTime = Date.now();

  // 关键修复：类目是多选控件。切换到下一个类目前，必须先清空上一个类目。
  // 否则会出现“地方菜 + 特色菜 + 甜品...”越选越多。
  const cleared = await clearCategorySelectionsToAll({ query: false });
  if (!cleared) return false;

  if (name !== '全部') {
    const option = findCategoryOption(name);
    if (!option) {
      log(`没有找到类目筛选：${name}`);
      return false;
    }

    clickDomElement(option) || option.click();
    log(`已选择单一类目：${name}`);
    await sleep(500);
  } else {
    log('已选择类目：全部');
  }

  state.selectedCategoryName = name;
  saveState();

  // 有些类目点击后会自动查询；有些需要点击查询按钮，这里统一补一次查询。
  const clicked = await clickSearchQueryButton();
  if (!clicked) return false;

  await waitForFreshListSince(startTime, beforeSignature, 15000);
  await sleep(500);
  syncCurrentPageFromDom(`category-${name}`, { force: false });
  saveState();
  return true;
}

async function collectListCurrentAreaPages(options = {}) {
  const fastDelay = Number(options.fastDelayMs || CONFIG.fastPageDelayMs || 700);
  const maxPages = Number(options.maxPages || CONFIG.fullPageMaxSafetyPages || 300);
  let pageCount = 0;
  let addedPages = 0;

  if (!isListPage()) {
    const returned = await returnToListPage();
    if (!returned) return { pages: pageCount, completed: false };
  }

  while (!state.stopRequested) {
    pageCount += 1;
    if (pageCount > maxPages) {
      log(`店铺列表采集达到安全页数上限 ${maxPages}，已停止`);
      return { pages: pageCount, completed: false };
    }

    const beforeCount = state.shops.length;
    syncCurrentPageFromDom('list-page-harvest', { force: false });
    addedPages += 1;

    log(`已同步当前页店铺：第 ${getCurrentPageNumber() || '?'} 页，新增 ${state.shops.length - beforeCount} 条，累计 ${state.shops.length} 条`);

    const moved = await goToNextPageFast(fastDelay);
    if (!moved) {
      return { pages: pageCount, completed: true };
    }
  }

  return { pages: pageCount, completed: false };
}

async function goToNextPageFast(delayMs = 700) {
  if (state.stopRequested) return false;

  const nextButton = findNextPageButton();
  if (!nextButton) {
    log('没有下一页，当前列表采集结束');
    return false;
  }

  const beforePage = getCurrentPageNumber();
  const beforeSignature = getCurrentPageSignature();
  const startTime = Date.now();

  try {
    nextButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {}

  await sleep(Math.min(Math.max(delayMs, 200), 1000));
  if (state.stopRequested) return false;

  clickDomElement(nextButton) || nextButton.click();

  const expectedPage = beforePage ? beforePage + 1 : null;
  log(`已点击下一页${beforePage ? `：当前第 ${beforePage} 页` : ''}`);

  const changed = await waitForPageListReady(expectedPage, beforeSignature, startTime, 18000);

  await sleep(Math.min(Math.max(delayMs, 200), 1000));

  if (!changed) {
    log('点击下一页后未检测到新页列表加载完成');
    return false;
  }

  await refreshCurrentPageMapping('next-page-fast-sync');
  return true;
}


function sanitizeFilenamePart(value) {
  const text = clean(value)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return text || '未命名区域';
}

function makeRegionBatchItem(city, region, raw) {
  const c = normalizeRegionText(city || '');
  const r = normalizeRegionText(region || '');
  const searchName = r || c;

  if (!searchName) return null;

  let fileBaseName = '';
  if (c && r && c !== r) {
    fileBaseName = `${c}-${r}`;
  } else {
    fileBaseName = searchName;
  }

  return {
    city: c,
    region: r,
    searchName,
    fileBaseName: sanitizeFilenamePart(fileBaseName),
    raw: clean(raw || fileBaseName),
  };
}

function parseRegionBatchText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const result = [];

  function pushItem(item) {
    if (!item || !item.searchName) return;
    const key = `${item.fileBaseName}|${item.searchName}`;
    if (result.some(existing => `${existing.fileBaseName}|${existing.searchName}` === key)) return;
    result.push(item);
  }

  const lines = raw
    .split(/[\n\r；;]+/)
    .map(line => clean(line))
    .filter(Boolean);

  for (const line of lines) {
    // 支持：徐州市：云龙区、泉山区、铜山区
    const colonMatch = line.match(/^(.+?[市州盟地区县])\s*[:：]\s*(.+)$/);
    if (colonMatch) {
      const city = colonMatch[1];
      const areas = colonMatch[2]
        .split(/[、,，\s]+/)
        .map(clean)
        .filter(Boolean);

      for (const area of areas) {
        pushItem(makeRegionBatchItem(city, area, line));
      }
      continue;
    }

    // 支持单行多个：云龙区、泉山区、铜山区
    if (/[、,，]/.test(line) && !/[-—_]/.test(line)) {
      line.split(/[、,，]+/)
        .map(clean)
        .filter(Boolean)
        .forEach(part => pushItem(makeRegionBatchItem('', part, part)));
      continue;
    }

    // 支持：徐州市-泉山区 / 徐州市_泉山区 / 徐州市 — 泉山区
    if (/[-—_]/.test(line)) {
      const parts = line.split(/[-—_]+/).map(clean).filter(Boolean);
      if (parts.length >= 2) {
        pushItem(makeRegionBatchItem(parts[0], parts.slice(1).join(''), line));
        continue;
      }
    }

    // 支持：徐州市 泉山区
    const spaceParts = line.split(/\s+/).map(clean).filter(Boolean);
    if (spaceParts.length >= 2 && /市|州|盟|地区/.test(spaceParts[0])) {
      pushItem(makeRegionBatchItem(spaceParts[0], spaceParts.slice(1).join(''), line));
      continue;
    }

    // 兜底：单个市 / 区 / 县
    pushItem(makeRegionBatchItem('', line, line));
  }

  return result;
}

function getRegionBatchItemsFromPanel() {
  const input = document.getElementById('__tb_ele_region_input__');

  // 关键修复：这里不能使用 clean()，否则换行会被压成空格，导致多区域列表解析异常。
  const text = String(input?.value || state.multiRegionText || state.regionKeyword || '');
  const items = parseRegionBatchText(text);

  if (items.length) return items;

  const pageRegion = getPageSelectedRegionText();
  return pageRegion ? [makeRegionBatchItem('', pageRegion, pageRegion)] : [];
}


function findSearchResetButton() {
  const container = getSearchContainer();

  const candidates = Array.from(container.querySelectorAll('button'))
    .filter(btn => !isInAssistantPanel(btn))
    .filter(btn => isElementMounted(btn))
    .filter(btn => !btn.closest('.ant-pagination'))
    .map(btn => ({
      el: btn,
      text: normalizeButtonText(btn.innerText || btn.textContent),
      rawText: clean(btn.innerText || btn.textContent),
      rect: btn.getBoundingClientRect(),
    }))
    .filter(item => item.text === '重置' || item.text === '清空');

  if (candidates.length) {
    candidates.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    return candidates[0].el;
  }

  const globalCandidates = Array.from(document.querySelectorAll('button'))
    .filter(btn => !isInAssistantPanel(btn))
    .filter(btn => isElementMounted(btn))
    .filter(btn => !btn.closest('.ant-pagination'))
    .map(btn => ({
      el: btn,
      text: normalizeButtonText(btn.innerText || btn.textContent),
      rawText: clean(btn.innerText || btn.textContent),
      rect: btn.getBoundingClientRect(),
    }))
    .filter(item => item.text === '重置' || item.text === '清空')
    .filter(item => item.rect.top < window.innerHeight * 0.45);

  if (globalCandidates.length) {
    globalCandidates.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    return globalCandidates[0].el;
  }

  return null;
}

async function clearPageSearchFiltersForRegionSwitch(reason = 'region-switch') {
  if (!isListPage()) {
    log(`当前不在列表页，跳过页面查询条件清空：${reason}`);
    return false;
  }

  try {
    getSearchContainer().scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {}

  await closeAllSelectDropdowns();
  await sleep(300);

  const beforeSignature = getCurrentPageSignature();
  const startTime = Date.now();
  const resetButton = findSearchResetButton();

  if (resetButton) {
    clickDomElement(resetButton) || resetButton.click();
    log(`已点击页面“重置”，清空上一区域查询状态：${reason}`);
  } else {
    log(`没有找到页面“重置”按钮，将仅清空脚本暂存状态：${reason}`);
  }

  // 重置会触发无区域列表接口；此时 state.regionKeyword 仍是旧/新锁定区域，
  // shouldAcceptCurrentListPage 会拦截非锁定区域列表，避免误写入店铺池。
  await waitForFreshListSince(startTime, beforeSignature, 4000);
  await sleep(700);
  await closeAllSelectDropdowns();

  state.searchSnapshot = null;
  state.selectedCategoryName = '';
  state.currentPageShopKeys = [];
  state.lastListTotalCount = 0;
  state.lastDomSignature = '';
  state.lastDomSyncedAt = 0;
  state.lastRejectedListSignature = '';
  saveState();
  updatePanel();

  return !!resetButton;
}

function resetRuntimeCollectionDataAfterRegionExport(options = {}) {
  const keepMultiRegionText = options.keepMultiRegionText !== false;
  const input = document.getElementById('__tb_ele_region_input__');
  const multiText = keepMultiRegionText
    ? String(input?.value || state.multiRegionText || '')
    : '';

  state.shops = [];
  state.details = [];
  state.logs = state.logs.slice(-30);
  state.currentPageShopKeys = [];
  state.lastListCapturedAt = 0;
  state.lastDomSyncedAt = 0;
  state.lastDomSignature = '';
  state.currentCollectingShopKey = '';
  state.lastListTotalCount = 0;
  state.selectedCategoryName = '';
  state.searchSnapshot = null;
  state.lastRejectedListSignature = '';
  state.currentBatchFileBaseName = '';

  if (options.clearRegion !== false) {
    state.regionKeyword = '';
  }

  if (keepMultiRegionText) {
    state.multiRegionText = multiText;
    if (input && input.value !== multiText) {
      input.value = multiText;
    }
  } else {
    state.multiRegionText = '';
  }

  saveState();
  updatePanel();
}

function resetCollectionDataForNextRegion(regionItem) {
  const input = document.getElementById('__tb_ele_region_input__');
  const multiText = String(input?.value || state.multiRegionText || '');

  state.shops = [];
  state.details = [];
  state.logs = state.logs.slice(-30);
  state.currentPageShopKeys = [];
  state.lastListCapturedAt = 0;
  state.lastDomSyncedAt = 0;
  state.lastDomSignature = '';
  state.currentCollectingShopKey = '';
  state.lastListTotalCount = 0;
  state.selectedCategoryName = '';
  state.searchSnapshot = null;
  state.lastRejectedListSignature = '';
  state.currentBatchFileBaseName = regionItem?.fileBaseName || '';
  state.multiRegionText = multiText;
  setPanelRegionKeyword(regionItem?.searchName || '', { syncInput: false });
  saveState();
  updatePanel();
}

function exportCSVWithFilename(filename) {
  const rows = buildRows();

  if (!rows.length) {
    log(`暂无数据，跳过导出 CSV：${filename}`);
    return false;
  }

  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(',')),
  ].join('\n');

  downloadText(filename, '\ufeff' + csv, 'text/csv;charset=utf-8;');
  log(`已导出 CSV：${filename}，共 ${rows.length} 条`);
  return true;
}

function exportJSONWithFilename(filename) {
  const data = {
    shops: state.shops,
    details: state.details,
    rows: buildRows(),
    logs: state.logs,
    region: state.regionKeyword,
    exportRegion: state.currentBatchFileBaseName || state.regionKeyword,
    exportedAt: now(),
  };

  if (!data.rows.length) {
    log(`暂无数据，跳过导出 JSON：${filename}`);
    return false;
  }

  downloadText(filename, JSON.stringify(data, null, 2), 'application/json;charset=utf-8;');
  log(`已导出 JSON：${filename}`);
  return true;
}

async function exportCurrentRegionFiles(regionItem) {
  const base = sanitizeFilenamePart(regionItem?.fileBaseName || state.currentBatchFileBaseName || state.regionKeyword || '未命名区域');
  exportCSVWithFilename(`${base}.csv`);
  await sleep(600);
  exportJSONWithFilename(`${base}.json`);
  await sleep(800);
}

function getRegionCategoriesForTotal(total) {
  return total > 1000 ? ['全部', ...CONFIG.regionCategoryNames] : ['全部'];
}

async function harvestRegionListCore(region) {
  const searched = await ensureRegionSearch(region);
  if (!searched || state.stopRequested) return false;

  const total = getCurrentListTotalCount();
  const categories = getRegionCategoriesForTotal(total);

  if (total > 1000) {
    log(`当前区域约 ${total} 家，超过 1000，先采集全部类目，再按细分类目补充采集店铺`);
  } else {
    log(`当前区域约 ${total || '未知'} 家，不超过 1000，按全部类目翻页采集店铺`);
  }

  for (const category of categories) {
    if (state.stopRequested) break;

    const ok = await selectCategory(category);
    if (!ok) {
      log(`类目 ${category} 查询失败，跳过`);
      continue;
    }

    await collectListCurrentAreaPages({ fastDelayMs: CONFIG.fastPageDelayMs });
  }

  return !state.stopRequested;
}

async function harvestRegionLinkCore(region) {
  const searched = await ensureRegionSearch(region);
  if (!searched || state.stopRequested) return false;

  const total = getCurrentListTotalCount();
  const categories = getRegionCategoriesForTotal(total);
  let totalLinked = 0;

  if (total > 1000) {
    log(`当前区域约 ${total} 家，超过 1000，先采集全部类目转链，再按细分类目补充采集转链`);
  } else {
    log(`当前区域约 ${total || '未知'} 家，不超过 1000，按全部类目采集转链`);
  }

  for (const category of categories) {
    if (state.stopRequested) break;

    const ok = await selectCategory(category);
    if (!ok) {
      log(`类目 ${category} 查询失败，跳过`);
      continue;
    }

    let guard = 0;
    while (!state.stopRequested) {
      guard += 1;
      if (guard > CONFIG.fullPageMaxSafetyPages) {
        log(`类目 ${category} 达到安全页数上限，停止该类目`);
        break;
      }

      const page = getCurrentPageNumber();
      log(`开始采集类目 ${category} 第 ${page || '?'} 页转链`);
      const pageResult = await collectCurrentPageAll();
      totalLinked += pageResult.collected;

      if (state.stopRequested) break;
      if (!pageResult.completed) {
        log(`类目 ${category} 当前页未完整采集，已尝试恢复；为避免整批突然结束，继续尝试下一页`, pageResult);

        const recovered = await recoverCurrentPageBeforeRetry(`category-${category}-page-failed`);
        if (recovered && hasVisiblePendingCard()) {
          log(`类目 ${category} 当前页仍有待采集店铺，继续重试当前页`);
          continue;
        }

        const movedAfterFail = await goToNextPageFast(CONFIG.fastPageDelayMs);
        if (!movedAfterFail) break;
        continue;
      }

      const moved = await goToNextPageFast(CONFIG.fastPageDelayMs);
      if (!moved) break;
    }
  }

  log(`区域转链核心流程结束：${region}，本次转链成功 ${totalLinked} 家`);
  return !state.stopRequested;
}

async function runMultiRegionListHarvest() {
  if (state.running || state.batchRunning || state.autoRunning || state.multiRegionRunning) {
    log('当前正在采集中，请等待完成或先点击停止采集。');
    return;
  }

  const items = getRegionBatchItemsFromPanel();
  if (!items.length) {
    log('请先输入区域列表，例如：徐州市-泉山区，或每行一个区县');
    return;
  }

  state.stopRequested = false;
  state.multiRegionRunning = true;
  state.autoRunning = true;
  state.currentRegionMode = 'multi-list';
  state.currentBatchTotal = items.length;
  state.multiRegionText = document.getElementById('__tb_ele_region_input__')?.value || '';
  saveState();

  try {
    for (let i = 0; i < items.length; i++) {
      if (state.stopRequested) break;

      const item = items[i];
      state.currentBatchIndex = i + 1;
      state.currentMode = `多区域店铺采集 ${i + 1}/${items.length}`;
      resetCollectionDataForNextRegion(item);
      await clearPageSearchFiltersForRegionSwitch(`开始采集 ${item.fileBaseName} 前`);
      log(`开始采集区域店铺：${item.fileBaseName}（查询：${item.searchName}）`);

      await harvestRegionListCore(item.searchName);
      await exportCurrentRegionFiles(item);
      await clearPageSearchFiltersForRegionSwitch(`区域 ${item.fileBaseName} 导出后`);
      resetRuntimeCollectionDataAfterRegionExport({ clearRegion: true, keepMultiRegionText: true });

      log(`区域店铺采集完成、已导出并已清空暂存数据：${item.fileBaseName}`);
      await sleep(1000);
    }
  } finally {
    state.multiRegionRunning = false;
    state.autoRunning = false;
    state.currentMode = '';
    state.currentRegionMode = '';
    state.currentBatchIndex = 0;
    updatePanel();
    log('多区域店铺采集流程结束');
  }
}

async function runMultiRegionLinkHarvest() {
  if (state.running || state.batchRunning || state.autoRunning || state.multiRegionRunning) {
    log('当前正在采集中，请等待完成或先点击停止采集。');
    return;
  }

  const items = getRegionBatchItemsFromPanel();
  if (!items.length) {
    log('请先输入区域列表，例如：徐州市-泉山区，或每行一个区县');
    return;
  }

  state.stopRequested = false;
  state.multiRegionRunning = true;
  state.autoRunning = true;
  state.currentRegionMode = 'multi-link';
  state.currentBatchTotal = items.length;
  state.multiRegionText = document.getElementById('__tb_ele_region_input__')?.value || '';
  saveState();

  try {
    for (let i = 0; i < items.length; i++) {
      if (state.stopRequested) break;

      const item = items[i];
      state.currentBatchIndex = i + 1;
      state.currentMode = `多区域转链采集 ${i + 1}/${items.length}`;
      resetCollectionDataForNextRegion(item);
      await clearPageSearchFiltersForRegionSwitch(`开始转链 ${item.fileBaseName} 前`);
      log(`开始采集区域转链：${item.fileBaseName}（查询：${item.searchName}）`);

      await harvestRegionLinkCore(item.searchName);
      await exportCurrentRegionFiles(item);
      await clearPageSearchFiltersForRegionSwitch(`区域 ${item.fileBaseName} 转链导出后`);
      resetRuntimeCollectionDataAfterRegionExport({ clearRegion: true, keepMultiRegionText: true });

      log(`区域转链采集完成、已导出并已清空暂存数据：${item.fileBaseName}`);
      await sleep(1000);
    }
  } finally {
    state.multiRegionRunning = false;
    state.autoRunning = false;
    state.currentMode = '';
    state.currentRegionMode = '';
    state.currentBatchIndex = 0;
    updatePanel();
    log('多区域转链采集流程结束');
  }
}

async function runRegionListHarvest(options = {}) {
  if (state.running || state.batchRunning || state.autoRunning) {
    log('当前正在采集中，请等待完成或先点击停止采集。');
    return;
  }

  const region = getPanelRegionKeyword();
  if (!region) {
    log('请先在助手面板输入市或区县');
    return;
  }

  state.stopRequested = false;
  state.autoRunning = true;
  state.currentRegionMode = 'list';
  state.currentMode = '区域店铺采集中';
  updatePanel();

  try {
    const searched = await ensureRegionSearch(region);
    if (!searched || state.stopRequested) return;

    const total = getCurrentListTotalCount();

    if (total > 1000) {
      log(`当前区域约 ${total} 家，超过 1000，先采集全部类目，再按细分类目补充采集店铺`);

      const categories = ['全部', ...CONFIG.regionCategoryNames];

      for (const category of categories) {
        if (state.stopRequested) break;
        const ok = await selectCategory(category);
        if (!ok) {
          log(`类目 ${category} 查询失败，跳过`);
          continue;
        }
        await collectListCurrentAreaPages({ fastDelayMs: CONFIG.fastPageDelayMs });
      }
    } else {
      log(`当前区域约 ${total || '未知'} 家，不超过 1000，按全部类目翻页采集店铺`);
      await selectCategory('全部');
      await collectListCurrentAreaPages({ fastDelayMs: CONFIG.fastPageDelayMs });
    }
  } finally {
    state.autoRunning = false;
    state.currentMode = '';
    state.currentRegionMode = '';
    updatePanel();
    log(`区域店铺采集结束：${region}，累计店铺 ${state.shops.length} 条`);
  }
}

async function runRegionLinkHarvest(options = {}) {
  if (state.running || state.batchRunning || state.autoRunning) {
    log('当前正在采集中，请等待完成或先点击停止采集。');
    return;
  }

  const region = getPanelRegionKeyword();
  if (!region) {
    log('请先在助手面板输入市或区县');
    return;
  }

  state.stopRequested = false;
  state.autoRunning = true;
  state.currentRegionMode = 'link';
  state.currentMode = '区域转链采集中';
  updatePanel();

  let totalLinked = 0;

  try {
    const searched = await ensureRegionSearch(region);
    if (!searched || state.stopRequested) return;

    const total = getCurrentListTotalCount();
    const categories = total > 1000 ? ['全部', ...CONFIG.regionCategoryNames] : ['全部'];

    if (total > 1000) {
      log(`当前区域约 ${total} 家，超过 1000，先采集全部类目转链，再按细分类目补充采集转链`);
    } else {
      log(`当前区域约 ${total || '未知'} 家，不超过 1000，按全部类目采集转链`);
    }

    for (const category of categories) {
      if (state.stopRequested) break;

      const ok = await selectCategory(category);
      if (!ok) {
        log(`类目 ${category} 查询失败，跳过`);
        continue;
      }

      let guard = 0;
      while (!state.stopRequested) {
        guard += 1;
        if (guard > CONFIG.fullPageMaxSafetyPages) {
          log(`类目 ${category} 达到安全页数上限，停止该类目`);
          break;
        }

        const page = getCurrentPageNumber();
        log(`开始采集类目 ${category} 第 ${page || '?'} 页转链`);
        const pageResult = await collectCurrentPageAll();
        totalLinked += pageResult.collected;

        if (state.stopRequested) break;
        if (!pageResult.completed) {
          log(`类目 ${category} 当前页未完整采集，停止该类目`, pageResult);
          break;
        }

        const moved = await goToNextPageFast(CONFIG.fastPageDelayMs);
        if (!moved) break;
      }
    }
  } finally {
    state.autoRunning = false;
    state.currentMode = '';
    state.currentRegionMode = '';
    updatePanel();
    log(`区域转链采集结束：${region}，本次转链成功 ${totalLinked} 家，累计已获链接 ${state.shops.filter(item => item.wx_app_path).length} 条`);
  }
}

function buildRows() {
    return state.shops.map((shop, index) => ({
      index: index + 1,
      dom_key: shop.dom_key || '',
      source_type: shop.source_type || '',
      source_page: shop.source_page || '',
      source_index: shop.source_index || '',
      export_region: shop.export_region || '',
      locked_region: shop.locked_region || '',
      source_category: shop.source_category || '',
      shop_name: shop.shop_name,
      rate: shop.rate,
      monthly_sale_text: shop.monthly_sale_text,
      monthly_sale_number: shop.monthly_sale_number,
      delivery_price: shop.delivery_price,
      delivery_price_yuan: shop.delivery_price_yuan,
      commission_rate: shop.commission_rate,
      commission: shop.commission,
      tag_list: shop.tag_list,
      recommend_reasons: shop.recommend_reasons,
      wx_appid_base: shop.wx_appid_base,
      wx_path_base: shop.wx_path_base,
      en_ele_shop_id: shop.en_ele_shop_id,
      shop_id: shop.shop_id,
      md5_shop_id: shop.md5_shop_id,
      ad_store_id: shop.ad_store_id,
      origin_store_id: shop.origin_store_id,
      logo_url: shop.logo_url,
      item_img_url: shop.item_img_url,
      item_1_name: shop.item_1_name,
      item_1_price: shop.item_1_price,
      item_1_image: shop.item_1_image,
      item_2_name: shop.item_2_name,
      item_2_price: shop.item_2_price,
      item_2_image: shop.item_2_image,
      item_3_name: shop.item_3_name,
      item_3_price: shop.item_3_price,
      item_3_image: shop.item_3_image,
      promotion_status: shop.promotion_status || '',
      promotion_short_code: shop.promotion_short_code || '',
      wx_appid: shop.wx_appid || '',
      wx_app_path: shop.wx_app_path || '',
      wx_qrcode: shop.wx_qrcode || '',
      wx_poster: shop.wx_poster || '',
      share_text_title: shop.share_text_title || '',
      share_text_right_desc: shop.share_text_right_desc || '',
      taobao_scheme_url: shop.taobao_scheme_url || '',
      taobao_qrcode: shop.taobao_qrcode || '',
      captured_at: shop.captured_at,
      promotion_captured_at: shop.promotion_captured_at || '',
    }));
  }

  function csvEscape(value) {
    const str = String(value ?? '');
    return `"${str.replace(/"/g, '""')}"`;
  }

  function downloadText(filename, content, mimeType) {
    const blob = new Blob([content], {
      type: mimeType || 'text/plain;charset=utf-8;',
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = filename;
    a.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCSV() {
    const rows = buildRows();

    if (!rows.length) {
      console.warn('暂无数据。');
      return;
    }

    const headers = Object.keys(rows[0]);

    const csv = [
      headers.join(','),
      ...rows.map(row => headers.map(header => csvEscape(row[header])).join(',')),
    ].join('\n');

    const filename = `${sanitizeFilenamePart(state.currentBatchFileBaseName || state.regionKeyword || 'taobao_shop_promotion_' + new Date().toISOString().replace(/[:.]/g, '-'))}.csv`;

    downloadText(filename, '\ufeff' + csv, 'text/csv;charset=utf-8;');

    log(`已导出 CSV：${filename}，共 ${rows.length} 条`);
  }

  function exportJSON() {
    const data = {
      shops: state.shops,
      details: state.details,
      rows: buildRows(),
      logs: state.logs,
      exportedAt: now(),
    };

    const filename = `${sanitizeFilenamePart(state.currentBatchFileBaseName || state.regionKeyword || 'taobao_shop_promotion_' + new Date().toISOString().replace(/[:.]/g, '-'))}.json`;

    downloadText(filename, JSON.stringify(data, null, 2), 'application/json;charset=utf-8;');

    log(`已导出 JSON：${filename}`);
  }

  function clearData() {
    state.shops = [];
    state.details = [];
    state.logs = [];
    state.currentPageShopKeys = [];
    state.lastListCapturedAt = 0;
    state.currentCollectingShopKey = '';
    state.regionKeyword = '';
    state.selectedCategoryName = '';
    state.lastListTotalCount = 0;
    state.currentRegionMode = '';
    state.multiRegionText = '';
    state.multiRegionRunning = false;
    state.currentBatchIndex = 0;
    state.currentBatchTotal = 0;
    state.currentBatchFileBaseName = '';
    localStorage.removeItem(STORE_KEY);
    log('已清空采集数据。');
  }

  function getRows() {
    const rows = buildRows();
    console.table(rows);
    return rows;
  }

  function updatePanel() {
    const status = document.getElementById('__tb_ele_promotion_status__');
    if (!status) return;

    const gotDetails = state.shops.filter(item => item.wx_app_path).length;
    const pending = state.shops.filter(item => !item.wx_app_path).length;

    const pageRegion = getPageSelectedRegionText();
    const displayRegion = state.regionKeyword || pageRegion || '-';
    const regionWarn = state.regionKeyword && pageRegion && !isRegionMatchedForCapture(state.regionKeyword, pageRegion)
      ? ` <span style="color:#d93026;">页面:${pageRegion}</span>`
      : '';

    status.innerHTML = `
      <div>区域：<b>${displayRegion}</b>${state.selectedCategoryName ? ` / <b>${state.selectedCategoryName}</b>` : ''}${regionWarn}</div>
      <div>当前总数：<b>${getCurrentListTotalCount() || '-'}</b></div>
      <div>列表店铺：<b>${state.shops.length}</b></div>
      <div>已获链接：<b>${gotDetails}</b></div>
      <div>待采集：<b>${pending}</b></div>
      <div>状态：<b>${state.stopRequested ? '正在停止' : (state.currentMode || (state.running ? '采集中' : '空闲'))}</b></div>
      <div>版本：<b>Working 1.3.3</b></div>
    `;
  }

  function createPanel() {
    const old = document.getElementById('__tb_ele_promotion_panel__');
    if (old) old.remove();

    const panel = document.createElement('div');
    panel.id = '__tb_ele_promotion_panel__';

    panel.style.cssText = `
      position: fixed;
      top: 90px;
      right: 20px;
      z-index: 999999;
      width: 330px;
      background: #fff;
      border: 1px solid #ff6a00;
      box-shadow: 0 8px 24px rgba(0,0,0,.16);
      border-radius: 10px;
      padding: 12px;
      font-size: 13px;
      color: #222;
      font-family: Arial, "Microsoft YaHei", sans-serif;
    `;

    const defaultRegionText = state.multiRegionText || state.regionKeyword || getPageSelectedRegionText() || '';

    panel.innerHTML = `
      <div style="font-weight:700;font-size:15px;margin-bottom:8px;">推广采集助手 Working 1.3.3</div>
      <div id="__tb_ele_promotion_status__" style="line-height:1.7;margin-bottom:10px;"></div>

      <div style="margin-bottom:8px;">
        <textarea id="__tb_ele_region_input__" placeholder="输入多个区域：每行一个；支持 徐州市-泉山区 或 徐州市：云龙区、泉山区" style="box-sizing:border-box;width:100%;height:72px;border:1px solid #ffb37a;border-radius:6px;padding:8px 10px;font-size:13px;outline:none;resize:vertical;line-height:1.45;">${defaultRegionText}</textarea>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button id="__tb_ele_multi_link_btn__">批量区域转链</button>
        <button id="__tb_ele_multi_shop_btn__">批量区域店铺</button>
        <button id="__tb_ele_region_link_btn__">采集首个区域转链</button>
        <button id="__tb_ele_region_shop_btn__">采集首个区域店铺</button>
        <button id="__tb_ele_next_btn__">采集下一家</button>
        <button id="__tb_ele_stop_btn__">停止采集</button>
        <button id="__tb_ele_csv_btn__">导出CSV</button>
        <button id="__tb_ele_json_btn__">导出JSON</button>
        <button id="__tb_ele_clear_btn__" style="grid-column:1 / span 2;">清空数据</button>
      </div>
      <div style="margin-top:8px;color:#999;font-size:12px;line-height:1.5;">
        批量模式会按区域逐个采集，并在每个区域完成后自动导出 CSV/JSON。<br>
        文件名按“xx市-xx区.csv/json”生成；翻页等待约 ${CONFIG.fastPageDelayMs}ms。
      </div>
    `;

    document.body.appendChild(panel);

    const buttonStyle = `
      border: 1px solid #ff6a00;
      background: #fff7f0;
      color: #ff6a00;
      border-radius: 6px;
      height: 32px;
      cursor: pointer;
      font-size: 12px;
    `;

    panel.querySelectorAll('button').forEach(btn => {
      btn.style.cssText += buttonStyle;
    });

    const regionInput = document.getElementById('__tb_ele_region_input__');
    regionInput.onchange = () => {
      // 关键修复：失焦时只保存完整多区域文本，不再调用 setPanelRegionKeyword 覆盖 textarea。
      state.multiRegionText = regionInput.value;
      const first = parseRegionBatchText(regionInput.value)[0];
      state.regionKeyword = first?.searchName || normalizeRegionText(regionInput.value);
      state.lastRejectedListSignature = '';
      saveState();
      updatePanel();
    };
    regionInput.oninput = () => {
      // 输入期间保留完整文本；regionKeyword 只用于状态展示和“首个区域”按钮。
      state.multiRegionText = regionInput.value;
      const first = parseRegionBatchText(regionInput.value)[0];
      state.regionKeyword = first?.searchName || normalizeRegionText(regionInput.value);
      state.lastRejectedListSignature = '';
      saveState();
      updatePanel();
    };

    document.getElementById('__tb_ele_multi_link_btn__').onclick = runMultiRegionLinkHarvest;
    document.getElementById('__tb_ele_multi_shop_btn__').onclick = runMultiRegionListHarvest;
    document.getElementById('__tb_ele_region_link_btn__').onclick = runRegionLinkHarvest;
    document.getElementById('__tb_ele_region_shop_btn__').onclick = runRegionListHarvest;
    document.getElementById('__tb_ele_next_btn__').onclick = collectNext;
    document.getElementById('__tb_ele_stop_btn__').onclick = requestStopCollection;
    document.getElementById('__tb_ele_csv_btn__').onclick = exportCSV;
    document.getElementById('__tb_ele_json_btn__').onclick = exportJSON;
    document.getElementById('__tb_ele_clear_btn__').onclick = clearData;

    updatePanel();
  }

  function start() {
    try {
      restoreState();
      hookNetwork();
      hookHistory();
      hookManualPageDomSync();

      if (document.body) {
        createPanel();
      } else {
        window.addEventListener('DOMContentLoaded', createPanel, { once: true });
      }

      window.tbElePromotionCapture = {
        state,
        collectNext,
        collectBatch,
        collectAllPages,
        runRegionLinkHarvest,
        runRegionListHarvest,
        runMultiRegionLinkHarvest,
        runMultiRegionListHarvest,
        parseRegionBatchText,
        selectCategory,
        ensureRegionSearch,
        requestStopCollection,
        syncCurrentPageFromDom,
        getRows,
        exportCSV,
        exportJSON,
        clearData,
      };

      console.log('[推广采集助手 Working] 已安装：', location.href);
    } catch (error) {
      console.error('[推广采集助手 Working] 启动失败：', error);
      alert('推广采集助手启动失败，请打开控制台查看错误：' + error.message);
    }
  }

  start();
})();
