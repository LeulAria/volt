// Front chat state of the running arm (bounded): title, reply text length, streaming markers, scroller.
import { cdp } from './lib.mjs';
const c = await cdp();
const r = await Promise.race([c.evaluate(`JSON.stringify({ title: document.title, vis: document.visibilityState, replies: [...document.querySelectorAll('.volt-agent-reply')].filter(e => e.offsetParent).map(e => e.textContent.length), streaming: document.querySelectorAll('.streaming').length, fresh: document.querySelectorAll('.volt-agent-fresh-text').length, inner: [...document.querySelectorAll('.volt-agent-thread-inner')].filter(e => e.offsetParent).map(e => e.scrollTop + '/' + e.scrollHeight), threads: document.querySelectorAll('.volt-agent-thread').length, dom: document.getElementsByTagName('*').length })`), new Promise(r => setTimeout(() => r('timeout'), 8000))]);
console.log(r); c.close(); process.exit(0);
