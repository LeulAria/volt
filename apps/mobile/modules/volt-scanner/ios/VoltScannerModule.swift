// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import AVFoundation
import ExpoModulesCore
import UIKit
import Vision
import VisionKit

/// Scans a pairing QR code with VisionKit's data scanner, full screen with a Cancel button, and
/// resolves the first code it reads (null when cancelled).
public final class VoltScannerModule: Module {
  private var session: AnyObject?

  public func definition() -> ModuleDefinition {
    Name("VoltScanner")

    AsyncFunction("isAvailable") { (promise: Promise) in
      Task { @MainActor in
        promise.resolve(VoltScannerModule.usable())
      }
    }

    AsyncFunction("scan") { (promise: Promise) in
      Task { @MainActor [weak self] in
        guard let self else {
          promise.resolve(nil)
          return
        }
        await self.scan(promise)
      }
    }
  }

  /// A device with the scanner, and a camera the user has not turned down (yet to be asked counts:
  /// scanning asks).
  @MainActor
  private static func usable() -> Bool {
    guard DataScannerViewController.isSupported else {
      return false
    }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .notDetermined:
      return true
    case .authorized:
      return DataScannerViewController.isAvailable
    default:
      return false
    }
  }

  @MainActor
  private func scan(_ promise: Promise) async {
    guard DataScannerViewController.isSupported else {
      promise.reject("ERR_SCANNER_UNSUPPORTED", "This device can't scan codes.")
      return
    }
    if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
      _ = await AVCaptureDevice.requestAccess(for: .video)
    }
    guard DataScannerViewController.isAvailable else {
      promise.reject("ERR_CAMERA_DENIED", "Allow Volt to use the camera in Settings to scan the pairing code.")
      return
    }
    guard let presenter = appContext?.utilities?.currentViewController() else {
      promise.reject("ERR_NO_WINDOW", "Volt isn't on screen.")
      return
    }
    let scan = ScanSession(promise: promise)
    scan.onFinish = { [weak self] in
      self?.session = nil
    }
    session = scan
    scan.present(from: presenter)
  }
}

@MainActor
private final class ScanSession: NSObject, DataScannerViewControllerDelegate {
  private var promise: Promise?
  private var scanner: DataScannerViewController?
  private var navigation: UINavigationController?
  var onFinish: (() -> Void)?

  init(promise: Promise) {
    self.promise = promise
  }

  func present(from presenter: UIViewController) {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      qualityLevel: .balanced,
      recognizesMultipleItems: false,
      isHighFrameRateTrackingEnabled: false,
      isPinchToZoomEnabled: true,
      isGuidanceEnabled: true,
      isHighlightingEnabled: true
    )
    scanner.delegate = self
    scanner.title = "Scan Pairing Code"
    scanner.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancel))
    let navigation = UINavigationController(rootViewController: scanner)
    navigation.modalPresentationStyle = .fullScreen
    navigation.overrideUserInterfaceStyle = .dark
    self.scanner = scanner
    self.navigation = navigation
    presenter.present(navigation, animated: true) { [weak self] in
      do {
        try scanner.startScanning()
      } catch {
        self?.finish(nil, error: error)
      }
    }
  }

  @objc private func cancel() {
    finish(nil)
  }

  func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
    for item in addedItems {
      if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue, !payload.isEmpty {
        finish(payload)
        return
      }
    }
  }

  func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
    finish(nil, error: error)
  }

  private func finish(_ value: String?, error: Error? = nil) {
    guard let promise else {
      return
    }
    self.promise = nil
    scanner?.stopScanning()
    navigation?.dismiss(animated: true)
    if let error {
      promise.reject("ERR_SCAN_FAILED", error.localizedDescription)
    } else {
      promise.resolve(value)
    }
    onFinish?()
  }
}
