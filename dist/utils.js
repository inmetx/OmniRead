/* =====================================================================
 * utils.js - 纯函数工具集 (v2.1)
 *
 * 设计目的：
 *   - 把核心业务逻辑中的【纯函数】（无 chrome/DOM/window 依赖）集中于此
 *   - 便于单元测试：test 文件可直接 require('./utils.js')，零环境依赖
 *   - 浏览器侧通过 window.TranslateUtils 暴露，业务文件改引用
 *
 * 导出方式：UMD 风格——浏览器挂 window.TranslateUtils，Node 走 module.exports。
 * ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;          // Node/CommonJS（供测试用）
  }
  if (typeof window !== 'undefined') {
    window.TranslateUtils = api;   // 浏览器（供 content/provider/cache 用）
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ===================================================================
   * 文本过滤：判断一段文本是否【应该翻译】。返回 false = 跳过。
   * 原则：代码/数据/标识符类不译，只译自然语言。
   * =================================================================== */
   function shouldTranslate(text, sourceLang) {
    const t = (text == null ? '' : String(text)).trim();
    if (t.length <= 2) return false;

    // 1. 语言/符号类
    if (sourceLang !== 'zh' && sourceLang !== 'auto') {
      if (/[\u4e00-\u9fff]/.test(t)) return false;                     // 已含中文（非中文源时跳过）
    }
    if (/^[\d\s.,%$€£¥+\-*/=()\[\]{}|\\:;!?@#&^~`<>"']+$/.test(t)) return false; // 纯符号/数字

    // 2. 标识符类
    if (/^https?:\/\//i.test(t)) return false;                       // URL
    if (/^\w+([.-]\w+)*@\w+([.-]\w+)*\.\w+$/.test(t)) return false;  // 邮箱
    if (!/[A-Za-z]/.test(t) && /\p{Extended_Pictographic}/u.test(t)) return false; // 纯 emoji
    if (/^[a-z]+(_[a-z0-9]+)+$/.test(t)) return false;               // snake_case
    if (!/\s/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t) && /^[a-zA-Z][a-zA-Z0-9]*$/.test(t)) {
      if (/[a-z][A-Z]/.test(t) && t.length <= 24) return false;      // camelCase
    }

    // 3. 区块链 / DeFi 专用
    if (/^0x[a-fA-F0-9]+$/i.test(t)) return false;                   // 0x 前缀 hex
    if (/^[a-fA-F0-9]{16,}$/.test(t) && !/[g-zG-Z]/.test(t)) return false; // 长 hex 串

    // 4. 金额 + 单位
    if (/^[$€£¥]?\s*[\d,]+(\.\d+)?\s*[%]?$/.test(t)) return false;    // 纯金额/百分比
    if (/^[$€£¥]?\s*[\d,]+(\.\d+)?\s+[A-Z]{2,6}$/.test(t)) return false; // 数字 + 代币

    // 5. 代币/股票代码：纯大写 2~6 位
    if (/^[A-Z]{2,6}$/.test(t)) return false;

    // 6. 全大写常量（带下划线/数字，≥3 字符）
    if (/^[A-Z][A-Z0-9_]{2,23}$/.test(t)) return false;

    return true;
  }

  /* ===================================================================
   * URL 规范化：去尾斜杠；末尾无 /vN 则补 /v1
   * =================================================================== */
  function normalizeBaseURL(baseURL) {
    let u = (baseURL || '').trim().replace(/\/+$/, '');
    if (!/\/v\d+$/.test(u)) u += '/v1';
    return u;
  }

  /* ===================================================================
   * 错误分类：判断错误类型以决定降级/中止策略
   * =================================================================== */

  /* 可恢复错误：解析/对齐错（可降级到智能对齐）。
   * openaiChat 抛的错形如 "HTTP 401: ..." 或 "网络请求失败: ..."；
   * parseJsonArray 抛的是 JSON.parse 的 "Unexpected token..." 之类。 */
  function isRecoverableError(err) {
    const m = (err?.message || '');
    if (m.startsWith('HTTP ')) return false;
    if (m.startsWith('网络请求失败')) return false;
    if (m.startsWith('响应非 JSON')) return false;
    if (m.includes('choices[0].message.content')) return false;
    return true;
  }

  /* 致命模型错误：鉴权/配置类（401/403/404），不应重试。
   * 供 alignAndFill 的 singleCall 内部使用——遇到立即上抛，不吞成空串。 */
  function isFatalModelError(err) {
    return isFatalHttpError(err);
  }

  /* 致命 HTTP 错误（供 content.js 并发池用，等价逻辑） */
  function isFatalHttpError(err) {
    const m = (err?.message || '').match(/HTTP (\d{3})/);
    if (!m) return false;
    const code = +m[1];
    return code === 401 || code === 403 || code === 404;
  }

  /* ===================================================================
   * FNV-1a 32bit 哈希 → base36（缓存 key 生成）
   * 比 SHA-1 快 100x，碰撞率在缓存规模下可忽略
   * =================================================================== */
  function hashFNV1a(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  /* 缓存 key：hash(providerId | sourceLang | targetLang | text) */
  function makeCacheKey(text, providerId, targetLang, sourceLang) {
    return hashFNV1a(`${providerId}|${sourceLang || 'auto'}|${targetLang || 'zh'}|${text}`);
  }

  /* ===================================================================
   * 配置校验（从 config.js 复制，保证 sanitizeConfig 可被测试且零依赖）
   * 注意：config.js 仍保留自己的实现（含 OFFLINE_PROVIDER_ID 等），
   *       此处仅用于测试断言逻辑一致性。
   * =================================================================== */
  const OFFLINE_PROVIDER_ID = 'offline-default';

  function validateProvider(p) {
    if (!p || typeof p !== 'object') return 'provider 必须是对象';
    if (!p.id || typeof p.id !== 'string') return '缺少 id';
    if (!p.name || typeof p.name !== 'string') return '缺少 name';
    if (p.type === 'offline') return null;
    if (p.type === 'google') return null;
    if (p.type === 'bing') return null;
    if (p.type === 'openai') {
      if (!p.baseURL || typeof p.baseURL !== 'string') return 'OpenAI provider 缺少 baseURL';
      if (!p.model || typeof p.model !== 'string') return 'OpenAI provider 缺少 model';
      return null;
    }
    return '未知 provider 类型: ' + p.type;
  }

  function sanitizeConfig(raw) {
    const config = raw && typeof raw === 'object' ? raw : {};
    let providers = Array.isArray(config.providers) ? config.providers : [];
    providers = providers.filter(p => !validateProvider(p));
    const seen = new Set();
    providers = providers.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    const builtins = [
      { id: OFFLINE_PROVIDER_ID, type: 'offline', name: '离线 (Gemini Nano)', enabled: true },
      { id: 'google-free', type: 'google', name: 'Google Translate (免费)', enabled: true },
      { id: 'bing-free', type: 'bing', name: 'Microsoft Bing (免费)', enabled: true }
    ];
    for (const builtin of builtins) {
      if (!providers.some(p => p.id === builtin.id)) {
        providers.push(builtin);
      }
    }
    let activeProviderId = config.activeProviderId;
    if (!activeProviderId || !providers.some(p => p.id === activeProviderId)) {
      activeProviderId = OFFLINE_PROVIDER_ID;
    }
    return { providers, activeProviderId };
  }

  return {
    shouldTranslate,
    normalizeBaseURL,
    isRecoverableError,
    isFatalModelError,
    isFatalHttpError,
    hashFNV1a,
    makeCacheKey,
    validateProvider,
    sanitizeConfig,
    OFFLINE_PROVIDER_ID
  };
});
