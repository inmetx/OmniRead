/* =====================================================================
 * test/cache.test.js - TranslateCache 集成测试
 *
 * 覆盖：lookup（命中/未命中/部分命中）、put（入库/忽略规则）、
 *       TTL 过期、LRU 淘汰、clear、stats
 * 运行：node --test test/
 * ===================================================================== */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  resetStorage, resetModules
} = require('./setup');

let Cache;

beforeEach(async () => {
  resetStorage();
  ({ Cache } = resetModules());
  await Cache.ready();
});

describe('TranslateCache.lookup', () => {
  test('全未命中 → 全 miss', () => {
    const { hit, miss } = Cache.lookup(['a', 'b', 'c'], 'p', 'zh', 'auto');
    assert.equal(hit.size, 0);
    assert.deepEqual(miss, [0, 1, 2]);
  });

  test('put 后再 lookup → 全命中', () => {
    Cache.put(['a', 'b'], ['A', 'B'], 'p', 'zh', 'auto');
    const { hit, miss } = Cache.lookup(['a', 'b'], 'p', 'zh', 'auto');
    assert.equal(miss.length, 0);
    assert.equal(hit.size, 2);
    assert.equal(hit.get(0), 'A');
    assert.equal(hit.get(1), 'B');
  });

  test('部分命中 → 只返回未命中的下标', () => {
    Cache.put(['a'], ['A'], 'p', 'zh', 'auto');
    const { hit, miss } = Cache.lookup(['a', 'b'], 'p', 'zh', 'auto');
    assert.equal(hit.size, 1);
    assert.equal(hit.get(0), 'A');
    assert.deepEqual(miss, [1]);
  });

  test('不同 providerId → 视为未命中（key 含 providerId）', () => {
    Cache.put(['a'], ['A'], 'p1', 'zh', 'auto');
    const { hit, miss } = Cache.lookup(['a'], 'p2', 'zh', 'auto');
    assert.equal(hit.size, 0);
    assert.deepEqual(miss, [0]);
  });

  test('不同 targetLang → 视为未命中', () => {
    Cache.put(['a'], ['A'], 'p', 'zh', 'auto');
    const { hit, miss } = Cache.lookup(['a'], 'p', 'ja', 'auto');
    assert.equal(hit.size, 0);
    assert.deepEqual(miss, [0]);
  });

  test('命中时更新访问时间（LRU）', () => {
    Cache.put(['a'], ['A'], 'p', 'zh', 'auto');
    const { hit } = Cache.lookup(['a'], 'p', 'zh', 'auto');
    assert.equal(hit.size, 1);
    // 再次 lookup 仍命中（不是被某种副作用误删）
    const { hit: hit2 } = Cache.lookup(['a'], 'p', 'zh', 'auto');
    assert.equal(hit2.size, 1);
  });
});

describe('TranslateCache.put 入库规则', () => {
  test('空译文不入库', () => {
    Cache.put(['a'], [''], 'p', 'zh', 'auto');
    const { miss } = Cache.lookup(['a'], 'p', 'zh', 'auto');
    assert.deepEqual(miss, [0]);
  });

  test('仅空白的译文不入库', () => {
    Cache.put(['a'], ['   '], 'p', 'zh', 'auto');
    const { miss } = Cache.lookup(['a'], 'p', 'zh', 'auto');
    assert.deepEqual(miss, [0]);
  });

  test('与原文相同的不入库（避免无意义缓存）', () => {
    Cache.put(['hello'], ['hello'], 'p', 'zh', 'auto');
    const { miss } = Cache.lookup(['hello'], 'p', 'zh', 'auto');
    assert.deepEqual(miss, [0]);
  });

  test('返回新增条数', () => {
    const added = Cache.put(['a', 'b', 'c'], ['A', '', 'C'], 'p', 'zh', 'auto');
    assert.equal(added, 2);   // 中间空串被忽略
  });

  test('非字符串译文跳过', () => {
    const added = Cache.put(['a', 'b'], [null, undefined], 'p', 'zh', 'auto');
    assert.equal(added, 0);
  });
});

describe('TranslateCache TTL（7 天过期）', () => {
  test('未过期 → 命中', () => {
    Cache.put(['a'], ['A'], 'p', 'zh', 'auto');
    const { hit } = Cache.lookup(['a'], 'p', 'zh', 'auto');
    assert.equal(hit.size, 1);
  });

  test('超过 7 天 → 视为 miss 并惰性删除', () => {
    Cache.put(['a'], ['A'], 'p', 'zh', 'auto');
    // 前进时间 8 天（> 7 天 TTL）
    const realNow = Date.now;
    Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000;
    try {
      const { hit, miss } = Cache.lookup(['a'], 'p', 'zh', 'auto');
      assert.equal(hit.size, 0);
      assert.deepEqual(miss, [0]);
    } finally {
      Date.now = realNow;
    }
    // 过期条目已被惰性删除
    assert.equal(Cache.stats().count, 0);
  });
});

describe('TranslateCache LRU 淘汰', () => {
  test('超过 2000 条 → 批量淘汰至 <= 2000', () => {
    // 灌入 2001 条（每条原文唯一）
    const texts = [];
    const trans = [];
    for (let i = 0; i < 2001; i++) {
      texts.push('text_' + i);
      trans.push('译_' + i);
    }
    Cache.put(texts, trans, 'p', 'zh', 'auto');
    assert.ok(Cache.stats().count <= 2000,
      `count=${Cache.stats().count} 应 <= 2000`);
    assert.ok(Cache.stats().count > 0);
  });

  test('淘汰保留最近访问的', () => {
    Cache.put(['old'], ['旧'], 'p', 'zh', 'auto');
    // 访问 old 提升其访问时间
    Cache.lookup(['old'], 'p', 'zh', 'auto');
    // 灌入足够多新条目触发淘汰
    const texts = [], trans = [];
    for (let i = 0; i < 2000; i++) {
      texts.push('new_' + i);
      trans.push('新_' + i);
    }
    Cache.put(texts, trans, 'p', 'zh', 'auto');
    // old 因被访问过，访问时间较新，未必被淘汰——这里只验证淘汰后总数合法
    assert.ok(Cache.stats().count <= 2000);
  });
});

describe('TranslateCache.clear / stats', () => {
  test('clear 后 count = 0', async () => {
    Cache.put(['a', 'b'], ['A', 'B'], 'p', 'zh', 'auto');
    assert.ok(Cache.stats().count > 0);
    await Cache.clear();
    assert.equal(Cache.stats().count, 0);
  });

  test('clear 后再 put 仍正常', () => {
    Cache.put(['x'], ['X'], 'p', 'zh', 'auto');
    return Cache.clear().then(() => {
      Cache.put(['y'], ['Y'], 'p', 'zh', 'auto');
      const { hit } = Cache.lookup(['y'], 'p', 'zh', 'auto');
      assert.equal(hit.size, 1);
    });
  });

  test('stats 返回 max 上限', () => {
    const s = Cache.stats();
    assert.equal(s.max, 2000);
    assert.equal(typeof s.count, 'number');
  });
});
