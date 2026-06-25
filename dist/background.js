/* =====================================================================
 * background.js - service worker (v2.1)
 *
 * 职责：
 *   1. 安装时注册右键菜单「翻译选中内容」
 *   2. 监听菜单点击 → 转发给当前 tab 的 content.js
 * ===================================================================== */
(() => {
  'use strict';

  const MENU_ID = 'translate-selection';

  /* 注册右键菜单：已存在则更新，不存在则创建（覆盖安装/重启所有场景） */
  chrome.contextMenus.update(MENU_ID, {
    title: '翻译选中内容',
    contexts: ['selection']
  }, () => {
    if (chrome.runtime.lastError) {
      chrome.contextMenus.create({
        id: MENU_ID,
        title: '翻译选中内容',
        contexts: ['selection']
      });
    }
  });

  /* 监听菜单点击：转发给当前 tab。 */
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID) return;
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, {
      action: 'translate_selection',
      text: info.selectionText || ''
    }, () => {
      if (chrome.runtime.lastError) { /* 静默 */ }
    });
  });
})();
