'use strict';
// litdoctor 单测：零依赖 node:test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// 本文件位于 test/ 下，ROOT 必须是仓库根（否则 dogfood 用例会扫到 test/ 本身）
const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.js');

// index.js 在被 require 时导出内部函数（require.main === module 才执行 main）
const lib = require(INDEX);

function makeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litdoctor-test-'));
  const dirty = path.join(dir, 'dirty.js');
  fs.writeFileSync(dirty, [
    '// timeout is 3000 in comment, should be ignored',
    'const TIMEOUT = 3000;',
    'if (status === 200) { handle(); }',
    'setTimeout(fn, 86400000);',
    "const id = 'user-3000';", // 字符串内数字，不算魔法值
    "const MSG = 'please wait';",
    "log('please wait');",
    "show('please wait');", // 重复 3 次
    'const x = 1; const y = 2;', // 惯用量
  ].join('\n'));
  const clean = path.join(dir, 'clean.js');
  fs.writeFileSync(clean, [
    'const TIMEOUT_MS = 1000;', // 1000 在白名单
    'const MAX_RETRY = 3;', // 3 在白名单
    "const GREETING = 'hi';", // 长度 <6 不计重复
    'function go() { return TIMEOUT_MS; }',
  ].join('\n'));
  return { dir, dirty, clean };
}

test('dirty sample reports magic-number and repeated-literal', () => {
  const { dirty } = makeFixtures();
  const issues = lib.scanFile(dirty, 'js', lib.DEFAULTS);
  const magics = issues.filter((i) => i.rule === 'magic-number');
  const reps = issues.filter((i) => i.rule === 'repeated-literal');
  assert.ok(magics.length >= 3, 'should detect >=3 magic numbers, got ' + magics.length);
  assert.strictEqual(reps.length, 1, 'should detect 1 repeated literal');
  assert.ok(reps[0].message.includes('please wait'));
});

test('clean sample reports zero issues', () => {
  const { clean } = makeFixtures();
  const issues = lib.scanFile(clean, 'js', lib.DEFAULTS);
  assert.strictEqual(issues.length, 0);
});

test('tokenizer ignores numbers inside comments and strings', () => {
  const { strings, numbers } = lib.tokenize(
    "// 3000 comment\nconst a = 'x3000y';\nconst b = 200;", 'js'
  );
  assert.strictEqual(numbers.length, 1, 'only bare 200 counted');
  assert.strictEqual(numbers[0].value, 200);
  // 字符串 'x3000y' 不应产生数字 token
  assert.ok(strings.some((s) => s.value === 'x3000y'));
});

test('tokenizer skips regex literal numbers', () => {
  const { numbers } = lib.tokenize("const re = /^\\d{3}$/; const n = 42;", 'js');
  // 正则内 {3} 的 3 不应产出；裸 42 应产出
  assert.strictEqual(numbers.length, 1);
  assert.strictEqual(numbers[0].value, 42);
});

test('dogfood: scanning self directory yields zero issues', () => {
  const files = lib.collectFiles(ROOT);
  let all = [];
  for (const f of files) all = all.concat(lib.scanFile(f.abs, lib.langOf(f.abs), lib.DEFAULTS));
  assert.strictEqual(all.length, 0, 'self scan must be clean: ' + JSON.stringify(all));
});

test('dogfood via CLI: --json output is pure JSON with zero issues', () => {
  // 必须配门禁阈值：未配门禁时本工具按设计返回 rc=3（inconclusive），
  // execFileSync 会在非 0 时抛错，那正是「假绿灯」修复后的预期行为。
  const out = execFileSync('node', [INDEX, '--json', '--root', ROOT, '--min-score', '90'], { encoding: 'utf8' });
  const parsed = JSON.parse(out); // 含尾部文本会抛错
  assert.strictEqual(parsed.tool, 'litdoctor');
  assert.strictEqual(parsed.issues.length, 0);
  assert.strictEqual(parsed.gate.state, 'pass');
  assert.strictEqual(parsed.basisComplete, true);
});

test('CI gate fails when --min-score not met (dirty)', () => {
  const { dirty } = makeFixtures();
  let code = 0;
  try {
    execFileSync('node', [INDEX, '--json', '--root', dirty, '--min-score', '100'], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
});

test('CI gate passes for clean sample', () => {
  const { clean } = makeFixtures();
  let code = 0;
  try {
    execFileSync('node', [INDEX, '--json', '--root', clean, '--min-score', '100'], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.strictEqual(code, 0);
});

test('unknown option exits with code 2', () => {
  let code = 0;
  try {
    execFileSync('node', [INDEX, '--bogus'], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
});

test('python triple-quoted docstring treated as string, bare magic still flagged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litdoctor-py-'));
  const f = path.join(dir, 'sample.py');
  fs.writeFileSync(f, '"""module doc with 3000 inside"""\ndef f():\n    x = 200\n    return x\n');
  const issues = lib.scanFile(f, 'py', lib.DEFAULTS);
  const magics = issues.filter((i) => i.rule === 'magic-number');
  const reps = issues.filter((i) => i.rule === 'repeated-literal');
  assert.strictEqual(magics.length, 1, 'only bare 200 flagged, docstring 3000 ignored');
  assert.ok(magics[0].message.includes('200'));
  assert.strictEqual(reps.length, 0, 'docstring content not falsely repeated');
});

test('array index context not flagged as magic-number', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litdoctor-arr-'));
  const f = path.join(dir, 'sample.js');
  fs.writeFileSync(f, 'const a = [200];\nconst b = arr[3000];\nconst c = 4000;\n');
  const issues = lib.scanFile(f, 'js', lib.DEFAULTS);
  const magics = issues.filter((i) => i.rule === 'magic-number');
  assert.strictEqual(magics.length, 1, 'only bare 4000 flagged, indexes skipped');
  assert.ok(magics[0].message.includes('4000'));
});

test('repeated-literal reports first occurrence line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litdoctor-rep-'));
  const f = path.join(dir, 'sample.js');
  fs.writeFileSync(f, [
    'line1',
    "const A = 'literal-value';",
    'line3',
    "const B = 'literal-value';",
    'line5',
    "const C = 'literal-value';",
  ].join('\n'));
  const issues = lib.scanFile(f, 'js', lib.DEFAULTS);
  const reps = issues.filter((i) => i.rule === 'repeated-literal');
  assert.strictEqual(reps.length, 1);
  assert.strictEqual(reps[0].line, 2, 'first occurrence line');
});

// ============ 以下为本轮修复新增的回归用例 ============

test('gate: 0 scanned files is inconclusive, never pass', () => {
  const g = lib.buildGateState({
    files: [], totalBytes: 0,
    opts: Object.assign({}, lib.DEFAULTS, { minScore: 90 }),
    failed: false,
  });
  assert.strictEqual(g.state, lib.GATE_STATE.INCONCLUSIVE);
  assert.strictEqual(lib.exitCodeFor(g), 3, 'rc must be 3 not 0 — 假绿灯防线');
});

test('gate: unconfigured thresholds are inconclusive', () => {
  const g = lib.buildGateState({ files: [{ abs: 'a' }], totalBytes: 10, opts: lib.DEFAULTS, failed: false });
  assert.strictEqual(g.state, lib.GATE_STATE.INCONCLUSIVE);
  assert.strictEqual(g.configured, false);
});

test('gate: all-zero-byte files are inconclusive', () => {
  const g = lib.buildGateState({
    files: [{ abs: 'a' }], totalBytes: 0,
    opts: Object.assign({}, lib.DEFAULTS, { minScore: 90 }),
    failed: false,
  });
  assert.strictEqual(g.state, lib.GATE_STATE.INCONCLUSIVE);
});

test('gate: configured + trusted input maps to pass/fail correctly', () => {
  const opts = Object.assign({}, lib.DEFAULTS, { minScore: 90 });
  const p = lib.buildGateState({ files: [{ abs: 'a' }], totalBytes: 50, opts, failed: false });
  assert.strictEqual(p.state, lib.GATE_STATE.PASS);
  assert.strictEqual(lib.exitCodeFor(p), 0);
  const f = lib.buildGateState({ files: [{ abs: 'a' }], totalBytes: 50, opts, failed: true });
  assert.strictEqual(f.state, lib.GATE_STATE.FAIL);
  assert.strictEqual(lib.exitCodeFor(f), 2);
});

test('regression: filename containing dist/build must NOT be skipped', () => {
  // 历史缺陷：用 path.includes('dist') 导致 distribution.js / rebuild.js 被整棵跳过
  for (const name of ['distribution.js', 'rebuild.js', 'coverage_report.js', 'mybuild.js']) {
    assert.strictEqual(
      lib.isSkippable(path.join('/proj/src', name), path.join('src', name)),
      false, name + ' 不应被跳过'
    );
  }
});

test('regression: real dist/build/node_modules directories ARE skipped', () => {
  assert.strictEqual(lib.isSkippable('/proj/dist/a.js', 'dist/a.js'), true);
  assert.strictEqual(lib.isSkippable('/proj/build/a.js', 'build/a.js'), true);
  assert.strictEqual(lib.isSkippable('/proj/node_modules/x/a.js', 'node_modules/x/a.js'), true);
  assert.strictEqual(lib.isSkippable('/proj/coverage/a.js', 'coverage/a.js'), true);
  assert.strictEqual(lib.isSkippable('/proj/src/a.txt', 'src/a.txt'), true, '不支持的扩展名');
});

test('regression: root ancestor named tests must not blank the whole tree', () => {
  // 历史缺陷：对完整 filePath 做 /tests\// 正则，项目路径含 tests/ 时全树被误判为测试
  const abs = '/home/u/tests/myproj/src/a.js';
  assert.strictEqual(lib.isTestFile(abs, path.join('src', 'a.js')), false);
  // 但相对 root 内的 tests/ 目录仍应被识别为测试
  assert.strictEqual(lib.isTestFile('/proj/tests/a.js', 'tests/a.js'), true);
  assert.strictEqual(lib.isTestFile('/proj/src/a.test.js', 'src/a.test.js'), true);
});

test('collectFiles returns {abs, rel} and skips tests by relative path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'litdoctor-cf-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const x = 86400000;\n');
  fs.writeFileSync(path.join(dir, 'tests', 'a.js'), 'const x = 86400000;\n');
  const files = lib.collectFiles(dir);
  assert.strictEqual(files.length, 1, '只有 src/a.js 应入选');
  // rel 内部统一用 '/' 分隔（跨平台稳定），不要用 path.join 断言
  assert.strictEqual(files[0].rel, 'src/a.js');
  assert.ok(path.isAbsolute(files[0].abs));
});

test('DEFAULTS.minScore is null so "configured" can be detected', () => {
  assert.strictEqual(lib.DEFAULTS.minScore, null,
    'minScore 必须是 null；用 0 会让 configured 永远为真，三态门禁失效');
});

test('DEFAULTS whitelist matches README documented values', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const line = readme.split('\n').find((l) => l.includes('白名单'));
  assert.ok(line, 'README 必须有一行说明惯用量白名单');
  for (const v of ['0', '1024', '0.5', '64', '256', '512']) {
    assert.ok(lib.COMMON_NUMBERS.has(Number(v)), `白名单应含 ${v}`);
    assert.ok(line.includes(v), `README 白名单行应含 ${v}（文档漂移防线）`);
  }
});
