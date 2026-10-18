# Install Volt

Download builds from [GitHub Releases](https://github.com/LeulAria/volt/releases/latest) or from [volt.leularia.com/download](https://volt.leularia.com/download).
Files are named `volt-<channel>-<version>-<os>-<arch>.<ext>`, for example `volt-stable-0.0.2-darwin-arm64.dmg`.

| Platform | Download | Guide |
| --- | --- | --- |
| macOS, Apple silicon | `darwin-arm64.dmg` | [macOS install guide](macos.md) |
| macOS, Intel | `darwin-x64.dmg` | [macOS install guide](macos.md) |
| macOS, both | `darwin-universal.dmg` | [macOS install guide](macos.md) |
| Windows 10 and 11, x64 or Arm | `win32-<arch>-user-setup.exe` (no admin rights), `win32-<arch>-system-setup.exe`, or `win32-<arch>.zip` | [Windows](#windows) |
| Linux, x64, Arm64 or armhf | `linux-<arch>.deb`, `linux-<arch>.rpm`, or `linux-<arch>.tar.gz` | [Linux](#linux) |

These builds are **not code-signed**, because Volt is an independent open-source project and has no signing certificate yet. Your operating system
warns you the first time you run one. That is expected. Each guide shows how to get past it, and you can always build Volt from source:
see [Run from source](../../README.md#run-from-source).

**Macs need one extra step**, so read the [macOS install guide](macos.md) before you open the app.

The same guide, with screenshots, is on the website at [volt.leularia.com/docs/install](https://volt.leularia.com/docs/install).

## Install from the Terminal

On macOS and Linux one command downloads the right build for your computer, checks its SHA-256 against the release and installs it, with no `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/LeulAria/VOLT/main/install.sh | bash
```

On a Mac it puts `Volt.app` in `/Applications` (or `~/Applications`). On Linux it unpacks into `~/.local/share/volt` and links `~/.local/bin/volt`.
`VOLT_VERSION=0.0.2` picks a version and `VOLT_INSTALL_DIR` the folder. Read [`install.sh`](../../install.sh) first; it is short.

## Windows

1. Download the `user-setup.exe` for your processor (x64 for most PCs, arm64 for Windows on Arm).
2. Run it. Windows shows **Windows protected your PC** (SmartScreen) because the installer is not signed.
   Click **More info**, then **Run anyway**.
3. Finish the installer. Volt starts from the Start menu and adds a `volt` command to your `PATH`.

The `.zip` is a portable copy: unzip it anywhere and run `Volt.exe`. Updates download in the background and install in place when you used a setup file;
a zip install shows the download instead.

From a terminal:

```powershell
volt .          # open the current folder
volt --version
```

## Linux

```bash
# Debian, Ubuntu
sudo apt install ./volt-stable-0.0.2-linux-x64.deb

# Fedora, RHEL, openSUSE
sudo dnf install ./volt-stable-0.0.2-linux-x64.rpm

# Any distribution: unpack and run the volt binary inside
tar xzf volt-stable-0.0.2-linux-x64.tar.gz
```

Then run `volt` or `volt .`. Volt tells you when an update is out and opens the download page.

## Channels

Volt ships three channels, each its own app with its own settings, so they install side by side:

| Channel | App | Command | Data folder |
| --- | --- | --- | --- |
| Stable | Volt | `volt` | `~/.volt` |
| Beta | Volt Beta | `volt-beta` | `~/.volt-beta` |
| Nightly | Volt Nightly | `volt-nightly` | `~/.volt-nightly` |

Stable releases are tagged `v<version>`. Beta and nightly builds are marked as prereleases. See [Releasing Volt](../releasing.md) for how they are built.
