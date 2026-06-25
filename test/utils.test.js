/* =====================================================================
 * 单元测试 - utils.js 纯函数
 *
 * 运行：node --test test/utils.test.js
 * 依赖：Node 18+ 内置 node:test + node:assert，零安装
 *
 * 覆盖：
 *   1. shouldTranslate     - 文本过滤（代码/数据/标识符/自然语言）
 *   2. normalizeBaseURL    - OpenAI baseURL 规范化
 *   3. isRecoverableError  - 错误分类（解析错 vs 网络/鉴权错）
 *   4. isFatalModelError   - 致命错误（401/403/404）
 *   5. makeCacheKey        - 缓存 key 一致性 + 碰撞
 *   6. sanitizeConfig      - 配置校验（去重/补离线/修复 activeId）
 * ===================================================================== */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../utils.js');

/* ===================== 1. shouldTranslate ===================== */
describe('shouldTranslate', () => {
  // 应翻译（自然语言）
  test('正常英文句子 → true', () => {
    assert.equal(U.shouldTranslate('Hello World'), true);
    assert.equal(U.shouldTranslate('The quick brown fox jumps'), true);
    assert.equal(U.shouldTranslate('Connect Wallet'), true);
    assert.equal(U.shouldTranslate('Learn more about this feature'), true);
  });
  test('UI 短语 → true', () => {
    assert.equal(U.shouldTranslate('Sign in'), true);
    assert.equal(U.shouldTranslate('Submit'), true);
    assert.equal(U.shouldTranslate('Swap'), true);
  });

  // 不应翻译 - 代码/数据
  test('钱包地址/0x hash → false', () => {
    assert.equal(U.shouldTranslate('0xdAC17F958D2ee523a2206206994597C13D831ec7'), false);
    assert.equal(U.shouldTranslate('0x1f9840a5'), false);
    assert.equal(U.shouldTranslate('0x1234'), false);
  });
  test('长 hex 串 → false', () => {
    assert.equal(U.shouldTranslate('4a3f2b8c9d1e0f2a3b4c5d6e7f8a9b0c1d2e3f4a'), false);
  });
  test('金额+代币 → false', () => {
    assert.equal(U.shouldTranslate('1.5 ETH'), false);
    assert.equal(U.shouldTranslate('2,340.50 USDC'), false);
    assert.equal(U.shouldTranslate('$1,234.56'), false);
    assert.equal(U.shouldTranslate('100.00'), false);
  });
  test('代币/股票代码 → false', () => {
    assert.equal(U.shouldTranslate('ETH'), false);
    assert.equal(U.shouldTranslate('USDC'), false);
    assert.equal(U.shouldTranslate('WBTC'), false);
    assert.equal(U.shouldTranslate('AAPL'), false);
  });

  // 不应翻译 - 标识符
  test('snake_case → false', () => {
    assert.equal(U.shouldTranslate('max_retries'), false);
    assert.equal(U.shouldTranslate('user_id'), false);
  });
  test('camelCase → false', () => {
    assert.equal(U.shouldTranslate('useState'), false);
    assert.equal(U.shouldTranslate('getElementById'), false);
  });
  test('全大写常量 → false', () => {
    assert.equal(U.shouldTranslate('MAX_BATCHES_PER_SESSION'), false);
    assert.equal(U.shouldTranslate('API_KEY'), false);
  });
  test('URL/邮箱 → false', () => {
    assert.equal(U.shouldTranslate('https://example.com'), false);
    assert.equal(U.shouldTranslate('user@example.com'), false);
  });

  // 不应翻译 - 语言/符号
  test('已含中文 → false', () => {
    assert.equal(U.shouldTranslate('Hello 世界'), false);
    assert.equal(U.shouldTranslate('连接钱包'), false);
  });
  test('纯符号/数字 → false', () => {
    assert.equal(U.shouldTranslate('12345'), false);
    assert.equal(U.shouldTranslate('!@#$%'), false);
    assert.equal(U.shouldTranslate('99.9%'), false);
  });
  test('过短文本 → false', () => {
    assert.equal(U.shouldTranslate('Hi'), false);
    assert.equal(U.shouldTranslate(''), false);
    assert.equal(U.shouldTranslate('A'), false);
  });

  // 空值健壮性
  test('null/undefined → false', () => {
    assert.equal(U.shouldTranslate(null), false);
    assert.equal(U.shouldTranslate(undefined), false);
    assert.equal(U.shouldTranslate(123), false);
  });
});

/* ===================== 2. normalizeBaseURL ===================== */
describe('normalizeBaseURL', () => {
  test('无 /v1 自动补全', () => {
    assert.equal(U.normalizeBaseURL('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
    assert.equal(U.normalizeBaseURL('https://api.openai.com'), 'https://api.openai.com/v1');
  });
  test('已有 /v1 不重复补', () => {
    assert.equal(U.normalizeBaseURL('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1');
    assert.equal(U.normalizeBaseURL('https://api.openai.com/v1'), 'https://api.openai.com/v1');
  });
  test('去尾斜杠', () => {
    assert.equal(U.normalizeBaseURL('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
    assert.equal(U.normalizeBaseURL('https://api.deepseek.com///'), 'https://api.deepseek.com/v1');
  });
  test('支持 /v2 等其它版本号', () => {
    assert.equal(U.normalizeBaseURL('https://api.x.com/v2'), 'https://api.x.com/v2');
  });
  test('本地 Ollama', () => {
    assert.equal(U.normalizeBaseURL('http://localhost:11434'), 'http://localhost:11434/v1');
    assert.equal(U.normalizeBaseURL('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  });
  test('空值健壮', () => {
    assert.equal(U.normalizeBaseURL(''), '/v1');
    assert.equal(U.normalizeBaseURL(null), '/v1');
  });
});

/* ===================== 3. isRecoverableError ===================== */
describe('isRecoverableError', () => {
  test('HTTP 错误 → 不可恢复', () => {
    assert.equal(U.isRecoverableError(new Error('HTTP 401: unauthorized')), false);
    assert.equal(U.isRecoverableError(new Error('HTTP 403: forbidden')), false);
    assert.equal(U.isRecoverableError(new Error('HTTP 404: not found')), false);
    assert.equal(U.isRecoverableError(new Error('HTTP 429: rate limit')), false);
    assert.equal(U.isRecoverableError(new Error('HTTP 500: server error')), false);
  });
  test('网络错误 → 不可恢复', () => {
    assert.equal(U.isRecoverableError(new Error('网络请求失败: timeout')), false);
    assert.equal(U.isRecoverableError(new Error('响应非 JSON: ...')), false);
    assert.equal(U.isRecoverableError(new Error('响应缺少 choices[0].message.content')), false);
  });
  test('JSON 解析错 → 可恢复', () => {
    assert.equal(U.isRecoverableError(new Error('Unexpected token < in JSON')), true);
    assert.equal(U.isRecoverableError(new Error('Unexpected end of JSON input')), true);
  });
  test('空 error 对象 → 可恢复（默认降级）', () => {
    assert.equal(U.isRecoverableError(new Error()), true);
    assert.equal(U.isRecoverableError(null), true);
    assert.equal(U.isRecoverableError({}), true);
  });
});

/* ===================== 4. isFatalModelError ===================== */
describe('isFatalModelError', () => {
  test('401/403/404 → 致命', () => {
    assert.equal(U.isFatalModelError(new Error('HTTP 401: ...')), true);
    assert.equal(U.isFatalModelError(new Error('HTTP 403: ...')), true);
    assert.equal(U.isFatalModelError(new Error('HTTP 404: ...')), true);
  });
  test('429/500/网络错 → 非致命', () => {
    assert.equal(U.isFatalModelError(new Error('HTTP 429: ...')), false);
    assert.equal(U.isFatalModelError(new Error('HTTP 500: ...')), false);
    assert.equal(U.isFatalModelError(new Error('网络请求失败')), false);
    assert.equal(U.isFatalModelError(new Error('JSON parse error')), false);
  });
  test('isFatalHttpError 等价', () => {
    assert.equal(U.isFatalHttpError(new Error('HTTP 403: x')), true);
    assert.equal(U.isFatalHttpError(new Error('HTTP 200: ok')), false);
  });
});

/* ===================== 5. makeCacheKey ===================== */
describe('makeCacheKey', () => {
  test('相同输入 → 相同 key', () => {
    const k1 = U.makeCacheKey('Hello', 'deepseek', 'zh', 'auto');
    const k2 = U.makeCacheKey('Hello', 'deepseek', 'zh', 'auto');
    assert.equal(k1, k2);
  });
  test('不同 provider → 不同 key', () => {
    const k1 = U.makeCacheKey('Hello', 'deepseek', 'zh', 'auto');
    const k2 = U.makeCacheKey('Hello', 'openai', 'zh', 'auto');
    assert.notEqual(k1, k2);
  });
  test('不同 targetLang → 不同 key', () => {
    const k1 = U.makeCacheKey('Hello', 'deepseek', 'zh', 'auto');
    const k2 = U.makeCacheKey('Hello', 'deepseek', 'ja', 'auto');
    assert.notEqual(k1, k2);
  });
  test('不同 sourceLang → 不同 key', () => {
    const k1 = U.makeCacheKey('Hello', 'deepseek', 'zh', 'en');
    const k2 = U.makeCacheKey('Hello', 'deepseek', 'zh', 'auto');
    assert.notEqual(k1, k2);
  });
  test('不同文本 → 不同 key', () => {
    const k1 = U.makeCacheKey('Hello', 'p', 'zh', 'auto');
    const k2 = U.makeCacheKey('World', 'p', 'zh', 'auto');
    assert.notEqual(k1, k2);
  });
  test('targetLang 缺省 → 默认 zh', () => {
    const k1 = U.makeCacheKey('Hello', 'p');
    const k2 = U.makeCacheKey('Hello', 'p', 'zh');
    assert.equal(k1, k2);
  });
  test('sourceLang 缺省 → 默认 auto', () => {
    const k1 = U.makeCacheKey('Hello', 'p', 'zh');
    const k2 = U.makeCacheKey('Hello', 'p', 'zh', 'auto');
    assert.equal(k1, k2);
  });
  test('返回 base36 字符串', () => {
    const k = U.makeCacheKey('test', 'p', 'zh');
    assert.match(k, /^[0-9a-z]+$/);
    assert.ok(k.length > 0);
  });
  test('hashFNV1a 确定性', () => {
    assert.equal(U.hashFNV1a('abc'), U.hashFNV1a('abc'));
    assert.notEqual(U.hashFNV1a('abc'), U.hashFNV1a('abd'));
  });
});

/* ===================== 6. sanitizeConfig ===================== */
describe('sanitizeConfig', () => {
  test('空配置 → 补默认内置 providers', () => {
    const r = U.sanitizeConfig({});
    assert.ok(r.providers.length >= 3);
    const ids = r.providers.map(p => p.id);
    assert.ok(ids.includes(U.OFFLINE_PROVIDER_ID));
    assert.ok(ids.includes('google-free'));
    assert.ok(ids.includes('bing-free'));
    assert.equal(r.activeProviderId, U.OFFLINE_PROVIDER_ID);
  });
  test('null/非对象 → 补默认内置 providers', () => {
    const r = U.sanitizeConfig(null);
    const ids = r.providers.map(p => p.id);
    assert.ok(ids.includes(U.OFFLINE_PROVIDER_ID));
    assert.ok(ids.includes('google-free'));
    assert.ok(ids.includes('bing-free'));
  });
  test('过滤非法 provider（缺字段）', () => {
    const r = U.sanitizeConfig({
      providers: [
        { id: 'offline-default', type: 'offline', name: '离线' },
        { type: 'openai', name: '缺id' },                          // 缺 id
        { id: 'p2', type: 'openai', name: '缺baseURL' },           // 缺 baseURL
        { id: 'p3', type: 'unknown', name: '未知类型' }            // 未知 type
      ],
      activeProviderId: 'offline-default'
    });
    // 3 built-in (offline, google, bing) + 1 valid offline from input
    // but input offline duplicates built-in, so deduped → 3 built-in
    const ids = r.providers.map(p => p.id);
    assert.ok(ids.includes('offline-default'));
    assert.ok(ids.includes('google-free'));
    assert.ok(ids.includes('bing-free'));
    assert.equal(r.providers.length, 3);
  });
  test('去重（相同 id 只留一个）', () => {
    const r = U.sanitizeConfig({
      providers: [
        { id: 'offline-default', type: 'offline', name: '离线1' },
        { id: 'offline-default', type: 'offline', name: '离线2' },
        { id: 'p1', type: 'openai', name: 'GPT', baseURL: 'https://x.com', model: 'gpt-4o' }
      ],
      activeProviderId: 'p1'
    });
    // 3 built-in (offline, google, bing) + 1 valid openai, deduped offline → 4
    assert.equal(r.providers.length, 4);
  });
  test('activeProviderId 指向不存在的 provider → 回退离线', () => {
    const r = U.sanitizeConfig({
      providers: [{ id: 'offline-default', type: 'offline', name: '离线' }],
      activeProviderId: 'deleted-id'
    });
    assert.equal(r.activeProviderId, U.OFFLINE_PROVIDER_ID);
  });
  test('合法 OpenAI provider 保留', () => {
    const r = U.sanitizeConfig({
      providers: [
        { id: 'offline-default', type: 'offline', name: '离线' },
        { id: 'ds', type: 'openai', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-x' }
      ],
      activeProviderId: 'ds'
    });
    // 3 built-in + 1 openai → 4
    assert.equal(r.providers.length, 4);
    assert.equal(r.activeProviderId, 'ds');
  });
});

/* ===================== 7. validateProvider ===================== */
describe('validateProvider', () => {
  test('合法 offline → null', () => {
    assert.equal(U.validateProvider({ id: 'x', type: 'offline', name: 'n' }), null);
  });
  test('合法 google → null', () => {
    assert.equal(U.validateProvider({ id: 'x', type: 'google', name: 'n' }), null);
  });
  test('合法 bing → null', () => {
    assert.equal(U.validateProvider({ id: 'x', type: 'bing', name: 'n' }), null);
  });
  test('合法 openai → null', () => {
    assert.equal(U.validateProvider({ id: 'x', type: 'openai', name: 'n', baseURL: 'https://x.com', model: 'm' }), null);
  });
  test('缺 baseURL → 错误信息', () => {
    assert.match(U.validateProvider({ id: 'x', type: 'openai', name: 'n', model: 'm' }), /baseURL/);
  });
  test('未知类型 → 错误信息', () => {
    assert.match(U.validateProvider({ id: 'x', type: 'foo', name: 'n' }), /未知/);
  });
  test('非对象 → 错误', () => {
    assert.ok(U.validateProvider(null));
    assert.ok(U.validateProvider('str'));
  });
});
