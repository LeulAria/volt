package tax

import "math"

var rates = map[string]float64{
	"eu":   0.2,
	"us":   0.07,
	"none": 0,
}

func RoundCents(value float64) float64 {
	return math.Round(value*100) / 100
}

func ComputeTax(amount float64, region string) float64 {
	return RoundCents(amount * rates[region])
}
