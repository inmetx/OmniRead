# OmniRead

> 智能网页双语翻译 Chrome 扩展 · 离线优先 · 零依赖 · Manifest V3

四种翻译引擎自由切换，支持整页翻译、双语对照、划词翻译。完全离线可用（Gemini Nano），也支持 OpenAI 兼容的云端引擎以获得更快的速度。

---

## ✨ 特性

- **🔧 四引擎切换** — 离线 Gemini Nano / OpenAI 兼容 / Google 免费 / Bing 免费
- **🌐 整页翻译** — 替换原文 或 双语对照两种显示模式
- **💬 划词翻译** — 选中文本 → 右键 → 浮窗显示译文（Shadow DOM 隔离，复制/定位）
- **⚡ 智能缓存** — LRU + 7 天 TTL，重复内容零消耗，命中即跳过模型调用
- **🔀 并发加速** — 云端引擎 3 路并发，离线串行避免 OOM
- **🛑 请求取消** — 停止翻译立即中断在途请求，省 token
- **🔄 SPA 友好** — 双定时器防抖 + 虚拟滚动节点复用检测，X / Twitter 等动态页面不漏译
- **⌨️ 快捷键** — 默认 `Ctrl+Shift+T`，可在设置页自定义
- **🎯 智能过滤** — 自动跳过钱包地址、代币符号、金额、代码标识符
- **🌍 多语言** — 源语言自动检测或手动指定，目标语言支持 中文 / English / 日本語 / 한국어
- **📦 零依赖** — 原生 JavaScript，无 React / 无打包工具，拷贝即用

---

## 📥 快速开始

### 安装（开发者模式）

1. 下载或克隆本仓库
2. 打开 Chrome，地址栏输入 `chrome://extensions`
3. 右上角打开「开发者模式」开关
4. 点击「加载已解压的扩展程序」，选择仓库根目录
5. 工具栏出现 OmniRead 图标即安装成功

### 默认即可用

安装后默认使用**离线 Gemini Nano**，无需任何配置。

> 若离线引擎不可用，需在 `chrome://flags` 启用 `prompt-api-for-gemini-nano`，并在 `chrome://components` 下载模型。详见 [dist/README.md](./dist/README.md)。

### 配置云端引擎（可选，更快更准）

点击扩展图标 → 右上角 ⚙ → 「+ 添加 OpenAI 兼容引擎」：

| 服务 | baseURL | model 示例 |
|------|---------|-----------|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` |
| 本地 Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` |

> baseURL 末尾的 `/v1` 可写可不写，插件会自动补全。
> 本地 Ollama 需先 `ollama serve`，并设置 `OLLAMA_ORIGINS=*` 允许跨域。

---

## 🔧 引擎对比

| 引擎 | 认证 | 网络 | 批量 | 速度 | 备注 |
|------|------|------|------|------|------|
| 离线 Gemini Nano | 无 | ❌ 离线 | ✅ | 慢 | 默认，隐私优先，session 每 3 批重建 |
| OpenAI 兼容 | API Key | ✅ | ✅ | 中-快 | 覆盖 DeepSeek/Ollama/硅基流动等 |
| Google 免费 | 自动 | ✅ | ❌ 串行 | 快 | 调用网页版接口 |
| Bing 免费 | 自动 | ✅ | ✅ | 快 | Edge 浏览器同款端点 |

---

## 🚀 使用

| 操作 | 方式 |
|------|------|
| 整页翻译 | 点击工具栏图标 → 选语言 → 「翻译」，或按 `Ctrl+Shift+T` |
| 划词翻译 | 选中文本 → 右键 → 「翻译选中内容」 |
| 切换显示模式 | 工具栏图标右上角「Aa」按钮（替换 ↔ 双语） |
| 切换引擎 | 工具栏图标 → 「引擎」下拉（自动停止+重译） |
| 停止/还原 | 翻译中点「显示原文」按钮 |

---

## 📁 项目结构

```
OmniRead/
├── manifest.json          扩展清单（MV3）
├── background.js          右键菜单 service worker（无状态）
├── content.js             DOM 遍历 + 并发池 + observer + 划词浮窗
├── provider.js            四引擎抽象层（核心）
├── cache.js               LRU + TTL 缓存
├── config.js              引擎配置存取
├── utils.js               纯函数工具集（可单测）
├── popup.html / .js       工具栏弹窗
├── options.html / .js     设置页
├── icons/                 图标
├── test/                  单元/集成测试（116 用例）
├── dist/                  发布包副本（含用户向 README）
└── ARCHITECTURE.md        架构文档（面向维护者）
```

---

## 🧪 测试

零依赖，仅需 Node 18+（内置 `node:test`）：

```bash
node --test test/utils.test.js test/cache.test.js test/provider.test.js
```

覆盖 116 个用例：纯函数（utils）+ 缓存（cache）+ 引擎调度与缓存联动（provider）。

---

## 📖 架构文档

想了解**为什么这样设计**（Provider 抽象、取消链路、并发池、SPA 三道防线、LRU 缓存等），阅读 **[ARCHITECTURE.md](./ARCHITECTURE.md)**。

面向最终用户的安装使用说明见 **[dist/README.md](./dist/README.md)**。

---

## ⚠️ 注意事项

- **Google / Bing 免费引擎**调用的是网页版逆向接口，稳定性取决于服务端策略，偶尔可能限流或失效。
- **API Key** 存储在 `chrome.storage.local`（未加密），请注意保管。
- **离线 Gemini Nano** 在未经中文充分训练的版本上，中文输出质量可能不稳定。
- 本项目为**个人自用 / 私下分享**，未做商店上架适配（`host_permissions` 较宽，含逆向端点）。

---

## 📜 许可

个人自用 / 私下分享。未附加开源 License，默认 All Rights Reserved。
