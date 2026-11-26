// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

package com.voltadk.scanner

import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Scans a pairing QR code with Google's code scanner: Play services shows the camera and reads
 * the code, so the app needs no camera permission and ships no barcode model.
 */
class VoltScannerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VoltScanner")

    AsyncFunction("isAvailable") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    }

    AsyncFunction("scan") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject(CodedException("ERR_NO_ACTIVITY", "Volt isn't on screen.", null))
        return@AsyncFunction
      }
      val options = GmsBarcodeScannerOptions.Builder()
        .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
        .enableAutoZoom()
        .build()
      GmsBarcodeScanning.getClient(activity, options).startScan()
        .addOnSuccessListener { barcode -> promise.resolve(barcode.rawValue) }
        .addOnCanceledListener { promise.resolve(null) }
        .addOnFailureListener { error -> promise.reject(CodedException("ERR_SCAN_FAILED", error.message ?: "The scanner failed.", error)) }
    }
  }
}
