// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

package com.voltadk.pinnedtls

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionSpec
import okhttp3.CookieJar
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.IOException
import java.net.Socket
import java.security.MessageDigest
import java.security.cert.Certificate
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedTrustManager

class PinnedFetchOptions : Record {
  @Field val method: String = "GET"
  @Field val headers: Map<String, String> = emptyMap()
  @Field val body: String? = null
  @Field val timeoutMs: Double = 10_000.0
}

/**
 * Requests and WebSockets to Volt's agent server on the network. Its certificate is self-signed,
 * so no authority vouches for it: a connection goes through only when the server's leaf
 * certificate hashes (SHA-256 of its DER) to the pin the phone learned from the pairing QR, and
 * fails in the handshake otherwise. Nothing here falls back to the system's checks or to plain HTTP.
 */
class VoltPinnedTlsModule : Module() {
  /** One client per pin: its connections were all checked against that pin. */
  private val clients = ConcurrentHashMap<String, OkHttpClient>()
  private val calls = ConcurrentHashMap<String, Call>()
  private val aborted = ConcurrentHashMap.newKeySet<String>()
  private val sockets = ConcurrentHashMap<String, WebSocket>()
  /** The close code and reason the app asked for, reported when the socket has closed. */
  private val closing = ConcurrentHashMap<String, Pair<Int, String>>()

  override fun definition() = ModuleDefinition {
    Name("VoltPinnedTls")

    Events("onSocket")

    AsyncFunction("fetch") { id: String, url: String, pin: String, options: PinnedFetchOptions, promise: Promise ->
      fetch(id, url, pin, options, promise)
    }

    Function("cancel") { id: String ->
      calls[id]?.let {
        aborted.add(id)
        it.cancel()
      }
    }

    Function("openSocket") { id: String, url: String, pin: String ->
      openSocket(id, url, pin)
    }

    Function("send") { id: String, text: String ->
      // A failed send ends the socket, and its close is reported.
      sockets[id]?.send(text)
    }

    Function("closeSocket") { id: String, code: Int, reason: String ->
      val socket = sockets[id] ?: return@Function
      closing[id] = Pair(code, reason)
      val sent = try {
        socket.close(code, reason)
      } catch (e: IllegalArgumentException) {
        false
      }
      if (!sent) {
        socket.cancel()
      }
    }

    // Pages from a pinned address in a WebView (react-native-webview, patched in
    // patches/react-native-webview+*.patch) are trusted with the same pin and nothing else.
    Function("setWebViewPins") { pins: Map<String, String> ->
      try {
        Class.forName("com.reactnativecommunity.webview.RNCWebViewClient")
          .getMethod("setPinnedCertificates", Map::class.java)
          .invoke(null, HashMap(pins))
        true
      } catch (e: ReflectiveOperationException) {
        false
      }
    }

    OnDestroy {
      calls.values.forEach { it.cancel() }
      sockets.values.forEach { it.cancel() }
      clients.values.forEach { it.dispatcher.executorService.shutdown() }
      clients.clear()
    }
  }

  // region Clients

  private fun clientFor(pin: String): OkHttpClient {
    val expected = decodePin(pin) ?: throw CodedException("ERR_BAD_PIN", "$pin is not a certificate pin.", null)
    return clients.getOrPut(pin) {
      val trust = PinnedTrustManager(expected)
      val context = SSLContext.getInstance("TLS")
      context.init(null, arrayOf(trust), null)
      OkHttpClient.Builder()
        .sslSocketFactory(context.socketFactory, trust)
        // The certificate names only localhost: the pin, checked in the handshake, is the identity.
        .hostnameVerifier { _, session -> runCatching { trust.matches(session.peerCertificates.firstOrNull()) }.getOrDefault(false) }
        .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
        .protocols(listOf(Protocol.HTTP_1_1))
        .cookieJar(CookieJar.NO_COOKIES)
        .cache(null)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
    }
  }

  private fun requireScheme(url: String, scheme: String) {
    val actual = url.substringBefore("://", "").lowercase()
    if (actual != scheme) {
      throw CodedException("ERR_INSECURE", "A pinned connection needs a $scheme address, not $url.", null)
    }
  }

  // endregion

  // region HTTP

  private fun fetch(id: String, url: String, pin: String, options: PinnedFetchOptions, promise: Promise) {
    val client: OkHttpClient
    val request: Request
    try {
      requireScheme(url, "https")
      client = clientFor(pin).newBuilder().callTimeout(options.timeoutMs.toLong().coerceAtLeast(1_000), TimeUnit.MILLISECONDS).build()
      val contentType = options.headers.entries.firstOrNull { it.key.equals("Content-Type", true) }?.value?.toMediaTypeOrNull()
      val body = options.body?.toRequestBody(contentType)
        ?: if (options.method.equals("GET", true) || options.method.equals("HEAD", true)) null else ByteArray(0).toRequestBody(null)
      val builder = Request.Builder().url(url).method(options.method.uppercase(), body)
      for ((name, value) in options.headers) {
        if (!name.equals("Host", true) && !name.equals("Content-Length", true)) {
          builder.header(name, value)
        }
      }
      request = builder.build()
    } catch (e: CodedException) {
      promise.reject(e)
      return
    } catch (e: IllegalArgumentException) {
      promise.reject(CodedException("ERR_BAD_REQUEST", e.message ?: "Bad request.", e))
      return
    }
    val call = client.newCall(request)
    calls[id] = call
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        calls.remove(id)
        val wasAborted = aborted.remove(id)
        when {
          isPinMismatch(e) -> promise.reject(CodedException("ERR_PIN_MISMATCH", "${request.url.host} answered with a certificate other than the one this phone paired with.", e))
          wasAborted -> promise.reject(CodedException("ERR_ABORTED", "The request was cancelled.", e))
          else -> promise.reject(CodedException("ERR_UNREACHABLE", e.message ?: "Can't reach ${request.url.host}.", e))
        }
      }

      override fun onResponse(call: Call, response: Response) {
        calls.remove(id)
        aborted.remove(id)
        response.use {
          val text = try {
            it.body?.string() ?: ""
          } catch (e: IOException) {
            promise.reject(CodedException("ERR_UNREACHABLE", e.message ?: "The answer was cut off.", e))
            return
          }
          promise.resolve(mapOf("status" to it.code, "body" to text))
        }
      }
    })
  }

  // endregion

  // region WebSocket

  private fun openSocket(id: String, url: String, pin: String) {
    requireScheme(url, "wss")
    val client = clientFor(pin).newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()
    val socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        emit(id, "open")
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        emit(id, "message", "data" to text)
      }

      override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        emit(id, "message", "data" to bytes.utf8())
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, null)
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        ended(id, code, reason, null)
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        ended(id, null, null, t)
      }
    })
    sockets[id] = socket
  }

  /**
   * Reports a socket's end once: the server's close, the app's own close, or a failure (1015 when
   * the certificate didn't match, as WebSocket's "TLS handshake failed").
   */
  private fun ended(id: String, code: Int?, reason: String?, error: Throwable?) {
    if (sockets.remove(id) == null) {
      return
    }
    val requested = closing.remove(id)
    when {
      error != null && isPinMismatch(error) -> {
        emit(id, "error", "code" to "ERR_PIN_MISMATCH", "message" to "The server answered with a certificate other than the one this phone paired with.")
        emit(id, "close", "code" to 1015, "reason" to "certificate does not match the pin")
      }
      code != null -> emit(id, "close", "code" to code, "reason" to (reason ?: ""))
      requested != null -> emit(id, "close", "code" to requested.first, "reason" to requested.second)
      else -> {
        emit(id, "error", "code" to "ERR_UNREACHABLE", "message" to (error?.message ?: ""))
        emit(id, "close", "code" to 1006, "reason" to (error?.message ?: ""))
      }
    }
  }

  private fun emit(id: String, type: String, vararg fields: Pair<String, Any>) {
    sendEvent("onSocket", mapOf("id" to id, "type" to type, *fields))
  }

  // endregion
}

private fun decodePin(pin: String): ByteArray? {
  if (!Regex("^[A-Za-z0-9_-]{43}$").matches(pin)) {
    return null
  }
  return try {
    Base64.decode(pin, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP).takeIf { it.size == 32 }
  } catch (e: IllegalArgumentException) {
    null
  }
}

private fun isPinMismatch(error: Throwable): Boolean {
  var cause: Throwable? = error
  while (cause != null) {
    if (cause is PinMismatchException) {
      return true
    }
    cause = cause.cause
  }
  return false
}

private class PinMismatchException : CertificateException("The server's certificate is not the pinned one.")

/** Trusts exactly one leaf certificate: the one whose DER hashes (SHA-256) to the pin. */
private class PinnedTrustManager(private val pin: ByteArray) : X509ExtendedTrustManager() {
  fun matches(certificate: Certificate?): Boolean {
    val der = certificate?.encoded ?: return false
    return MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(der), pin)
  }

  private fun check(chain: Array<out X509Certificate>?) {
    if (chain.isNullOrEmpty() || !matches(chain[0])) {
      throw PinMismatchException()
    }
  }

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = check(chain)
  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) = check(chain)
  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) = check(chain)

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("No client certificates.")
  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) = throw CertificateException("No client certificates.")
  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) = throw CertificateException("No client certificates.")

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
