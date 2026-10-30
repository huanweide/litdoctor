**中文** · [README.md](./README.md)

<p align="center">
  <a href="https://github.com/huanweide/family-showcase"><img src="https://img.shields.io/badge/Engineering%20Health%20Family-18%20axes-22c55e" alt="Engineering Health Family"></a>
  <a href="https://github.com/huanweide/litdoctor/stargazers"><img src="https://img.shields.io/github/stars/huanweide/litdoctor" alt="Stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/huanweide/litdoctor" alt="License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node"></a>
</p>

# litdoctor

> Zero-dependency, single-file Node CLI — a hardcoded-magic-value / repeated-literal hygiene checkup: a 0–100 health score plus an honest CI gate.

> [!WARNING]
> **This axis has been merged into the [doctors](https://github.com/huanweide/doctors) monorepo and is no longer maintained.**
> The code now lives at [`doctors/packages/litdoctor/`](https://github.com/huanweide/doctors/tree/main/packages/litdoctor) and runs as the `doctors lit` subcommand (or `node packages/litdoctor/index.js`). This repository no longer accepts changes — please use <https://github.com/huanweide/doctors>.

**Part of the [Engineering Health Family](https://github.com/huanweide/family-showcase)** (18 zero-dependency checkup axes). Standalone tool — see [doctors](https://github.com/huanweide/doctors) (monorepo) and [enghealth](https://github.com/huanweide/enghealth) (unified runner).

A "hardcoded magic value / repeated literal" hygiene checkup. It scans the JS/TS/Python/Go ecosystem, finds stray bare magic numbers and repeated string literals, gives a 0–100 health score, and ships an **honest** CI gate.

- Zero-dependency: pure Node built-in modules, single-file `index.js`, copy-and-run, works offline.
- Cross-language: one rule set for JS/TS/Python/Go.
- Three-state gate: `pass` / `fail` / `inconclusive` — **never falsely reports passed when it finds nothing**.

## Install / usage

No install needed — clone and run:

```bash
node index.js                       # scan current directory
node index.js ./src                 # scan a specific directory
node index.js --json --root ./src --min-score 90   # pure JSON + real gate (for CI)
```

To use it as a global command (the package is **not published to npm**, so `npm i -g litdoctor` returns 404):

```bash
git clone https://github.com/huanweide/litdoctor.git
cd litdoctor && npm link            # then use `litdoctor ./src` directly
```

## Who should use this

- You want to catch magic numbers and copy-pasted string literals across JS/TS/Python/Go without installing ESLint/SonarQube/a service.
- You need a CI gate that degrades honestly (reports `inconclusive`, not `pass`) when nothing was scanned.

## Who should NOT use this

- You need full duplicate-code-block detection (≥5 consecutive lines) — that is `dupscan`'s job; `litdoctor` targets scattered identical literals.
- You want security semantics — `litdoctor` only flags the "magic value / repeated literal" hygiene dimension, it does not judge security deeply.

## Detection rules

| Rule | Level | Description |
|------|-------|-------------|
| `magic-number` | medium | Bare numeric literal (non-idiomatic, e.g. `200` / `3000` / `86400000`); suggest a named constant |
| `repeated-literal` | low | The same string literal (length ≥ 7) repeated ≥ 3 times; suggest extracting to a constant/config |

Idiomatic-number allowlist (not flagged): `0 1 -1 2 3 4 5 6 7 8 9 10 20 25 50 60 64 100 256 512 1000 1024 10000 0.5 -0.5`.

> This list is item-by-item compared against the source `COMMON_NUMBERS` by the unit test `DEFAULTS whitelist matches README documented values`; changing the source without updating the docs turns CI red.

Exclusion rules match by **exact path segment** (not substring): `node_modules` `.git` `dist` `build` `coverage` `out` `.next` `.nuxt` `vendor` `__pycache__` `.venv` `venv`, plus test files (`*.test.*` `test.*` `tests/` `__tests__/` `test_*.py` `*_test.go`).

So normal source files whose names happen to contain keywords — `distribution.js`, `rebuild.js`, `coverage_report.js` — are **not** mis-skipped, while a real `dist/` directory is excluded as expected. Test detection only looks at the path relative to `--root`, so a project placed under any directory (even one whose name contains `tests`) scans normally.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--root <dir>` | `.` | Scan root |
| `--json` | off | Output pure JSON (with `gate` and `basisComplete` fields) |
| `--min-string-len <n>` | 7 | Minimum length for a repeated literal |
| `--repeat-threshold <n>` | 3 | Repeat count threshold for a literal |
| `--max-issues <n>` | ∞ | Max total issues (fail above) |
| `--max-medium <n>` | ∞ | Max medium-level issues |
| `--max-low <n>` | ∞ | Max low-level issues |
| `--min-score <n>` | unset | Minimum health score (fail below) |
| `--fail-on-high` | off | Kept for compatibility (no high rule currently) |

All numeric parameters must be **non-negative integers**: missing value, decimals, negatives, trailing garbage (e.g. `12abc`), or empty string all exit 2. A malformed gate parameter means the gate does not exist — it must not silently downgrade.

## The three-state gate (important)

The worst failure mode for a scan-type gate tool is "**scanned 0 objects but reported passed**" — a green light that never goes out on CI. `litdoctor` therefore never outputs a boolean conclusion; it outputs three states:

| `gate.state` | Exit code | Meaning |
|---|---|---|
| `pass` | 0 | Gate threshold configured, input trustworthy, metrics met |
| `fail` | 2 | Gate threshold configured, and at least one metric unmet |
| `inconclusive` | 3 | **Cannot conclude**: no gate threshold configured, or the scan input is empty / all files have no parseable content |

The JSON output carries two extra fields to help downstream consumers:

```jsonc
{
  "summary": { "files": 128, "issues": 3, "score": 96 },
  "gate": { "state": "pass", "configured": true, "reason": "all metrics met" },
  "basisComplete": true   // false means this conclusion is untrustworthy; do not treat it as compliance evidence
}
```

> Returning `3` instead of `0` when no threshold is configured is deliberate: "I'm just looking" will not be misread as "check passed" in CI. To actually let it pass, write `--min-score 0` explicitly.

## Health score

```
Base 100; tolerates 4 literal-equivalents per 1k lines (magic-number counts 1, repeated-literal counts 0.5).
Each equivalent beyond that deducts 25 points, floored at 0.
```

## CI gate example

```yaml
- name: literal hygiene
  run: node index.js --json --root ./src --min-score 90 --max-medium 5
```

Exit codes: `0` pass / `2` gate failed / `3` cannot conclude / other = runtime error.

## Differentiation

- Complements `dupscan` (duplicate code blocks): `dupscan` finds ≥5 consecutive duplicated lines; `litdoctor` finds scattered identical literals (different granularity, no overlap).
- Clear boundary with `secscan` (security APIs): `litdoctor` only flags the "repeated literal / magic value" hygiene dimension, it does not judge security semantics deeply.
- Unlike ESLint `no-magic-numbers` (JS-only, needs deps + config), SonarQube (needs a service), or fallow (Rust-only), `litdoctor` is **zero-dependency, single-file, cross-language, and its gate tells the truth** — it runs directly in a CI sandbox / offline, no install or binary download required.

## Tests

```bash
node --test          # 42 groups: unit tests + spawn-level smoke
```

`test/smoke-cli.js` really spawns a process to verify the **exit-code contract**. This layer is not optional: `node --test` unit tests only exercise exported functions and never touch `process.exitCode`, so a changed exit code would sail through green.

## License

[MIT](LICENSE)

---

Maintained by **huanweide** · [GitHub](https://github.com/huanweide)

← [Back to the code-health family overview](https://github.com/huanweide/family-showcase)
