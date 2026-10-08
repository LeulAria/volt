/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Apple's speech recognizer behind a line protocol. Reads 16 kHz mono 16-bit PCM from stdin and
 * prints one JSON object per line: `partial` and `final` with `text`, `error` with `message`, and a
 * `probe` reply to `--probe`. It is compiled on first use with the Xcode command line tools.
 */
export const VOLT_SPEECH_HELPER_SOURCE = `import Foundation
import Speech
import AVFoundation

setvbuf(stdout, nil, _IONBF, 0)

var localeId = "en-US"
var onDeviceOnly = false
var probeOnly = false
var argv = CommandLine.arguments.dropFirst()
while let arg = argv.popFirst() {
	switch arg {
	case "--locale": if let value = argv.popFirst() { localeId = value }
	case "--on-device": onDeviceOnly = true
	case "--probe": probeOnly = true
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
guard status == .authorized else {
	emit(["type": "error", "message": "Speech recognition is not allowed for Volt. Allow it in System Settings > Privacy & Security > Speech Recognition."])
	exit(3)
}
if onDeviceOnly && !recognizer.supportsOnDeviceRecognition {
	emit(["type": "error", "message": "The on-device speech model for " + localeId + " is not installed."])
	exit(4)
}

let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.requiresOnDeviceRecognition = onDeviceOnly
request.taskHint = .dictation
let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

var lastText = ""
var finished = false
let done = DispatchSemaphore(value: 0)
let finish = { (text: String, message: String?) in
	if finished { return }
	finished = true
	var object: [String: Any] = ["type": "final", "text": text]
	if let message = message { object["message"] = message }
	emit(object)
	done.signal()
}

_ = recognizer.recognitionTask(with: request) { result, error in
	if let result = result {
		lastText = result.bestTranscription.formattedString
		if result.isFinal {
			finish(lastText, nil)
			return
		}
		if !finished { emit(["type": "partial", "text": lastText]) }
	}
	if let error = error {
		finish(lastText, error.localizedDescription)
	}
}

DispatchQueue.global().async {
	let input = FileHandle.standardInput
	while true {
		let data = input.readData(ofLength: 3200)
		if data.isEmpty {
			request.endAudio()
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
		request.append(buffer)
	}
}

_ = done.wait(timeout: .now() + 300)
if !finished { finish(lastText, "Timed out.") }
exit(0)
`;
