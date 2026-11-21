// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import CryptoKit
import ExpoModulesCore
import Foundation
import Security

/// Requests and WebSockets to Volt's agent server on the network. Its certificate is self-signed,
/// so no authority vouches for it: a connection goes through only when the server's leaf
/// certificate hashes (SHA-256 of its DER) to the pin the phone learned from the pairing QR, and
/// is cancelled before any byte is sent otherwise. Nothing here falls back to the system's checks
/// or to plain HTTP.
public final class VoltPinnedTlsModule: Module {
  private let lock = NSLock()
  /// One session per pin: its connections were all checked against that pin.
  private var sessions: [String: URLSession] = [:]
  private var requests: [String: URLSessionTask] = [:]
  private var aborted = Set<String>()
  private var sockets: [String: URLSessionWebSocketTask] = [:]
  private var socketIds: [ObjectIdentifier: String] = [:]
  /// The close code and reason the app asked for, reported when the socket has closed.
  private var closing: [String: (Int, String)] = [:]

  public func definition() -> ModuleDefinition {
    Name("VoltPinnedTls")

    Events("onSocket")

    AsyncFunction("fetch") { (id: String, url: String, pin: String, options: PinnedFetchOptions, promise: Promise) in
      self.fetch(id: id, url: url, pin: pin, options: options, promise: promise)
    }

    Function("cancel") { (id: String) in
      self.lock.lock()
      let task = self.requests[id]
      if task != nil {
        self.aborted.insert(id)
      }
      self.lock.unlock()
      task?.cancel()
    }

    Function("openSocket") { (id: String, url: String, pin: String) in
      try self.openSocket(id: id, url: url, pin: pin)
    }

    Function("send") { (id: String, text: String) in
      self.lock.lock()
      let task = self.sockets[id]
      self.lock.unlock()
      // A failed send ends the task, and its close is reported.
      task?.send(.string(text)) { _ in }
    }

    Function("closeSocket") { (id: String, code: Int, reason: String) in
      self.lock.lock()
      let task = self.sockets[id]
      if task != nil {
        self.closing[id] = (code, reason)
      }
      self.lock.unlock()
      task?.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: reason.data(using: .utf8))
    }

    // Pages from a pinned address in a WebView (react-native-webview, patched in
    // patches/react-native-webview+*.patch) are trusted with the same pin and nothing else.
    Function("setWebViewPins") { (pins: [String: String]) -> Bool in
      guard let impl = NSClassFromString("RNCWebViewImpl") as? NSObject.Type else {
        return false
      }
      let selector = NSSelectorFromString("setPinnedCertificates:")
      guard impl.responds(to: selector) else {
        return false
      }
      // Read on the main thread, which also creates the WebView after this (main queue order).
      DispatchQueue.main.async {
        _ = impl.perform(selector, with: pins as NSDictionary)
      }
      return true
    }

    OnDestroy {
      self.lock.lock()
      let all = Array(self.sessions.values)
      self.sessions.removeAll()
      self.lock.unlock()
      all.forEach { $0.invalidateAndCancel() }
    }
  }

  // MARK: - Sessions

  private func session(for pin: String) throws -> URLSession {
    guard let expected = PinnedTrust.decodePin(pin) else {
      throw Exception(name: "BadPin", description: "\(pin) is not a certificate pin.", code: "ERR_BAD_PIN")
    }
    lock.lock()
    defer { lock.unlock() }
    if let session = sessions[pin] {
      return session
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
    let delegate = PinnedSessionDelegate(pin: expected, owner: self)
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
    sessions[pin] = session
    return session
  }

  private static func secureUrl(_ text: String, scheme: String) throws -> URL {
    guard let url = URL(string: text), url.scheme?.lowercased() == scheme, url.host != nil else {
      throw Exception(name: "Insecure", description: "A pinned connection needs a \(scheme) address, not \(text).", code: "ERR_INSECURE")
    }
    return url
  }

  // MARK: - HTTP

  private func fetch(id: String, url text: String, pin: String, options: PinnedFetchOptions, promise: Promise) {
    let url: URL
    let session: URLSession
    do {
      url = try Self.secureUrl(text, scheme: "https")
      session = try self.session(for: pin)
    } catch {
      promise.reject(error)
      return
    }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: max(1, options.timeoutMs / 1000))
    request.httpMethod = options.method
    for (name, value) in options.headers {
      request.setValue(value, forHTTPHeaderField: name)
    }
    if let body = options.body {
      request.httpBody = body.data(using: .utf8)
    }
    var taskRef: URLSessionDataTask?
    let task = session.dataTask(with: request) { [weak self] data, response, error in
      guard let self else {
        return
      }
      self.lock.lock()
      self.requests.removeValue(forKey: id)
      let wasAborted = self.aborted.remove(id) != nil
      self.lock.unlock()
      if let taskRef, PinnedTrust.wasRefused(taskRef) {
        promise.reject(Exception(name: "PinMismatch", description: "\(url.host ?? text) answered with a certificate other than the one this phone paired with.", code: "ERR_PIN_MISMATCH"))
        return
      }
      if wasAborted {
        promise.reject(Exception(name: "AbortError", description: "The request was cancelled.", code: "ERR_ABORTED"))
        return
      }
      if let error {
        promise.reject(Exception(name: "Unreachable", description: error.localizedDescription, code: "ERR_UNREACHABLE"))
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      promise.resolve(["status": status, "body": data.flatMap { String(data: $0, encoding: .utf8) } ?? ""])
    }
    taskRef = task
    lock.lock()
    requests[id] = task
    lock.unlock()
    task.resume()
  }

  // MARK: - WebSocket

  private func openSocket(id: String, url text: String, pin: String) throws {
    let url = try Self.secureUrl(text, scheme: "wss")
    let task = try session(for: pin).webSocketTask(with: url)
    // The server sends whole snapshots in one message; URLSession's default limit is 1 MB.
    task.maximumMessageSize = 256 * 1024 * 1024
    lock.lock()
    sockets[id] = task
    socketIds[ObjectIdentifier(task)] = id
    lock.unlock()
    task.resume()
    receive(id: id, task: task)
  }

  private func receive(id: String, task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self, case .success(let message) = result else {
        // The close (or the failure) is reported by the delegate.
        return
      }
      switch message {
      case .string(let text):
        self.sendEvent("onSocket", ["id": id, "type": "message", "data": text])
      case .data(let data):
        self.sendEvent("onSocket", ["id": id, "type": "message", "data": String(data: data, encoding: .utf8) ?? ""])
      @unknown default:
        break
      }
      self.receive(id: id, task: task)
    }
  }

  fileprivate func socketOpened(_ task: URLSessionTask) {
    if let id = socketId(task) {
      sendEvent("onSocket", ["id": id, "type": "open"])
    }
  }

  /// Reports a socket's end once: the server's close frame, the app's own close, or a failure
  /// (1015 when the certificate didn't match, as WebSocket's "TLS handshake failed").
  fileprivate func socketEnded(_ task: URLSessionTask, code: Int?, reason: String?, error: Error?) {
    lock.lock()
    // The first report wins: a close frame is followed by the task's completion.
    guard let id = socketIds.removeValue(forKey: ObjectIdentifier(task)) else {
      lock.unlock()
      return
    }
    let requested = closing.removeValue(forKey: id)
    sockets.removeValue(forKey: id)
    lock.unlock()
    if PinnedTrust.wasRefused(task) {
      sendEvent("onSocket", ["id": id, "type": "error", "code": "ERR_PIN_MISMATCH", "message": "The server answered with a certificate other than the one this phone paired with."])
      sendEvent("onSocket", ["id": id, "type": "close", "code": 1015, "reason": "certificate does not match the pin"])
      return
    }
    if let code {
      sendEvent("onSocket", ["id": id, "type": "close", "code": code, "reason": reason ?? ""])
    } else if let requested {
      sendEvent("onSocket", ["id": id, "type": "close", "code": requested.0, "reason": requested.1])
    } else {
      if let error {
        sendEvent("onSocket", ["id": id, "type": "error", "code": "ERR_UNREACHABLE", "message": error.localizedDescription])
      }
      sendEvent("onSocket", ["id": id, "type": "close", "code": 1006, "reason": error?.localizedDescription ?? ""])
    }
  }

  private func socketId(_ task: URLSessionTask) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return socketIds[ObjectIdentifier(task)]
  }
}

struct PinnedFetchOptions: Record {
  @Field var method: String = "GET"
  @Field var headers: [String: String] = [:]
  @Field var body: String? = nil
  @Field var timeoutMs: Double = 10_000
}

/// The pin check: SHA-256 of the leaf certificate's DER, compared in constant time.
enum PinnedTrust {
  private static let refusedKey = UnsafeMutablePointer<UInt8>.allocate(capacity: 1)

  static func decodePin(_ pin: String) -> Data? {
    guard pin.count == 43, pin.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
      return nil
    }
    let base64 = pin.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="
    guard let data = Data(base64Encoded: base64), data.count == 32 else {
      return nil
    }
    return data
  }

  static func leafMatches(_ trust: SecTrust, pin: Data) -> Bool {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else {
      return false
    }
    let digest = Data(SHA256.hash(data: SecCertificateCopyData(leaf) as Data))
    guard digest.count == pin.count else {
      return false
    }
    var difference: UInt8 = 0
    for (a, b) in zip(digest, pin) {
      difference |= a ^ b
    }
    return difference == 0
  }

  static func markRefused(_ task: URLSessionTask) {
    objc_setAssociatedObject(task, refusedKey, true, .OBJC_ASSOCIATION_RETAIN)
  }

  static func wasRefused(_ task: URLSessionTask) -> Bool {
    (objc_getAssociatedObject(task, refusedKey) as? Bool) == true
  }
}

private final class PinnedSessionDelegate: NSObject, URLSessionTaskDelegate, URLSessionWebSocketDelegate {
  private let pin: Data
  private weak var owner: VoltPinnedTlsModule?

  init(pin: Data, owner: VoltPinnedTlsModule) {
    self.pin = pin
    self.owner = owner
  }

  // Without a session-level handler, URLSession asks this one for the server's trust too.
  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
      // No client certificates or passwords: the device token is the credential.
      completionHandler(.rejectProtectionSpace, nil)
      return
    }
    guard let trust = challenge.protectionSpace.serverTrust, PinnedTrust.leafMatches(trust, pin: pin) else {
      PinnedTrust.markRefused(task)
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    owner?.socketOpened(webSocketTask)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    owner?.socketEnded(webSocketTask, code: closeCode.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) }, error: nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if task is URLSessionWebSocketTask {
      owner?.socketEnded(task, code: nil, reason: nil, error: error)
    }
  }
}
