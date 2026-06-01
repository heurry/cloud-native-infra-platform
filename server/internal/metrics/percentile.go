package metrics

import "sort"

// Pct 线性插值分位，p 为分数（如 0.50/0.95/0.99），口径同 Java
// MetricsService.percentile 与 numpy.percentile。空切片 → nil（JSON null）。
func Pct(values []float64, p float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	s := append([]float64(nil), values...)
	sort.Float64s(s)
	if len(s) == 1 {
		v := s[0]
		return &v
	}
	rank := float64(len(s)-1) * p
	low := int(rank)
	high := low + 1
	if high > len(s)-1 {
		high = len(s) - 1
	}
	weight := rank - float64(low)
	v := s[low]*(1-weight) + s[high]*weight
	return &v
}

// Mean 平均值；空切片 → nil。
func Mean(values []float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	var sum float64
	for _, v := range values {
		sum += v
	}
	m := sum / float64(len(values))
	return &m
}
