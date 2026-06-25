/* =====================================================================
 * OmniRead - content script (v2.1)
 *
 * 职责：消息协议、DOM 遍历、写入/还原、observer、竞态锁、并发池、划词浮窗。
 * 翻译调用全部走 window.TranslateProvider / window.TranslateConfig / window.TranslateCache。
 * 默认离线 provider 行为与 v1.6 完全一致（回归不破坏）。
 * ===================================================================== */
(() => {
  'use strict';

  /* ---------- 全局状态 ---------- */
  let isTranslationActive = false;
  let displayMode = 'replace';           // 'replace' | 'bilingual'
  let observer = null;
  let debounceTimeout = null;
  let debounceMaxTimer = null;           // 最大等待：防止高频滚动时 debounce 被永久 reset（X 场景）
  let translatingPromise = null;         // 竞态锁
  let isMutatingFromSelf = false;
  let activeProvider = null;             // 当前激活的 provider 配置
  let abortController = null;            // 取消控制器：stopTranslation 时 abort 在途请求

  let translatedNodes = new WeakSet();   // let：stopTranslation 时重新赋值以清空
  let nodeLastText = new WeakMap();      // 记录节点上次处理的原文 → 检测虚拟滚动复用（X）
  let nodeFailCount = new WeakMap();
  let originalTexts = new WeakMap();
  const replacedNodes = new Set();       // 整段替换模式记录被改写节点（停止时还原）
  const MAX_FAIL_RETRIES = 2;

  const DEFAULTS = {
    BATCH_SIZE: 15,
    DEBOUNCE_MS: 500,
    CONCURRENCY: 3           // 批次并发数（DeepSeek 等云端引擎用，离线用 1）
  };
  let config = { ...DEFAULTS };

  const SKIP_TAGS = new Set([
    'script', 'style', 'svg', 'code', 'pre', 'noscript', 'textarea',
    'kbd', 'var', 'math', 'sup', 'sub', 'option', 'template'
  ]);

  /* ---------- 启动时载入持久化模式与目标语言 ---------- */
  chrome.storage.local.get(['displayMode', 'targetLang', 'sourceLang', 'translateShortcut'], (data) => {
    if (data.displayMode) displayMode = data.displayMode;
    if (data.targetLang) TranslateProvider.setTargetLang(data.targetLang);
    if (data.sourceLang) TranslateProvider.setSourceLang(data.sourceLang);
    if (data.translateShortcut) currentShortcut = data.translateShortcut;
  });

  /* ---------- 自定义快捷键 ---------- */
  let currentShortcut = 'Ctrl+Shift+T';

  function parseShortcut(str) {
    const parts = str.toLowerCase().split('+').map(s => s.trim());
    return {
      ctrl: parts.includes('ctrl'),
      shift: parts.includes('shift'),
      alt: parts.includes('alt'),
      meta: parts.includes('meta') || parts.includes('command'),
      key: parts.find(p => !['ctrl', 'shift', 'alt', 'meta', 'command'].includes(p)) || ''
    };
  }

  function matchShortcut(e, shortcut) {
    const s = parseShortcut(shortcut);
    return e.ctrlKey === s.ctrl
      && e.shiftKey === s.shift
      && e.altKey === s.alt
      && e.metaKey === s.meta
      && e.key.toLowerCase() === s.key;
  }

  document.addEventListener('keydown', async (e) => {
    if (!matchShortcut(e, currentShortcut)) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    e.preventDefault();
    if (isTranslationActive) {
      stopTranslation();
    } else {
      // 快捷键启动：先同步持久化的语言/模式，再复用 startTranslation 的完整流程。
      // 复用而非重复实现，确保和点按钮一样走 checkAvailability——引擎不可用时
      // 会抛错，这里上报给 popup（快捷键无弹窗直连），避免静默失败。
      const data = await chrome.storage.local.get(['displayMode', 'targetLang', 'sourceLang']);
      TranslateProvider.setTargetLang(data.targetLang || 'zh');
      TranslateProvider.setSourceLang(data.sourceLang || 'auto');
      displayMode = data.displayMode || 'replace';
      try {
        await startTranslation();
      } catch (e) {
        notifyPopup('error', { message: e.message });
      }
    }
  });

  /* =====================================================================
   * 消息协议
   * ===================================================================== */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'start_translation') {
      if (request.mode) displayMode = request.mode;
      if (request.targetLang) TranslateProvider.setTargetLang(request.targetLang);
      if (request.sourceLang) TranslateProvider.setSourceLang(request.sourceLang);
      startTranslation()
        .then(stats => sendResponse({ status: 'done', stats }))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }
    if (request.action === 'stop_translation') {
      stopTranslation();
      sendResponse({ status: 'stopped' });
      return;
    }
    if (request.action === 'check_status') {
      (async () => {
        const cfg = await TranslateConfig.getActive();
        const ok = cfg ? await TranslateProvider.checkAvailability(cfg) : false;
        sendResponse({ available: ok, provider: cfg });
      })();
      return true;
    }
    if (request.action === 'get_state') {
      (async () => {
        const cfg = await TranslateConfig.getActive();
        sendResponse({
          active: isTranslationActive,
          mode: displayMode,
          targetLang: TranslateProvider.getTargetLang(),
          sourceLang: TranslateProvider.getSourceLang(),
          providerId: cfg ? cfg.id : null,
          providerName: cfg ? cfg.name : null
        });
      })();
      return true;
    }
    if (request.action === 'set_mode') {
      displayMode = request.mode || 'replace';
      chrome.storage.local.set({ displayMode });
      sendResponse({ status: 'ok', mode: displayMode });
      return;
    }
    if (request.action === 'set_target_lang') {
      TranslateProvider.setTargetLang(request.targetLang || 'zh');
      chrome.storage.local.set({ targetLang: TranslateProvider.getTargetLang() });
      sendResponse({ status: 'ok', targetLang: TranslateProvider.getTargetLang() });
      return;
    }
    if (request.action === 'set_source_lang') {
      TranslateProvider.setSourceLang(request.sourceLang || 'auto');
      chrome.storage.local.set({ sourceLang: TranslateProvider.getSourceLang() });
      sendResponse({ status: 'ok', sourceLang: TranslateProvider.getSourceLang() });
      return;
    }
    if (request.action === 'translate_selection') {
      const text = (request.text || '').trim();
      if (!text) return;
      // 异步翻译+显示浮窗，立即响应 background（不阻塞右键菜单关闭）
      sendResponse({ status: 'received' });
      translateSelection(text);
      return;
    }
  });

  /* 主动把错误反馈给 popup。
   * M3：并发池下多个 worker 可能因同一原因（如鉴权失败）接连报错，
   *     相同 message 在 2 秒内只弹一次，避免 popup 被重复消息刷屏。 */
  const _notifiedRecently = new Map();   // message → timestamp
  function notifyPopup(type, payload) {
    const msg = payload?.message;
    if (msg) {
      const now = Date.now();
      const last = _notifiedRecently.get(msg) || 0;
      if (now - last < 2000) return;     // 2 秒内已报过，跳过
      _notifiedRecently.set(msg, now);
    }
    try {
      chrome.runtime.sendMessage({ from: 'content', action: 'notify', type, ...payload });
    } catch { /* popup 可能未打开，忽略 */ }
  }

  /* =====================================================================
   * 翻译主流程
   * ===================================================================== */

  async function startTranslation() {
    activeProvider = await TranslateConfig.getActive();
    if (!activeProvider) throw new Error('未配置翻译引擎，请在设置页添加');

    const available = await TranslateProvider.checkAvailability(activeProvider);
    if (!available) {
      if (activeProvider.type === 'offline') {
        throw new Error('Gemini Nano 不可用。请检查: 1) chrome://flags 启用 prompt-api-for-gemini-nano 2) 模型已下载');
      }
      throw new Error(`引擎「${activeProvider.name}」不可用，请检查 baseURL / API key / 网络`);
    }

    isTranslationActive = true;
    abortController = new AbortController();   // 新建取消器，供 translateAll 传给 provider
    const stats = await translateAll();
    startPageRadar();
    return stats;
  }

  function stopTranslation() {
    isTranslationActive = false;
    if (abortController) {                  // 中断在途请求，省 token
      abortController.abort();
      abortController = null;
    }
    translatingPromise = null;              // 显式释放竞态锁，确保可重新翻译
    TranslateProvider.destroyAll();  // 销毁离线 session 等
    if (typeof TranslateCache !== 'undefined') TranslateCache.flush();  // 缓存立即落盘
    if (observer) { observer.disconnect(); observer = null; }
    if (debounceTimeout) { clearTimeout(debounceTimeout); debounceTimeout = null; }
    if (debounceMaxTimer) { clearTimeout(debounceMaxTimer); debounceMaxTimer = null; }

    /* 还原 DOM：双语走 span 反查，整段替换走 replacedNodes */
    isMutatingFromSelf = true;
    try {
      document.querySelectorAll('[data-translation]').forEach(span => {
        const prev = span.previousSibling;
        if (prev && originalTexts.has(prev)) {
          prev.textContent = originalTexts.get(prev);
        }
        span.remove();
      });
      replacedNodes.forEach(node => {
        if (node.parentElement && originalTexts.has(node)) {
          node.textContent = originalTexts.get(node);
        }
      });
      replacedNodes.clear();
      /* 清空处理记录：还原 DOM 后，节点已是原文，下次翻译应重新处理。
       * WeakSet/WeakMap 无 clear()，重新赋值新实例。
       * 不清空会导致"停止→重译"时所有节点被当作已翻译而跳过（无反应）。 */
      translatedNodes = new WeakSet();
      nodeLastText = new WeakMap();
      nodeFailCount = new WeakMap();
      originalTexts = new WeakMap();
    } finally {
      isMutatingFromSelf = false;
    }
  }

  /* ---------- MutationObserver 自触发防护 ---------- */
  function startPageRadar() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      if (isMutatingFromSelf) return;
      if (!isTranslationActive) return;
      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(doIncremental, config.DEBOUNCE_MS);
      // 最大等待：X 等高 DOM 更新频率页面，debounce 可能被不停 reset。
      // maxTimer 只设一次（不清空），2 秒后强制执行，确保增量翻译不会永久被阻止。
      if (!debounceMaxTimer) {
        debounceMaxTimer = setTimeout(doIncremental, 2000);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  /* 增量翻译执行：清除两个定时器，触发 translateAll(true) */
  function doIncremental() {
    if (debounceTimeout) { clearTimeout(debounceTimeout); debounceTimeout = null; }
    if (debounceMaxTimer) { clearTimeout(debounceMaxTimer); debounceMaxTimer = null; }
    translateAll(true);
  }

  /* =====================================================================
   * 文本过滤：判断一段文本是否【应该翻译】。
   * 逻辑已抽到 utils.js（可单测），此处直接引用。
   * ===================================================================== */

  /* =====================================================================
   * 遍历与写入
   * ===================================================================== */
  function collectTextNodes() {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.textContent.trim();
        if (!text) return NodeFilter.FILTER_REJECT;
        /* 虚拟滚动复用检测：节点曾处理过，但若当前文本与上次处理的不同（被复用），
         * 说明节点被 React 重新填充了新内容（如 X 推文滚出视口后复用给下一条），
         * 需要重新翻译。文本相同才跳过。 */
        if (translatedNodes.has(node)) {
          const lastText = nodeLastText.get(node);
          if (lastText === text) return NodeFilter.FILTER_REJECT;  // 同节点同内容，跳过
          // 同节点不同内容 → 被复用了，继续往下走重新翻译（但先清掉旧译文记录）
          originalTexts.delete(node);
        }
        const fails = nodeFailCount.get(node) || 0;
        if (fails > MAX_FAIL_RETRIES) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName?.toLowerCase();
        if (SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
        if (!TranslateUtils.shouldTranslate(text, TranslateProvider.getSourceLang())) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function applyTranslation(node, translation) {
    const parent = node.parentElement;
    if (!parent) return;
    if (!originalTexts.has(node)) originalTexts.set(node, node.textContent);

    const raw = node.textContent;
    const leadWS = raw.match(/^\s*/)[0];
    const trailWS = raw.match(/\s*$/)[0];

    isMutatingFromSelf = true;
    try {
      if (displayMode === 'bilingual') {
        const oldSpan = parent.querySelector(':scope > [data-translation]');
        if (oldSpan) oldSpan.remove();
        const span = document.createElement('span');
        span.dataset.translation = '1';
        const langInfo = TranslateProvider.LANG_INFO[TranslateProvider.getTargetLang()];
        span.lang = langInfo?.bcp47 || 'zh';
        span.dir = langInfo?.rtl ? 'rtl' : 'auto';
        span.textContent = (trailWS ? '' : ' ') + translation;
        span.style.cssText = 'color:#666;display:inline;font-size:0.95em;margin-left:.35em;';
        parent.insertBefore(span, node.nextSibling);
      } else {
        replacedNodes.add(node);
        node.textContent = leadWS + translation + trailWS;
      }
    } finally {
      isMutatingFromSelf = false;
    }
  }

  /* =====================================================================
   * translateAll：竞态锁，并发调用 provider
   *
   * 并发模型：固定并发池。
   *   - 离线引擎（Gemini Nano）：CONCURRENCY 实际取 1（本地算力串行，并发无收益且可能 OOM）
   *   - 云端引擎（DeepSeek/OpenAI 等）：CONCURRENCY=3，3 批同时发，谁完成谁领下一批
   *   - DOM 写入无竞争：每批节点互不重叠，applyTranslation 各自独立
   *   - 取消：worker 每轮检查 isTranslationActive，停止立即生效
   *   - 致命错误（401/403/404）：设置 fatal 标志，剩余 worker 不再发起新请求
   * ===================================================================== */
  /* 翻译期间若有新的增量请求被锁挡住，标记此标志。
   * 当前翻译完成后自动追加一次增量翻译，避免新内容漏译（X 下拉场景）。 */
  let pendingIncremental = false;

  async function translateAll(isIncremental = false) {
    if (translatingPromise) {
      // 被锁挡住：不丢弃，标记"有待处理请求"，等当前翻译完成后自动追加。
      // （旧实现直接 return 旧 promise 导致增量请求被永久丢弃——X 下拉漏译的根因）
      pendingIncremental = true;
      return translatingPromise;
    }
    translatingPromise = (async () => {
      const stats = { total: 0, translated: 0, failed: 0 };
      if (observer) observer.disconnect();

      try {
        const textNodes = collectTextNodes();
        stats.total = textNodes.length;
        const isOffline = activeProvider?.type === 'offline';
        console.log(`[翻译] 待翻译 ${textNodes.length} 个节点，引擎=${activeProvider?.name}(${activeProvider?.type})，模式=${displayMode}，并发=${isOffline ? 1 : config.CONCURRENCY}`);

        /* 精准语言提示：仅用户主动翻译（非增量）且 0 节点时提示。
         * 增量翻译（observer 触发）遇到 0 节点是正常的，静默返回。 */
        if (textNodes.length === 0) {
          if (!isIncremental) {
            const targetLang = TranslateProvider.getTargetLang();
            const info = TranslateProvider.LANG_INFO[targetLang];
            notifyPopup('warn', { message: `未发现需要翻译的内容（页面可能已是${info?.name || targetLang}）。` });
          }
          return stats;
        }

        /* 切分批次 */
        const batches = [];
        for (let i = 0; i < textNodes.length; i += config.BATCH_SIZE) {
          const batch = textNodes.slice(i, Math.min(i + config.BATCH_SIZE, textNodes.length));
          batches.push({ index: batches.length, nodes: batch, texts: batch.map(n => n.textContent.trim()) });
        }
        const totalBatches = batches.length;

        /* 共享状态 */
        let nextBatchIdx = 0;
        let fatal = false;

        async function worker(workerId) {
          while (true) {
            if (!isTranslationActive) return;
            if (fatal) return;
            const myIdx = nextBatchIdx++;
            if (myIdx >= totalBatches) return;
            const { nodes, texts } = batches[myIdx];

            try {
              const t0 = Date.now();
              const translations = await TranslateProvider.translateTexts(texts, activeProvider, abortController?.signal);
              console.log(`[翻译] 批次 ${myIdx + 1}/${totalBatches} 完成 (w${workerId}, ${Date.now() - t0}ms)`);

              nodes.forEach((node, idx) => {
                const t = translations[idx];
                if (t && t.trim()) {
                  applyTranslation(node, t.trim());
                  translatedNodes.add(node);
                  nodeLastText.set(node, texts[idx]);   // 记录处理时的原文，用于检测复用
                  stats.translated++;
                } else {
                  translatedNodes.add(node);
                  nodeLastText.set(node, texts[idx]);
                  nodeFailCount.set(node, (nodeFailCount.get(node) || 0) + 1);
                  stats.failed++;
                }
              });
            } catch (err) {
              // 用户主动取消（abort）：静默停止，不计失败、不弹错
              if (err.message === 'TRANSLATION_ABORTED') {
                console.log(`[翻译] 批次 ${myIdx + 1} 已取消 (w${workerId})`);
                return;
              }
              console.warn(`[翻译] 批次 ${myIdx + 1} 失败 (w${workerId}):`, err.message);
              stats.failed += nodes.length;
              notifyPopup('error', { message: `翻译失败: ${err.message}` });
              if (isFatalError(err)) {
                fatal = true;   // 鉴权类错误，其余批次停止发起新请求
                return;
              }
            }
          }
        }

        /* 启动 N 个 worker，全部完成才返回 */
        const concurrency = isOffline ? 1 : Math.max(1, config.CONCURRENCY);
        const workers = [];
        for (let w = 0; w < concurrency; w++) workers.push(worker(w + 1));
        await Promise.all(workers);

        console.log(`[翻译] 完成: 成功 ${stats.translated}, 失败 ${stats.failed}, 共 ${stats.total}`);
        if (stats.failed > 0) notifyPopup('warn', { message: `部分内容翻译失败（${stats.failed} 条）` });
      } finally {
        translatingPromise = null;
        if (isTranslationActive && observer) {
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        }
        // 追加处理：翻译期间若有新内容加载（observer 触发但被锁挡住，pendingIncremental=true），
        // 当前翻译完成后自动追加一次增量翻译，捕获这些新内容（X 下拉场景的核心修复）。
        // queueMicrotask 确保不在当前 finally 栈内递归调用。
        if (isTranslationActive && pendingIncremental) {
          pendingIncremental = false;
          queueMicrotask(() => translateAll(true));
        }
      }
      return stats;
    })();
    return translatingPromise;
  }

  /* 鉴权/配置类错误视为致命，停止重试（逻辑在 utils.js，可单测） */
  const isFatalError = (err) => TranslateUtils.isFatalHttpError(err);

  /* =====================================================================
   * 划词翻译：右键"翻译选中内容"后，在选区附近显示浮窗
   *
   * 设计：
   *   - 浮窗用 Shadow DOM 隔离，不受页面 CSS 影响
   *   - 定位跟随选区（getBoundingClientRect），优先显示在选区下方，空间不足时上方
   *   - 复用 TranslateProvider + 缓存（与整页/文本翻译同一套）
   *   - 点击外部 / Esc 关闭，避免堆积多个浮窗
   * ===================================================================== */
  let selectionFloat = null;   // 当前浮窗的 host 元素（唯一）

  function closeSelectionFloat() {
    if (selectionFloat) {
      selectionFloat.remove();
      selectionFloat = null;
      document.removeEventListener('mousedown', onOutsideClick, true);
      document.removeEventListener('keydown', onEscKey, true);
    }
  }

  function onOutsideClick(e) {
    if (selectionFloat && !selectionFloat.contains(e.target)) closeSelectionFloat();
  }
  function onEscKey(e) {
    if (e.key === 'Escape') closeSelectionFloat();
  }

  async function translateSelection(text) {
    // 关闭已有浮窗
    closeSelectionFloat();

    // 获取选区位置（此时选区可能已被右键菜单清除，用缓存的上一次选区）
    const sel = window.getSelection();
    let rect = null;
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    }
    // 兜底：屏幕中央
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      rect = { left: window.innerWidth / 2 - 150, top: window.innerHeight / 2, width: 300, height: 0 };
    }

    // 创建浮窗 host（含 Shadow DOM）
    const host = document.createElement('div');
    host.id = '__twp_float_host__';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:0;top:0;';
    const shadow = host.attachShadow({ mode: 'closed' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
          max-width: 340px; min-width: 180px;
          background: #fff; color: #333;
          border: 1px solid #d1d5db; border-radius: 8px;
          box-shadow: 0 8px 24px rgba(0,0,0,.18);
          padding: 0; overflow: hidden;
          font-size: 13px; line-height: 1.6;
        }
        .head {
          display: flex; align-items: center; justify-content: space-between;
          padding: 6px 10px; background: #f8f9fa; border-bottom: 1px solid #e5e7eb;
          font-size: 11px; color: #888;
        }
        .head .lang { font-weight: bold; color: #007bff; }
        .copy {
          border: 1px solid #d1d5db; background: #fff; border-radius: 4px;
          padding: 2px 8px; font-size: 11px; cursor: pointer; color: #555;
        }
        .copy:hover { background: #f3f4f6; }
        .copy.done { background: #28a745; color: #fff; border-color: #28a745; }
        .body { padding: 10px 12px; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow-y: auto; }
        .body.loading { color: #999; }
        .body.error { color: #dc3545; }
        .close {
          position: absolute; top: 4px; right: 6px; cursor: pointer;
          color: #aaa; font-size: 16px; line-height: 1; padding: 2px 4px;
        }
        .close:hover { color: #333; }
      </style>
      <div class="panel">
        <div class="head">
          <span class="lang" id="lang"></span>
          <button class="copy" id="copy">复制</button>
        </div>
        <div class="body loading" id="body">翻译中...</div>
        <span class="close" id="close">×</span>
      </div>
    `;

    const elLang = shadow.getElementById('lang');
    const elBody = shadow.getElementById('body');
    const elCopy = shadow.getElementById('copy');
    const elClose = shadow.getElementById('close');

    const langInfo = TranslateProvider.LANG_INFO[TranslateProvider.getTargetLang()];
    elLang.textContent = '→ ' + (langInfo?.name || '中文');
    elBody.dir = langInfo?.rtl ? 'rtl' : 'auto';

    document.body.appendChild(host);
    selectionFloat = host;

    // 定位（先让面板渲染一帧拿到尺寸）。position:fixed 用视口坐标，无需 scrollY
    requestAnimationFrame(() => {
      const panel = shadow.querySelector('.panel');
      const pw = panel.offsetWidth, ph = panel.offsetHeight;
      const gap = 8;
      let left = rect.left;
      let top = rect.bottom + gap;
      // 水平：不超出视口
      if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
      if (left < 8) left = 8;
      // 垂直：下方空间不足则放上方
      if (top + ph > window.innerHeight - 8) {
        const upTop = rect.top - ph - gap;
        if (upTop > 8) top = upTop;
      }
      host.style.transform = `translate(${left}px, ${top}px)`;
    });

    // 交互绑定
    elClose.addEventListener('click', closeSelectionFloat);
    elCopy.addEventListener('click', async () => {
      const t = elBody.textContent;
      if (!t || elBody.classList.contains('loading')) return;
      try {
        await navigator.clipboard.writeText(t);
        elCopy.classList.add('done');
        elCopy.textContent = '✓';
        setTimeout(() => { elCopy.classList.remove('done'); elCopy.textContent = '复制'; }, 1200);
      } catch {}
    });
    // 点击外部 / Esc 关闭
    document.addEventListener('mousedown', onOutsideClick, true);
    document.addEventListener('keydown', onEscKey, true);

    // 执行翻译
    try {
      const cfg = await TranslateConfig.getActive();
      if (!cfg) {
        elBody.className = 'body error';
        elBody.textContent = '请先在扩展设置中配置翻译引擎';
        return;
      }
      const result = await TranslateProvider.translateTexts([text], cfg);
      const out = (result && result[0]) || '';
      elBody.className = 'body';
      elBody.textContent = out || '（无译文）';
    } catch (e) {
      elBody.className = 'body error';
      elBody.textContent = '✗ ' + e.message;
    }
  }
})();
