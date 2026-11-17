function demoTax(amount, rate) {
	const tax = amount * rate;
	return Math.round(tax * 100) / 100;
}

const total = demoTax(90, 0.2);
console.log('tax', total);
