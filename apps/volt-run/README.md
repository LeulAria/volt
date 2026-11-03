# volt-run

Volt in your browser, with one command:

```sh
npx volt-run
```

It starts Volt on your computer and opens it in a browser tab: your agents, chats, files, terminals
and git, in the same workbench as the Volt app. On your own computer the browser signs in by itself.

## How it starts fast

`volt-run` is one small file with no dependencies. What it runs is Volt's agent server, the process that
runs agents and keeps the chat history, serving the full Volt workbench to the browser. It takes the
quickest way there:

1. **Volt is already running** (the Volt app starts the same server): it opens that one. Under 100 ms.
2. **Volt is installed** (`/Applications/Volt.app`, `~/.local/share/volt`, `%LOCALAPPDATA%\Programs\Volt`):
   it runs the server from there. Nothing to download, and the Volt app keeps using the same server.
3. Otherwise it **downloads Volt once** for your platform from its
   [GitHub release](https://github.com/LeulAria/VOLT/releases) (the disk image on macOS, the tarball on
   Linux, unpacked as it downloads, the zip on Windows), checks its SHA-256 against the checksums this
   package was published with, and keeps it in `~/.volt/runtime`. Later starts skip the download.

A warm start of the server takes about a third of a second: it keeps Node's compile cache in the profile.

Your chats and settings are the Volt app's own (the same profile), so whatever you start in the browser
is in the app too, and the other way round.

## Commands

```text
npx volt-run              start Volt and open it (the default)
npx volt-run stop         stop Volt's agent server
npx volt-run status       whether Volt is running, where, and from which build
npx volt-run pair         a pairing code and link for a phone or another computer
npx volt-run clean        delete the builds volt-run downloaded
```

| Option | |
| --- | --- |
| `-p, --port <n>` | listen on this port (default: the profile's own, 47100-47899) |
| `--host <addr>` | listen on this address; `0.0.0.0` lets phones and other computers on your network pair |
| `--no-open` | don't open the browser |
| `-d, --detach` | start in the background and return; it stops by itself after 15 minutes with no browser or window |
| `--profile <dir>` | use another Volt profile |
| `--app <path>` | run this Volt build: `Volt.app`, an install folder or a Volt checkout |
| `--download` | use a downloaded build even when Volt is installed |
| `--release <v>` | download this Volt version, or `latest` |
| `--channel <c>` | `stable`, `beta` or `nightly` |
| `--verbose` | print the agent server's log as it runs |

In the foreground, Ctrl+C stops Volt (it saves your chats first). `BROWSER=none` never opens a browser;
`VOLT_RUN_CACHE` moves the downloaded builds.

## Phones and other computers

```sh
npx volt-run --host 0.0.0.0
```

prints a pairing link and a QR code. Open the link (or scan it with the Volt phone app) and that device
is paired: it can follow and steer your agents until you remove it in Volt's Settings > Devices. Without
the code nobody else gets in. `npx volt-run pair` makes a new code (each one is valid for 10 minutes).

On a computer you reach over SSH, forward the port instead and sign in as yourself:

```sh
ssh -L 47100:127.0.0.1:47100 you@server
npx volt-run --port 47100 --no-open      # on the server
# then open http://127.0.0.1:47100/ on your computer
```

On Linux, Volt's Electron needs the desktop libraries even without a window. On a bare server:
`sudo apt install libgtk-3-0 libnss3 libgbm1 libasound2` (Debian, Ubuntu) or
`sudo dnf install gtk3 nss mesa-libgbm alsa-lib` (Fedora).

## Requirements

Node.js 20 or newer, on macOS, Windows or Linux (x64 or arm64; Linux also armhf). Volt 0.0.6 or newer:
older Volt apps can't sign a browser in, so `volt-run` downloads a newer build instead.

## Developing

From the root of the [Volt repository](https://github.com/LeulAria/VOLT):

```sh
npm run volt-run -- --app .                  # run this checkout's agent server (compile out/ first)
npm --prefix apps/volt-run ci                # esbuild, for the build
npm run volt-run:test
npm run volt-run:build                       # apps/volt-run/dist/volt-run.mjs
npm run volt-run:release -- --version 0.0.6  # build, test and pack for a release; add --publish to publish
```

The source is in `src/`, one module per job: `args` (command line), `paths` (the profile and the
server's files, as the desktop names them), `server` (find, start, stop), `runtime` (which build),
`release` (manifests), `download` (download, check, unpack), `browser` and `ui`. `scripts/build.mjs`
combines them, with what they share with Volt (release naming, channel names, the QR encoder), into
one file. Releases publish it through `.github/workflows/volt-npm.yml`; see `docs/releasing.md`.
