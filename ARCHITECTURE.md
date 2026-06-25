# OmniRead 架构文档 (v2.1)

> 面向维护者与二次开发者。本文解释**为什么这样设计**，而非逐行注释代码。
> 用户向文档见 [dist/README.md](./dist/README.md)。

---

## 1. 设计目标与约束

| 目标 | 实现手段 |
|---|---|
| 多引擎统一调度 | Provider 抽象层，4 种引擎走同一接口 |
| 重复内容零消耗 | LRU + TTL 缓存，命中即短路 |
| SPA 动态内容不漏译 | MutationObserver + 双定时器 + 虚拟滚动检测 |
| 取消立即生效、省 token | AbortController + 哨兵错误贯穿全链路 |
| 离线优先、隐私可选 | Gemini Nano 作为不可删除的保底引擎 |
| 零依赖、可读 | 原生 JS + IIFE 隔离，无构建工具 |

**硬约束**：Manifest V3（service worker）、零 npm 依赖、无 TypeScript、无打包步骤。

---

## 2. 整体架构

### 2.1 模块拓扑

```
┌─────────────────────────────────────────────────────────────┐
│  Chrome Extension (MV3)                                     │
│                                                              │
│  ┌──────────────┐    contextMenus     ┌──────────────────┐  │
│  │ background.js│ ──────────────────► │ content.js       │  │
│  │ (SW, 无状态) │   sendMessage       │ (每页一份实例)   │  │
│  └──────────────┘                     │                  │  │
│         ▲                             │  ┌────────────┐  │  │
│         │ runtime.sendMessage         │  │ provider.js│  │  │
│  ┌──────┴───────┐  tabs.sendMessage   │  │  (4 引擎)  │  │  │
│  │ popup.js     │ ◄─────────────────► │  └─────┬──────┘  │  │
│  │ options.js   │                     │        │         │  │
│  └──────┬───────┘                     │  ┌─────┴──────┐  │  │
│         │ chrome.storage.local        │  │  cache.js  │  │  │
│         │ (配置/模式/快捷键)           │  │ (LRU+TTL)  │  │  │
│         └─────────────────────────────┼──┤            │  │  │
│                                         │  └─────┬──────┘  │  │
│  content_scripts 加载顺序（manifest）： │        │         │  │
│  utils → config → provider → cache      │  ┌─────┴──────┐  │  │
│  → content                              │  │ config.js  │  │  │
│                                         │  │ utils.js   │  │  │
│                                         │  └────────────┘  │  │
│                                         └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 模块职责契约

每个模块用 IIFE `(()=>{ 'use strict'; ... })()` 隔离，通过 `window.TranslateXxx` 暴露对外 API。模块间**只允许通过这些 API 通信**，不直接读彼此内部变量。

| 文件 | 全局 API | 职责 | 不负责 |
|---|---|---|---|
| `utils.js` | `TranslateUtils` | 纯函数（无 chrome/DOM 依赖）：文本过滤、URL 规范化、错误分类、FNV-1a 哈希、配置校验 | 任何 I/O |
| `config.js` | `TranslateConfig` | provider 配置存取（`get/set/getActive/getDefault`）、`sanitizeConfig` 去重补默认 | 翻译本身 |
| `provider.js` | `TranslateProvider` | 4 引擎抽象、prompt 构造、批量/单条降级、缓存联动分发 | DOM、UI |
| `cache.js` | `TranslateCache` | LRU+TTL 缓存（内存热缓存 + storage 持久化）、防抖写回 | 翻译调用 |
| `content.js` | （消息协议） | DOM 遍历、并发池、observer、划词浮窗、消息路由 | 引擎实现细节 |
| `background.js` | （contextMenus） | 右键菜单注册与转发 | 业务逻辑 |
| `popup.js` / `options.js` | — | UI 状态与用户交互 | 翻译逻辑 |

**关键设计**：`utils.js` 采用 UMD 双导出（`window.TranslateUtils` + `module.exports`），使其能在 Node 下被 `require` 进行单元测试，是整个可测试性体系的基石。

### 2.3 为什么用 `window.TranslateXxx` 而非 ES modules？

content script 运行在**隔离世界（isolated world）**，与页面 JS 互不打扰，但共享 DOM。在这种环境里：
- ES modules（`import/export`）在 content_scripts 中支持不稳定，需额外的构建步骤。
- 挂 `window` 是 Chrome 扩展最古老、最可靠的模块共享方式，且 manifest 的 `js` 数组保证了加载顺序。

代价是全局命名空间污染——但 IIFE + 唯一前缀 `Translate` 已将风险降到可接受。

---

## 3. 核心数据流：整页翻译主链路

### 3.1 启动翻译（点击按钮 / 快捷键）

```
用户点击「翻译」
  │
  ▼
popup.js: chrome.tabs.sendMessage({action:'start_translation', mode, targetLang, sourceLang})
  │
  ▼
content.js onMessage: start_translation
  ├─ TranslateProvider.setTargetLang / setSourceLang   (同步模块状态)
  └─ startTranslation()                                 (async)
       │
       ├─ TranslateConfig.getActive()                   取激活 provider 配置
       ├─ TranslateProvider.checkAvailability(cfg)      探测引擎可用（5s 缓存）
       │    └─ 不可用 → throw（带具体提示：Gemini Nano 还是 baseURL/key）
       ├─ abortController = new AbortController()       建立取消控制器
       ├─ await translateAll()                          ← 主流程（见 3.2）
       └─ startPageRadar()                              挂 MutationObserver
            │
            ▼ 返回 stats 给 popup
```

**快捷键路径**（`content.js:72`）走同一 `startTranslation()`，保证与点按钮行为一致；失败时 `notifyPopup('error')` 上报（快捷键无弹窗直连，复用与翻译错误相同的通道）。

### 3.2 translateAll：并发池核心

```
translateAll(isIncremental)
  │
  ├─【竞态锁】if (translatingPromise) {
  │              pendingIncremental = true;     ← 不丢弃，标记待处理
  │              return translatingPromise;
  │           }
  │
  └─ translatingPromise = (async () => {
       observer.disconnect()                    ← 翻译期间暂停，避免自触发
       textNodes = collectTextNodes()           ← TreeWalker + 过滤 + 复用检测
       │
       ├─ 切批次：每 BATCH_SIZE(15) 节点一批
       ├─ 启动 N 个 worker（离线 N=1，云端 N=3）
       │    worker 循环：
       │      if (!isTranslationActive) return  ← 停止信号
       │      if (fatal) return                 ← 鉴权错，其余批次停发
       │      myIdx = nextBatchIdx++            ← 领任务（无锁自增，单线程 JS 安全）
       │      translations = TranslateProvider.translateTexts(texts, cfg, signal)
       │      applyTranslation(node, t)         ← 写 DOM（见 3.3）
       │      translatedNodes.add(node); nodeLastText.set(node, 原文)
       │
       └─ finally:
            translatingPromise = null           ← 释放锁
            if (isTranslationActive) observer.observe()   ← 恢复监听
            if (pendingIncremental) {           ← 翻译期间有新内容被锁挡住
              pendingIncremental = false;
              queueMicrotask(() => translateAll(true));   ← 追加一次增量
            }
     })();
```

**三个关键决策的理由**：

1. **固定并发池而非 Promise.all 一次性全发**：云端引擎有并发限制（DeepSeek/OpenAI 通常 3-5），一次性发 50 个请求会触发 429。固定池"谁完成谁领下一批"自动背压。
2. **离线强制 N=1**：Gemini Nano 是本地推理，并发无收益且可能 OOM（模型常驻内存 ~1.5GB）。
3. **`pendingIncremental` + `queueMicrotask`**：旧实现 `if (translatingPromise) return promise` 会**永久丢弃**被锁挡住的增量请求——这是 X 下拉漏译的根因之一。现在的方案保证"翻译期间到达的新内容，在当前翻译完成后必被追加处理一次"。

### 3.3 DOM 写入与还原

```
applyTranslation(node, translation)
  │
  ├─ originalTexts.set(node, node.textContent)    ← 首次记录原文（停止时还原用）
  ├─ 保留首尾空白（leadWS / trailWS）              ← 避免破坏排版
  │
  ├─ replace 模式：
  │     replacedNodes.add(node)
  │     node.textContent = leadWS + translation + trailWS
  │
  └─ bilingual 模式：
        parent.insertBefore(span, node.nextSibling)
        span.dataset.translation = '1'           ← 还原时反查标记
        span.textContent = translation
```

**还原（stopTranslation）** 双路径：
- 双语：`querySelectorAll('[data-translation]')` 找所有译文 span，用 `originalTexts.get(previousSibling)` 还原原文后 `span.remove()`。
- 替换：遍历 `replacedNodes` Set，逐个 `textContent = originalTexts.get(node)`。

还原后**重新赋值** `translatedNodes = new WeakSet()` 等（WeakSet/WeakMap 无 `clear()`），否则"停止→重译"时所有节点被当作已处理而跳过。

---

## 4. 关键设计决策

### 4.1 取消链路（AbortController + 哨兵错误）

停止翻译时必须立即中断在途网络请求（省 token、省算力），且不能让错误冒泡成"翻译失败"。

```
stopTranslation()
  └─ abortController.abort()
       │
       ▼  fetch 抛 AbortError
openaiChat / BingFreeProvider
  └─ catch: if (e.name === 'AbortError') throw new Error('TRANSLATION_ABORTED')
       │                                          ↑ 哨兵错误
       ▼
alignAndFill
  └─ if (e.message === 'TRANSLATION_ABORTED') throw e   ← 不吞成空串，立即上抛
       │
       ▼
worker (content.js)
  └─ if (err.message === 'TRANSLATION_ABORTED') return   ← 静默退出，不计失败、不弹错
```

**为什么用字符串哨兵而非自定义 Error 子类**：项目零依赖且无构建步骤，自定义类需额外声明；字符串比较足够可靠，且 `message` 在所有错误聚合/日志场景里天然可见。代价是没有类型保护（typo 不会编译期报错）——靠测试覆盖（`provider.test.js` 有专门的 abort 用例锁死这条路径）。

### 4.2 错误分级

`utils.js` 把错误分两类，决定降级还是中止：

| 分类 | 判定 | 处理 |
|---|---|---|
| **可恢复** (`isRecoverableError`) | JSON 解析错（`Unexpected token`）等 | 批量失败 → 降级到 `alignAndFill` 智能对齐/单条补译 |
| **致命** (`isFatalHttpError`) | HTTP 401/403/404（鉴权/配置） | 立即上抛，worker 设 `fatal=true`，其余批次停发新请求 |

**判定依据是错误 message 前缀**：
- `HTTP ` / `网络请求失败` / `响应非 JSON` / `choices[0].message.content` → 不可恢复（直接上抛）
- 其它（如 `Unexpected token`）→ 可恢复（降级）

这套分类**依赖错误 message 的约定格式**，是脆弱点。但所有抛错点都集中在 `openaiChat`（`provider.js:272`）一处，格式可控。测试用例锁定了每种前缀的行为。

### 4.3 智能对齐补译（alignAndFill）

LLM 批量翻译常返回数量不符的 JSON 数组（少译/多译/合并）。`alignAndFill` 处理三种情况：

```
arr.length === n        → 完美对齐，直接返回
arr.length < n/2        → 差异过大，丢弃 arr，全量逐条重译
n/2 <= arr.length < n   → 轻微偏差，采纳前 (min-1) 条，末段逐条补译
```

补译过程中遇致命错误（401）或 `TRANSLATION_ABORTED` **立即上抛**，避免剩余条目白跑；遇普通错误吞成空串（宁可少一条译文也不让整批失败）。

### 4.4 SPA 动态内容处理（三道防线）

这是项目踩坑最深的部分，针对 X(Twitter) 等虚拟滚动网站：

**防线一：双定时器 debounce**
```
MutationObserver 回调：
  clearTimeout(debounceTimeout)
  debounceTimeout = setTimeout(doIncremental, 500ms)   ← 常规防抖
  if (!debounceMaxTimer)
    debounceMaxTimer = setTimeout(doIncremental, 2000ms) ← 兜底：只设一次，不随滚动 reset
```
X 高频更新 DOM 会让 500ms debounce 永不触发；maxTimer 不被 reset，2s 后强制执行。

**防线二：虚拟滚动节点复用检测**
```
collectTextNodes:
  if (translatedNodes.has(node)) {
    if (nodeLastText.get(node) === 当前文本) 跳过;     ← 同节点同内容
    else 清除 originalTexts 记录，继续重新翻译;        ← React 复用了 DOM 节点塞新内容
  }
```
react-virtualized 滚出视口的推文节点会被**复用**给下一条，`translatedNodes` WeakSet 无法察觉内容变化。`nodeLastText` WeakMap 快照原文对比解决。

**防线三：pendingIncremental 追加**（见 3.2）—— 翻译期间被锁挡住的新内容，完成后自动补译。

### 4.5 缓存设计（LRU + TTL + 部分命中）

```
key = hashFNV1a(providerId | sourceLang | targetLang | text)   ← 复合 key，换引擎/语言自动隔离
存储：{ entries: { "<hash>": { v:译文, t:访问时间, c:创建时间 } } }

lookup(texts, ...):
  命中 → hit.set(i, v); 更新 t（LRU）
  过期(now - c > 7天) → 惰性删除 + miss
  未命中 → miss.push(i)
  返回 { hit: Map<i,译文>, miss: number[] }

translateTexts:
  全命中 → 直接组装返回，fetch 调用次数 = 0     ← 核心优化
  部分命中 → 只翻译 miss 子集，合并返回
```

**设计要点**：
- **FNV-1a 32bit → base36** 比 SHA-1 快 ~100x，2000 条规模碰撞率可忽略（测试有碰撞用例）。
- **内存热缓存**：启动一次性 load，查询 O(1)；写回防抖 1000ms，避免每条触发 IO。
- **LRU 淘汰**：超 2000 条时按 `t` 排序删最旧 200 条（O(n log n)，低频操作）。
- **TTL 7 天**：换 prompt/引擎后旧译文自动失效（因 key 含 providerId/lang，多数情况换引擎本就 miss，TTL 是额外保险）。

---

## 5. Provider 抽象层

### 5.1 统一接口

每个引擎实现两个方法，差异完全内聚：

```js
{
  async checkAvailability(providerConfig?) : Promise<boolean>
  async translateTexts(texts, providerConfig?, signal?) : Promise<string[]>
  destroy() : void
}
```

分发器 `TranslateProvider.translateTexts` 负责：缓存查询 → 只译 miss → 写回缓存 → 合并。引擎只需关心"给我一批文本，返回译文数组"。

### 5.2 四引擎差异矩阵

| 引擎 | 认证 | 批量 | 并发 | 速度 | 备注 |
|---|---|---|---|---|---|
| **offline** (Gemini Nano) | 无 | ✅ session prompt | 1（串行） | 慢（本地推理） | session 每 3 批重建（防上下文漂移） |
| **openai** (兼容) | Bearer apiKey | ✅ JSON 数组 | 3 | 中-快 | 429 自动重试 1 次 |
| **google** (免费) | 逆向 x-goog-api-key | ❌ 串行单条 | 4（内部） | 快 | key 20min 刷新；逆向端点 |
| **bing** (免费) | 逆向 Bearer token | ✅ POST 数组 | 3 | 快 | token 8min 刷新；逆向端点 |

**共享逻辑**（prompt 构造、批量协议、智能对齐）在 provider.js 顶部统一定义，各引擎复用。

### 5.3 扩展新引擎（指南）

以添加 "Claude 原生 API" 为例：

1. **在 `provider.js` 新增 `ClaudeProvider` 对象**，实现三方法：
   ```js
   const ClaudeProvider = {
     async checkAvailability(cfg) { /* 探测 */ },
     async translateTexts(texts, cfg, signal) {
       // 复用 buildBatchPrompt / parseJsonArray / alignAndFill
       const raw = await this._call(buildBatchPrompt(texts), cfg, signal);
       let arr = parseJsonArray(raw);
       if (arr.length === texts.length) return arr;
       return alignAndFill(arr, texts, async t => cleanSingle(await this._call(buildSinglePrompt(t), cfg, signal)));
     },
     destroy() {}
   };
   ```
2. **在分发器加分支**（`provider.js:619-622` checkAvailability、`provider.js:654-664` translateTexts 各一处 `else if`）。
3. **在 `utils.js` 的 `validateProvider` 加类型**（`if (p.type === 'claude') return null;`）。
4. **在 `config.js` / `utils.js` 的 `sanitizeConfig` 决定是否作为内置保底**（通常不加，让用户自配）。
5. **（可选）在 `options.js` 的 `render` 加端点展示分支**。

**不需要改**：content.js（不感知引擎）、cache.js（key 已含 providerId 自动隔离）、popup.js（从 config.providers 动态渲染下拉）。

---

## 6. 消息协议

content.js 与 popup/background 之间的通信契约：

| 方向 | action | 载荷 | 响应 |
|---|---|---|---|
| popup → content | `start_translation` | `{mode, targetLang, sourceLang}` | `{status:'done', stats}` 或 `{status:'error', error}` |
| popup → content | `stop_translation` | — | `{status:'stopped'}` |
| popup → content | `check_status` | — | `{available, provider}` |
| popup → content | `get_state` | — | `{active, mode, targetLang, sourceLang, providerId, providerName}` |
| popup → content | `set_mode` | `{mode}` | `{status:'ok', mode}` |
| popup → content | `set_target_lang` | `{targetLang}` | `{status:'ok', targetLang}` |
| popup → content | `set_source_lang` | `{sourceLang}` | `{status:'ok', sourceLang}` |
| background → content | `translate_selection` | `{text}` | `{status:'received'}`（立即响应，翻译异步） |
| content → popup | `notify` | `{type:'error'\|'warn', message}` | 无（单向上报，2s 去重） |

**异步消息约定**：handler 返回 `true` 表示稍后异步调 `sendResponse`；返回 `undefined`/`false` 表示同步响应。

---

## 7. 关键常量速查

| 常量 | 值 | 位置 | 含义 |
|---|---|---|---|
| `BATCH_SIZE` | 15 | content.js:30 | 每批文本节点数 |
| `DEBOUNCE_MS` | 500 | content.js:31 | observer 防抖 |
| debounce maxTimer | 2000 | content.js:253 | 高频滚动兜底强制执行 |
| `CONCURRENCY` | 3（云端）/ 1（离线） | content.js:32,436 | 批次并发数 |
| `MAX_FAIL_RETRIES` | 2 | content.js:27 | 单节点失败重试上限 |
| `MAX_ENTRIES` | 2000 | cache.js:24 | 缓存条目上限 |
| `EVICT_BATCH` | 200 | cache.js:26 | LRU 一次淘汰数 |
| `TTL_MS` | 7 天 | cache.js:27 | 缓存过期 |
| `WRITE_DEBOUNCE_MS` | 1000 | cache.js:25 | 缓存写回防抖 |
| `OFFLINE_MAX_BATCHES` | 3 | provider.js:208 | 离线 session 重建周期 |
| `AVAIL_CACHE_MS` | 5000 | provider.js:600 | 可用性探测结果缓存 |
| Google key FRESHNESS | 20 分钟 | provider.js:404 | |
| Bing token FRESHNESS | 8 分钟 | provider.js:504 | |

---

## 8. 测试体系

```
test/
├── setup.js            测试环境引导（零依赖 mock：chrome.storage / fetch / LanguageModel）
├── utils.test.js       49 用例  纯函数（shouldTranslate/normalizeBaseURL/错误分类/哈希/配置校验）
├── cache.test.js       18 用例  集成（lookup/put/TTL/LRU/clear）
└── provider.test.js    49 用例  纯函数(_test导出) + 集成（OpenAI/Offline/缓存联动）

运行：node --test test/utils.test.js test/cache.test.js test/provider.test.js
要求：Node 18+（内置 node:test + node:assert），零安装
```

**覆盖策略**：
- **纯函数**走 UMD 导出直接 `require`，单测最快的反馈环。
- **有状态模块**（provider/cache）通过 `test/setup.js` 注入内存版 `chrome.storage.local`、可编程 `fetch`、mock `LanguageModel`，做集成测试。
- `provider.js` 追加 `_test` 导出 7 个内部纯函数（`buildBatchPrompt`/`alignAndFill` 等），让原本闭包内的逻辑可被直接断言。**运行时零影响**（仅函数引用，不改变调用链）。
- **content.js 未覆盖**（DOM/observer/并发池依赖真实浏览器，jsdom 投入产出比低），是已知测试缺口。

---

## 9. 已知限制与设计取舍

| 项 | 现状 | 原因 / 取舍 |
|---|---|---|
| Google/Bing 逆向端点 | 调用网页版私有 API | 无法过 Chrome Web Store 审核；保留供个人使用 |
| API Key 明文存 storage | `chrome.storage.local` 未加密 | 通病；README 应提示用户 |
| `host_permissions` 固定 4 域 | 即使用离线/OpenAI 也申请 | 上架前应改 `optional_host_permissions` |
| content.js 无自动化测试 | ~45% 代码无覆盖 | jsdom 集成测试成本高，优先补了 provider/cache |
| `getSystemPrompt` 未缓存 | 每次 _call 重建字符串 | 微优化，离线每 session 用一次影响小 |
| 错误分类依赖 message 前缀 | 字符串约定，非类型安全 | 零依赖约束下权衡；靠测试锁定 |
| 错误去重 Map 不清理 | 长停留页面缓慢增长 | 错误类型有限，规模可忽略 |

---

## 10. 扩展点速查

| 想做的事 | 改哪里 |
|---|---|
| 加新翻译引擎 | `provider.js`（见 5.3）+ `utils.js` validateProvider |
| 加目标语言 | `provider.js` LANG_INFO + `popup.html` 两个 select |
| 改批次大小/并发 | `content.js` DEFAULTS |
| 改缓存容量/TTL | `cache.js` 顶部常量 |
| 加新显示模式 | `content.js` applyTranslation + stopTranslation 还原逻辑 |
| 改快捷键默认值 | `content.js:50` + `options.js` DEFAULT_SHORTCUT |
| 上架商店（裁 Google/Bing） | 删两 Provider + 分支 + manifest host_permissions + sanitizeConfig 内置项 |

---

*文档版本：v2.1 · 与代码同步维护。改动架构时请同步更新本文。*
