/* =====================================================================
 * config.js - 翻译 provider 配置模型与存取 (v2.1)
 *
 * 设计借鉴 vibe-reading：
 *   - 配置 = providers 数组 + 全局 activeProviderId 字符串引用
 *   - 存储统一放在 chrome.storage.local 的 translateConfig 键
 *   - 离线 provider 始终存在作为保底，不可删除
 *
 * Provider 类型：
 *   { id, type: 'offline', name, enabled }
 *   { id, type: 'openai', name, enabled, baseURL, apiKey, model, temperature }
 * ===================================================================== */
(() => {
  'use strict';

  const STORAGE_KEY = 'translateConfig';

  /* 离线 provider 的固定 id（不可删除，作为保底） */
  const OFFLINE_PROVIDER_ID = 'offline-default';

  /* 默认配置：离线 + Google + Bing 作为内置保底 */
  const DEFAULT_CONFIG = {
    providers: [
      {
        id: OFFLINE_PROVIDER_ID,
        type: 'offline',
        name: '离线 (Gemini Nano)',
        enabled: true
      },
      {
        id: 'google-free',
        type: 'google',
        name: 'Google Translate (免费)',
        enabled: true
      },
      {
        id: 'bing-free',
        type: 'bing',
        name: 'Microsoft Bing (免费)',
        enabled: true
      }
    ],
    activeProviderId: OFFLINE_PROVIDER_ID
  };

  /* 复用 utils.js 的纯函数实现，避免代码重复 */
  function validateProvider(p) { return TranslateUtils.validateProvider(p); }
  function sanitizeConfig(raw) { return TranslateUtils.sanitizeConfig(raw); }

  /* ---------- Promise 化的 storage ---------- */
  function getStored() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (data) => {
        resolve(sanitizeConfig(data[STORAGE_KEY]));
      });
    });
  }

  function setStored(config) {
    const clean = sanitizeConfig(config);
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: clean }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(clean);
      });
    });
  }

  /* ---------- 对外 API ---------- */
  window.TranslateConfig = {
    STORAGE_KEY,
    OFFLINE_PROVIDER_ID,
    DEFAULT_CONFIG,
    validateProvider,
    sanitizeConfig,
    async get() { return getStored(); },
    async set(config) { return setStored(config); },
    /* 取当前激活的 provider 配置 */
    async getActive() {
      const config = await getStored();
      return config.providers.find(p => p.id === config.activeProviderId) || null;
    },
    /* 取默认配置副本（重置用） */
    getDefault() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
  };
})();
