# Device studio harness

Renders devices with the real studio code in headless Chrome (GPU), outside Volt.

    node build/volt/deviceStudio/harness/shoot.mjs --id iphone-17-pro --view angle --out /tmp/a.png
    node build/volt/deviceStudio/harness/shoot.mjs --entry harness/entries/my-device.json --id my-device --posture half --out /tmp/b.png

Options: `--id` (repeatable) or `--all`; `--view front|angle|side|back`; `--yaw`/`--pitch` (radians);
`--finish <id>`; `--posture closed|half|open`; `--hinge <degrees>` (pose the hinge directly);
`--landscape`; `--light` (light stage); `--size 900x1000`; `--out file.png` or `--dir folder`;
`--entry file.json` (a full `IDeviceCatalogEntry` drawn besides the catalog).

The studio, the catalog (`src/vs/workbench/contrib/voltAgent/browser/preview/deviceStudio/catalog`)
and `entry.ts` are bundled in memory on every run. The page on the display is `sample.html`, captured
once into `page-phone.png` / `page-wide.png`. Reference photos of real devices live in
`~/.volt-studio/refs/<id>/`.
