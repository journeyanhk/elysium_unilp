/**
 * 数据库测试包装器自身的回归测试（M3.3 review 第五轮）。
 *
 * 背景：上一版的包装器把 `undefined` 当成测试选项传给 node 的测试运行器，
 * 结果**用例回调根本没被执行**：用例被当成空用例「静默通过」，
 * 缺表时既没有跳过、也没有失败 —— 跳过机制形同虚设（review 环境实测 0 skipped / 22 fail）。
 *
 * 因此这里用子进程实测包装器的行为，防止再次退化：
 *   - 缺表环境：用例必须被「跳过」（skipped=1），而不是静默通过；
 *   - 表齐全环境：用例体必须**真的执行**（用例体内故意抛错 → fail=1）。
 *     若包装器再次失效（用例体不执行），会得到 pass=1/fail=0/skipped=0，本测试即失败。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPER = path.join(__dirname, 'helpers', 'db-required.js');

function runProbe(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbwrap-'));
  const file = path.join(dir, 'probe.test.js');
  fs.writeFileSync(file, `
const test = require(${JSON.stringify(HELPER)});
test('probe', async () => { throw new Error('PROBE_BODY_RAN'); });
`);
  // 注意：必须清掉 NODE_TEST_CONTEXT —— 在测试运行器内部再启动 `node --test` 子进程时，
  // 该变量会让子进程以「测试工作进程」身份运行，输出不会回到我们这里（表现为空输出）。
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER;
  const res = spawnSync(process.execPath, ['--test', file], { env: childEnv, encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  fs.rmSync(dir, { recursive: true, force: true });
  const num = (key) => {
    const m = out.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return { out, pass: num('pass'), fail: num('fail'), skipped: num('skipped') };
}

test('缺表环境：包装器必须跳过用例（而不是静默通过或失败）', () => {
  const r = runProbe({ TEST_REQUIRED_TABLES: '__not_a_real_table__' });
  assert.equal(r.fail, 0, `缺表时不应有失败：\n${r.out}`);
  assert.equal(r.skipped, 1, `缺表时应跳过用例：\n${r.out}`);
  assert.match(r.out, /数据库未就绪/);
  assert.match(r.out, /__not_a_real_table__/, '跳过原因必须列出缺失的表名');
  assert.match(r.out, /ensure-m3-tables|自动同步建表/, '跳过原因必须给出修复办法');
});

test('表齐全环境：包装器必须真正执行用例体（防止包装器再次失效）', () => {
  const r = runProbe({});
  if (r.skipped === 1) {
    // 本环境本身缺表：此时跳过是正确行为，但必须给出原因
    assert.match(r.out, /数据库未就绪/);
    return;
  }
  assert.equal(r.fail, 1, `用例体抛错必须体现为 fail=1（若为 pass=1/fail=0 说明包装器没有执行用例体）：\n${r.out}`);
  assert.match(r.out, /PROBE_BODY_RAN/);
});

test('包装器导出的入口与钩子可用（before/after 已接管）', () => {
  const helper = require('./helpers/db-required');
  for (const key of ['before', 'after', 'beforeEach', 'afterEach', 'describe', 'it', 'skip']) {
    assert.equal(typeof helper[key], 'function', `缺少入口：${key}`);
  }
  assert.equal(typeof helper.dbStatus, 'function');
});
