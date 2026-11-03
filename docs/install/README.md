# Install Volt

Download builds from [GitHub Releases](https://github.com/LeulAria/volt/releases/latest) or from [volt.leularia.com/download](https://volt.leularia.com/download).
Files are named `volt-<channel>-<version>-<os>-<arch>.<ext>`, for example `volt-stable-0.0.3-darwin-arm64.dmg`.

| Platform | Download | Guide |
| --- | --- | --- |
| macOS, Apple silicon | `darwin-arm64.dmg` | [macOS](#macos) |
| macOS, Intel | `darwin-x64.dmg` | [macOS](#macos) |
| macOS, both | `darwin-universal.dmg` | [macOS](#macos) |
| Windows 10 and 11, x64 or Arm | `win32-<arch>-user-setup.exe` (no admin rights), `win32-<arch>-system-setup.exe`, or `win32-<arch>.zip` | [Windows](#windows) |
| Linux, x64, Arm64 or armhf | `linux-<arch>.deb`, `linux-<arch>.rpm`, or `linux-<arch>.tar.gz` | [Linux](#linux) |

**Windows installers are not code-signed yet**, so Windows warns you the first time you run one. That is expected, and the
[Windows](#windows) steps show how to get past it. You can always build Volt from source: see [Run from source](../../README.md#run-from-source).

The same guide is on the website at [volt.leularia.com/docs/install](https://volt.leularia.com/docs/install).

## macOS

Download the `.dmg` (arm64 for Apple silicon, x64 for Intel), open it and drag **Volt** to Applications. Mac builds are signed
with an Apple Developer ID and notarized from 0.0.4, and they update themselves.

Volt 0.0.3 and older were not signed and cannot update themselves. Download the new version once and replace the app in
Applications. Your settings and chats stay.

To use `volt .` in a terminal, run **Shell Command: Install 'volt' command in PATH** from the Command Palette (<kbd>⇧</kbd><kbd>⌘</kbd><kbd>P</kbd>).

## Install from the Terminal

On macOS and Linux one command downloads the right build for your computer, checks its SHA-256 against the release and installs it, with no `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/LeulAria/VOLT/main/install.sh | bash
```

On a Mac it puts `Volt.app` in `/Applications` (or `~/Applications`). On Linux it unpacks into `~/.local/share/volt` and links `~/.local/bin/volt`.
`VOLT_VERSION=0.0.3` picks a version and `VOLT_INSTALL_DIR` the folder. Read [`install.sh`](../../install.sh) first; it is short.

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
sudo apt install ./volt-stable-0.0.3-linux-x64.deb

# Fedora, RHEL, openSUSE
sudo dnf install ./volt-stable-0.0.3-linux-x64.rpm

# Any distribution: unpack and run the volt binary inside
tar xzf volt-stable-0.0.3-linux-x64.tar.gz
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
