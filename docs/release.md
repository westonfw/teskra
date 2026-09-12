# Teskra 签名与发布流程（TASK-073）

本文档记录 Windows 安装包的签名与发布流程：`build → sign → package → checksum → release notes`。

打包配置本身见 `apps/desktop/electron-builder.yml`（TASK-072）；本文只覆盖其上游/下游环节。

## 流水线入口

```bash
npm run release                          # = node scripts/release.mjs
npm run release -- --target win          # 强制 Windows 目标（默认取当前平台）
npm run release -- --target dir          # 只产出未打包目录，用于本地快速验证
npm run release -- --skip-build          # 复用已有 apps/desktop/out
npm run release:checksums                # 仅对 apps/desktop/dist 重新生成 SHA256SUMS.txt
npm run release:checksums -- --verify    # 校验 SHA256SUMS.txt
```

`scripts/release.mjs` 依次执行：

1. **版本号解析**（见下节）。
2. **签名状态检查**：目标为 win 且 `CSC_LINK` + `CSC_KEY_PASSWORD` 均存在时提示将执行
   Authenticode 签名；否则打印警告并继续产出**未签名**安装包（不失败）。
3. **build**：`npm run build --workspace @teskra/desktop`（electron-vite）；构建环境注入
   `TESKRA_APP_VERSION=<version>`，由 `apps/desktop/electron.vite.config.ts` 的 `define`
   烘焙进 main / preload bundle（`window.teskra.appVersion` 的来源，见
   `apps/desktop/src/main/build-info.ts`）。
4. **package**：electron-builder，注入 `-c.extraMetadata.version=<version>`，`--publish never`。
5. **checksum**：`scripts/make-checksums.mjs` 生成 `apps/desktop/dist/SHA256SUMS.txt`。
6. **release notes**：从 git log 生成 `apps/desktop/dist/RELEASE_NOTES.md` 骨架
   （范围为上一个 tag 到 HEAD；无 tag 时取最近 50 条提交），人工补全「已知问题」等章节。

## 版本号自动注入

优先级（高 → 低）：

1. HEAD 上的精确 git tag（`git describe --tags --exact-match`），`v1.2.3` → `1.2.3`；
2. `--version` 参数（用于 workflow_dispatch 手动触发）；
3. `apps/desktop/package.json` 的 `version`（开发机默认路径）。

解析结果从同一个值注入两处：build 时经 `TESKRA_APP_VERSION` 烘焙进 main / preload bundle
（`window.teskra.appVersion`），package 时经 electron-builder 的 `-c.extraMetadata.version`
注入，因此 artifact 文件名（`Teskra-Setup-<version>.exe` / `Teskra-<version>-portable.exe`）、
应用自身版本号与渲染进程可见版本号始终一致。开发模式（未设置 `TESKRA_APP_VERSION`）下 define
回退到 `apps/desktop/package.json` 的 `version`，与 `app.getVersion()` 一致。
解析结果不是 semver 时脚本直接失败，不会产出带脏版本号的产物。

## Authenticode 签名（Windows）

签名由 electron-builder 内置完成，完全通过环境变量驱动（electron-builder 官方约定，
无需改动 `electron-builder.yml`）：

| 环境变量           | 内容                                                        |
| ------------------ | ----------------------------------------------------------- |
| `CSC_LINK`         | 代码签名证书：PFX 文件路径，或 base64 编码的 PFX 内容       |
| `CSC_KEY_PASSWORD` | PFX 密码                                                    |

证书准备（一次性）：

1. 从 CA 获取 Authenticode 代码签名证书（EV 证书可立即获得 SmartScreen 信誉；OV 需要积累）。
2. 导出为 PFX（含私钥）。
3. CI 中：`base64 -w0 cert.pfx` 的结果存入 GitHub Secret `TESKRA_CSC_LINK`，
   密码存入 `TESKRA_CSC_KEY_PASSWORD`（见 `.github/workflows/release.yml`）。
4. 本地：直接设 `CSC_LINK=C:\path\to\cert.pfx`。

两个变量**必须同时设置**；任一缺失时 release 脚本打印警告并产出未签名安装包，
便于在未配置证书的环境（fork、开发机）跑通完整流程。

> **[Windows 验证] 未验证**：实际 Authenticode 签名（含 SmartScreen 行为、签名后安装包
> 在干净 Windows 上的安装）尚未在 Windows 实机验证。验证方式：在设置好上述 Secret 后
> 推送 `v*` tag 触发 Release workflow，检查产物 `signtool verify /pa <installer>.exe`。

## Checksum（SHA256）

`scripts/make-checksums.mjs` 对 `apps/desktop/dist` 下的产物文件生成 `SHA256SUMS.txt`：

- 格式与 GNU sha256sum 一致（`<hash>  <文件名>`、LF、按文件名排序），保证生成结果确定。
- 排除 `SHA256SUMS.txt` 自身与 `RELEASE_NOTES.md`（后者允许打包后编辑）。

验证方式：

```bash
# Linux / macOS / Git-Bash
cd apps/desktop/dist && sha256sum -c SHA256SUMS.txt

# 跨平台（无 coreutils 的 Windows）
node scripts/make-checksums.mjs --verify
```

## 可复现性说明

流程可复现 = 固定工具链 + 锁文件 + 显式版本注入：

- Node 版本由根 `package.json` 的 `engines`（`>=22 <23`）+ `engine-strict` 钉死，
  CI 从同一字段读取；
- 依赖完全由 `package-lock.json` 决定（`npm ci`，不使用 `npm install`）；
- Electron / electron-builder 锁定 minor（升级是独立 Task）；
- 版本号不由打包时刻的状态决定，只来自 tag / `--version` / package.json。

注意：NSIS/PE 产物内部包含打包时间戳，**不保证逐字节（bit-for-bit）复现**；
`SHA256SUMS.txt` 的用途是校验「某一次发布」的产物在传输/下载后未被篡改，
而不是比较两次构建。

## CI：Release workflow

`.github/workflows/release.yml`（与 CI 门禁分离，不影响 `ci.yml` 的合并门禁）：

- 触发：推送 `v*` tag，或 `workflow_dispatch` 手动触发；
- Runner：`windows-latest`，Node 版本从 `engines` 读取；
- 步骤：`npm ci` → `node scripts/release.mjs`（携带 `TESKRA_CSC_LINK` /
  `TESKRA_CSC_KEY_PASSWORD` Secret）→ 上传 `*.exe`、`SHA256SUMS.txt`、
  `RELEASE_NOTES.md` 为 workflow artifact；
- 未配置 Secret 时同样能跑通，产出未签名安装包。

> **[Windows 验证] 未验证**：release workflow 尚未在 windows-latest runner 上实际运行过
> （本仓库尚无 git tag）。首次发布前需推送一个 `v0.x.0` tag 实测。
