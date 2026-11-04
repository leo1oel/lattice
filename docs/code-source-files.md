# Code and configuration sources

Project file creation, text-source import/drop, content search and explicit
agent file attachments recognize these additional common text formats:

- JavaScript modules: `.mjs`, `.cjs`.
- Rust, Go, C/C++ and headers: `.rs`, `.go`, `.c`, `.cc`, `.cpp`, `.h`, `.hpp`.
- Java, Ruby, Perl and R: `.java`, `.rb`, `.pl`, `.r`.
- Shell scripts: `.sh`, `.bash`, `.zsh`.
- Configuration/web/query sources: `.json`, `.yaml`, `.yml`, `.toml`, `.xml`,
  `.css`, `.scss`, `.sql`.

Extensions are case-insensitive. These use the existing UTF-8 text editor and
language resolution; no compiler, interpreter, language server or package
manager is installed by creating a file. JSON starts as an empty object and
shell scripts start with the corresponding shebang. Shell files are ordinary
non-executable files until the user changes their mode or runs an interpreter.

This extends the same source-kind table used by Python support. Existing
project path, symlink and protected-state guards still apply. Unknown executable
formats such as `.exe` remain unavailable through source-file creation. Bare
names retain the research workspace's existing `.tex` default.
