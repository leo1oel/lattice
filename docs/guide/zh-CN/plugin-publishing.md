# 发布插件

**设置 › 插件 › 浏览** 中的插件市场列出的是 Lattice 注册表里的插件。注册表是一个 GitHub 仓库，每个插件是其中一个小条目，通过 pull request 添加。条目钉住你源码仓库的一个标签，以及你的插件文件夹在这个标签下打包后的 SHA-256。注册表从不接受你自己打好的 zip：它的 CI 自己打包你标签下的文件夹，只有哈希一致时才发布这个 zip，所以审核者读过的源码和用户装到的内容逐字节相同。

本页把 [第一个插件](plugin-development.md) 里的 Hello 插件上架到市场。主题走同一个注册表，见 [制作主题](theme-development.md)。

## 注册表地址

本指南中只有这张表和 [签名](#6-签名) 一节里的命令写了注册表的地址，所以注册表迁到 lattice-writer GitHub 组织时，要改的就是这些。

| 内容 | 位置 |
|---|---|
| 注册表仓库 | [lattice-writer/lattice-plugins][registry] |
| 它的 README：条目格式和 CI 检查 | [README.md][registry-readme] |
| 审核清单 | [REVIEW.md][review] |
| pull request 检查清单 | [pull_request_template.md][pr-template] |
| 紧急停用名单 | [blocked.json][blocked] |
| Lattice 读取的签名索引 | [index.json][index]，以及 [index.json.minisig][index-sig] |
| 签名公钥 | [keys/primary.pub][primary-key] |

## 发布之前

下面这些由注册表自动检查，其余由审核者阅读：

- 插件是 `node` 插件，脚本是可读的源码：不能是压缩或生成的代码（不能有超过 1,000 个字符的行），不能用 `eval`、`new Function` 或 `vm`，不能下载并运行远程代码。依赖要以可读源码的形式放在插件文件夹里。
- 清单有 `description`，`license` 是 Lattice 接受的许可证（见 [清单文件](plugin-reference.md#清单文件)）。
- 文件夹里有 `README.md` 和 `LICENSE` 文件。README 列出每个 `network` 源和 `network-local` 端口及其用途，说明每个密钥的用途；如果插件会把项目内容发到本机之外，要明确写出来。
- `id` 属于你，不冒充他人：未经许可不要用“Lattice”或“Overleaf”这样的名字，不要用容易混淆的 id。
- 你已经在 Lattice 里通过从文件夹安装运行过它的每个命令。

给 Hello 加上 `README.md`：

```markdown
# Hello

A Lattice plugin that greets you and counts the words you selected.

## What it reads

- `project-read = ["context"]`: the project's name, the active file and the selected text, to put them in its answers.

It makes no network connections and sends nothing off your Mac.
```

再加一个 `LICENSE`，写上 MIT 许可证全文和你的名字。

## 1. 给源码打标签

把插件文件夹推到一个公开的 GitHub 仓库（这里是 `https://github.com/yourname/lattice-hello`，插件在仓库根目录），然后给要上架的提交打标签：

```sh
git tag v0.1.0
git push origin v0.1.0
```

插件也可以放在大仓库的某个子文件夹里，条目的 `path` 指向那个文件夹即可。

## 2. 打包并计算哈希

用 Lattice 的打包脚本打包该标签的一份干净检出：

```sh
curl -fsSLO https://raw.githubusercontent.com/leo1oel/lattice/main/plugin-sdk/scripts/pack-plugin.mjs
git clone --quiet --depth 1 --branch v0.1.0 https://github.com/yourname/lattice-hello release
node pack-plugin.mjs release dist/hello-0.1.0.zip
```

它打印 zip 的路径和 SHA-256：

```text
/Users/you/dist/hello-0.1.0.zip
sha256 c6d59e1c411f807169880145090894fb684ecdf624f13351a97f60e48399db87
```

打包是可复现的：同样的文件在任何 Mac 或 CI 机器上都得到同样的字节，与文件时间戳、所有者或磁盘列出文件的顺序无关。它收录文件夹下的普通文件，按路径排序，跳过测试（`*.test.mjs`）和所有名字以点开头的文件或文件夹（所以 `.git` 不会进去），每个文件都不压缩、直接存储（stored），时间固定为 1980-01-01，权限为 0644，可执行文件为 0755。之所以存储而不压缩，是因为不同 zlib 版本压缩出的字节不同，压缩后的 zip 在你的 Mac 和注册表 CI 上会得到不同的哈希。`unzip -v dist/hello-0.1.0.zip` 会把每个条目列为 `Stored`。

要打包干净的克隆，而不是你的工作文件夹。CI 打包的正是 git 在该标签下记录的内容，所以文件夹里一个未跟踪的文件，或者 git 没有记录的可执行权限，都会让哈希和 CI 对不上。打包两次应得到同样的哈希；如果不同，说明文件夹里有东西在变。

## 3. 添加条目

Fork 注册表（[地址](#注册表地址)），在你的 fork 里添加 `plugins/<id>/entry.json`，这里是 `plugins/io.github.yourname.hello/entry.json`：

```json
{
  "id": "io.github.yourname.hello",
  "version": "0.1.0",
  "repository": "https://github.com/yourname/lattice-hello",
  "tag": "v0.1.0",
  "commit": "<the full 40-character sha the tag points at>",
  "path": ".",
  "sha256": "c6d59e1c411f807169880145090894fb684ecdf624f13351a97f60e48399db87",
  "author": "Your Name",
  "categories": ["writing"]
}
```

- `id` 和 `version` 与清单一致，文件夹名等于 `id`。
- `commit` 是在你的仓库里运行 `git rev-parse "v0.1.0^{commit}"` 打印的值。
- `path` 是插件在仓库里的文件夹，在根目录时写 `"."`。
- `sha256` 是 `pack-plugin.mjs` 打印的值。
- `categories` 最多四个小写单词，例如 `citations`、`bibliography` 或 `writing`。

开 pull request 之前，先运行和 CI 相同的检查。在你 fork 的检出里，确认 `main` 是最新的，并使用 Node 22 或更高版本：

```sh
npm ci
node scripts/validate.mjs --base origin/main
```

对新插件，它打印：

```text
ok   plugins/io.github.yourname.hello/entry.json
     note: asks for: {"projectRead":["context"],"networkLocal":[],"network":[],"secrets":[]}
     note: new plugin: needs a human review per REVIEW.md (first submission)
```

哈希不对时会失败，提示 `sha256 mismatch: the entry says …, the pack of . at <commit> is …`。然后开 pull request，一个 pull request 只放一个条目，并填写其中的检查清单。

## 4. CI 检查什么

每个 pull request 上，注册表的 `validate.mjs` 只拉取你的标签，要求它指向 `commit`，并从 git 对象库里读取该提交下的文件夹。然后它：

- 拒绝符号链接和子模块，并遵守 Lattice 的上限：10,000 个文件、解压后 200 MiB、zip 50 MiB；
- 打包文件夹，把 SHA-256 和条目里的比对；
- 按 Lattice 的方式检查清单（schema、id、版本、API 级别、名称、权限和命令），以及市场规则：运行时为 `node`，有描述，许可证在接受列表中，有 README 和许可证文件；
- 拒绝有超过 1,000 个字符的行、或使用 `eval`、`new Function`、`vm` 的脚本；
- 对更新，检查 `version` 是否升高，打印新版本比已发布版本多申请的权限，并标出仓库或运行时的变化；
- 检查 `blocked.json` 格式是否正确。

## 5. 人工审核

CI 做机械的那一半；另一半由维护者（目前是 Leo）按 [REVIEW.md][review] 审核，并把结论写在 pull request 里。每次首次提交、以及改变仓库或所有者、扩大权限或改变运行时的更新，都要人工审核。其他更新在 CI 通过并经过 24 小时冷静期后合并，期间任何维护者都可以叫停。

审核者阅读你钉住的提交下的源码，并会问：

1. id 或名称是否在冒充他人？
2. 描述是否准确，许可证是否齐全，仓库是否真实且公开？移植的作品要注明原作者。
3. 权限是否与宣称的用途相符，每个源、端口和密钥是否都在 README 里说明了？
4. 它是否会把项目内容发到本机之外？如果会，README 和描述是否明确写出？
5. 源码是否可读，没有下载并运行远程代码，没有未以可读源码形式附带的依赖？
6. 它是否以误导人的方式重复了内置功能？

## 6. 签名

你不需要签任何东西。pull request 合并后，注册表的发布工作流会打包每个条目，生成 `index.json` 和 `blocked.json`，用注册表的 minisign 密钥给两者签名，再连同 zip 一起发布到 GitHub Pages。签名任务只在 `main` 上运行，每次都要等 Leo 批准，私钥只作为该任务受保护环境的密钥存在。

Lattice 用内置在应用里的公钥验证这两个签名，拒绝比上次验证过的更旧的索引，并在安装前核对每个 zip 的 SHA-256 和清单是否与索引一致。所以无论是被攻破的下载服务器，还是拿到你 GitHub 账号的人，都改不了用户装到的内容。你也可以自己验证已发布的索引：

```sh
curl -fsSLO https://leo1oel.github.io/lattice-plugins/index.json
curl -fsSLO https://leo1oel.github.io/lattice-plugins/index.json.minisig
curl -fsSLO https://raw.githubusercontent.com/lattice-writer/lattice-plugins/main/keys/primary.pub
minisign -V -p primary.pub -m index.json
```

它会打印 `Signature and comment signature verified`，以及类似 `lattice-plugins file:index.json serial:2` 的可信注释。（用 `brew install minisign` 安装 minisign。）

下一次发布后，你的插件就会出现在 **浏览** 中，安装后标为 **已审核**。

## 更新与权限变化

发布新版本：

1. 在 `lattice-plugin.toml` 里升高 `version`，提交，并给这个提交打标签（`v0.2.0`）。
2. 像第 2 步一样，重新打包干净的标签。
3. 在你的条目里修改 `version`、`tag`、`commit` 和 `sha256`，然后开 pull request。

版本只能升高，仓库也应保持不变：换仓库需要人工审核。更新申请了更多权限时，CI 会准确列出新增的部分，例如：

```text
ok   plugins/io.github.yourname.hello/entry.json
     note: asks for: {"projectRead":["context"],"networkLocal":[],"network":["https://api.crossref.org"],"secrets":[]}
     note: new network: https://api.crossref.org
     note: permissions grew: needs a human review
```

用户在 **设置 › 插件** 中看到的是：

- 不申请新权限的更新由 **全部更新** 应用，插件保持开启。
- 申请了更多权限的更新单独留在自己的卡片上，只列出新增的部分，用户可以选择 **允许并更新**，或保留现有版本。

所以尽量保持权限稳定；确实需要新权限时，在 README 和 pull request 里说明原因。开发时从文件夹安装的插件也一样：新的权限会让插件停止运行，直到你选择 **查看…** 并重新开启。

## 紧急停用开关

如果某个已发布的版本被发现有害或有严重问题，注册表可以在所有 Mac 上把它停用。[blocked.json][blocked] 列出被停用的版本，和索引一起签名发布：

```json
[
  {
    "id": "io.github.yourname.hello",
    "versions": "<=0.1.0",
    "action": "disable",
    "reason": "Crashes on projects without a main document; update to 0.1.1.",
    "url": "https://github.com/yourname/lattice-hello/issues/1"
  }
]
```

- `versions` 是一个 semver 范围，`"*"` 表示所有版本。
- `"disable"` 关闭已安装的副本，拒绝安装这些版本，并在插件卡片上显示原因，**了解更多** 链接到 `url`。`"warn"` 让插件继续工作，把原因显示为警告。
- Lattice 从不删除插件的文件或数据文件夹，也从不影响从文件夹安装的插件。
- 从 `plugins/` 中删除条目只会阻止新的安装。已安装的副本会继续工作，除非也被停用。

要撤回你自己的某个版本，开一个 pull request 往 `blocked.json` 里加一项，同时发布修复后的版本；任何人发现有害插件，都可以用同样的方式开 issue 或 pull request。它在下一次签名发布时生效。

[registry]: https://github.com/lattice-writer/lattice-plugins
[registry-readme]: https://github.com/lattice-writer/lattice-plugins#readme
[review]: https://github.com/lattice-writer/lattice-plugins/blob/main/REVIEW.md
[pr-template]: https://github.com/lattice-writer/lattice-plugins/blob/main/.github/pull_request_template.md
[blocked]: https://github.com/lattice-writer/lattice-plugins/blob/main/blocked.json
[index]: https://leo1oel.github.io/lattice-plugins/index.json
[index-sig]: https://leo1oel.github.io/lattice-plugins/index.json.minisig
[primary-key]: https://github.com/lattice-writer/lattice-plugins/blob/main/keys/primary.pub
