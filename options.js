/* options.js - 配置页逻辑 (v2.1) */
(() => {
  'use strict';

  /* ---------- DOM ---------- */
  const tbody = document.getElementById('providerBody');
  const addBtn = document.getElementById('addBtn');
  const overlay = document.getElementById('formOverlay');
  const formTitle = document.getElementById('formTitle');
  const fName = document.getElementById('f_name');
  const fBaseURL = document.getElementById('f_baseURL');
  const fApiKey = document.getElementById('f_apiKey');
  const fModel = document.getElementById('f_model');
  const fTemperature = document.getElementById('f_temperature');
  const formErr = document.getElementById('formErr');
  const testResult = document.getElementById('testResult');
  const saveBtn = document.getElementById('saveBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const testBtn = document.getElementById('testBtn');
  const pwToggle = document.getElementById('pwToggle');

  let editingId = null;   // 编辑模式下保存当前 provider id

  /* ---------- 渲染列表 ---------- */
  async function render() {
    const config = await TranslateConfig.get();
    tbody.innerHTML = '';
    config.providers.forEach(p => {
      const tr = document.createElement('tr');
      const isDefault = p.id === config.activeProviderId;

      const endpointInfo = p.type === 'offline'
        ? '<span class="mono">Chrome 内置 Gemini Nano</span>'
        : p.type === 'google'
        ? '<span class="mono">免费 · 无需 API Key</span>'
        : p.type === 'bing'
        ? '<span class="mono">免费 · 无需 API Key</span>'
        : `<span class="mono">${escapeHtml(p.baseURL || '')}<br>${escapeHtml(p.model || '')}</span>`;

      tr.innerHTML = `
        <td>
          ${escapeHtml(p.name)}
          ${isDefault ? '<span class="badge badge--default">默认</span>' : ''}
        </td>
        <td>
          <span class="badge badge--${p.type}">${p.type === 'offline' ? '离线' : p.type === 'google' ? 'Google 免费' : p.type === 'bing' ? 'Bing 免费' : 'OpenAI 兼容'}</span>
        </td>
        <td>${endpointInfo}</td>
        <td>
          ${isDefault ? '' : `<button data-act="default" data-id="${p.id}">设为默认</button>`}
          ${p.type === 'offline' || p.type === 'google' || p.type === 'bing' ? '' : `
            <button data-act="edit" data-id="${p.id}">编辑</button>
            <button class="danger" data-act="del" data-id="${p.id}">删除</button>
          `}
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  /* ---------- 列表事件委托 ---------- */
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    const config = await TranslateConfig.get();

    if (act === 'default') {
      config.activeProviderId = id;
      await TranslateConfig.set(config);
      render();
    } else if (act === 'edit') {
      const p = config.providers.find(x => x.id === id);
      if (p) openForm(p);
    } else if (act === 'del') {
      if (!confirm(`确定删除引擎「${config.providers.find(x => x.id === id)?.name}」？`)) return;
      config.providers = config.providers.filter(x => x.id !== id);
      if (config.activeProviderId === id) config.activeProviderId = TranslateConfig.OFFLINE_PROVIDER_ID;
      await TranslateConfig.set(config);
      render();
    }
  });

  /* ---------- 添加 ---------- */
  addBtn.addEventListener('click', () => openForm(null));

  /* ---------- 打开表单 ---------- */
  function openForm(p) {
    editingId = p ? p.id : null;
    formTitle.textContent = p ? '编辑引擎' : '添加引擎';
    fName.value = p?.name || '';
    fBaseURL.value = p?.baseURL || '';
    fApiKey.value = p?.apiKey || '';
    fModel.value = p?.model || '';
    fTemperature.value = (p?.temperature ?? 0.1);
    formErr.textContent = '';
    testResult.textContent = '';
    testResult.className = 'test-result';
    overlay.classList.add('show');
    fName.focus();
  }

  function closeForm() {
    overlay.classList.remove('show');
    editingId = null;
  }
  cancelBtn.addEventListener('click', closeForm);

  /* ---------- 密码显隐 ---------- */
  pwToggle.addEventListener('click', () => {
    if (fApiKey.type === 'password') {
      fApiKey.type = 'text'; pwToggle.textContent = '隐藏';
    } else {
      fApiKey.type = 'password'; pwToggle.textContent = '显示';
    }
  });

  /* ---------- 测试连接：真实翻译一条，错误能完整显示 ---------- */
  testBtn.addEventListener('click', async () => {
    const cfg = readForm();
    if (!cfg) return;
    testResult.textContent = '测试中（真实翻译 "Hello World"）...';
    testResult.className = 'test-result';
    try {
      // 用真实翻译测试，既验连通性又验模型可用性
      const out = await TranslateProvider.translateTexts(['Hello World'], cfg);
      if (out && out[0] && out[0].trim()) {
        testResult.textContent = `✓ 连接成功，译文：${out[0].slice(0, 30)}`;
        testResult.className = 'test-result ok';
      } else {
        testResult.textContent = '✗ 返回为空';
        testResult.className = 'test-result bad';
      }
    } catch (e) {
      // 完整显示错误体（含 DeepSeek 返回的 detail）
      testResult.textContent = '✗ ' + e.message;
      testResult.className = 'test-result bad';
      console.error('[测试连接]', e);
    }
  });

  /* ---------- 读取表单（含校验） ---------- */
  function readForm() {
    const name = fName.value.trim();
    const baseURL = fBaseURL.value.trim();
    const apiKey = fApiKey.value.trim();
    const model = fModel.value.trim();
    const temperature = parseFloat(fTemperature.value);
    formErr.textContent = '';
    if (!name) { formErr.textContent = '请填写显示名称'; return null; }
    if (!baseURL) { formErr.textContent = '请填写 baseURL'; return null; }
    if (!/^https?:\/\//i.test(baseURL)) { formErr.textContent = 'baseURL 必须以 http(s):// 开头'; return null; }
    if (!model) { formErr.textContent = '请填写模型名'; return null; }
    return {
      id: editingId || ('openai-' + Date.now()),
      type: 'openai',
      name, baseURL, apiKey, model,
      temperature: Number.isNaN(temperature) ? 0.1 : temperature,
      enabled: true
    };
  }

  /* ---------- 保存 ---------- */
  saveBtn.addEventListener('click', async () => {
    const provider = readForm();
    if (!provider) return;
    const config = await TranslateConfig.get();
    const idx = config.providers.findIndex(p => p.id === provider.id);
    if (idx >= 0) config.providers[idx] = provider;
    else config.providers.push(provider);
    try {
      await TranslateConfig.set(config);
      closeForm();
      render();
    } catch (e) {
      formErr.textContent = '保存失败: ' + e.message;
    }
  });

  /* ---------- 工具 ---------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* ---------- 缓存管理 ---------- */
  const cacheCountEl = document.getElementById('cacheCount');
  const clearCacheBtn = document.getElementById('clearCacheBtn');

  async function refreshCacheCount() {
    if (typeof TranslateCache === 'undefined') return;
    await TranslateCache.ready();
    const { count } = TranslateCache.stats();
    cacheCountEl.textContent = count;
  }

  clearCacheBtn.addEventListener('click', async () => {
    if (!confirm('确定清除全部翻译缓存？已保存的引擎配置不受影响。')) return;
    if (typeof TranslateCache !== 'undefined') {
      await TranslateCache.clear();
      await refreshCacheCount();
    }
  });

  /* ---------- 快捷键 ---------- */
  const shortcutInput = document.getElementById('shortcutInput');
  const saveShortcutBtn = document.getElementById('saveShortcutBtn');
  const resetShortcutBtn = document.getElementById('resetShortcutBtn');
  const shortcutMsg = document.getElementById('shortcutMsg');
  const DEFAULT_SHORTCUT = 'Ctrl+Shift+T';
  let editingShortcut = '';

  async function loadShortcut() {
    const data = await chrome.storage.local.get('translateShortcut');
    editingShortcut = data.translateShortcut || DEFAULT_SHORTCUT;
    shortcutInput.value = editingShortcut;
  }

  shortcutInput.addEventListener('focus', () => {
    shortcutInput.value = '';
    shortcutInput.placeholder = '请按下组合键...';
  });

  shortcutInput.addEventListener('blur', () => {
    if (!editingShortcut) editingShortcut = DEFAULT_SHORTCUT;
    shortcutInput.value = editingShortcut;
    shortcutInput.placeholder = '按下单个键...';
  });

  shortcutInput.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    if (e.metaKey) parts.push('Meta');
    const key = e.key;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
      parts.push(key.length === 1 ? key.toUpperCase() : key);
      editingShortcut = parts.join('+');
      shortcutInput.value = editingShortcut;
      shortcutInput.blur();
    }
  });

  saveShortcutBtn.addEventListener('click', async () => {
    if (!editingShortcut) { shortcutMsg.textContent = '请先按下组合键'; shortcutMsg.style.color = '#dc3545'; return; }
    await chrome.storage.local.set({ translateShortcut: editingShortcut });
    shortcutMsg.textContent = '已保存，刷新页面后生效';
    shortcutMsg.style.color = '#166534';
    setTimeout(() => { shortcutMsg.textContent = ''; }, 2000);
  });

  resetShortcutBtn.addEventListener('click', async () => {
    editingShortcut = DEFAULT_SHORTCUT;
    shortcutInput.value = editingShortcut;
    await chrome.storage.local.set({ translateShortcut: DEFAULT_SHORTCUT });
    shortcutMsg.textContent = '已恢复默认';
    shortcutMsg.style.color = '#166534';
    setTimeout(() => { shortcutMsg.textContent = ''; }, 2000);
  });

  /* ---------- 初始化 ---------- */
  render();
  refreshCacheCount();
  loadShortcut();
})();
