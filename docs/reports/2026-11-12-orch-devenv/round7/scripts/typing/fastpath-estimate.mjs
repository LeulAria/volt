// Upper bound of LiveMarkdown's plain-prose path on ADEMark's stream-1 reply: the text conditions only, outside
// code fences, for 16-character chunks (80 tokens/s in 50 ms frames). Analysis aid.
import { readFileSync } from 'fs';
const lines = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(l => JSON.parse(l));
const reply = lines.filter(l => l.type === 'turn').at(-1).blocks.find(b => b.type === 'text').text;
const PLAIN = /^[A-Za-z0-9 ,.;:?!'"%/-]*$/;
const lastWord = t => t.slice(t.search(/\S*$/));
let fast = 0, slow = 0, code = 0;
for (let at = 16; at < reply.length; at += 16) {
	const drawn = reply.slice(0, at - 16), text = reply.slice(0, at), added = text.slice(drawn.length);
	if (((drawn.match(/```/g) ?? []).length % 2) === 1) { code++; continue; }
	const word = lastWord(drawn);
	const lineStart = drawn.lastIndexOf('\n', drawn.length - word.length - 1) + 1;
	const settled = /[A-Za-z]\S*\s/.test(drawn.slice(lineStart, drawn.length - word.length));
	if (word && PLAIN.test(added) && PLAIN.test(word) && !/\s$/.test(added) && !/:\/\/|www\./i.test(word + added) && settled) { fast++; } else { slow++; }
}
console.log(JSON.stringify({ chars: reply.length, chunksInCode: code, prose: fast + slow, fastByText: fast, share: (fast / (fast + slow)).toFixed(2) }));
