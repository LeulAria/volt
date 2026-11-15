// Evaluates one expression in the test window and prints the result as JSON.
//   node ev.mjs '<expression>'
import { cdp } from './lib.mjs';

const c = await cdp();
console.log(JSON.stringify(await c.evaluate(process.argv[2]), null, 1));
c.close();
