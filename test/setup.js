/* =====================================================================
 * test/setup.js - 测试环境引导（零依赖）
 *
 * 为 provider.js / cache.js / config.js 的 IIFE 提供浏览器全局环境：
 *   - globalThis.window = globalThis：使 IIFE 里的 window.TranslateXxx = ...
 *     落到全局，模块内的自由变量（TranslateUtils 等）也能解析到同一对象
 *   - globalThis.self = globalThis：离线 provider 用 'LanguageModel' in self 探测
 *   - 内存版 chrome.storage.local：lookup/put/flush/clear 的存储后端
 *   - 可编程 fetch：mock 网络响应，断言调用次数/参数
 *   - mockLanguageModel：注入 Gemini Nano 的 create/prompt/destroy
 *
 * 运行：node --test test/
 * ===================================================================== */

/* ---------- 全局环境（仅初始化一次） ---------- */
globalThis.window = globalThis;
globalThis.self = globalThis;

/* ---------- 内存版 chrome.storage.local ---------- */
const _store = {};
globalThis.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        // keys 为 string | string[] | null(=all) | object(带默认值)
        const out = {};
        const want = Array.isArray(keys) ? keys
          : (typeof keys === 'string' ? [keys]
            : (keys && typeof keys === 'object' ? Object.keys(keys) : null));
        if (want == null) Object.assign(out, _store);
        else want.forEach(k => { if (k in _store) out[k] = _store[k]; });
        if (cb) cb(out);
      },
      set(obj, cb) {
        Object.assign(_store, obj);
        if (cb) cb();
      },
      remove(key, cb) {
        if (Array.isArray(key)) key.forEach(k => delete _store[k]);
        else delete _store[key];
        if (cb) cb();
      }
    }
  },
  runtime: { lastError: null }
};

function resetStorage() {
  for (const k of Object.keys(_store)) delete _store[k];
}

/* ---------- fetch 模拟 ---------- */
let _origFetch = null;
let _fetchImpl = null;
let fetchCallCount = 0;
const fetchCalls = [];

function mockFetch(handler) {
  /* handler: (url, opts) => { ok?, status?, statusText?, json?, text?, delay? }
   * 或 (url, opts) => Promise<ResponseLike> */
  if (!_origFetch) _origFetch = globalThis.fetch;
  fetchCallCount = 0;
  fetchCalls.length = 0;
  _fetchImpl = async function (url, opts) {
    fetchCallCount++;
    fetchCalls.push({ url, opts });
    const r = await handler(url, opts);
    // r 可以是对象或 ResponseLike；统一补全方法
    return {
      ok: r.ok !== false && (r.status === undefined || (r.status >= 200 && r.status < 300)),
      status: r.status !== undefined ? r.status : 200,
      statusText: r.statusText || '',
      async json() { return r.json; },
      async text() { return r.text !== undefined ? r.text : JSON.stringify(r.json); }
    };
  };
  globalThis.fetch = _fetchImpl;
}

function restoreFetch() {
  if (_origFetch) { globalThis.fetch = _origFetch; _origFetch = null; }
  _fetchImpl = null;
}

function getFetchCount() { return fetchCallCount; }
function getFetchCalls() { return fetchCalls; }
function resetFetchCount() { fetchCallCount = 0; fetchCalls.length = 0; }

/* ---------- LanguageModel 模拟 ---------- */
function mockLanguageModel(availability = 'available', responses = []) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const session = {
    promptCount: 0,
    async prompt(_text) {
      this.promptCount++;
      const r = queue.shift();
      if (r instanceof Error) throw r;
      return r !== undefined ? r : '';
    },
    destroy() { this._destroyed = true; }
  };
  const LM = {
    _session: session,
    async availability() { return availability; },
    async create() { return session; }
  };
  globalThis.LanguageModel = LM;
  return LM;
}

function clearLanguageModel() {
  delete globalThis.LanguageModel;
}

/* ---------- 模块重载（保证 test 间状态隔离） ---------- */
const MODULE_PATHS = [
  '../utils.js', '../config.js', '../provider.js', '../cache.js'
];

function resetModules() {
  for (const p of MODULE_PATHS) {
    const full = require.resolve(p);
    delete require.cache[full];
  }
  /* 重新加载：utils 先（UMD 会同时设 window.TranslateUtils 和 module.exports），
   * 随后 config/provider/cache 依赖它。 */
  const Utils = require('../utils.js');           // 触发 window.TranslateUtils =
  require('../config.js');                         // window.TranslateConfig =
  require('../provider.js');                       // window.TranslateProvider =
  require('../cache.js');                          // window.TranslateCache =
  return {
    Utils,
    Config: globalThis.TranslateConfig,
    Provider: globalThis.TranslateProvider,
    Cache: globalThis.TranslateCache
  };
}

module.exports = {
  resetStorage,
  mockFetch, restoreFetch, getFetchCount, getFetchCalls, resetFetchCount,
  mockLanguageModel, clearLanguageModel,
  resetModules
};
