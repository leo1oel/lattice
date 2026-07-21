# Lattice 应用内自动更新 —— 已接好 + 你要做的收尾

我已经把应用内自动更新整套接进了项目（不需要 Apple 的 99 美元账号，Tauri 更新器用自己的免费密钥）。下面是「已经改了什么」和「你需要做的 4 步」。

## 已经改好的部分（代码里）

- `src/app-updater.tsx` + `src/app-updater.css`：更新逻辑 + UI。
  - 设置里可选**手动 / 自动**更新（`UpdateModeSetting`，已加到「设置 → Editor & builds → App updates」）。
  - 有新版本时**右上角弹出提示条**（`UpdateBanner`，已挂在 `main.tsx`）。
  - **一键更新**：点「Update now」→ 下载（带进度条）→ 安装 → 自动重启。自动模式下发现新版本会直接装。
- `main.tsx`：用 `<UpdaterProvider>` 包住 App，并挂上 `<UpdateBanner corner="top-right" />`。
- `src-tauri/Cargo.toml`：加了 `tauri-plugin-updater`、`tauri-plugin-process`。
- `src-tauri/src/lib.rs`：注册了这两个插件。
- `src-tauri/tauri.conf.json`：开了 `bundle.createUpdaterArtifacts`，并配好 `plugins.updater`（公钥 + 更新地址指向 `github.com/leo1oel/lattice` 的 Releases）。
- `src-tauri/capabilities/default.json`：加了 `updater:default`、`process:allow-relaunch` 权限。
- `package.json`：加了 `@tauri-apps/plugin-updater`、`@tauri-apps/plugin-process`。
- `.github/workflows/release.yml`：一键发版的 CI（push 一个 tag 就自动构建+签名+发布+生成 `latest.json`）。

## 关于更新签名密钥（重要）

我用 `tauri signer generate` 生成了一对**可用的启动密钥**：

- **公钥**：已经填进 `tauri.conf.json` 的 `plugins.updater.pubkey`，可以直接用。
- **私钥**：我单独发给你了（`lattice-updater.key`）。**它是机密，不要提交进 git**。用它给每个更新包签名。

> 这把私钥在我的临时环境里生成过，安全起见，等你要正式对外发布时，建议自己重跑一次
> `pnpm tauri signer generate` 换一对新的，把新公钥填回 `tauri.conf.json`，新私钥只存在你本地/CI Secret 里。换密钥后，**老版本装的用户需要手动装一次新版**才能继续走自动更新（因为验签公钥变了）。

## 你要做的 4 步

### 1. 装依赖（在你的 Mac 上）
```bash
pnpm install
```
（拉下新加的两个 JS 插件；Rust 插件会在下次 `tauri build` 时自动拉。）

### 2. 本地验证能跑
```bash
pnpm tauri dev
```
右上角短时间内会去检查更新（本地没有新版本时不会弹提示，属正常）。设置里能看到「App updates」的手动/自动开关和「Check now」。

### 3. 配好发版（二选一）

**方式 A：CI 自动发版（推荐，最省事）**
1. 到 GitHub 仓库 → Settings → Secrets and variables → Actions，加两个 secret：
   - `TAURI_SIGNING_PRIVATE_KEY` = `lattice-updater.key` 文件的**全部内容**
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = 空字符串（这把 key 没设密码）
2. 每次发版：把 `tauri.conf.json` 和 `package.json` 里的 `version` 加一档（比如 `0.1.38`），提交，然后打 tag 推上去：
   ```bash
   git tag v0.1.38
   git push origin v0.1.38
   ```
3. CI 会在 macOS runner 上构建通用包（Intel + Apple Silicon）、用更新私钥签名、发布 GitHub Release，并生成 `latest.json`。已装用户下次开 app 就会收到更新提示。

**方式 B：本地手动发版**
```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat /path/to/lattice-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
pnpm tauri build
```
产物在 `src-tauri/target/release/bundle/`：
- `macos/Lattice.app`（可压缩 zip 直接发别人）与 `dmg/Lattice_x.y.z_*.dmg`
- `macos/Lattice.app.tar.gz` + `Lattice.app.tar.gz.sig`（更新包 + 签名）

然后在 GitHub 上新建一个 Release（tag 例如 `v0.1.38`），把 `.app.tar.gz`、`.app.tar.gz.sig`、`.dmg` 传上去，再手写一个 `latest.json` 一并作为 release 资产上传：
```json
{
  "version": "0.1.38",
  "notes": "本次更新内容……",
  "pub_date": "2026-07-21T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<把 Lattice.app.tar.gz.sig 的内容整段粘进来>",
      "url": "https://github.com/leo1oel/lattice/releases/download/v0.1.38/Lattice.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "<同上（通用包可复用同一个）>",
      "url": "https://github.com/leo1oel/lattice/releases/download/v0.1.38/Lattice.app.tar.gz"
    }
  }
}
```
更新地址已配成 `releases/latest/download/latest.json`，所以把最新 Release 设为 “latest” 即可。（方式 A 的 CI 会自动生成这个文件，不用手写。）

### 4. 分发给别人（暂不做 Apple 公证）
把 `Lattice.app`（zip）或 `.dmg` 发给别人。因为没做 Apple 公证，别人**第一次**打开要放行一次：
- macOS Sequoia(15)：双击 → 弹窗点「完成」→ 系统设置 → 隐私与安全性 → 拉到底点「仍要打开」。
- 或终端：`xattr -dr com.apple.quarantine /Applications/Lattice.app`

之后应用内自动更新是无感的，不用再放行。

## 以后想「双击零警告」时

再花 99 美元/年加入 Apple Developer Program，做 Developer ID 签名 + 公证（公证是**自动扫描、几分钟出结果、无人工审核**）。到时候只需在 CI 里加 `APPLE_CERTIFICATE`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` 等 secret，其余都不用动。

## 备注
- 我没法在这边替你跑 `pnpm tauri build`（编译 macOS 应用必须在 macOS 上，我这边是 Linux 云沙箱）。上面的命令都在你 Mac 上执行。
- CI 的 `beforeBuildCommand` 会跑 `pnpm prepare:agent`（准备内置 agent 二进制）。如果这一步在 CI 里因为拿不到 `binaries/lattice-agent` 而失败，最稳妥是先用**方式 B 本地发版**，等 agent 二进制的获取方式在 CI 里配好后再切到方式 A。
