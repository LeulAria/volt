Pod::Spec.new do |s|
  s.name           = 'VoltPinnedTls'
  s.version        = '1.0.0'
  s.summary        = 'HTTPS requests and WebSockets that trust only a pinned certificate.'
  s.description    = 'Talks to the Volt agent server on the network, whose self-signed certificate is trusted only when its SHA-256 matches the pin from pairing.'
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
  s.frameworks = 'Security', 'CryptoKit'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
