'use strict';
// litdoctor spawn 级冒烟测试：真实起进程，验证**退出码契约**。
// 为什么必须有这一层：node --test 的单测只测导出的函数，根本不碰 process.exitCode。
// 家族历史事故——改退出码时单测全绿，只有 spawn 拦得住。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INDEX = path.join(path.resolve(__dirname, '..'), 'index.js');

function run(args) {
  const r = spawnSync('node', [INDEX, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- 三态门禁：这是本工具唯一的价值，必须在进程级锁死 ----

test('smoke: empty dir + gate configured -> rc 3, never rc 0', () => {
  const d = tmpdir('litdoctor-smoke-empty-');
  const r = run(['--root', d, '--min-score', '90']);
  assert.strictEqual(r.code, 3, `空输入必须是 inconclusive(rc=3)，实际 rc=${r.code}：${r.stdout}`);
  assert.ok(r.stdout.includes('inconclusive'), '文本输出必须说明无法判定');
});

test('smoke: empty dir + --json -> gate.state inconclusive, basisComplete false', () => {
  const d = tmpdir('litdoctor-smoke-emptyj-');
  const r = run(['--root', d, '--json', '--min-score', '90']);
  assert.strictEqual(r.code, 3);
  const j = JSON.parse(r.stdout); // stdout 必须完整未被截断
  assert.strictEqual(j.gate.state, 'inconclusive');
  assert.strictEqual(j.basisComplete, false);
});

test('smoke: no gate thresholds at all -> rc 3 (不能谎报通过)', () => {
  const d = tmpdir('litdoctor-smoke-nogate-');
  fs.writeFileSync(path.join(d, 'a.js'), 'const x = 86400000;\n');
  const r = run(['--root', d]);
  assert.strictEqual(r.code, 3, '未配门禁阈值时不得返回 0');
  assert.ok(r.stdout.includes('未配置'), '应说明未配门禁');
});

test('smoke: gate configured + violation -> rc 2', () => {
  const d = tmpdir('litdoctor-smoke-bad-');
  fs.writeFileSync(path.join(d, 'a.js'), 'const x = 86400000;\n');
  const r = run(['--root', d, '--max-medium', '0']);
  assert.strictEqual(r.code, 2);
});

test('smoke: gate configured + clean input -> rc 0', () => {
  const d = tmpdir('litdoctor-smoke-good-');
  fs.writeFileSync(path.join(d, 'a.js'), 'const TIMEOUT_MS = 10;\n');
  const r = run(['--root', d, '--min-score', '90']);
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('pass'));
});

// ---- 参数容错：门禁参数写错 = 门禁不存在，必须退 2 ----

test('smoke: unknown option -> rc 2', () => {
  assert.strictEqual(run(['--bogus']).code, 2);
});

test('smoke: --root with missing value -> rc 2 (not undefined path crash)', () => {
  const r = run(['--root']);
  assert.strictEqual(r.code, 2);
  assert.ok(!r.stderr.includes('undefined'), `报错信息不该泄漏 undefined：${r.stderr}`);
});

test('smoke: --root must not swallow the following flag -> rc 2', () => {
  const r = run(['--root', '--json']);
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('--root'), r.stderr);
});

test('smoke: numeric flag missing value -> rc 2', () => {
  assert.strictEqual(run(['--max-issues']).code, 2);
});

test('smoke: non-integer numeric flag -> rc 2', () => {
  const d = tmpdir('litdoctor-smoke-frac-');
  fs.writeFileSync(path.join(d, 'a.js'), 'const a = 1;\n');
  assert.strictEqual(run(['--max-issues', '12.5', '--root', d]).code, 2);
});

test('smoke: trailing-garbage numeric flag -> rc 2 (parseInt would silently take 12)', () => {
  const d = tmpdir('litdoctor-smoke-nan-');
  fs.writeFileSync(path.join(d, 'a.js'), 'const a = 1;\n');
  assert.strictEqual(run(['--max-issues', '12abc', '--root', d]).code, 2);
});

test('smoke: empty string numeric value -> rc 2 (Number("")===0 trap)', () => {
  const d = tmpdir('litdoctor-smoke-emptystr-');
  fs.writeFileSync(path.join(d, 'a.js'), 'const a = 1;\n');
  assert.strictEqual(run(['--max-issues', '', '--root', d]).code, 2);
});

test('smoke: negative threshold -> rc 2', () => {
  const d = tmpdir('litdoctor-smoke-neg-');
  fs.writeFileSync(path.join(d, 'a.js'), 'const a = 1;\n');
  assert.strictEqual(run(['--min-score', '-1', '--root', d]).code, 2);
});

test('smoke: nonexistent root -> rc 2', () => {
  assert.strictEqual(run(['--root', path.join(os.tmpdir(), 'definitely-missing-xyz')]).code, 2);
});

// ---- 回归：假绿灯的两条历史路径 ----

test('smoke: distribution.js is scanned (regression: substring skip)', () => {
  const d = tmpdir('litdoctor-smoke-dist-');
  fs.writeFileSync(path.join(d, 'distribution.js'), 'const x = 86400000;\n');
  const r = run(['--root', d, '--json', '--max-medium', '0']);
  assert.strictEqual(r.code, 2, 'distribution.js 被跳过就会 rc=0 假绿灯：' + r.stdout);
  assert.strictEqual(JSON.parse(r.stdout).summary.files, 1);
});

test('smoke: root under an ancestor named tests still scans (regression)', () => {
  const base = tmpdir('litdoctor-smoke-tests-');
  const proj = path.join(base, 'tests', 'myproj', 'src');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'a.js'), 'const x = 86400000;\n');
  const r = run(['--root', proj, '--json', '--max-medium', '0']);
  assert.strictEqual(r.code, 2, '祖先目录叫 tests 导致全树跳过 = 假绿灯：' + r.stdout);
});

test('smoke: real dist/ dir is still excluded', () => {
  const d = tmpdir('litdoctor-smoke-real-');
  fs.mkdirSync(path.join(d, 'dist'));
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'dist', 'a.js'), 'const x = 86400000;\n');
  fs.writeFileSync(path.join(d, 'src', 'b.js'), 'const TIMEOUT_MS = 10;\n');
  const r = run(['--root', d, '--json', '--min-score', '90']);
  assert.strictEqual(JSON.parse(r.stdout).summary.files, 1, 'dist/ 应被排除，src/ 应保留');
});

// ---- stdout 完整性 ----

test('smoke: --json stdout is complete and parseable under gate failure', () => {
  const d = tmpdir('litdoctor-smoke-json-');
  for (let i = 0; i < 40; i++) {
    fs.writeFileSync(path.join(d, `f${i}.js`), `const x = ${80000 + i * 7};\n`.repeat(3));
  }
  const r = run(['--root', d, '--json', '--max-medium', '0']);
  assert.strictEqual(r.code, 2);
  const j = JSON.parse(r.stdout); // process.exit() 截断 stdout 会让这里抛错
  assert.ok(j.issues.length >= 40);
  assert.strictEqual(j.gate.state, 'fail');
});

// ---- --help / --version ----

test('smoke: --help exits 0 and documents the three exit codes', () => {
  const r = run(['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('inconclusive'), '帮助应说明三态');
  assert.ok(r.stdout.includes('3=无法判定'));
});

test('smoke: --version exits 0 and matches package.json', () => {
  const r = run(['--version']);
  assert.strictEqual(r.code, 0);
  const pkg = JSON.parse(fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'package.json'), 'utf8'));
  assert.strictEqual(r.stdout.trim(), pkg.version, 'CLI 版本与 package.json 漂移');
});
