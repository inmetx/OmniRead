# OmniRead · AI 网页双语翻译官 v2.1

智能网页翻译扩展，支持整页翻译、划词翻译、双语对照、多引擎切换。完全离线优先，无需注册即可使用。

## ✨ 功能特性

- **整页翻译**：一键翻译整个网页，支持「替换」和「双语对照」两种显示模式
- **划词翻译**：选中任意文本 → 右键 → 「翻译选中内容」，译文浮窗跟随显示
- **多引擎支持**：
  - 🔒 **离线 Gemini Nano**（默认，完全离线，隐私优先）
  - 🌐 **Google Translate**（免费，无需 API Key）
  - 🌐 **Microsoft Bing**（免费，无需 API Key，支持批量）
  - 🔑 **OpenAI 兼容**（DeepSeek / OpenAI / Ollama / 硅基流动等，需自配 Key）
- **多语言**：源语言自动检测或手动指定，目标语言支持中文 / 英文 / 日文 / 韩文
- **智能缓存**：翻译结果 LRU 缓存 + 7 天 TTL，重复内容零消耗
- **并发加速**：云端引擎自动并发翻译（3 路），支持请求取消（省 token）
- **快捷键**：默认 `Ctrl+Shift+T` 一键翻译，可在设置页自定义
- **智能过滤**：自动跳过钱包地址、代币符号、金额、代码标识符等不该翻译的内容

## 📦 安装（开发者模式）

1. 下载并解压本压缩包
2. 打开 Chrome，地址栏输入 `chrome://extensions`
3. 右上角打开「开发者模式」开关
4. 点击「加载已解压的扩展程序」，选择解压后的文件夹
5. 工具栏出现 OmniRead 图标即安装成功

## ⚙️ 引擎配置

### 默认开箱即用

安装后默认使用**离线 Gemini Nano**，无需任何配置。若要启用云端引擎（更快、更准）：

### 启用离线 Gemini Nano（如未生效）

1. 地址栏输入 `chrome://flags`
2. 搜索 `prompt-api-for-gemini-nano`，设为 **Enabled**
3. 地址栏输入 `chrome://components`，找到「Optimization Guide On Device Model」点击更新（下载模型）
4. 重启 Chrome

### 配置 OpenAI 兼容引擎（可选，追求速度与质量）

1. 点击扩展图标 → 右上角 ⚙ 设置
2. 点击「+ 添加 OpenAI 兼容引擎」
3. 填写：

   | 服务 | baseURL | model 示例 |
   |------|---------|-----------|
   | DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
   | OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
   | 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` |
   | 本地 Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` |

4. 填入 API Key，点击「测试连接」
5. 「设为默认」即可使用

> 💡 baseURL 末尾的 `/v1` 可写可不写，插件会自动补全。
> 💡 本地 Ollama 需先 `ollama serve`，并设置环境变量 `OLLAMA_ORIGINS=*` 允许跨域。

## 🚀 使用方法

### 整页翻译
- 点击工具栏图标 → 选择源语言/目标语言 → 点击「翻译」按钮
- 或按快捷键 `Ctrl+Shift+T`（可自定义）

### 划词翻译
- 在网页选中一段文本 → 右键 → 「翻译选中内容」
- 译文浮窗显示在选区附近，点击外部或按 Esc 关闭
- 浮窗内可一键复制译文

### 显示模式
- 点击工具栏图标右上角「Aa」图标切换：
  - **替换模式**（Aa，灰色）：译文替换原文
  - **双语模式**（Aa文，蓝色）：保留原文，译文以灰色小字显示在下方

### 切换引擎
- 点击工具栏图标 → 「引擎」下拉选择 → 自动保存

### 停止 / 还原
- 翻译中点击「显示原文」按钮，立即停止并还原页面（在途请求会被取消）

## 📁 文件结构

```
OmniRead/
├── manifest.json          扩展清单
├── background.js          右键菜单 service worker
├── content.js             页面 DOM 操作 + 划词浮窗 + 并发池
├── provider.js            翻译引擎抽象（离线/Google/Bing/OpenAI）
├── cache.js               LRU + TTL 缓存
├── config.js              引擎配置存取
├── utils.js               纯函数工具（可单测）
├── popup.html / .js       工具栏弹窗
├── options.html / .js     设置页
└── icons/                 图标
```

## 🔧 技术特点

- **零依赖**：原生 JavaScript，无 React / 无打包工具，拷贝即用
- **分层架构**：config / provider / cache / utils 各司其职，通过 window API 解耦
- **错误分级**：JSON 解析错降级重试、鉴权错立即中止、并发下错误去重
- **Shadow DOM 隔离**：划词浮窗样式不受页面 CSS 污染
- **WeakMap 防泄漏**：翻译节点用弱引用，页面卸载即回收

## 📝 备注

- Google / Bing 免费引擎调用的是网页版接口，稳定性取决于服务端策略，偶尔可能限流。
- 离线 Gemini Nano 在未经中文充分训练的版本上，中文输出质量可能不稳定（Chrome 控制台可能出现 `No output language was specified` 警告，不影响使用）。
- 翻译缓存存储在 `chrome.storage.local`，上限 2000 条 / 7 天过期，可在设置页清除。

## 📜 许可

个人自用 / 私下分享。
