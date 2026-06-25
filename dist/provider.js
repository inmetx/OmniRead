/* =====================================================================
 * provider.js - 翻译 Provider 抽象层 (v2.1)
 *
 * 设计借鉴 vibe-reading："翻译 = 构造 prompt + 调模型"。
 * Provider 差异只在请求构造与响应解析，统一对外接口：
 *
 *   TranslateProvider.checkAvailability(providerConfig) → Promise<bool>
 *   TranslateProvider.translateTexts(texts, providerConfig, signal?) → Promise<string[]>
 *
 * 两种 provider：
 *   offline : Chrome 内置 Gemini Nano（离线，保底）
 *   openai  : OpenAI 兼容接口（覆盖 OpenAI/DeepSeek/Ollama/SiliconFlow 等）
 *
 * 两者共享：按目标语言生成的 system prompt、JSON 批量协议、智能对齐补译、单条降级。
 * ===================================================================== */
(() => {
  'use strict';

  /* ===================================================================
   * 目标语言配置
   * =================================================================== */
  const LANG_INFO = {
    zh: { name: '简体中文', native: '简体中文', bcp47: 'zh-CN', rtl: false },
    en: { name: '英文',     native: 'English',  bcp47: 'en',    rtl: false },
    ja: { name: '日文',     native: '日本語',    bcp47: 'ja',    rtl: false },
    ko: { name: '韩文',     native: '한국어',    bcp47: 'ko',    rtl: false }
  };
  let currentTargetLang = 'zh';   // 当前目标语言（默认中文）
  let currentSourceLang = 'auto'; // 当前源语言（默认自动检测）
  let targetLangDirty = false;   // 语言变更后需重建离线 session
  function setTargetLang(code) {
    if (LANG_INFO[code] && code !== currentTargetLang) {
      currentTargetLang = code;
      targetLangDirty = true;     // 标记：下次 getSession 重建 session
    }
  }
  function getTargetLang() { return currentTargetLang; }
  function getTargetName() { return LANG_INFO[currentTargetLang]?.name || '简体中文'; }
  function isTargetRTL()   { return !!LANG_INFO[currentTargetLang]?.rtl; }
  function setSourceLang(code) {
    if (code !== currentSourceLang) {
      currentSourceLang = code;
      targetLangDirty = true;
    }
  }
  function getSourceLang() { return currentSourceLang; }
  function getSourceName() {
    if (currentSourceLang === 'auto') return '自动检测';
    return LANG_INFO[currentSourceLang]?.name || '自动检测';
  }

  /* ===================================================================
   * 共享：系统提示词（按目标语言生成）
   *
   * 设计原则：
   *   1. 正向表述优先（"输出中文" 优于 "禁止输出英文"）——LLM 对正向指令服从度更高
   *   2. 合并冗余禁令，避免稀释每条规则的权重
   *   3. 明确 UI 文案语境（按钮/标签/提示语），避免过度翻译短词
   *   4. 给专有名词明确的判定边界，防止普通英文被当专名保留
   *   5. 术语对照表覆盖 DeFi + 通用 Web UI 两大场景（仅中文）
   * =================================================================== */
  function buildSystemPrompt(targetLang, sourceLang) {
    const info = LANG_INFO[targetLang] || LANG_INFO.zh;
    const targetName = info.name;
    const srcLang = sourceLang || 'auto';
    const srcDesc = srcLang === 'auto'
      ? '自动判断输入文本的源语言'
      : `源语言为${LANG_INFO[srcLang]?.name || srcLang}`;
    const langRule = targetLang === 'zh'
      ? '2. 输出简体中文。整段译文必须是中文，不夹杂英文（规则 3 的例外除外）。'
      : `2. 输出${targetName}（${info.native}）。整段译文必须是${targetName}，不夹杂其他语言（规则 3 的例外除外）。`;
    const punctuationRule = targetLang === 'zh'
      ? `5. 标点转中文全角（逗号 句号 问号 叹号 冒号 分号 双引号 单引号 括号等），但代码片段内的标点保持原样。`
      : '5. 使用目标语言的标点习惯，但代码片段内的标点保持原样。';
    const terminology = targetLang === 'zh'
      ? [
          '【术语对照表】',
          '- DeFi/加密：smart contract→智能合约，liquidity pool→流动性池，staking→质押，wallet→钱包，swap→兑换，slippage→滑点，yield farming→收益耕作，governance→治理，mint→铸造，burn→销毁，airdrop→空投，bridge→跨链桥，oracle→预言机，gas fee→矿工费/手续费，liquidity→流动性，APY→年化收益率，TVL→总锁仓量。',
          '- Web UI：Sign in→登录，Sign up→注册，Submit→提交，Settings→设置，Dashboard→仪表盘，Learn more→了解更多，Get started→开始使用，Account→账户，Profile→个人资料，Notification→通知，Search→搜索，Close→关闭，Delete→删除，Edit→编辑，Save→保存，Confirm→确认，Cancel→取消。',
          ''
        ]
      : [];

    return [
      `你是专业的网页翻译引擎。${srcDesc}，把输入的网页文本翻译成${targetName}（${info.native}）。`,
      '',
      '【输入类型】',
      '输入多为网页 UI 文案：按钮、菜单、标签、提示语、正文段落。这些文本通常简短、是祈使句、常省略主语——译文应保持同样简洁。',
      targetLang === 'zh'
        ? '示例：Submit→提交（不是"提交申请"）；Sign in→登录；Learn more→了解更多。'
        : '示例：保持译文的简洁，不要增译。Submit→直接译为目标语言对应词，不加修饰。',
      '',
      '【输出规则】',
      '1. 只输出译文。不要解释、注释、引导语、编号、引号或代码块包裹。',
      langRule,
      '3. 仅以下内容保留原文：品牌/产品/项目名（GitHub、React、Ethereum、Uniswap）、人名、代码标识符、URL、邮箱、数字、代币符号（ETH、USDC）。',
      '   判定边界：Connect/Wallet/Submit 等普通英文单词不是专名，必须翻译。',
      '4. 输入中的数字、URL、邮箱、代码标识符、代币符号原样保留。',
      punctuationRule,
      '',
      '【批量模式】',
      '当用户要求输出 JSON 数组时：输出严格 JSON，每个元素是一条纯译文，顺序与输入一一对应，不得合并、拆分、遗漏或新增。',
      '',
      ...terminology,
      '【风格】',
      '- 自然流畅的目标语言书面语，符合该语言表达习惯，不逐字死译。',
      '- 简洁，不增译、不补主语，除非目标语言语法必需。'
    ].join('\n');
  }
  /* 兼容旧引用（保留 SYSTEM_PROMPT 常量，按当前 targetLang 取） */
  function getSystemPrompt() { return buildSystemPrompt(currentTargetLang, currentSourceLang); }

  /* ===================================================================
   * 共享：JSON 批量 prompt 构造与解析（按当前 targetLang）
   * =================================================================== */
  function buildBatchPrompt(texts) {
    const n = texts.length;
    const targetName = getTargetName();
    const srcName = getSourceName();
    const srcPrefix = currentSourceLang === 'auto'
      ? '请判断以下文本的源语言'
      : `请把下面每一行${srcName}文本`;
    const indexed = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
    return (
      `${srcPrefix}翻译成${targetName}，输出一个 JSON 字符串数组。\n` +
      `要求：\n` +
      `- 数组长度必须等于输入行数（${n}），顺序一一对应\n` +
      `- 每个元素只能是纯译文，禁止包含英文、编号、引号转义之外的标点\n` +
      `- 不要合并、拆分、遗漏、新增任何条目\n` +
      `- 只输出 JSON 数组本身，不要代码块标记、注释或任何额外文字\n\n` +
      `${indexed}`
    );
  }

  function stripCodeFence(s) {
    let c = s.trim();
    if (c.startsWith('```json')) c = c.slice(7);
    else if (c.startsWith('```')) c = c.slice(3);
    if (c.endsWith('```')) c = c.slice(0, -3);
    return c.trim();
  }

  function parseJsonArray(raw) {
    const parsed = JSON.parse(stripCodeFence(raw));
    const arr = Array.isArray(parsed) ? parsed : Object.values(parsed);
    return arr.map(x => String(x ?? '').trim());
  }

  /* 单条 prompt 与单条结果清洗（去引号包裹） */
  function buildSinglePrompt(t) {
    const targetName = getTargetName();
    const srcName = getSourceName();
    const srcPrefix = currentSourceLang === 'auto'
      ? '请判断下面文本的源语言'
      : `请把下面的${srcName}文本`;
    return `${srcPrefix}翻译成${targetName}。只输出译文，不要任何解释、引号或代码块标记：\n${t}`;
  }
  function cleanSingle(s) {
    return stripCodeFence(s).replace(/^["'“”』「」\s]+|["'“”』」\s]+$/g, '').trim();
  }

  /* 错误分类（逻辑在 utils.js，可单测）：
   *   isRecoverableError：解析/对齐错可降级；网络/鉴权错不可恢复
   *   isFatalModelError：鉴权/配置类（401/403/404），alignAndFill 遇到立即上抛不吞空串 */
  const isRecoverableError = (err) => TranslateUtils.isRecoverableError(err);
  const isFatalModelError = (err) => TranslateUtils.isFatalModelError(err);

  /* 智能对齐补译：arr 与期望 n 不等时，前段采纳、末段补译。
   * singleCall = async (text) => string，由具体 provider 提供。
   * M2：singleCall 遇致命错误（401/403/404）立即上抛，避免剩余条目白跑。 */
  async function alignAndFill(arr, texts, singleCall) {
    const n = texts.length;
    if (arr && arr.length === n) return arr;

    // 差异过大 → 全量逐条降级
    if (!arr || arr.length < Math.ceil(n / 2)) {
      if (arr) console.warn(`[翻译] 数量差异过大(期望${n}/得到${arr.length})，全量逐条降级`);
      const out = [];
      for (const t of texts) {
        try { out.push(await singleCall(t)); }
        catch (e) {
          if (isFatalModelError(e) || e.message === 'TRANSLATION_ABORTED') throw e;  // 致命错/取消立即上抛
          out.push('');
        }
      }
      return out;
    }

    // 轻微偏差 → 前 trusted 条采纳，末段补译
    const trusted = Math.max(0, Math.min(arr.length, n) - 1);
    const out = arr.slice(0, trusted);
    console.warn(`[翻译] 智能对齐: 采纳前 ${trusted} 条，从第 ${trusted + 1} 条起补译 ${n - trusted} 条`);
    for (let i = trusted; i < n; i++) {
      try { out.push(await singleCall(texts[i])); }
      catch (e) {
        if (isFatalModelError(e) || e.message === 'TRANSLATION_ABORTED') throw e;  // 致命错/取消立即上抛
        out.push('');
      }
    }
    return out;
  }

  /* ===================================================================
   * 离线 Provider：Chrome 内置 Gemini Nano
   * =================================================================== */
  let offlineSession = null;
  let offlineSessionBatchCount = 0;
  const OFFLINE_MAX_BATCHES = 3;

  const OfflineProvider = {
    async checkAvailability() {
      if (!('LanguageModel' in self)) return false;
      try {
        const status = await LanguageModel.availability();
        return status === 'available';
      } catch {
        return false;
      }
    },

    async _getSession() {
      // 语言变更或达到批次上限时重建 session（重建后 prompt 用新语言）
      if (!offlineSession || offlineSessionBatchCount >= OFFLINE_MAX_BATCHES || targetLangDirty) {
        if (offlineSession) { offlineSession.destroy(); offlineSession = null; }
        targetLangDirty = false;
        offlineSession = await LanguageModel.create({
          initialPrompts: [{ role: 'system', content: getSystemPrompt() }],
          temperature: 0.1,
          topK: 1
        });
        offlineSessionBatchCount = 0;
      }
      return offlineSession;
    },

    async _call(prompt) {
      const sess = await this._getSession();
      const result = await sess.prompt(prompt);
      offlineSessionBatchCount++;
      return result;
    },

    async translateTexts(texts) {
      // 批量
      let arr = null;
      try {
        const raw = await this._call(buildBatchPrompt(texts));
        arr = parseJsonArray(raw);
      } catch (e) {
        console.warn('[翻译][离线] 批量失败:', e.message);
      }
      // 单条
      const singleCall = async (t) => cleanSingle(await this._call(buildSinglePrompt(t)));
      // 完美对齐直接返回，否则智能对齐补译
      if (arr && arr.length === texts.length) return arr;
      return alignAndFill(arr, texts, singleCall);
    },

    destroy() {
      if (offlineSession) { offlineSession.destroy(); offlineSession = null; }
      offlineSessionBatchCount = 0;
    }
  };

  /* ===================================================================
   * OpenAI 兼容 Provider
   * 覆盖 OpenAI / DeepSeek / Ollama / SiliconFlow / 智谱 / 火山等
   * =================================================================== */
  /* URL 规范化（逻辑在 utils.js，可单测） */
  const normalizeBaseURL = (baseURL) => TranslateUtils.normalizeBaseURL(baseURL);

  async function openaiChat(messages, providerConfig, signal) {
    const baseURL = normalizeBaseURL(providerConfig.baseURL);
    const url = `${baseURL}/chat/completions`;
    const body = {
      model: providerConfig.model,
      messages,
      temperature: typeof providerConfig.temperature === 'number' ? providerConfig.temperature : 0.1,
      stream: false
    };
    const headers = { 'Content-Type': 'application/json' };
    if (providerConfig.apiKey) headers['Authorization'] = `Bearer ${providerConfig.apiKey}`;

    const doFetch = () => fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    });

    let resp;
    try {
      resp = await doFetch();
    } catch (e) {
      // 用户主动取消（abort）：抛专门的取消错误，上层据此静默处理，不计入失败
      if (e.name === 'AbortError') throw new Error('TRANSLATION_ABORTED');
      throw new Error(`网络请求失败: ${e.message}`);
    }
    // 429 限流：指数退避重试 1 次
    if (resp.status === 429) {
      console.warn('[翻译][OpenAI] 429 限流，1.5s 后重试一次');
      await new Promise(r => setTimeout(r, 1500));
      resp = await doFetch();
    }
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 300); } catch {}
      throw new Error(`HTTP ${resp.status}: ${detail || resp.statusText}`);
    }
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new Error(`响应非 JSON: ${e.message}`);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('响应缺少 choices[0].message.content');
    return content;
  }

  const OpenAIProvider = {
    async checkAvailability(providerConfig) {
      // 探测：发一条极短翻译，成功即视为可用
      try {
        const r = await openaiChat(
          [{ role: 'user', content: 'Reply with the single word: OK' }],
          providerConfig
        );
        return typeof r === 'string';
      } catch {
        return false;
      }
    },

    async _call(prompt, providerConfig, signal) {
      return openaiChat(
        [
          { role: 'system', content: getSystemPrompt() },
          { role: 'user', content: prompt }
        ],
        providerConfig,
        signal
      );
    },

    async translateTexts(texts, providerConfig, signal) {
      // 批量
      let arr = null;
      try {
        const raw = await this._call(buildBatchPrompt(texts), providerConfig, signal);
        arr = parseJsonArray(raw);
      } catch (e) {
        // 仅解析错（JSON 格式/数量不符）才降级；网络/鉴权错直接上抛
        if (isRecoverableError(e)) {
          console.warn('[翻译][OpenAI] 批量解析失败，降级智能对齐:', e.message);
        } else {
          throw e;
        }
      }
      // 单条
      const singleCall = async (t) =>
        cleanSingle(await this._call(buildSinglePrompt(t), providerConfig, signal));
      if (arr && arr.length === texts.length) return arr;
      return alignAndFill(arr, texts, singleCall);
    },

    destroy() { /* 无状态，无需清理 */ }
  };

  /* ===================================================================
   * Google Translate（免费，无需 API Key）
   *
   * 使用 Google Translate 网页版 API（GET 请求，无需认证）
   * 优势：稳定、免费、支持批量
   * =================================================================== */
  const GoogleFreeProvider = {
    _apiKey: null,
    _lastFetchTime: 0,
    _fetchPromise: null,

    async _refreshAuth() {
      if (this._fetchPromise) return this._fetchPromise;
      this._fetchPromise = (async () => {
        try {
          const resp = await fetch(
            'https://translate.googleapis.com/_/translate_http/_/js/k=translate_http.tr.en_US.YusFYy3P_ro.O/am=AAg/d=1/exm=el_conf/ed=1/rs=AN8SPfq1Hb8iJRleQqQc8zhdzXmF9E56eQ/m=el_main'
          );
          const text = await resp.text();
          const match = text.match(/['"]x\-goog\-api\-key['"]\s*\:\s*['"](\w{39})['"]/i);
          if (match && match[1]) {
            this._apiKey = match[1];
            this._lastFetchTime = Date.now();
          }
        } catch (e) {
          console.warn('[翻译][Google] 获取 API Key 失败:', e);
        } finally {
          this._fetchPromise = null;   // 任何情况都释放，避免异常时永久卡死后续刷新
        }
      })();
      return this._fetchPromise;
    },

    async _ensureAuth() {
      const FRESHNESS_MS = 20 * 60 * 1000;
      if (this._apiKey && (Date.now() - this._lastFetchTime) < FRESHNESS_MS) return;
      await this._refreshAuth();
    },

    _mapLang(code) {
      const map = { 'prs': 'fa-AF' };
      return map[code] || code;
    },

    async checkAvailability() {
      try {
        const result = await this._translateSingle('Hello', 'en', 'zh');
        return typeof result === 'string' && result.length > 0;
      } catch {
        return false;
      }
    },

    async _translateSingle(text, sourceLang, targetLang, signal) {
      const sl = sourceLang || 'auto';
      const tl = this._mapLang(targetLang);
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
      
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      
      // 响应格式: [[["translated","original",...], ...], ...]
      if (Array.isArray(data) && Array.isArray(data[0])) {
        return data[0].map(item => item[0]).join('');
      }
      throw new Error('Google Translate 响应格式异常');
    },

    async translateTexts(texts, signal) {
      const sourceLang = currentSourceLang === 'auto' ? 'auto' : this._mapLang(currentSourceLang);
      const targetLang = this._mapLang(currentTargetLang);

      // 并发限制：Google 免费端点同时最多 4 个请求，避免 429 限流
      const CONCURRENCY = 4;
      const results = new Array(texts.length);
      let cursor = 0;

      async function worker() {
        while (cursor < texts.length) {
          const i = cursor++;
          try {
            results[i] = await GoogleFreeProvider._translateSingle(texts[i], sourceLang, targetLang, signal);
          } catch (e) {
            if (e.message === 'TRANSLATION_ABORTED') throw e;
            console.warn('[翻译][Google] 单条翻译失败:', e.message);
            results[i] = '';
          }
        }
      }

      const workers = [];
      for (let w = 0; w < Math.min(CONCURRENCY, texts.length); w++) {
        workers.push(worker());
      }
      await Promise.all(workers);
      return results;
    },

    destroy() {}
  };

  /* ===================================================================
   * Microsoft Bing Translator（免费，无需 API Key）
   *
   * 端点：api-edge.cognitive.microsofttranslator.com/translate
   * 认证：Bearer Token（从 edge.microsoft.com/translate/auth 获取，每 8 分钟刷新）
   * 优势：官方 Edge 浏览器同款、支持批量、免费
   * =================================================================== */
  const BingFreeProvider = {
    _token: null,
    _lastFetchTime: 0,
    _fetchPromise: null,

    async _refreshAuth() {
      if (this._fetchPromise) return this._fetchPromise;
      this._fetchPromise = (async () => {
        try {
          const resp = await fetch('https://edge.microsoft.com/translate/auth');
          const text = await resp.text();
          if (text && text.length > 1) {
            this._token = text;
            this._lastFetchTime = Date.now();
          }
        } catch (e) {
          console.error('[翻译][Bing] 获取 Token 失败:', e);
        } finally {
          this._fetchPromise = null;   // 任何情况都释放，避免异常时永久卡死后续刷新
        }
      })();
      return this._fetchPromise;
    },

    async _ensureAuth() {
      const FRESHNESS_MS = 8 * 60 * 1000;
      if (this._token && (Date.now() - this._lastFetchTime) < FRESHNESS_MS) return;
      await this._refreshAuth();
    },

    _mapLang(code) {
      const map = {
        'zh': 'zh-Hans',
        'auto': 'auto-detect',
        'zh-CN': 'zh-Hans',
        'zh-TW': 'zh-Hant',
        'tl': 'fil',
        'hmn': 'mww',
        'ku': 'kmr',
        'ckb': 'ku',
        'mn': 'mn-Cyrl',
        'no': 'nb',
        'lg': 'lug',
        'sr': 'sr-Cyrl',
        'mni-Mtei': 'mni',
        'pt': 'pt-BR'
      };
      return map[code] || code;
    },

    async checkAvailability() {
      try {
        await this._ensureAuth();
        if (!this._token) return false;
        const resp = await fetch(
          'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + this._token
            },
            body: JSON.stringify([{ text: 'Hello' }])
          }
        );
        return resp.ok;
      } catch {
        return false;
      }
    },

    async translateTexts(texts, signal) {
      await this._ensureAuth();
      if (!this._token) throw new Error('Microsoft Translator 认证失败，无法获取 Token');

      const sourceLang = this._mapLang(currentSourceLang);
      const targetLang = this._mapLang(currentTargetLang);

      const fromParam = sourceLang !== 'auto-detect' ? `&from=${sourceLang}` : '';
      const url = `https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0${fromParam}&to=${targetLang}`;

      const doFetch = () => fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this._token
        },
        body: JSON.stringify(texts.map(t => ({ text: t }))),
        signal
      });

      let resp;
      try {
        resp = await doFetch();
      } catch (e) {
        if (e.name === 'AbortError') throw new Error('TRANSLATION_ABORTED');
        throw new Error(`网络请求失败: ${e.message}`);
      }
      if (resp.status === 429) {
        console.warn('[翻译][Bing] 429 限流，1.5s 后重试');
        await new Promise(r => setTimeout(r, 1500));
        resp = await doFetch();
      }
      if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.text()).slice(0, 300); } catch {}
        throw new Error(`HTTP ${resp.status}: ${detail || resp.statusText}`);
      }
      const data = await resp.json();
      if (!Array.isArray(data)) throw new Error('Microsoft Translator 响应格式异常');
      return data.map(item => item?.translations?.[0]?.text || '');
    },

    destroy() {}
  };

  /* ===================================================================
   * 统一分发器（对外 API）
   * =================================================================== */
  /* checkAvailability 短缓存：5 秒内同 provider 不重复网络请求（popup 频繁打开优化） */
  const _availabilityCache = new Map();  // providerId → { result, time }
  const AVAIL_CACHE_MS = 5000;

  window.TranslateProvider = {
    /* 语言相关 */
    getSystemPrompt,
    LANG_INFO,
    setTargetLang,
    getTargetLang,
    getTargetName,
    isTargetRTL,
    setSourceLang,
    getSourceLang,
    getSourceName,

    async checkAvailability(providerConfig) {
      if (!providerConfig) return false;
      const pid = providerConfig.id || providerConfig.type;
      const cached = _availabilityCache.get(pid);
      if (cached && (Date.now() - cached.time) < AVAIL_CACHE_MS) return cached.result;

      let result = false;
      if (providerConfig.type === 'offline') result = await OfflineProvider.checkAvailability();
      else if (providerConfig.type === 'openai') result = await OpenAIProvider.checkAvailability(providerConfig);
      else if (providerConfig.type === 'google') result = await GoogleFreeProvider.checkAvailability();
      else if (providerConfig.type === 'bing') result = await BingFreeProvider.checkAvailability();

      _availabilityCache.set(pid, { result, time: Date.now() });
      return result;
    },

    async translateTexts(texts, providerConfig, signal) {
      if (!providerConfig) throw new Error('未配置 provider');
      if (!Array.isArray(texts) || texts.length === 0) return [];

      const pid = providerConfig.id || providerConfig.type;

      /* ---------- 缓存查询 ---------- */
      const hasCache = typeof window.TranslateCache !== 'undefined';
      let hitMap = null, missIdx = null;
      if (hasCache) {
        await window.TranslateCache.ready();
        ({ hit: hitMap, miss: missIdx } = window.TranslateCache.lookup(texts, pid, currentTargetLang, currentSourceLang));
        if (missIdx.length === 0) {
          // 全部命中：直接组装返回，不调模型
          console.log(`[缓存] 全命中 ${texts.length}/${texts.length} 条`);
          return texts.map((_, i) => hitMap.get(i));
        }
        if (hitMap.size > 0) {
          console.log(`[缓存] 命中 ${hitMap.size}/${texts.length} 条，仅翻译未命中的 ${missIdx.length} 条`);
        }
      }

      /* ---------- 内部分发：只翻译未命中的子集 ---------- */
      const missTexts = missIdx ? missIdx.map(i => texts[i]) : texts;
      let missResults;
      try {
        if (providerConfig.type === 'offline') {
          missResults = await OfflineProvider.translateTexts(missTexts);
        } else if (providerConfig.type === 'openai') {
          missResults = await OpenAIProvider.translateTexts(missTexts, providerConfig, signal);
        } else if (providerConfig.type === 'google') {
          missResults = await GoogleFreeProvider.translateTexts(missTexts, signal);
        } else if (providerConfig.type === 'bing') {
          missResults = await BingFreeProvider.translateTexts(missTexts, signal);
        } else {
          throw new Error('未知 provider 类型: ' + providerConfig.type);
        }
      } catch (e) {
        // 失败时，命中部分仍返回（部分成功优于全失败）
        if (hitMap && hitMap.size > 0) {
          console.warn('[翻译] 批次失败，返回已缓存的 ' + hitMap.size + ' 条');
          const out = new Array(texts.length).fill('');
          hitMap.forEach((v, i) => { out[i] = v; });
          throw e;  // 仍向上抛，让 content.js 计入失败
        }
        throw e;
      }

      /* ---------- 写回缓存 ---------- */
      if (hasCache) {
        window.TranslateCache.put(missTexts, missResults, pid, currentTargetLang, currentSourceLang);
      }

      /* ---------- 合并：命中 + 新译 ---------- */
      if (!hitMap || hitMap.size === 0) return missResults;
      const out = new Array(texts.length);
      for (let i = 0; i < texts.length; i++) {
        out[i] = hitMap.has(i) ? hitMap.get(i) : missResults[missIdx.indexOf(i)];
      }
      return out;
    },

    /* 销毁所有 provider 的内部状态（如离线 session） */
    destroyAll() {
      OfflineProvider.destroy();
      OpenAIProvider.destroy();
      GoogleFreeProvider.destroy();
      BingFreeProvider.destroy();
    },

    /* 仅用于单元测试：导出内部纯函数，不参与运行时调用链。
     * 运行时逻辑零变化，仅让 buildBatchPrompt / alignAndFill 等可被直接断言。 */
    _test: {
      buildSystemPrompt, buildBatchPrompt, buildSinglePrompt,
      parseJsonArray, stripCodeFence, cleanSingle, alignAndFill
    }
  };
})();
