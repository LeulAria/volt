// node evalp.mjs '<expression>'  evaluate in the test window
import { cdp } from './lib.mjs';
const c = await cdp();
console.log(JSON.stringify(await c.evaluate(process.argv[2]), null, 1));
c.close();
