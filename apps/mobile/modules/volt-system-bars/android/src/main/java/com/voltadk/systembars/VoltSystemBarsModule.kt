// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

package com.voltadk.systembars

import android.os.Build
import androidx.core.view.WindowInsetsControllerCompat
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The navigation bar over an edge-to-edge page: no scrim of the system's light or dark mode behind
 * three-button navigation, and buttons that match the page drawn behind them.
 */
class VoltSystemBarsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VoltSystemBars")

    AsyncFunction("setNavigationBarStyle") { dark: Boolean ->
      val window = appContext.currentActivity?.window ?: return@AsyncFunction
      // Before Android 10 the bar keeps React Native's own translucent background, which is
      // tinted for the system's mode; its buttons must stay as they are to remain readable.
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        return@AsyncFunction
      }
      window.isNavigationBarContrastEnforced = false
      WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightNavigationBars = !dark
    }.runOnQueue(Queues.MAIN)
  }
}
