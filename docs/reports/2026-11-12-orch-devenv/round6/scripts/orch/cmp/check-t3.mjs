// Hidden check for T3 (agents never see it). Usage: node check-t3.mjs <dir>
const dir = process.argv[2];
const m = await import(dir + '/src/money.ts');
const cases = [
	['formatCents(0)', () => m.formatCents(0), '$0.00'],
	['formatCents(105)', () => m.formatCents(105), '$1.05'],
	['formatCents(123456)', () => m.formatCents(123456), '$1234.56'],
	['formatCents(-250)', () => m.formatCents(-250), '-$2.50'],
	['formatCents(-5)', () => m.formatCents(-5), '-$0.05'],
	['formatReceipt(example)', () => m.formatReceipt?.([{ label: 'Tea', cents: 350 }, { label: 'Refund', cents: -100 }]), 'Tea: $3.50\nRefund: -$1.00\nTotal: $2.50'],
	['formatReceipt([])', () => m.formatReceipt?.([]), 'Total: $0.00'],
];
const out = cases.map(([name, f, want]) => { let got; try { got = f(); } catch (e) { got = 'throws ' + e.message; } return { name, ok: got === want, got }; });
console.log(JSON.stringify({ pass: out.filter(c => c.ok).length, total: out.length, plantedFixed: out.slice(0, 5).every(c => c.ok), failed: out.filter(c => !c.ok) }));
