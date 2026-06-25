/* =====================================================================
 * cache.js - 翻译结果全局 LRU 缓存 (v2.1)
 *
 * 设计：
 *   - 全局缓存：跨页面、跨会话共享（高频文案 Sign in/Submit 只译一次）
 *   - 持久化：chrome.storage.local，key = "translateCache"
 *   - LRU 淘汰：按条目数上限（默认 2000），超出删最久未访问
 *   - 内存热缓存：启动时一次性加载，查询走内存（O(1)），
 *     写入防抖批量回写 storage（避免每条都触发 IO）
 *   - 缓存 key：hash(原文 + providerId + 目标语言)
 *
 * 存储 schema：
 *   translateCache: {
 *     entries: { "<hash>": { v: "译文", t: <访问时间戳>, c: <创建时间戳> } },
 *     version: 1
 *   }
 *   - t: 最后访问时间（用于 LRU 淘汰，每次命中更新）
 *   - c: 创建时间（用于 TTL，7 天过期；旧数据无 c 时用 t 兜底）
 * ===================================================================== */
(() => {
  'use strict';

  const STORAGE_KEY = 'translateCache';
  const MAX_ENTRIES = 2000;            // 条目上限
  const WRITE_DEBOUNCE_MS = 1000;      // 写回防抖
  const EVICT_BATCH = 200;             // 超限时一次淘汰的数量
  const TTL_MS = 7 * 24 * 60 * 60 * 1000;  // TTL：7 天后视为过期（换引擎/prompt 后旧译文自动失效）

  /* 内存热缓存：启动时加载，查询直接走这里 */
  let entries = null;                  // null = 未加载，{} = 已加载
  let dirty = false;                   // 有未写回的改动
  let writeTimer = null;
  const loadPromise = (function initLoad() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (data) => {
        const stored = data[STORAGE_KEY];
        entries = (stored && stored.entries && typeof stored.entries === 'object')
          ? stored.entries : {};
        resolve();
      });
    });
  })();

   /* ---------- key 生成：FNV-1a hash（逻辑在 utils.js，可单测） ---------- */
  const makeKey = (text, providerId, targetLang, sourceLang) => TranslateUtils.makeCacheKey(text, providerId, targetLang, sourceLang);

  /* ---------- LRU 淘汰：按 t（访问时间戳）升序删最旧的 ---------- */
  function evictIfNeeded() {
    const keys = Object.keys(entries);
    if (keys.length <= MAX_ENTRIES) return;
    // 按时间戳排序，删除最老的 EVICT_BATCH 个
    keys.sort((a, b) => (entries[a].t || 0) - (entries[b].t || 0));
    const toRemove = keys.length - MAX_ENTRIES + EVICT_BATCH;
    for (let i = 0; i < toRemove; i++) delete entries[keys[i]];
    console.log(`[缓存] LRU 淘汰 ${toRemove} 条，剩余 ${Object.keys(entries).length}`);
  }

  /* ---------- 防抖写回 storage ---------- */
  function scheduleWrite() {
    dirty = true;
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flush();
    }, WRITE_DEBOUNCE_MS);
  }

  /* ---------- 立即写回（停止翻译/手动清除时调用） ---------- */
  function flush() {
    if (!dirty || !entries) return;
    dirty = false;
    const snapshot = { entries, version: 1 };
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: snapshot }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[缓存] 写回失败:', chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      console.warn('[缓存] 写回异常:', e.message);
    }
  }

  /* ---------- 对外 API ---------- */
  window.TranslateCache = {
    ready() { return loadPromise; },

    /* 批量查询：返回 { hit: Map<idx, 译文>, miss: number[]（未命中的下标） }
     * 调用方据此决定哪些条目要调模型。
     * TTL：超过 7 天的条目视为过期，当 miss 处理并惰性删除。 */
    lookup(texts, providerId, targetLang, sourceLang) {
      if (!entries) return { hit: new Map(), miss: texts.map((_, i) => i) };
      const hit = new Map();
      const miss = [];
      const now = Date.now();
      let expiredFound = false;
      texts.forEach((t, i) => {
        const k = makeKey(t, providerId, targetLang, sourceLang);
        const e = entries[k];
        if (e && typeof e.v === 'string') {
          // TTL 检查：c(createdAt) 缺失则用 t 兜底（兼容旧数据）
          const created = e.c || e.t || 0;
          if (now - created > TTL_MS) {
            delete entries[k];          // 惰性删除过期条目
            expiredFound = true;
            miss.push(i);
          } else {
            e.t = now;                  // 更新访问时间（LRU）
            hit.set(i, e.v);
          }
        } else {
          miss.push(i);
        }
      });
      if (expiredFound) scheduleWrite();  // 删除也要落盘
      return { hit, miss };
    },

    /* 批量写入：texts[idx] → translations[idx] 的若干对
     * 记录 createdAt(c) 用于 TTL，访问时间(t) 用于 LRU */
    put(texts, translations, providerId, targetLang, sourceLang) {
      if (!entries) return;
      const now = Date.now();
      let added = 0;
      texts.forEach((t, i) => {
        const v = translations[i];
        if (typeof v === 'string' && v.trim() && v !== t) {  // 空译文/与原文相同不入库
          entries[makeKey(t, providerId, targetLang, sourceLang)] = { v, t: now, c: now };
          added++;
        }
      });
      if (added > 0) {
        evictIfNeeded();
        scheduleWrite();
      }
      return added;
    },

    /* 立即落盘（停止翻译时调用，确保不丢） */
    flush,

    /* 清空全部缓存 */
    async clear() {
      entries = {};
      dirty = false;
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
      return new Promise((resolve) => {
        chrome.storage.local.remove(STORAGE_KEY, () => resolve());
      });
    },

    /* 统计信息（给 UI 显示用） */
    stats() {
      return { count: entries ? Object.keys(entries).length : 0, max: MAX_ENTRIES };
    }
  };
})();
