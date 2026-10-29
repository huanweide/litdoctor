> [!WARNING]
> **⚠️ 本轴已并入 [doctors](https://github.com/huanweide/doctors) 家族 monorepo → 本仓停止维护。**
>
> 代码原件已迁至 [`doctors/packages/litdoctor/`](https://github.com/huanweide/doctors/tree/main/packages/litdoctor)，
> 在 doctors 里以 `doctors lit` 子命令调用（或 `node packages/litdoctor/index.js`）。
> 本仓不再接受新改动，请前往 <https://github.com/huanweide/doctors>。

<!-- badges -->
[![License](https://img.shields.io/github/license/huanweide/litdoctor)](LICENSE)
[![Stars](https://img.shields.io/github/stars/huanweide/litdoctor)](https://github.com/huanweide/litdoctor/stargazers)
[![Engineering Health Family](https://img.shields.io/badge/Engineering%20Health%20Family-18%20axes-22c55e)](https://github.com/huanweide/family-showcase)
<!-- /badges -->

**🔧 Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). Standalone tool — see [doctors](https://github.com/huanweide/doctors) (monorepo) and [enghealth](https://github.com/huanweide/enghealth) (unified runner).

# litdoctor

零依赖单文件 Node CLI · 工程健康家族（family）第十七轴 · 源码层第十一轴

「硬编码魔法值 / 重复字面量」卫生体检。扫描 JS/TS/Python/Go 生态，找出散落的裸魔法数字与重复字符串字面量，给出 0–100 健康分，并内置**会说实话的** CI 门禁。

- 零依赖：纯 Node 内置模块，单文件 `index.js`，拷贝即跑、离线可用
- 跨语言：JS/TS/Python/Go 一套规则
- 门禁三态：`pass` / `fail` / `inconclusive`——**扫不到东西时绝不谎报通过**

## 安装 / 使用

无需安装，克隆后直接跑：

```bash
node index.js                       # 扫描当前目录
node index.js ./src                 # 扫描指定目录
node index.js --json --root ./src --min-score 90   # 纯 JSON + 真门禁（CI 用）
```

想当全局命令用（**本包目前未发布到 npm registry**，`npm i -g litdoctor` 会 404）：

```bash
git clone https://github.com/huanweide/litdoctor.git
cd litdoctor && npm link            # 之后可直接 litdoctor ./src
```

## 检测规则

| 规则 | 级别 | 说明 |
|------|------|------|
| `magic-number` | medium | 裸数字字面量（非惯用量，如 `200` / `3000` / `86400000`），建议定义为命名常量 |
| `repeated-literal` | low | 同一字符串字面量（长度 ≥ 7）重复出现 ≥ 3 次，建议抽为常量/配置 |

惯用量白名单（不报）：`0 1 -1 2 3 4 5 6 7 8 9 10 20 25 50 60 64 100 256 512 1000 1024 10000 0.5 -0.5`。

> 该列表由单测 `DEFAULTS whitelist matches README documented values` 与源码 `COMMON_NUMBERS` 逐项比对，改源码不改文档会直接让 CI 变红。

排除规则按**路径段精确匹配**（不是子串包含）：`node_modules` `.git` `dist` `build` `coverage` `out` `.next` `.nuxt` `vendor` `__pycache__` `.venv` `venv`，以及测试文件（`*.test.*` `test.*` `tests/` `__tests__/` `test_*.py` `*_test.go`）。

因此 `distribution.js`、`rebuild.js`、`coverage_report.js` 这类**名字里带关键字的正常源码文件不会被误跳过**，而真正的 `dist/` 目录照常排除。测试判定只看相对 `--root` 的路径，所以项目放在任何目录（含名字带 `tests` 的路径）下都能正常扫描。

## 选项

| 选项 | 默认 | 说明 |
|------|------|------|
| `--root <dir>` | `.` | 扫描根目录 |
| `--json` | 关 | 输出纯 JSON（含 `gate` 与 `basisComplete` 字段） |
| `--min-string-len <n>` | 7 | 重复字面量最小长度 |
| `--repeat-threshold <n>` | 3 | 字面量重复次数阈值 |
| `--max-issues <n>` | ∞ | 问题总数上限（超则失败） |
| `--max-medium <n>` | ∞ | medium 级上限 |
| `--max-low <n>` | ∞ | low 级上限 |
| `--min-score <n>` | 未设 | 健康分下限（低于则失败） |
| `--fail-on-high` | 关 | 兼容保留（本工具暂无 high 规则） |

所有数值参数必须是**非负整数**：缺值、小数、负数、尾随垃圾字符（如 `12abc`）、空字符串，一律退 `2`。门禁参数写错等于门禁不存在，不能静默降级。

## 门禁三态（重要）

扫描型门禁工具最恶劣的失败模式是「**扫了 0 个对象却报通过**」——CI 上就是一盏永不熄灭的绿灯。litdoctor 因此不输出布尔结论，而输出三态：

| `gate.state` | 退出码 | 含义 |
|---|---|---|
| `pass` | 0 | 配了门禁阈值、输入可信、指标达标 |
| `fail` | 2 | 配了门禁阈值，且至少一项不达标 |
| `inconclusive` | 3 | **无法下结论**：未配任何门禁阈值，或扫描输入为空 / 全部文件无可解析内容 |

JSON 输出附带两个字段方便下游判断：

```jsonc
{
  "summary": { "files": 128, "issues": 3, "score": 96 },
  "gate": { "state": "pass", "configured": true, "reason": "全部指标达标" },
  "basisComplete": true   // false 表示本次结论不可信，别拿它当合规证据
}
```

> 未配门禁阈值时返回 `3` 而不是 `0`，是刻意的：这样「我只是跑着看看」不会在 CI 里被误读成「检查通过」。想让它放行，显式写 `--min-score 0` 即可。

## 健康分

```
基础 100，每千行容忍 4 个字面量当量（magic-number 计 1，repeated-literal 计 0.5）
超出部分每当量扣 25 分，封底 0
```

## CI 门禁示例

```yaml
- name: literal hygiene
  run: node index.js --json --root ./src --min-score 90 --max-medium 5
```

退出码：`0` 通过 / `2` 门禁失败 / `3` 无法判定 / 其他 运行错误。

## 差异化定位

- 与 `dupscan`（重复代码块）互补：dupscan 查 ≥5 行连续代码块重复，litdoctor 查散落的相同字面量（粒度不同，不重叠）。
- 与 `secscan`（安全 API）边界清晰：litdoctor 只标「字面量重复 / 魔法值」卫生维度，不深判安全语义。
- 与 ESLint `no-magic-numbers`（仅 JS、需装依赖配规则）、SonarQube（需服务）、fallow（仅 Rust）的区别：litdoctor 是**零依赖单文件、跨语言、门禁会说实话**的魔法值/字面量专科体检——在 CI 沙箱 / 离线环境可直接跑，无需安装或下载二进制。

## 测试

```bash
node --test          # 42 组：单测 + spawn 级冒烟
```

其中 `test/smoke-cli.js` 真实起进程验证**退出码契约**。这一层不可省略：`node --test` 的单测只测导出的函数，根本不碰 `process.exitCode`，改退出码时单测会全绿放行。


## 许可证

[MIT](LICENSE)

---

## 作者

由 **ReTr · huanweide** 维护 · [GitHub 主页](https://github.com/huanweide)

家族同类：devdoctor · testlite · debtlens · a11ydoctor · awaitscan · cycscan · secscan · dupscan · typedoctor · debugdoctor · repodoctor · docdoctor · commitdoctor · reldoctor · pkgdoctor · enghealth
---

## 便携性 · 零依赖承诺

- 零运行时依赖：只用一个 Node 内置模块，无需 `npm install`。
- 单文件：整个工具就是一个 `index.js`，复制进任何仓库即可用。
- 离线 / 跨平台：Node 18+ 即可，不联网、不挑系统。
- 一键跑：`node index.js --root ./src`（详见上方用法）。

← [回到代码健康家族总览](https://github.com/huanweide/family-showcase)
