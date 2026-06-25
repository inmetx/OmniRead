/* popup.js (v2.1)
 * 仅整页翻译：引擎切换 / 模式切换 / 语言选择 / 翻译按钮。 */

/* ---------------- DOM 引用 ---------------- */
const elStatus       = document.getElementById('statusDisplay');
const elTranslateBtn = document.getElementById('translateBtn');
const elBtnText      = document.getElementById('btnText');
const elStopBtn      = document.getElementById('stopBtn');
const elError        = document.getElementById('errorMsg');
const elWarn         = document.getElementById('warnMsg');
const elEngine       = document.getElementById('engineSelect');
const elSettings     = document.getElementById('settingsBtn');
const elModeToggle   = document.getElementById('modeToggle');
const elSourceLang   = document.getElementById('sourceLang');
const elTargetLang   = document.getElementById('targetLang');
const elShortcutHint = document.getElementById('shortcutHint');

let currentMode = 'replace';
let currentSourceLang = 'auto';
let currentTargetLang = 'zh';

/* ---------------- 初始化 ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  loadMode();
  loadEngine();
  loadLang();
  loadShortcutHint();
  checkPageState();
});

/* 加载持久化的显示模式 */
async function loadMode() {
  try {
    const data = await chrome.storage.local.get('displayMode');
    if (data.displayMode) currentMode = data.displayMode;
    updateModeToggle();
    updateButtonText();
  } catch { /* 忽略 */ }
}

function updateButtonText() {
  elBtnText.textContent = '翻译';
}

/* 更新模式图标：Aa=替换，Aa文=双语；同步 title */
function updateModeToggle() {
  const isBilingual = currentMode === 'bilingual';
  elModeToggle.querySelector('.mode-text').textContent = isBilingual ? 'Aa文' : 'Aa';
  elModeToggle.title = isBilingual
    ? '当前：双语对照（点击切回替换模式）'
    : '当前：替换模式（点击切换双语对照）';
  elModeToggle.style.color = isBilingual ? '#007bff' : '#666';
}

/* ---------------- 加载引擎下拉 ---------------- */
async function loadEngine() {
  try {
    const cfg = await TranslateConfig.get();
    elEngine.innerHTML = '';
    cfg.providers.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + (p.type === 'offline' || p.type === 'google' || p.type === 'bing' ? '' : ` (${p.model || 'openai'})`);
      elEngine.appendChild(opt);
    });
    elEngine.value = cfg.activeProviderId;
  } catch (e) { console.warn('加载引擎失败', e); }
}

elEngine.addEventListener('change', async () => {
  try {
    const cfg = await TranslateConfig.get();
    cfg.activeProviderId = elEngine.value;
    await TranslateConfig.set(cfg);
    /* 若页面已翻译/翻译中，切换引擎后自动「还原 + 重新翻译」，
     * 否则旧译文残留且节点被标记已处理，新引擎不会生效。 */
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && !isRestrictedUrl(tab.url)) {
      try {
        const state = await chrome.tabs.sendMessage(tab.id, { action: 'get_state' });
        if (state?.active) {
          // 已翻译/翻译中：先停止（还原 DOM + 清状态），再用新引擎重译
          await chrome.tabs.sendMessage(tab.id, { action: 'stop_translation' });
          await chrome.tabs.sendMessage(tab.id, {
            action: 'start_translation',
            mode: currentMode,
            targetLang: currentTargetLang,
            sourceLang: currentSourceLang
          });
        }
      } catch { /* content script 未注入，忽略 */ }
    }
    checkPageState();
  } catch (e) { showError('切换引擎失败: ' + e.message); }
});

/* ---------------- 加载语言设置 ---------------- */
async function loadLang() {
  try {
    const data = await chrome.storage.local.get(['sourceLang', 'targetLang']);
    if (data.sourceLang) { currentSourceLang = data.sourceLang; elSourceLang.value = data.sourceLang; }
    if (data.targetLang) { currentTargetLang = data.targetLang; elTargetLang.value = data.targetLang; }
    updateButtonText();
  } catch { /* 忽略 */ }
}

elSourceLang.addEventListener('change', async () => {
  currentSourceLang = elSourceLang.value;
  await chrome.storage.local.set({ sourceLang: currentSourceLang });
  notifyContentScript('set_source_lang', { sourceLang: currentSourceLang });
});

elTargetLang.addEventListener('change', async () => {
  currentTargetLang = elTargetLang.value;
  await chrome.storage.local.set({ targetLang: currentTargetLang });
  updateButtonText();
  notifyContentScript('set_target_lang', { targetLang: currentTargetLang });
});

async function notifyContentScript(action, data) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && !isRestrictedUrl(tab.url)) {
      await chrome.tabs.sendMessage(tab.id, { action, ...data });
    }
  } catch { /* 忽略 */ }
}

/* ---------------- 加载快捷键提示 ---------------- */
async function loadShortcutHint() {
  try {
    const data = await chrome.storage.local.get('translateShortcut');
    const shortcut = data.translateShortcut || 'Ctrl+Shift+T';
    elShortcutHint.textContent = `(${shortcut})`;
  } catch { /* 忽略 */ }
}

/* ---------------- 设置入口 ---------------- */
elSettings.addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL('options.html'));
});

/* ---------------- 模式切换：点击图标在 替换/双语 间切换 ---------------- */
elModeToggle.addEventListener('click', async () => {
  currentMode = currentMode === 'bilingual' ? 'replace' : 'bilingual';
  updateModeToggle();
  updateButtonText();
  await chrome.storage.local.set({ displayMode: currentMode });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && !isRestrictedUrl(tab.url)) {
      await chrome.tabs.sendMessage(tab.id, { action: 'set_mode', mode: currentMode });
    }
  } catch { /* 忽略 */ }
});

/* ---------------- 监听 content 主动上报 ---------------- */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.from !== 'content' || msg.action !== 'notify') return;
  if (msg.type === 'error') showError(msg.message);
  if (msg.type === 'warn')  showWarn(msg.message);
});

/* ---------------- 状态检查 ---------------- */
async function checkPageState() {
  hideError(); hideWarn();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    if (isRestrictedUrl(tab.url)) {
      setStatus('该页面不支持翻译', 'no');
      elTranslateBtn.disabled = true;
      return;
    }
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'check_status' });
    const name = res?.provider?.name || '当前引擎';
    setStatus(res?.available ? `${name} ✓ 可用` : `${name} ✗ 不可用`, res?.available ? 'ok' : 'no');
    const state = await chrome.tabs.sendMessage(tab.id, { action: 'get_state' });
    setTranslatingState(!!(state && state.active));
  } catch {
    setStatus('无法连接页面', 'err');
  }
}

/* ---------------- 翻译按钮 ---------------- */
elTranslateBtn.addEventListener('click', async () => {
  hideError(); hideWarn();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || isRestrictedUrl(tab.url)) { showError('该页面不支持翻译'); return; }
    elTranslateBtn.disabled = true;
    elBtnText.textContent = '翻译中...';
    const res = await chrome.tabs.sendMessage(tab.id, {
      action: 'start_translation',
      mode: currentMode,
      targetLang: currentTargetLang,
      sourceLang: currentSourceLang
    });
    if (!res) throw new Error('页面未响应，请刷新后重试');
    if (res.status === 'error') throw new Error(res.error || '翻译失败');
    setTranslatingState(true);
  } catch (e) {
    showError(e.message);
    setTranslatingState(false);
  }
});

elStopBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && !isRestrictedUrl(tab.url)) {
      await chrome.tabs.sendMessage(tab.id, { action: 'stop_translation' });
    }
  } catch { /* 忽略 */ }
  setTranslatingState(false);
  checkPageState();
});

/* ---------------- 工具 ---------------- */
function setTranslatingState(active) {
  elTranslateBtn.style.display = active ? 'none' : 'block';
  elStopBtn.style.display = active ? 'block' : 'none';
  if (!active) { elTranslateBtn.disabled = false; updateButtonText(); }
}

function setStatus(msg, type) {
  elStatus.textContent = msg;
  elStatus.className = 'status status--' + type;
}
function showError(msg) { elError.textContent = msg; elError.style.display = 'block'; }
function showWarn(msg)  { elWarn.textContent = msg; elWarn.style.display = 'block'; }
function hideError() { elError.style.display = 'none'; }
function hideWarn()  { elWarn.style.display = 'none'; }

function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(url);
}
