/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Apple's speech recognizer behind a line protocol. Reads 16 kHz mono 16-bit PCM from stdin and
 * prints one JSON object per line: `partial` and `final` with `text`, `error` with `message`, a
 * `probe` reply to `--probe`, and an `authorization` reply with `status` to `--authorize`, which asks
 * for speech access first when macOS has no answer yet. It is compiled on first use with the Xcode
 * command line tools.
 *
 * macOS asks the responsible app for speech access and kills a process whose responsible app has no
 * NSSpeechRecognitionUsageDescription. Volt has it, and its approval survives helper rebuilds. A dev
 * build started from a terminal or another app has that app as responsible instead; then the helper
 * re-launches itself as its own responsible process, carrying {@link VOLT_SPEECH_HELPER_INFO_PLIST}.
 */
export const VOLT_SPEECH_HELPER_SOURCE = `import Foundation
import Speech
import AVFoundation
import Darwin

typealias ResponsibleFor = @convention(c) (pid_t) -> pid_t
func responsibleAppMayAskForSpeech() -> Bool {
	guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return false }
	let pid = unsafeBitCast(symbol, to: ResponsibleFor.self)(getpid())
	var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
	guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return false }
	var url = URL(fileURLWithPath: String(cString: path))
	while url.path != "/" {
		if url.pathExtension == "app" {
			return Bundle(url: url)?.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil
		}
		url.deleteLastPathComponent()
	}
	return false
}

var childPid: pid_t = 0
func runDisclaimed() {
	guard getenv("VOLT_SPEECH_DISCLAIMED") == nil, !responsibleAppMayAskForSpeech(),
		let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim"),
		let executable = Bundle.main.executablePath else { return }
	typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
	var attributes: posix_spawnattr_t? = nil
	posix_spawnattr_init(&attributes)
	defer { posix_spawnattr_destroy(&attributes) }
	guard unsafeBitCast(symbol, to: SetDisclaim.self)(&attributes, 1) == 0 else { return }
	setenv("VOLT_SPEECH_DISCLAIMED", "1", 1)
	guard posix_spawn(&childPid, executable, nil, &attributes, CommandLine.unsafeArgv, environ) == 0 else { return }
	signal(SIGTERM) { _ in kill(childPid, SIGTERM); exit(143) }
	var status: Int32 = 0
	while waitpid(childPid, &status, 0) == -1 && errno == EINTR {}
	exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f))
}
runDisclaimed()

setvbuf(stdout, nil, _IONBF, 0)

var localeId = "en-US"
var onDeviceOnly = false
var probeOnly = false
var authorizeOnly = false
var argv = CommandLine.arguments.dropFirst()
while let arg = argv.popFirst() {
	switch arg {
	case "--locale": if let value = argv.popFirst() { localeId = value }
	case "--on-device": onDeviceOnly = true
	case "--probe": probeOnly = true
	case "--authorize": authorizeOnly = true
	default: break
	}
}

func emit(_ object: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
	FileHandle.standardOutput.write(data + Data([10]))
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
	emit(["type": "error", "message": "Speech recognition does not support " + localeId + "."])
	exit(2)
}

if probeOnly {
	emit(["type": "probe", "onDevice": recognizer.supportsOnDeviceRecognition, "available": recognizer.isAvailable, "authorization": SFSpeechRecognizer.authorizationStatus().rawValue])
	exit(0)
}

var status = SFSpeechRecognizer.authorizationStatus()
if status == .notDetermined {
	let answered = DispatchSemaphore(value: 0)
	SFSpeechRecognizer.requestAuthorization { value in
		status = value
		answered.signal()
	}
	_ = answered.wait(timeout: .now() + 120)
}
if authorizeOnly {
	emit(["type": "authorization", "status": status.rawValue])
	exit(0)
}
guard status == .authorized else {
	emit(["type": "error", "message": "Speech recognition is not allowed for Volt. Allow it in System Settings > Privacy & Security > Speech Recognition."])
	exit(3)
}
if onDeviceOnly && !recognizer.supportsOnDeviceRecognition {
	emit(["type": "error", "message": "The on-device speech model for " + localeId + " is not installed."])
	exit(4)
}

let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

// All state lives on the main queue: the recognizer calls back there and the reader hops to it.
// The recognizer ends a task on its own after a pause or its time limit; while audio still comes,
// a new task takes over and the text heard so far is kept, so a dictation sits through long pauses.
var committed = ""
var finished = false
var audioEnded = false
var endedAt: Date? = nil
var segment = 0
var quickFailures = 0
var request: SFSpeechAudioBufferRecognitionRequest! = nil

func joined(_ head: String, _ tail: String) -> String {
	if head.isEmpty { return tail }
	if tail.isEmpty { return head }
	return head + " " + tail
}

func finish(_ text: String, _ message: String?) {
	if finished { return }
	finished = true
	var object: [String: Any] = ["type": "final", "text": text]
	if let message = message { object["message"] = message }
	emit(object)
}

func startSegment() {
	let next = SFSpeechAudioBufferRecognitionRequest()
	next.shouldReportPartialResults = true
	next.requiresOnDeviceRecognition = onDeviceOnly
	next.taskHint = .dictation
	if #available(macOS 13, *) { next.addsPunctuation = true }
	request = next
	segment += 1
	let mine = segment
	let startedAt = Date()
	var heard = ""
	_ = recognizer.recognitionTask(with: next) { result, error in
		guard mine == segment, !finished else { return }
		if let result = result {
			heard = result.bestTranscription.formattedString
			if !result.isFinal { emit(["type": "partial", "text": joined(committed, heard)]) }
		}
		guard result?.isFinal == true || error != nil else { return }
		committed = joined(committed, heard)
		if audioEnded {
			finish(committed, committed.isEmpty ? error?.localizedDescription : nil)
			return
		}
		// A recognizer that fails at once, again and again, would restart forever.
		if heard.isEmpty && error != nil && Date().timeIntervalSince(startedAt) < 2 {
			quickFailures += 1
			if quickFailures >= 3 {
				finish(committed, error?.localizedDescription)
				return
			}
		} else {
			quickFailures = 0
		}
		startSegment()
	}
}
startSegment()

DispatchQueue.global().async {
	let input = FileHandle.standardInput
	while true {
		let data = input.readData(ofLength: 3200)
		if data.isEmpty {
			DispatchQueue.main.async {
				audioEnded = true
				endedAt = Date()
				request.endAudio()
			}
			return
		}
		let frames = AVAudioFrameCount(data.count / 2)
		guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { continue }
		buffer.frameLength = frames
		data.withUnsafeBytes { raw in
			if let base = raw.baseAddress, let destination = buffer.int16ChannelData?[0] {
				memcpy(destination, base, Int(frames) * 2)
			}
		}
		DispatchQueue.main.async { request.append(buffer) }
	}
}

// The recognizer needs the main run loop: a task started while it is blocked never leaves "starting".
// No limit while audio comes (the composer ends silent dictations); the last words get 20 seconds.
let started = Date()
while !finished {
	if let endedAt = endedAt, Date().timeIntervalSince(endedAt) > 20 { break }
	if Date().timeIntervalSince(started) > 3600 { break }
	_ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.1))
}
if !finished { finish(committed, "Timed out.") }
exit(0)
`;

/** Linked into the helper as its __info_plist section: macOS reads the usage description from it. */
export const VOLT_SPEECH_HELPER_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>dev.volt.speech</string>
	<key>CFBundleName</key>
	<string>Volt Speech</string>
	<key>NSSpeechRecognitionUsageDescription</key>
	<string>Volt turns your dictation into text for the agent composer.</string>
</dict>
</plist>
`;
