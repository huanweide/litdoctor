'use strict';
// litdoctor 单测：零依赖 node:test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname);
const INDEX = path.join(ROOT, 'index.js');

// 加载内部函数（去掉末尾 process.exit 以便导出）
const code = fs.readFileSync(INDEX, 'utf8');
const codeNoExit = code.replace(
  /process\.exit\(main\(\)\);\s*$/,
  'module.exports = { scanFile, collectFiles, tokenize, computeScore, langOf, isTestFile, parseArgs, DEFAULTS, COMMON_NUMBERS, main };'
);
const sandbox = { require, process, console, Buffer, module: {}, exports: {} };
vm.createContext(sandbox);
vm.runInContext(codeNoExit, sandbox);
const lib = sandbox.module.exports;

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
  for (const f of files) all = all.concat(lib.scanFile(f, lib.langOf(f), lib.DEFAULTS));
  assert.strictEqual(all.length, 0, 'self scan must be clean: ' + JSON.stringify(all));
});

test('dogfood via CLI: --json output is pure JSON with zero issues', () => {
  const out = execFileSync('node', [INDEX, '--json', '--root', ROOT], { encoding: 'utf8' });
  const parsed = JSON.parse(out); // 含尾部文本会抛错
  assert.strictEqual(parsed.tool, 'litdoctor');
  assert.strictEqual(parsed.issues.length, 0);
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
