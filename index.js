#!/usr/bin/env node
'use strict';
// litdoctor - 零依赖单文件「硬编码魔法值 / 重复字面量」卫生体检 CLI
// family 第十七轴 · 源码层第十一轴
// 扫 JS/TS/Python/Go 生态，检测裸魔法数字与重复字面量，给健康分 + CI 门禁。

const fs = require('fs');
const path = require('path');

const VERSION = '1.1.0';

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
  // null 而非 0：0 是合法阈值（健康分不可能低于 0，等价于不设限），
  // 用它当默认值会让「用户到底配没配门禁」永远为真，三态就废了。
  minScore: null,
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

// 只看「文件名」与「相对 root 的目录段」，不看 root 以上的祖先路径。
// 历史缺陷：直接对完整 filePath 做 /tests\// 正则，若 root 以上的祖先目录里带 tests/
// 会把整棵源码树误判为测试文件，导致扫 0 个文件却报「干净」。
// 传 relPath（相对 root 的路径）即可完全隔离祖先路径。
function isTestFile(filePath, relPath) {
  const norm = (relPath || filePath).replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  const base = parts[parts.length - 1];
  const dirs = parts.slice(0, -1).map((p) => p.toLowerCase());
  return (
    /\.(?:test|spec)\.[jt]sx?$/.test(base) ||
    /^test\.[jt]sx?$/.test(base) ||
    dirs.includes('__tests__') ||
    dirs.includes('test') ||
    dirs.includes('tests') ||
    /^test_.*\.py$/.test(base) ||
    /^.*_test\.go$/.test(base)
  );
}

// 排除目录：按「路径段」精确匹配，不再用子串包含。
// 历史缺陷：子串匹配会让 distribution.js / payload.js / rebuild.js 等正常源码文件被整棵跳过，
// 导致「扫 0 个对象却报健康分 100」——门禁工具最恶劣的假绿灯。
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  'out', '.next', '.nuxt', 'vendor', '__pycache__', '.venv', 'venv',
]);

function isSkippable(filePath, relPath) {
  const rel = relPath || filePath;
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  const dirs = parts.slice(0, -1).map((p) => p.toLowerCase());
  for (const d of dirs) {
    if (SKIP_DIR_SEGMENTS.has(d)) return true;
  }
  if (!SUPPORTED_EXT.has(path.extname(filePath).toLowerCase())) return true;
  if (isTestFile(filePath, relPath)) return true;
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
// 返回 [{ abs, rel }]，rel 是相对 root 的路径，供 isSkippable 做段级判断
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
    const base = path.basename(root);
    return isSkippable(root, base) ? [] : [{ abs: root, rel: base }];
  }
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIR_SEGMENTS.has(ent.name.toLowerCase())) continue;
        walk(full, relPath);
      } else if (ent.isFile()) {
        if (!isSkippable(full, relPath)) out.push({ abs: full, rel: relPath });
      }
    }
  };
  walk(root, '');
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
  --min-string-len <n>    重复字面量最小长度 (默认 7)
  --repeat-threshold <n>  字面量重复次数阈值 (默认 3)
  --max-issues <n>        问题总数上限 (超则失败)
  --max-medium <n>        medium 级问题上限
  --max-low <n>           low 级问题上限
  --min-score <n>         健康分下限 (低于则失败)
  --fail-on-high          存在 high 级问题则失败 (本工具暂无 high 规则，保留兼容)

门禁三态（--json 里见 gate.state / basisComplete 字段）:
  pass           配了门禁阈值且输入可信、指标达标
  fail           配了门禁阈值且至少一项不达标
  inconclusive   未配门禁阈值，或扫描输入为空 → 无法下结论，**不算通过**

退出码: 0=通过 / 2=门禁失败 / 3=无法判定（未配门禁或输入为空）/ 其他=运行错误`);
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
      const next = argv[i + 1];
      // 历史缺陷：`--root` 缺值时 o.root 被赋成 undefined，随后 statSync(undefined)
      // 抛出无意义的「根目录不存在: undefined」；若下一个 token 是别的标志（`--root --json`）
      // 更会被静默当成目录名吞掉。这里显式校验。
      if (next === undefined || next.startsWith('-')) {
        console.error(`选项 ${a} 缺少必需的目录参数`);
        process.exit(2);
      }
      o.root = next;
      i++;
      continue;
    }
    if (NUM_FLAGS[a]) {
      const raw = argv[++i];
      // Number('') === 0 —— 空串会静默变成阈值 0，等于门禁失效，必须单独拦。
      // Number('12abc') === NaN；parseInt('12abc') === 12（静默截断，更阴险）。
      // 门禁参数写错 = 门禁不存在，一律退 2。
      const v = Number(raw);
      if (raw === undefined || String(raw).trim() === '' || !Number.isFinite(v)) {
        console.error(`选项 ${a} 需要数字参数（收到: ${raw === undefined ? '<缺失>' : raw}）`);
        process.exit(2);
      }
      if (!Number.isInteger(v) || v < 0) {
        console.error(`选项 ${a} 需要非负整数（收到: ${raw}）`);
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

// ---------- 门禁三态 ----------
// 历史缺陷（家族共性最恶劣失败模式）：扫描型工具扫 0 个对象却输出
// 「健康分 100/100 · 未发现问题」并 rc=0 —— CI 上就是一盏永不熄灭的绿灯。
// 现在统一为三态：pass(通过) / fail(不达标) / inconclusive(输入不可信，无法下结论)。
const GATE_STATE = {
  PASS: 'pass',
  FAIL: 'fail',
  INCONCLUSIVE: 'inconclusive',
};

function buildGateState({ files, totalBytes, opts, failed }) {
  // 门禁未启用：所有阈值都是默认值，用户根本没配门禁
  const configured = Number.isFinite(opts.minScore) || opts.maxIssues !== Infinity ||
    opts.maxMedium !== Infinity || opts.maxLow !== Infinity || opts.failOnHigh;  if (!configured) {
    return {
      state: GATE_STATE.INCONCLUSIVE,
      configured: false,
      reason: '未配置任何门禁阈值，本次仅体检不判定（请显式传入 --min-score 或 --max-* / --fail-on-high）',
    };
  }
  // 输入不可信：扫到 0 个文件 → 无法得出任何结论，绝不能报 pass
  if (files.length === 0) {
    return {
      state: GATE_STATE.INCONCLUSIVE,
      configured: true,
      reason: '扫描输入为空（0 个可分析文件），无法判定；请确认 --root 指向源码目录且不是全部命中排除规则',
    };
  }
  // 全部文件读不到内容（编码异常 / 空文件 / 全部超 MAX_FILE_BYTES）→ 同样不可信
  if (totalBytes === 0) {
    return {
      state: GATE_STATE.INCONCLUSIVE,
      configured: true,
      reason: '扫描到的文件全部无可解析内容，无法判定',
    };
  }
  return {
    state: failed ? GATE_STATE.FAIL : GATE_STATE.PASS,
    configured: true,
    reason: failed ? '存在不达标项' : '全部指标达标',
  };
}

function exitCodeFor(state) {
  if (state.state === GATE_STATE.FAIL) return 2;
  // 输入不可信：退出码 3 与「门禁失败」区分开，避免被误读成「发现了问题」
  if (state.state === GATE_STATE.INCONCLUSIVE) return 3;
  return 0;
}

// ---------- 主入口 ----------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return 0; }
  if (opts.version) { console.log(VERSION); return 0; }

  const files = collectFiles(opts.root);
  let allIssues = [];
  let totalLines = 0;
  let totalBytes = 0;
  for (const f of files) {
    const abs = f.abs;
    const lang = langOf(abs);
    const issues = scanFile(abs, lang, opts);
    allIssues = allIssues.concat(issues);
    try {
      const c = fs.readFileSync(abs, 'utf8');
      totalLines += c.split('\n').length;
      totalBytes += Buffer.byteLength(c, 'utf8');
    } catch (e) { /* ignore */ }
  }

  const score = computeScore(allIssues, totalLines);

  // CI 门禁（仅用退出码表达）
  let failed = false;
  if (Number.isFinite(opts.minScore) && score < opts.minScore) failed = true;
  if (allIssues.length > opts.maxIssues) failed = true;
  if (countSev(allIssues, 'medium') > opts.maxMedium) failed = true;
  if (countSev(allIssues, 'low') > opts.maxLow) failed = true;
  if (opts.failOnHigh && countSev(allIssues, 'high') > 0) failed = true;

  const gate = buildGateState({ files, totalBytes, opts, failed });

  if (opts.json) {
    // JSON.stringify(undefined) 返回 undefined 而非字符串 —— 这里字段都是确定的，安全
    process.stdout.write(JSON.stringify({
      tool: 'litdoctor',
      version: VERSION,
      summary: { files: files.length, issues: allIssues.length, score },
      gate: { state: gate.state, configured: gate.configured, reason: gate.reason },
      basisComplete: gate.state !== GATE_STATE.INCONCLUSIVE,
      issues: allIssues,
    }, null, 2) + '\n');
  } else {
    printReport(files.length, allIssues, score);
    // 门禁状态始终显式打印：用户必须能一眼看出「这次到底判没判定」。
    // 只在失败时打印等于让人误以为「没消息就是通过」。
    console.log('');
    console.log(`门禁状态: ${gate.state} — ${gate.reason}`);
  }

  return exitCodeFor(gate);
}

// 支持被 test.js 直接 require（供单测覆盖内部函数）
if (require.main === module) {
  // 注意：这里必须用 process.exitCode 而不是 process.exit()。
  // process.exit() 会截断异步刷写的 stdout，导致 --json 输出残缺、
  // 下游 JSON.parse 直接抛错。设置 exitCode 让 Node 自然退出并冲刷缓冲。
  process.exitCode = main();
} else {
  module.exports = {
    scanFile, collectFiles, tokenize, computeScore, langOf, isTestFile,
    isSkippable, parseArgs, DEFAULTS, COMMON_NUMBERS, main,
    buildGateState, exitCodeFor, GATE_STATE, SKIP_DIR_SEGMENTS, VERSION,
  };
}
