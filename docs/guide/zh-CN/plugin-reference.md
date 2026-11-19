# 插件清单与 API

本页列出插件可以声明、申请、调用和返回的内容，以及插件市场额外的规则。完整的协议（每个字段和错误码）见 [docs/plugins.md](https://github.com/leo1oel/lattice/blob/main/docs/plugins.md)（英文），它所依据的 schema 是 [plugin-api/schema/level-1.json](https://github.com/leo1oel/lattice/blob/main/plugin-api/schema/level-1.json)。

## 清单文件

`lattice-plugin.toml` 放在插件文件夹的根目录。

| 键 | 是否必需 | 含义 |
|---|---|---|
| `schema` | 是 | 清单格式：`1`。 |
| `id` | 是 | 反向域名、全小写、唯一，永不更改。`app.lattice.*` 是保留的。 |
| `name` | 是 | 显示在设置里，以及命令面板中每个命令的前面。最多 80 个字符。 |
| `version` | 是 | 插件自己的版本号，semver 格式（`1.2.3`）。 |
| `api` | 是 | 需要的最低插件 API 级别：`1`。 |
| `license` | 是 | SPDX 标识。插件市场和从 URL 安装接受 0BSD、Apache-2.0、BSD-2-Clause、BSD-3-Clause、BSL-1.0、GPL-3.0(-only/-or-later)、ISC、LGPL-3.0(-only/-or-later)、MIT、MPL-2.0、Unlicense 和 Zlib。 |
| `description` | 上架市场时必需 | 一两句话，最多 500 个字符。 |
| `repository` | 否 | 源码的 https 链接。 |
| `runtime` | 是 | `"node"` 用 Lattice 自带的 Node（Node 24）运行。`"exec"` 按目标三元组运行原生可执行文件（`[targets]`），但插件市场只收 `node` 插件。 |
| `main` | `node` 插件必需 | 入口脚本，相对于插件文件夹。 |
| `[permissions]` | 否 | 插件可以访问什么，见下文。 |
| `[[commands]]` | 是 | 1 到 32 个命令。 |

每个命令有 `id`（小写字母、数字和连字符）、`title`（最多 80 个字符）、可选的 `description`，以及可选的 `input`：`{ kind = "none" }`（默认）立即运行，`{ kind = "text", placeholder = "…" }` 先让用户输入。

未知的顶层键会被忽略，所以为新版 Lattice 写的清单在旧版上也能加载。`[permissions]` 下的未知键则是错误：它申请的是这个版本的 Lattice 无法强制执行的东西。

## 权限

插件只能访问清单里声明、并且用户开启它时允许的内容。这由 Lattice 用 macOS 沙盒和对每次调用的检查来保证，而不是插件自己的承诺。

| 权限 | 允许什么 | 开启时向用户列出的内容 |
|---|---|---|
| `project-read = ["context"]` | 每次运行的 `context` 中包含主文档、当前文件、参考文献路径、选区（最多 12,000 个字符）和光标位置 | 读取打开的文件、选区和光标位置 |
| `project-read = ["bibliography"]` | 通过 `host.bibliographyEntries()` 读取解析后的 `.bib` 条目 | 读取项目的参考文献 |
| `network-local = [23119]` | 只能直接连接本机的这些端口（最多 8 个） | 连接 localhost:23119 |
| `network = ["https://api.crossref.org"]` | 通过 `host.fetch()` 向这些 https 源发送请求（最多 16 个，不带路径） | 向 https://api.crossref.org 发送请求 |
| `secrets = ["api-key"]` | 用户在插件卡片里保存、存放在钥匙串中的值，用 `host.secret()` 读取（最多 8 个名称） | 使用已保存的密钥“api-key” |

不申请任何权限的插件会显示“除项目名称外无其他访问权限”。它仍然可以读取自己的文件夹、读写自己的数据文件夹（`LATTICE_PLUGIN_DATA_DIR`），并知道项目名称。它永远拿不到用户的环境变量、API key 或其他文件，也读不到上面以外的项目文件。

只申请够用的权限。更新时申请更多权限的插件会停止运行，直到用户再次允许（见 [发布插件](plugin-publishing.md#更新与权限变化)），而且市场审核会问每项权限的用途。

## 一次运行

每个命令都在一个新进程里运行：

1. Lattice 发送 `initialize`，SDK 回答 API 级别。
2. Lattice 发送 `command/run`，带上命令 id、`input` 和 `context`。
3. 处理函数可以调用 Lattice，发送日志和进度。
4. 处理函数返回后，Lattice 关闭 stdin 并结束进程。

所以两次运行之间什么都不会保留，除非插件写进了自己的数据文件夹。运行超过 120 秒会被停止。用户取消或超时的时候，处理函数的 `signal` 会中止：把它传给所有耗时的操作。

进程拿到的环境变量有 `PATH=/usr/bin:/bin`、指向数据文件夹的 `HOME` 和 `TMPDIR`、`LANG`、`LATTICE_PLUGIN_ID`、`LATTICE_PLUGIN_API_LEVEL` 和 `LATTICE_PLUGIN_DATA_DIR`。

## 调用 Lattice

处理函数的 `host` 有这些方法：

| 方法 | 需要 | 返回 |
|---|---|---|
| `host.bibliographyEntries(file?)` | `project-read = ["bibliography"]` | `{ files: [{ path, entries: [{ key, type, fields, line }], error? }] }`，字段名为小写 |
| `host.fetch(url 或 { url, method?, headers?, body? })` | URL 的源在 `network` 中 | `{ status, headers, body }`；正文最大 4 MiB，限时 30 秒 |
| `host.secret(name)` | 名称在 `secrets` 中 | 已保存的值，或 `null` |
| `host.log(level, message)` | 无 | 写入 Lattice 的日志；`level` 为 `error`、`warn`、`info` 或 `debug` |
| `host.progress(message, fraction?)` | 无 | 命令运行时在命令面板中显示 `message` |

没有相应权限的调用会以 `HostError` 失败，`code` 为 -32001。例如在 `network = ["https://api.crossref.org"]` 下：

```js
const response = await host.fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
if (response.status !== 200) throw new PluginError(`Crossref answered ${response.status}.`);
const work = JSON.parse(response.body).message;
```

## 返回结果

返回以下三种之一。每种都可以带 `summary`：代表整个结果的纯文本，用于日志和通知。

- **消息：** `{ kind: "message", markdown }`。CommonMark，不支持原始 HTML。
- **列表：** `{ kind: "items", items: [{ id, title, subtitle?, detail?, badges?, actions? }] }`。用户选择一个条目，按回车执行它的第一个操作。
- **问题：** `{ kind: "diagnostics", items: [{ id, file, line?, severity, code?, message, fixes? }] }`。`severity` 为 `error`、`warning` 或 `info`；`code` 是稳定的规则名，例如 `duplicate-key`；`fixes` 是操作。

要显示错误，就抛出 `new PluginError("出了什么问题、该怎么办。")`。

## 操作

插件从不自己修改任何东西。它附上操作，由 Lattice 执行，每次修改文件前都先征得用户同意：

| `type` | 参数 | Lattice 做什么 |
|---|---|---|
| `insertCitation` | `key` | 在光标处插入 `\cite{key}` |
| `addBibEntry` | `bibtex`、`file?` | 显示该条目，用户确认后加入参考文献 |
| `replaceBibEntry` | `key`、`bibtex`、`file?` | 显示改动，用户确认后替换该条目 |
| `reveal` | `file`、`line?` | 打开项目文件并跳到该行 |
| `openUrl` | `url`（http 或 https） | 在浏览器中打开 |
| `copy` | `text` | 复制 |

每个操作还可以带可选的 `title`。Lattice 显示操作前会逐一检查：路径必须在项目之内，URL 必须是 http 或 https，BibTeX 必须恰好是一条有效条目。不符合的会被丢弃。

## 兼容性

插件 API 级别只会增加内容：新方法、可选字段、结果类型和操作类型。声明 `api = 1` 的插件在之后的每个 Lattice 版本上都能继续运行，直到级别 1 退役；退役至少提前两个次版本在 [docs/plugins.md](https://github.com/leo1oel/lattice/blob/main/docs/plugins.md#deprecation-register) 中公布。只读取你认识的字段，因为结果和上下文以后可能增加字段。
