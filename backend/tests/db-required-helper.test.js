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

function runProbe(env, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbwrap-'));
  const file = path.join(dir, 'probe.test.js');
  const marker = path.join(dir, 'hooks-ran.txt');
  const src = body
    ? body(marker)
    : `
const test = require(${JSON.stringify(HELPER)});
test('probe', async () => { throw new Error('PROBE_BODY_RAN'); });
`;
  fs.writeFileSync(file, src);
  // 注意：必须清掉 NODE_TEST_CONTEXT —— 在测试运行器内部再启动 `node --test` 子进程时，
  // 该变量会让子进程以「测试工作进程」身份运行，输出不会回到我们这里（表现为空输出）。
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER;
  const res = spawnSync(process.execPath, ['--test', file], { env: childEnv, encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const hooksRan = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
  fs.rmSync(dir, { recursive: true, force: true });
  const num = (key) => {
    const m = out.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return { out, pass: num('pass'), fail: num('fail'), skipped: num('skipped'), hooksRan };
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

// ---------- 钩子保护：缺表环境不得执行 before/after/beforeEach/afterEach ----------

const HOOK_PROBE = (marker) => `
const fs = require('node:fs');
const test = require(${JSON.stringify(HELPER)});
const mark = (name) => fs.appendFileSync(${JSON.stringify('__MARKER__')}, name + ';');
test.before(async () => { mark('before'); });
test.beforeEach(async () => { mark('beforeEach'); });
test.afterEach(async () => { mark('afterEach'); });
test.after(async () => { mark('after'); });
test('probe', async () => { mark('body'); });
`.replace('__MARKER__', marker);

test('缺表环境：四种钩子都不得执行（before / beforeEach / afterEach / after）', () => {
  const r = runProbe({ TEST_REQUIRED_TABLES: '__not_a_real_table__' }, HOOK_PROBE);
  assert.equal(r.fail, 0, `缺表时不应有失败（含清理钩子）：\n${r.out}`);
  assert.equal(r.skipped, 1);
  assert.equal(r.hooksRan, null, `缺表时钩子不应执行，实际执行了：${r.hooksRan}`);
});

test('表齐全环境：钩子必须真的执行（证明保护不是「一刀切不执行」）', () => {
  const r = runProbe({}, HOOK_PROBE);
  if (r.skipped === 1) return; // 本环境缺表：此时跳过正确
  assert.match(String(r.hooksRan || ''), /before;/, 'before 钩子应执行');
  assert.match(String(r.hooksRan || ''), /after;/, 'after 钩子应执行');
  assert.match(String(r.hooksRan || ''), /body;/, '用例体应执行');
});

test('文件级保护：钩子内显式检查 isDbReady() 后，缺表也不会失败', () => {
  const body = (marker) => `
const test = require(${JSON.stringify(HELPER)});
test.after(async () => {
  // 这是三个数据库测试文件采用的写法：钩子内显式检查，不依赖外层保护
  if (typeof test.isDbReady === 'function' && !(await test.isDbReady())) return;
  const { dbQuery } = require(${JSON.stringify(path.join(__dirname, 'helpers', 'db-retry.js'))});
  await dbQuery('DELETE FROM zz_table_that_does_not_exist');
});
test('probe', async () => {});
`;
  const r = runProbe({ TEST_REQUIRED_TABLES: '__not_a_real_table__' }, body);
  assert.equal(r.fail, 0, `文件级保护应避免清理钩子失败：\n${r.out}`);
  assert.equal(r.skipped, 1);
});

test('对照组：没有保护时，缺表环境的清理钩子确实会失败（证明本类问题可被检出）', () => {
  // 直接使用 node:test（绕过包装器保护），钩子访问不存在的表 → 必须失败
  const body = () => `
const test = require('node:test');
const { dbQuery } = require(${JSON.stringify(path.join(__dirname, 'helpers', 'db-retry.js'))});
test.after(async () => { await dbQuery('DELETE FROM zz_table_that_does_not_exist'); });
test('probe', async () => {});
`;
  const r = runProbe({}, body);
  assert.equal(r.fail, 1, `对照组应当失败（否则说明本测试无法检出该问题）：\n${r.out}`);
  assert.match(r.out, /zz_table_that_does_not_exist|does not exist/);
});
