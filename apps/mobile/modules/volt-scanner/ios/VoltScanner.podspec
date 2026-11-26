Pod::Spec.new do |s|
  s.name           = 'VoltScanner'
  s.version        = '1.0.0'
  s.summary        = 'Scans pairing QR codes with VisionKit.'
  s.description    = 'Scans pairing QR codes with VisionKit (DataScannerViewController); no barcode engine ships in the app.'
  s.license        = 'MIT'
  s.author         = 'Volt ADK'
  s.homepage       = 'https://github.com/LeulAria/volt'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/LeulAria/volt.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'VisionKit', 'Vision', 'AVFoundation'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
