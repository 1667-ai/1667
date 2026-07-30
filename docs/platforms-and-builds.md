---
summary: Release targets, platform requirements, and standalone build commands
read_when:
  - checking platform support
  - building a standalone executable
  - preparing release candidates
---

# Platforms and standalone builds

## Release targets

1667 supports these release targets:

- macOS arm64
- macOS x64
- Linux arm64
- Linux x64
- Windows x64

Linux HTTP server mode requires Linux kernel 6.8 or newer. The data file system
must support durable Linux file handles. Linux releases require glibc 2.17 or
newer.

## Build a standalone executable

```sh
cd tui
bun run build:standalone
./dist/1667 --version
./dist/1667 --version --json
./dist/1667 --demo --render-once --size 120x36
```

On Windows, use `.\dist\1667.exe` for these commands.

The build writes `tui/dist/1667` on macOS and Linux. The build writes
`tui/dist/1667.exe` on Windows. The standalone executable contains the TUI. It
also contains the backend worker, dependencies, and Bun runtime. You can move
the standalone executable to a different directory. It does not need Bun or
Node.js at run time.

The build verifies the root version, TUI version, and lockfile version. It reads
the build identity from the executable. It also tests the embedded worker and
the prompt tokenizer.

This standalone executable is a development candidate. The build does not sign
or publish the file. It does not create an archive or an installer.

See [the release instructions](RELEASING.md).
