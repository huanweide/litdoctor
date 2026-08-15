#!/usr/bin/env node
'use strict';
// litdoctor - 零依赖单文件「硬编码魔法值 / 重复字面量」卫生体检 CLI
// family 第十七轴 · 源码层第十一轴
// 扫 JS/TS/Python/Go 生态，检测裸魔法数字与重复字面量，给健康分 + CI 门禁。

const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';

// 惯用量白名单：魔法值检测排除项（常见哨兵/边界/惯用常量）
const COMMON_NUMBERS = new Set([
  0, 1, -1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 25, 50, 60, 100, 1024, 1000, 10000,
  0.5, -0.5, 64, 256, 512,
]);

const DEFAULTS = {
  root: '.',
  maxIssues: Infinity,
  maxMedium: Infinity,
  maxLow: Infinity,
  minScore: 0,
  minStringLen: 7,
  repeatThreshold: 3,
  json: false,
  failOnHigh: false,
  help: false,
  version: false,
};

const SUPPORTED_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte', '.py', '.go',
]);

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB 跳过防 OOM
const PER_K_LINES = 4; // 每千行容忍的字面量当量
const PENALTY = 25; // 每超 1 当量扣的分

// ---------- 文件分类 ----------
function langOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.py') return 'py';
  if (ext === '.go') return 'go';
  return 'js';
}

function isTestFile(filePath) {
  const base = path.basename(filePath);
  return (
    /\.(?:test|spec)\.[jt]sx?$/.test(filePath) ||
    /^test\.[jt]sx?$/.test(base) ||
    /(^|[/\\])__tests__\//.test(filePath) ||
    /(^|[/\\])tests\//.test(filePath) ||
    /^test_.*\.py$/.test(base) ||
    /^.*_test\.go$/.test(base)
  );
}

function isSkippable(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.includes('node_modules') || lower.includes('/.git/') ||
      lower.includes('\\.git\\') || lower.includes('dist') ||
      lower.includes('build') || lower.includes('coverage')) return true;
  if (!SUPPORTED_EXT.has(path.extname(filePath).toLowerCase())) return true;
  if (isTestFile(filePath)) return true;
  return false;
}

// ---------- 逐字符 tokenizer ----------
// 剥离注释与正则，产出字符串字面量（strings）与数字字面量（numbers）。
// 字符串内的数字不计入 numbers（避免 'abc123' 误判）。
function tokenize(content, lang) {
  const strings = [];
  const numbers = [];
  const n = content.length;
  let i = 0;
  let line = 1;
  let prevMeaningful = ''; // 用于正则上下文判断
  while (i < n) {
    const ch = content[i];
    if (ch === '\n') { line++; i++; prevMeaningful = ''; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }

    // Python 注释
    if (lang === 'py' && ch === '#') {
      while (i < n && content[i] !== '\n') i++;
      continue;
    }
    // JS/TS 行注释
    if (lang !== 'py' && ch === '/' && content[i + 1] === '/') {
      i += 2;
      while (i < n && content[i] !== '\n') i++;
      continue;
    }
    // 块注释
    if (ch === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) {
        if (content[i] === '\n') line++;
        i++;
      }
      i += 2;
      prevMeaningful = '';
      continue;
    }
    // Python 三引号文档字符串（整段作为字符串）
    if (lang === 'py' && (content.substr(i, 3) === '"""' || content.substr(i, 3) === "'''")) {
      const q3 = content.substr(i, 3);
      let j = i + 3;
      let val = '';
      while (j < n) {
        if (content[j] === '\\') { val += content[j] + (content[j + 1] || ''); j += 2; continue; }
        if (content[j] === '\n') line++;
        if (content.substr(j, 3) === q3) { j += 3; break; }
        val += content[j]; j++;
      }
      strings.push({ value: val, line });
      i = j;
      prevMeaningful = q3[0];
      continue;
    }
    // 字符串字面量
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let val = '';
      while (j < n) {
        if (content[j] === '\\') { val += content[j] + (content[j + 1] || ''); j += 2; continue; }
        if (content[j] === '\n') line++;
        if (content[j] === quote) { j++; break; }
        val += content[j];
        j++;
      }
      strings.push({ value: val, line });
      i = j;
      prevMeaningful = quote;
      continue;
    }
    // 正则字面量（仅 JS/TS）：前导有意义字符 ∈ =([,:!&|?{;) 才判定为正则
    if (lang !== 'py' && ch === '/' && /[=([,:!&|?{;]/.test(prevMeaningful)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (content[j] === '\\') { j += 2; continue; }
        if (content[j] === '[') inClass = true;
        else if (content[j] === ']') inClass = false;
        else if (content[j] === '/' && !inClass) { j++; break; }
        if (content[j] === '\n') line++;
        j++;
      }
      i = j;
      prevMeaningful = '/';
      continue;
    }
    // 数字字面量（裸，不含负号；负号不影响"值本身是否魔法值"判断）
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.]/.test(content[j])) j++;
      const raw = content.slice(i, j);
      if (/^\d+(\.\d+)?$/.test(raw)) {
        numbers.push({ value: Number(raw), line, index: i });
      }
      i = j;
      prevMeaningful = ch;
      continue;
    }
    prevMeaningful = ch;
    i++;
  }
  return { strings, numbers };
}

// ---------- 单文件扫描 ----------
function scanFile(filePath, lang, opts) {
  const issues = [];
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return issues;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return issues;

  const { strings, numbers } = tokenize(content, lang);

  // L1 magic-number：裸非惯用数字 |v| >= 20
  for (const num of numbers) {
    const { value, line, index } = num;
    const av = Math.abs(value);
    if (av >= 20 && !COMMON_NUMBERS.has(value)) {
      // 排除数组索引上下文（如 arr[200] / [200]）
      const before = content[index - 1];
      const after = content[index + String(value).length];
      if (before === '[' || after === ']') continue;
      issues.push({
        rule: 'magic-number',
        severity: 'medium',
        file: filePath,
        line,
        message: `裸数字字面量 ${value} 可能是魔法值，建议定义为命名常量`,
      });
    }
  }

  // L2 repeated-literal：长字符串字面量重复出现 >= threshold 次
  const strCount = new Map();
  for (const { value, line } of strings) {
    const v = value.trim();
    if (v.length < opts.minStringLen) continue;
    if (v.startsWith('-')) continue;       // CLI 标志
    if (v.includes('/')) continue;         // 路径
    if (/^[A-Z0-9_]+$/.test(v)) continue;  // 全大写常量名
    if (/^\d+$/.test(v)) continue;         // 纯数字串
    if (/[{}]/.test(v)) continue;          // 模板残留
    if (!strCount.has(v)) strCount.set(v, { count: 0, firstLine: line });
    strCount.get(v).count++;
  }
  for (const [v, info] of strCount) {
    if (info.count >= opts.repeatThreshold) {
      issues.push({
        rule: 'repeated-literal',
        severity: 'low',
        file: filePath,
        line: info.firstLine,
        message: `字符串字面量 "${v.slice(0, 40)}" 重复出现 ${info.count} 次，建议抽为常量/配置`,
      });
    }
  }
  return issues;
}

// ---------- 目录收集 ----------
function collectFiles(root) {
  const out = [];
  let stat;
  try {
    stat = fs.statSync(root);
  } catch (e) {
    console.error(`根目录不存在或无法访问: ${root}`);
    process.exit(2);
  }
  if (!stat.isDirectory()) {
    return isSkippable(root) ? [] : [root];
  }
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        walk(full);
      } else if (ent.isFile()) {
        if (!isSkippable(full)) out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

// ---------- 健康分 ----------
function countSev(issues, sev) {
  return issues.filter((i) => i.severity === sev).length;
}

function computeScore(issues, lines) {
  const weighted = issues.reduce((s, it) => s + (it.severity === 'medium' ? 1 : 0.5), 0);
  const allowed = PER_K_LINES * (lines / 1000);
  const excess = Math.max(0, weighted - allowed);
  return Math.max(0, Math.round(100 - excess * PENALTY));
}

// ---------- 报告 ----------
function printReport(fileCount, issues, score) {
  const mediums = countSev(issues, 'medium');
  const lows = countSev(issues, 'low');
  console.log(`litdoctor v${VERSION} - 字面量卫生体检`);
  console.log(`扫描文件: ${fileCount}`);
  console.log(`问题: ${issues.length} (magic-number: ${mediums} / repeated-literal: ${lows})`);
  console.log(`健康分: ${score}/100`);
  console.log('');
  if (issues.length === 0) {
    console.log('未发现字面量卫生问题。');
  } else {
    const ordered = issues.slice().sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 };
      if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
      return a.file.localeCompare(b.file) || a.line - b.line;
    });
    for (const it of ordered) {
      const loc = it.line > 0 ? `${it.file}:${it.line}` : it.file;
      console.log(`[${it.severity}] ${loc} (${it.rule}) ${it.message}`);
    }
  }
}

function printHelp() {
  console.log(`litdoctor v${VERSION} - 零依赖硬编码魔法值/重复字面量体检 CLI

用法: litdoctor [root] [选项]

选项:
  -h, --help              显示帮助
  -V, --version           显示版本
  --root <dir>            扫描根目录 (默认 ".")
  --json                  输出纯 JSON (门禁仅用退出码)
  --min-string-len <n>    重复字面量最小长度 (默认 6)
  --repeat-threshold <n>  字面量重复次数阈值 (默认 3)
  --max-issues <n>        问题总数上限 (超则 CI 失败)
  --max-medium <n>        medium 级问题上限
  --max-low <n>           low 级问题上限
  --min-score <n>         健康分下限 (低于则 CI 失败)
  --fail-on-high          存在 high 级问题则 CI 失败 (本工具暂无 high 规则，保留兼容)

退出码: 0=通过 / 2=门禁失败 / 其他=运行错误`);
}

// ---------- 参数解析（三类分离）----------
function parseArgs(argv) {
  const o = Object.assign({}, DEFAULTS);
  const NUM_FLAGS = {
    '--max-issues': 1, '--max-medium': 1, '--max-low': 1,
    '--min-score': 1, '--min-string-len': 1, '--repeat-threshold': 1,
  };
  const STR_FLAGS = { '--root': 1 };
  const BOOL_FLAGS = {
    '--json': 1, '--fail-on-high': 1, '-h': 1, '--help': 1,
    '-V': 1, '--version': 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS[a]) {
      if (a === '-h' || a === '--help') o.help = true;
      else if (a === '-V' || a === '--version') o.version = true;
      else if (a === '--json') o.json = true;
      else if (a === '--fail-on-high') o.failOnHigh = true;
      continue;
    }
    if (STR_FLAGS[a]) {
      o.root = argv[++i];
      continue;
    }
    if (NUM_FLAGS[a]) {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) {
        console.error(`选项 ${a} 需要数字参数`);
        process.exit(2);
      }
      const key = a.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      o[key] = v;
      continue;
    }
    if (a === '--') continue;
    if (!a.startsWith('-')) { o.root = a; continue; } // 位置参数视为 root
    console.error(`未知选项: ${a}`);
    process.exit(2);
  }
  return o;
}

// ---------- 主入口 ----------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return 0; }
  if (opts.version) { console.log(VERSION); return 0; }

  const files = collectFiles(opts.root);
  let allIssues = [];
  let totalLines = 0;
  for (const f of files) {
    const lang = langOf(f);
    const issues = scanFile(f, lang, opts);
    allIssues = allIssues.concat(issues);
    try {
      const c = fs.readFileSync(f, 'utf8');
      totalLines += c.split('\n').length;
    } catch (e) { /* ignore */ }
  }

  const score = computeScore(allIssues, totalLines);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      tool: 'litdoctor',
      version: VERSION,
      summary: { files: files.length, issues: allIssues.length, score },
      issues: allIssues,
    }, null, 2));
  } else {
    printReport(files.length, allIssues, score);
  }

  // CI 门禁（仅用退出码表达）
  let failed = false;
  if (score < opts.minScore) failed = true;
  if (allIssues.length > opts.maxIssues) failed = true;
  if (countSev(allIssues, 'medium') > opts.maxMedium) failed = true;
  if (countSev(allIssues, 'low') > opts.maxLow) failed = true;
  if (opts.failOnHigh && countSev(allIssues, 'high') > 0) failed = true;
  return failed ? 2 : 0;
}

process.exit(main());
