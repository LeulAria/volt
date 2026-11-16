/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The call's audio, as a page for a hidden WebView (an iframe on the web): the microphone at
 * 24 kHz PCM16 to the voice provider's realtime socket, its spoken answer through the speaker,
 * barge-in (the caller talks over it: playback stops and the server learns how much was heard).
 * The same protocol handling as the desktop's RealtimeVoiceClient
 * (src/vs/workbench/contrib/voltVoiceChat/browser/realtimeVoiceClient.ts).
 *
 * App → page: `window.__voice.cmd({ type, ... })`: start {session, sessionUpdate, greeting},
 * toolResult {callId, output, respond, instructions, end}, note {text}, mute {muted},
 * update {sessionUpdate}, hangup.
 * Page → app: JSON messages: ready, state {state}, level {level}, userTranscript {itemId, text, final},
 * assistantTranscript {itemId, text}, functionCall {callId, name, arguments}, ended {reason}, error {message}.
 */
export const VOICE_ENGINE_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body><script>
(function () {
	var RATE = 24000;
	var ws = null, mic = null, out = null, analyser = null;
	var playing = [], playhead = 0, playingItem = null;
	var responding = false, owed = null, muted = false, state = 'connecting', ended = false;
	var userDraft = {}, assistantDraft = {}, seenCalls = {};
	var greetTimer = null, spoke = false, endWhenQuiet = false, levelTimer = null;

	function post(msg) {
		var text = JSON.stringify(msg);
		if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(text); }
		else if (window.parent !== window) { window.parent.postMessage({ voltVoice: text }, '*'); }
	}
	function setState(next) { if (state !== next && !ended) { state = next; post({ type: 'state', state: next }); } }
	function send(event) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(event)); } }
	function rms(data) { var s = 0; for (var i = 0; i < data.length; i++) { s += data[i] * data[i]; } return Math.min(1, Math.sqrt(s / Math.max(1, data.length)) * 4); }

	function toBase64(samples) {
		var bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
		for (var i = 0; i < samples.length; i++) { var v = Math.max(-1, Math.min(1, samples[i])); view.setInt16(i * 2, Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), true); }
		var bin = ''; for (var j = 0; j < bytes.length; j += 0x8000) { bin += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(j, j + 0x8000))); }
		return btoa(bin);
	}
	function fromBase64(b64) {
		var bin = atob(b64), n = bin.length >> 1, outData = new Float32Array(n);
		for (var i = 0; i < n; i++) { var v = (bin.charCodeAt(i * 2 + 1) << 8) | bin.charCodeAt(i * 2); if (v >= 0x8000) { v -= 0x10000; } outData[i] = v / (v < 0 ? 0x8000 : 0x7fff); }
		return outData;
	}
	function resample(samples, from) {
		if (from === RATE) { return samples; }
		var ratio = from / RATE, length = Math.floor(samples.length / ratio), res = new Float32Array(length);
		for (var i = 0; i < length; i++) { var a = Math.floor(i * ratio), b = Math.min(samples.length, Math.max(a + 1, Math.floor((i + 1) * ratio))), s = 0; for (var j = a; j < b; j++) { s += samples[j]; } res[i] = s / (b - a); }
		return res;
	}

	function requestResponse(instructions) {
		if (responding) { owed = { instructions: instructions || (owed && owed.instructions) }; return; }
		responding = true;
		send(instructions ? { type: 'response.create', response: { instructions: instructions } } : { type: 'response.create' });
	}
	function stopPlayback(truncate) {
		if (truncate && playingItem && out && playing.length) {
			var heard = Math.max(0, Math.min(playingItem.queuedMs, (out.currentTime - playingItem.startedAt) * 1000));
			send({ type: 'conversation.item.truncate', item_id: playingItem.id, content_index: 0, audio_end_ms: Math.round(heard) });
		}
		playing.forEach(function (node) { node.onended = null; try { node.stop(); } catch (e) { } });
		playing = []; playingItem = null; playhead = 0;
	}
	function play(itemId, b64) {
		if (!out) { return; }
		var samples = fromBase64(b64); if (!samples.length) { return; }
		var buffer = out.createBuffer(1, samples.length, RATE); buffer.getChannelData(0).set(samples);
		var node = out.createBufferSource(); node.buffer = buffer; node.connect(analyser);
		if (playhead < out.currentTime) { playhead = out.currentTime + 0.03; }
		node.start(playhead);
		if (!playingItem || playingItem.id !== itemId) { playingItem = { id: itemId, queuedMs: 0, startedAt: playhead }; }
		playhead += buffer.duration; playingItem.queuedMs += buffer.duration * 1000;
		playing.push(node);
		node.onended = function () {
			playing = playing.filter(function (n) { return n !== node; });
			if (!playing.length && !responding) { setState('listening'); if (endWhenQuiet) { hangup('voice_goodbye'); } }
		};
		setState('speaking');
	}

	function onServerEvent(e) {
		var type = e.type || '', item = e.item_id || '';
		switch (type) {
			case 'session.updated':
				if (state === 'connecting') { setState('listening'); post({ type: 'ready' }); }
				break;
			case 'input_audio_buffer.speech_started':
				spoke = true; stopPlayback(true); setState('listening'); break;
			case 'input_audio_buffer.speech_stopped':
				setState('thinking'); break;
			case 'conversation.item.input_audio_transcription.delta':
				userDraft[item] = (userDraft[item] || '') + (e.delta || ''); post({ type: 'userTranscript', itemId: item, text: userDraft[item], final: false }); break;
			case 'conversation.item.input_audio_transcription.updated':
				userDraft[item] = e.transcript || e.text || ''; post({ type: 'userTranscript', itemId: item, text: userDraft[item], final: false }); break;
			case 'conversation.item.input_audio_transcription.completed':
				delete userDraft[item]; spoke = true; post({ type: 'userTranscript', itemId: item, text: String(e.transcript || '').trim(), final: true }); break;
			case 'response.created':
				responding = true; if (state !== 'speaking') { setState('thinking'); } break;
			case 'response.output_audio.delta': case 'response.audio.delta':
				if (e.delta) { play(item, e.delta); } break;
			case 'response.output_audio_transcript.delta': case 'response.audio_transcript.delta': case 'response.output_text.delta': case 'response.text.delta':
				assistantDraft[item] = (assistantDraft[item] || '') + (e.delta || ''); break;
			case 'response.output_audio_transcript.done': case 'response.audio_transcript.done': case 'response.output_text.done': case 'response.text.done': {
				var said = String(e.transcript || e.text || assistantDraft[item] || '').trim(); delete assistantDraft[item];
				if (said) { post({ type: 'assistantTranscript', itemId: item, text: said }); }
				break;
			}
			case 'response.function_call_arguments.done':
				functionCall(e.call_id, e.name, e.arguments); break;
			case 'response.output_item.done':
				if (e.item && e.item.type === 'function_call') { functionCall(e.item.call_id, e.item.name, e.item.arguments); } break;
			case 'response.done':
				responding = false;
				if (owed) { var o = owed; owed = null; setTimeout(function () { requestResponse(o.instructions); }, 0); }
				else if (!playing.length) { setState('listening'); if (endWhenQuiet) { hangup('voice_goodbye'); } }
				break;
			case 'error':
				post({ type: 'error', message: (e.error && e.error.message) || e.message || 'The voice service reported an error.', fatal: state === 'connecting' }); break;
		}
	}
	function functionCall(callId, name, args) {
		if (!callId || seenCalls[callId]) { return; }
		seenCalls[callId] = true;
		post({ type: 'functionCall', callId: callId, name: name || '', arguments: args || '{}' });
	}

	function openMic() {
		return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (stream) {
			var ctx = new (window.AudioContext || window.webkitAudioContext)();
			var source = ctx.createMediaStreamSource(stream), processor = ctx.createScriptProcessor(4096, 1, 1), sink = ctx.createGain();
			sink.gain.value = 0;
			processor.onaudioprocess = function (ev) {
				var data = ev.inputBuffer.getChannelData(0);
				if (muted || !ws || ws.readyState !== 1) { if (state !== 'speaking') { post({ type: 'level', level: 0 }); } return; }
				send({ type: 'input_audio_buffer.append', audio: toBase64(resample(data, ctx.sampleRate)) });
				if (state !== 'speaking') { post({ type: 'level', level: rms(data) }); }
			};
			source.connect(processor); processor.connect(sink); sink.connect(ctx.destination);
			ctx.resume();
			mic = { stream: stream, ctx: ctx, processor: processor, source: source };
		});
	}

	function start(msg) {
		out = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
		analyser = out.createAnalyser(); analyser.fftSize = 512; analyser.connect(out.destination); out.resume();
		levelTimer = setInterval(function () {
			if (state !== 'speaking' || !analyser) { return; }
			var data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data); post({ type: 'level', level: rms(data) });
		}, 80);
		openMic().then(function () {
			var protocols = msg.session.protocols && msg.session.protocols.length ? msg.session.protocols : undefined;
			ws = protocols ? new WebSocket(msg.session.url, protocols) : new WebSocket(msg.session.url);
			ws.onopen = function () { send(msg.sessionUpdate); };
			ws.onmessage = function (m) { var e; try { e = JSON.parse(m.data); } catch (err) { return; } onServerEvent(e); };
			ws.onclose = function (ev) {
				if (ended) { return; }
				post({ type: 'error', message: ev.code === 1000 ? 'The voice call ended.' : 'The voice connection closed' + (ev.reason ? ': ' + ev.reason : ' (code ' + ev.code + ').'), fatal: true });
				hangup('closed');
			};
			greetTimer = setTimeout(function () { if (!spoke && state !== 'connecting') { spoke = true; requestResponse(msg.greeting); } }, 15000);
		}, function (err) {
			post({ type: 'error', message: err && err.name === 'NotAllowedError' ? 'Volt is not allowed to use the microphone. Allow it in Settings.' : 'The microphone could not start: ' + (err && err.message || err), fatal: true });
			hangup('microphone');
		});
	}

	function hangup(reason) {
		if (ended) { return; }
		ended = true;
		clearTimeout(greetTimer); clearInterval(levelTimer);
		stopPlayback(false);
		if (ws) { try { ws.close(1000); } catch (e) { } ws = null; }
		if (mic) { mic.processor.onaudioprocess = null; mic.stream.getTracks().forEach(function (t) { t.stop(); }); try { mic.ctx.close(); } catch (e) { } mic = null; }
		if (out) { try { out.close(); } catch (e) { } out = null; }
		post({ type: 'ended', reason: reason });
	}

	window.__voice = {
		cmd: function (msg) {
			switch (msg.type) {
				case 'start': start(msg); break;
				case 'toolResult':
					send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: msg.callId, output: typeof msg.output === 'string' ? msg.output : JSON.stringify(msg.output) } });
					if (msg.end) { endWhenQuiet = true; if (!playing.length && !responding) { hangup('voice_goodbye'); } }
					else if (msg.respond) { requestResponse(msg.instructions); }
					break;
				case 'note':
					send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: msg.text }] } });
					requestResponse();
					break;
				case 'mute':
					muted = !!msg.muted; if (mic) { mic.stream.getAudioTracks().forEach(function (t) { t.enabled = !muted; }); } break;
				case 'update': send(msg.sessionUpdate); break;
				case 'hangup': hangup('hang_up'); break;
			}
		}
	};
	window.addEventListener('message', function (ev) { if (ev.data && ev.data.voltVoiceCmd) { window.__voice.cmd(ev.data.voltVoiceCmd); } });
	post({ type: 'loaded' });
})();
</script></body></html>`;
