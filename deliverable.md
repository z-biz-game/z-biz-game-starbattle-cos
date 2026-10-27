# 双星 Star Battle · 区域双星推理 · 交付卡

> 本文件由 `003_辅助能力/audit/script/gen_deliverable.py` 从本仓 README、package.json 与 `git ls-files` 生成，**不要手改**；改源后重跑，`--check` 必须逐字节一致。
> 读数取自本仓 `git ls-files` 与 package.json，均不含本文件自身；这里不写提交号，所以 `--check` 比的是内容，不是时间。

## 一句话

一个零猜测的益智盘：`N×N` 被切成 `N` 个不规则区域，**每行、每列、每个区域正好两颗星，

- 仓名：`z-biz-game-starbattle-cos`　组别：A · 益智消除与棋类
- 技术栈：Electron + Canvas

## 怎么跑

```sh
npm start    # node server.cjs
```

## 怎么验

| 层 | 命令 |
| --- | --- |
| 整仓门禁 | `bash tools/verify.sh` |
| 单元/规则测试 | `npm test` |
| npm verify | `npm run verify` |
| 文档腿 | `node tools/docs-test.mjs` |

## 规模

| 指标 | 读数 |
| --- | ---: |
| 跟踪文件 | 54 |
| 应用代码 | 4,253 行（JS 3,545 / CSS 547 / HTML 161） |
| 测试/工具文件 | 10 个 |
| 依赖 | `dependencies` 0 / `devDependencies` 1 |
| 位图资产（不含 shots） | 13 个 / 1893 KB |

## 目录

```
.github .gitignore DESIGN.md LICENSE README.md assets css electron icons index.html js manifest.webmanifest package.json server.cjs sw.js tools
```

## 已知边界

README 没有单列“未实现/限制”小节；以 README 正文与仓内闸为准。

## 证据

- 重跑：在 lead 仓根执行 `python3 003_辅助能力/audit/script/gen_deliverable.py ../z-biz-game-starbattle-cos --check`，应与本文件逐字节一致。
- 漂了就重跑并复核读数变化：新增文件、改 README 的边界小节、加/删闸都会让它变，这些变化本身就是要看的内容。
