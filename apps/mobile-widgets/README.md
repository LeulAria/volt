# volt-mobile-widgets

Live Activities (Lock Screen and Dynamic Island), home-screen and Lock Screen widgets for the Volt
mobile app. Three parts:

- `plugin/withVoltWidgets.js`: Expo config plugin. Adds the `VoltWidgetExtension` target, the App
  Group entitlement, `NSSupportsLiveActivities`, and copies the Swift sources and provider brand
  assets into the prebuilt iOS project.
- `ios/` and `targets/`: the Expo native module (`VoltWidgets`), the widget extension (SwiftUI
  widgets, Live Activity views, ActivityAttributes) and the Stop App Intent.
- `src/` and `server/`: pure TypeScript that maps the agent server's state to Live Activity content
  and widget snapshots, the start/update/end planner, the native driver, and a reference APNs relay
  for background Live Activity pushes.

## Wiring

Add the plugin to the app's `app.json` `expo.plugins` array and depend on the package:

```json
"plugins": [ "...existing plugins...", "volt-mobile-widgets" ]
```

The plugin needs `ios.bundleIdentifier` (the extension is `<bundleId>.widgets`) and an App Group
`group.<bundleId>` is used unless `["volt-mobile-widgets", { "appGroup": "group.…" }]` is given.
Run `npx expo prebuild --platform ios` after changing plugins.

## Tests

`npm test` runs the pure TypeScript tests with `node --test`. `npm run typecheck` checks the same
files with `tsc`. The Swift code is checked by building the app for the iOS simulator.
