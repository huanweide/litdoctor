# litdoctor

零依赖单文件 Node CLI · 工程健康家族（family）第十七轴 · 源码层第十一轴

「硬编码魔法值 / 重复字面量」卫生体检。扫描 JS/TS/Python/Go 生态，找出散落的裸魔法数字与重复字符串字面量，给出 0–100 健康分，并内置 CI 门禁。

- 零依赖：纯 Node 内置模块，单文件 `index.js`，拷贝即跑、离线可用
- 跨语言：JS/TS/Python/Go 一套规则
- 健康分 + CI 门禁：`--json` 纯 JSON 输出，门禁只用退出码表达

## 安装 / 使用

```bash
node index.js                       # 扫描当前目录
node index.js ./src                 # 扫描指定目录
node index.js --json --root ./src   # 纯 JSON 输出（CI 用）
```

## 检测规则

| 规则 | 级别 | 说明 |
|------|------|------|
| `magic-number` | medium | 裸数字字面量（非惯用量，如 `200` / `3000` / `86400000`），建议定义为命名常量 |
| `repeated-literal` | low | 同一字符串字面量（长度 ≥ 6）重复出现 ≥ 3 次，建议抽为常量/配置 |

惯用量白名单（不报）：`0 1 -1 2 3 4 5 6 7 8 9 10 20 25 50 60 100 1024 1000 10000 0.5`。

## 选项

| 选项 | 默认 | 说明 |
|------|------|------|
| `--root <dir>` | `.` | 扫描根目录 |
| `--json` | 关 | 输出纯 JSON（门禁仅用退出码） |
| `--min-string-len <n>` | 7 | 重复字面量最小长度 |
| `--repeat-threshold <n>` | 3 | 字面量重复次数阈值 |
| `--max-issues <n>` | ∞ | 问题总数上限（超则失败） |
| `--max-medium <n>` | ∞ | medium 级上限 |
| `--max-low <n>` | ∞ | low 级上限 |
| `--min-score <n>` | 0 | 健康分下限（低于则失败） |
| `--fail-on-high` | 关 | 兼容保留（本工具暂无 high 规则） |

## 健康分

```
基础 100，每千行容忍 4 个字面量当量（magic-number 计 1，repeated-literal 计 0.5）
超出部分每当量扣 25 分，封底 0
```

## CI 门禁示例

```yaml
- name: literal hygiene
  run: node litdoctor --json --root ./src --min-score 90 --max-medium 5
```

退出码：`0` = 通过 / `2` = 门禁失败 / 其他 = 运行错误。

## 差异化定位

- 与 `dupscan`（重复代码块）互补：dupscan 查 ≥5 行连续代码块重复，litdoctor 查散落的相同字面量（粒度不同，不重叠）。
- 与 `secscan`（安全 API）边界清晰：litdoctor 只标"字面量重复/魔法值"卫生维度，不深判安全语义。
- 与 fallow（Rust 整合 dead-code/dupes/complexity）、ESLint `no-magic-numbers`（仅 JS、需配置）的区别：litdoctor 是**零依赖单文件、跨语言、带健康分与 CI 门禁**的魔法值/字面量专科体检——在 CI 沙箱 / 离线环境可直接跑，无需安装或下载二进制。

## 测试

```bash
node --test
```

家族同类：devdoctor · testlite · debtlens · a11ydoctor · awaitscan · cycscan · secscan · dupscan · typedoctor · debugdoctor · repodoctor · docdoctor · commitdoctor · reldoctor · pkgdoctor · enghealth
