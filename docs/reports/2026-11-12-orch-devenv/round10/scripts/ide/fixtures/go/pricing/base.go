package pricing

// BaseRule carries what every rule shares.
type BaseRule struct {
	name string
}

func (b BaseRule) Name() string {
	return b.name
}

func (b BaseRule) clamp(value float64) float64 {
	if value < 0 {
		return 0
	}
	return value
}
