/* =====================================================================
 * test/provider.test.js - TranslateProvider 集成测试 + 内部纯函数单测
 *
 * 覆盖：
 *   1. _test 导出的纯函数：parseJsonArray / stripCodeFence / cleanSingle /
 *      buildBatchPrompt / buildSinglePrompt / alignAndFill / buildSystemPrompt
 *   2. OpenAIProvider：成功 / 批量解析失败降级 / HTTP 401 致命 / 429 重试 / abort
 *   3. OfflineProvider：mock LanguageModel 跑通批量+单条
 *   4. TranslateProvider.translateTexts：缓存联动（全命中短路 / 部分命中 / 合并顺序）
 * 运行：node --test test/
 * ===================================================================== */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  resetStorage, resetModules,
  mockFetch, restoreFetch, getFetchCount,
  mockLanguageModel, clearLanguageModel
} = require('./setup');

let Provider, Utils;

beforeEach(() => {
  resetStorage();
  restoreFetch();
  clearLanguageModel();
  ({ Provider, Utils } = resetModules());
  Provider.setTargetLang('zh');
  Provider.setSourceLang('auto');
});

/* ===================== 纯函数：parseJsonArray ===================== */
describe('_test.parseJsonArray', () => {
  test('普通 JSON 数组', () => {
    assert.deepEqual(Provider._test.parseJsonArray('["a","b","c"]'), ['a', 'b', 'c']);
  });
  test('```json 代码栅栏包裹', () => {
    assert.deepEqual(Provider._test.parseJsonArray('```json\n["a","b"]\n```'), ['a', 'b']);
  });
  test('``` 无 lang 栅栏', () => {
    assert.deepEqual(Provider._test.parseJsonArray('```\n["x"]\n```'), ['x']);
  });
  test('对象转数组（键值→值数组）', () => {
    assert.deepEqual(Provider._test.parseJsonArray('{"0":"a","1":"b"}'), ['a', 'b']);
  });
  test('元素两侧空白被 trim', () => {
    assert.deepEqual(Provider._test.parseJsonArray('["  a  ","b"]'), ['a', 'b']);
  });
  test('null/数字元素转字符串', () => {
    assert.deepEqual(Provider._test.parseJsonArray('[1, null, "x"]'), ['1', '', 'x']);
  });
  test('非法 JSON 抛错', () => {
    assert.throws(() => Provider._test.parseJsonArray('not json at all'));
  });
  test('空字符串抛错', () => {
    assert.throws(() => Provider._test.parseJsonArray(''));
  });
});

/* ===================== 纯函数：stripCodeFence ===================== */
describe('_test.stripCodeFence', () => {
  test('```json ... ```', () => {
    assert.equal(Provider._test.stripCodeFence('```json\n["a"]\n```'), '["a"]');
  });
  test('``` ... ```', () => {
    assert.equal(Provider._test.stripCodeFence('```\ntext\n```'), 'text');
  });
  test('无栅栏原样返回（trim）', () => {
    assert.equal(Provider._test.stripCodeFence('  hello  '), 'hello');
  });
  test('仅首部栅栏', () => {
    assert.equal(Provider._test.stripCodeFence('```json\nx'), 'x');
  });
});

/* ===================== 纯函数：cleanSingle ===================== */
describe('_test.cleanSingle', () => {
  test('去双引号包裹', () => {
    assert.equal(Provider._test.cleanSingle('"你好"'), '你好');
  });
  test('去单引号包裹', () => {
    assert.equal(Provider._test.cleanSingle("'hello'"), 'hello');
  });
  test('去全角引号 「」', () => {
    assert.equal(Provider._test.cleanSingle('「你好」'), '你好');
  });
  test('无引号原样返回', () => {
    assert.equal(Provider._test.cleanSingle('plain text'), 'plain text');
  });
  test('去代码栅栏', () => {
    assert.equal(Provider._test.cleanSingle('```\n译文\n```'), '译文');
  });
});

/* ===================== 纯函数：buildBatchPrompt / buildSinglePrompt ===================== */
describe('_test.buildBatchPrompt', () => {
  test('包含目标语言名（中文）', () => {
    Provider.setTargetLang('zh');
    const p = Provider._test.buildBatchPrompt(['Hello', 'World']);
    assert.match(p, /简体中文/);
  });
  test('包含目标语言名（英文）', () => {
    Provider.setTargetLang('en');
    const p = Provider._test.buildBatchPrompt(['你好']);
    assert.match(p, /英文/);
  });
  test('包含输入行数与编号', () => {
    const p = Provider._test.buildBatchPrompt(['a', 'b', 'c']);
    assert.match(p, /3/);            // 数组长度
    assert.match(p, /1\. a/);
    assert.match(p, /2\. b/);
    assert.match(p, /3\. c/);
  });
  test('要求输出 JSON 数组', () => {
    assert.match(Provider._test.buildBatchPrompt(['x']), /JSON/);
  });
});

describe('_test.buildSinglePrompt', () => {
  test('包含目标语言名', () => {
    Provider.setTargetLang('ja');
    assert.match(Provider._test.buildSinglePrompt('hello'), /日文/);
  });
  test('包含待译文本', () => {
    assert.match(Provider._test.buildSinglePrompt('my text'), /my text/);
  });
});

/* ===================== 纯函数：buildSystemPrompt ===================== */
describe('_test.buildSystemPrompt', () => {
  test('中文目标含术语对照表', () => {
    const p = Provider._test.buildSystemPrompt('zh', 'auto');
    assert.match(p, /术语对照表/);
    assert.match(p, /智能合约/);     // DeFi 术语
    assert.match(p, /登录/);         // Web UI 术语
  });
  test('非中文目标不含术语表', () => {
    const p = Provider._test.buildSystemPrompt('en', 'auto');
    assert.doesNotMatch(p, /术语对照表/);
  });
  test('指定源语言', () => {
    const p = Provider._test.buildSystemPrompt('zh', 'en');
    assert.match(p, /源语言为英文/);
  });
});

/* ===================== 纯函数：alignAndFill ===================== */
describe('_test.alignAndFill', () => {
  test('完美对齐 → 直接返回', async () => {
    const out = await Provider._test.alignAndFill(['A', 'B'], ['a', 'b'], async () => 'SHOULD_NOT_CALL');
    assert.deepEqual(out, ['A', 'B']);
  });
  test('差异过大（< n/2）→ 全量逐条降级', async () => {
    const out = await Provider._test.alignAndFill(['A'], ['a', 'b', 'c'], async (t) => t.toUpperCase());
    assert.deepEqual(out, ['A', 'B', 'C']);   // 采纳唯一一条 + 补译 b,c
  });
  test('差异过大且 null arr → 全量降级', async () => {
    const out = await Provider._test.alignAndFill(null, ['a', 'b'], async (t) => t + '!');
    assert.deepEqual(out, ['a!', 'b!']);
  });
  test('轻微偏差 → 采纳前段、末段补译', async () => {
    // n=3, arr.length=2 (>= n/2=1.5)：trusted = min(2,3)-1 = 1，采纳第1条，补译第2、3条
    const out = await Provider._test.alignAndFill(['X', 'Y'], ['a', 'b', 'c'], async (t) => t.toUpperCase());
    assert.equal(out[0], 'X');         // 采纳
    assert.equal(out[1], 'B');         // 补译
    assert.equal(out[2], 'C');         // 补译
  });
  test('致命错误（401）→ 立即上抛', async () => {
    await assert.rejects(
      Provider._test.alignAndFill(['A'], ['a', 'b'], async () => { throw new Error('HTTP 401: unauthorized'); }),
      /HTTP 401/
    );
  });
  test('TRANSLATION_ABORTED → 立即上抛', async () => {
    await assert.rejects(
      Provider._test.alignAndFill(null, ['a', 'b'], async () => { throw new Error('TRANSLATION_ABORTED'); }),
      /TRANSLATION_ABORTED/
    );
  });
  test('单条非致命错误 → 吞成空串', async () => {
    const out = await Provider._test.alignAndFill(null, ['a', 'b'], async (t) => {
      if (t === 'a') throw new Error('some recoverable error');
      return t.toUpperCase();
    });
    assert.equal(out[0], '');          // 吞成空串
    assert.equal(out[1], 'B');
  });
});

/* ===================== 集成：OpenAIProvider ===================== */
describe('OpenAIProvider.translateTexts（集成）', () => {
  const cfg = { id: 't', type: 'openai', baseURL: 'https://api.test.com/v1', model: 'm', apiKey: 'sk-x' };

  test('批量成功返回', async () => {
    mockFetch(async () => ({
      status: 200,
      json: { choices: [{ message: { content: '["你好","世界"]' } }] }
    }));
    const r = await Provider.translateTexts(['Hello', 'World'], cfg);
    assert.deepEqual(r, ['你好', '世界']);
    assert.equal(getFetchCount(), 1);
  });

  test('携带 Authorization 头', async () => {
    mockFetch(async (url, opts) => {
      assert.equal(opts.headers['Authorization'], 'Bearer sk-x');
      return { status: 200, json: { choices: [{ message: { content: '["x"]' } }] } };
    });
    await Provider.translateTexts(['a'], cfg);
  });

  test('批量解析失败 → 降级单条', async () => {
    let n = 0;
    mockFetch(async () => {
      n++;
      if (n === 1) return { status: 200, json: { choices: [{ message: { content: 'NOT VALID JSON' } }] } };
      return { status: 200, json: { choices: [{ message: { content: '译文' + n } }] } };
    });
    const r = await Provider.translateTexts(['a', 'b'], cfg);
    assert.equal(r.length, 2);
    assert.equal(getFetchCount(), 3);   // 1 批量 + 2 单条
  });

  test('HTTP 401 → 抛致命错', async () => {
    mockFetch(async () => ({ status: 401, text: async () => 'unauthorized' }));
    await assert.rejects(
      Provider.translateTexts(['a'], cfg),
      (err) => {
        assert.match(err.message, /HTTP 401/);
        assert.equal(Utils.isFatalHttpError(err), true);
        return true;
      }
    );
  });

  test('HTTP 429 → 重试一次', async () => {
    let n = 0;
    mockFetch(async () => {
      n++;
      if (n === 1) return { status: 429 };
      return { status: 200, json: { choices: [{ message: { content: '["译文"]' } }] } };
    });
    const r = await Provider.translateTexts(['a'], cfg);
    assert.deepEqual(r, ['译文']);
    assert.equal(getFetchCount(), 2);   // 首次 429 + 重试成功
  });

  test('AbortError → TRANSLATION_ABORTED', async () => {
    mockFetch(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    const ac = new AbortController();
    await assert.rejects(
      Provider.translateTexts(['a'], cfg, ac.signal),
      /TRANSLATION_ABORTED/
    );
  });
});

/* ===================== 集成：OfflineProvider ===================== */
describe('OfflineProvider.translateTexts（集成 mock LanguageModel）', () => {
  test('批量成功', async () => {
    mockLanguageModel('available', ['["你好","世界"]']);
    const r = await Provider.translateTexts(['Hello', 'World'], { id: 'offline-default', type: 'offline' });
    assert.deepEqual(r, ['你好', '世界']);
  });

  test('checkAvailability：available → true', async () => {
    mockLanguageModel('available');
    const ok = await Provider.checkAvailability({ id: 'offline-default', type: 'offline' });
    assert.equal(ok, true);
  });

  test('checkAvailability：无 LanguageModel → false', async () => {
    clearLanguageModel();
    const ok = await Provider.checkAvailability({ id: 'offline-default', type: 'offline' });
    assert.equal(ok, false);
  });

  test('checkAvailability：不可用 → false', async () => {
    mockLanguageModel('downloadable');   // 非 'available'
    const ok = await Provider.checkAvailability({ id: 'offline-default', type: 'offline' });
    assert.equal(ok, false);
  });
});

/* ===================== 集成：translateTexts + 缓存联动 ===================== */
describe('translateTexts 缓存联动', () => {
  const cfg = { id: 'openai-x', type: 'openai', baseURL: 'https://api.test.com/v1', model: 'm' };

  test('全命中 → 不调 fetch（短路）', async () => {
    // 第一次：填充缓存
    mockFetch(async () => ({ status: 200, json: { choices: [{ message: { content: '["你好"]' } }] } }));
    await Provider.translateTexts(['Hello'], cfg);
    assert.equal(getFetchCount(), 1);

    // 第二次：应全命中缓存，fetch 次数不增加
    await Provider.translateTexts(['Hello'], cfg);
    assert.equal(getFetchCount(), 1);
  });

  test('部分命中 → 只翻译未命中的子集', async () => {
    // 预填 'Hello' 的缓存（首次调 fetch）
    let fetchHits = 0;
    mockFetch(async (url, opts) => {
      fetchHits++;
      const body = JSON.parse(opts.body);
      const userMsg = body.messages.find(m => m.role === 'user').content;
      const m = userMsg.match(/(\d+)\.\s(.+)/);
      const text = m ? m[2] : userMsg;
      return { status: 200, json: { choices: [{ message: { content: JSON.stringify([text + '_译']) } }] } };
    });
    await Provider.translateTexts(['Hello'], cfg);   // 填充 Hello 缓存，fetchHits=1
    const hitsAfterFill = fetchHits;

    // 请求 [Hello, World]：Hello 命中缓存，只 World 走模型
    const r = await Provider.translateTexts(['Hello', 'World'], cfg);
    assert.equal(r.length, 2);
    assert.equal(r[0], 'Hello_译');    // 来自缓存
    assert.equal(r[1], 'World_译');    // 新译
    // 第二次只多调了 1 次 fetch（World 单独成批），证明 Hello 走缓存未调模型
    assert.equal(fetchHits - hitsAfterFill, 1);
  });

  test('合并命中+新译，顺序保持', async () => {
    mockFetch(async (url, opts) => {
      const body = JSON.parse(opts.body);
      const userMsg = body.messages.find(m => m.role === 'user').content;
      // 提取批量里的文本行
      const lines = userMsg.match(/\d+\.\s(.+)/g) || [userMsg];
      const texts = lines.map(l => l.replace(/^\d+\.\s/, ''));
      const arr = texts.map(t => t + '_译');
      return { status: 200, json: { choices: [{ message: { content: JSON.stringify(arr) } }] } };
    });
    // 预填 a
    await Provider.translateTexts(['a'], cfg);
    // 请求 [a, b, c]：a 命中，b/c 新译
    const r = await Provider.translateTexts(['a', 'b', 'c'], cfg);
    assert.equal(r.length, 3);
    assert.equal(r[0], 'a_译');        // 缓存
    assert.equal(r[1], 'b_译');        // 新译
    assert.equal(r[2], 'c_译');        // 新译
  });

  test('空数组 → 直接返回空（不触达 provider）', async () => {
    // translateTexts 在入口即 return []，不调用任何 provider
    const r = await Provider.translateTexts([], cfg);
    assert.deepEqual(r, []);
  });

  test('无 provider → 抛错', async () => {
    await assert.rejects(Provider.translateTexts(['x'], null), /未配置/);
  });
});

/* ===================== 集成：checkAvailability 缓存 ===================== */
describe('checkAvailability 短缓存', () => {
  test('5 秒内同 provider 不重复探测', async () => {
    mockLanguageModel('available');
    const cfg = { id: 'offline-default', type: 'offline' };
    const r1 = await Provider.checkAvailability(cfg);
    const r2 = await Provider.checkAvailability(cfg);
    assert.equal(r1, true);
    assert.equal(r2, true);   // 走缓存，不重复探测
  });
});
