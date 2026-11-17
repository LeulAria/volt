// node t3eval.mjs '<expression>'  evaluate in the T3 Code test window (CDP 9985)
import { connect, PORT } from './lib.mjs';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find(t => t.type === 'page' && /^t3code:/.test(t.url));
const c = await connect(page.webSocketDebuggerUrl, page.id);
console.log(JSON.stringify(await c.evaluate(process.argv[2]), null, 1));
c.close();
