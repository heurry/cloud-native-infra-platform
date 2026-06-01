package metrics

import (
	"math"
	"testing"
)

func TestPctNumpyParity(t *testing.T) {
	// numpy.percentile([1,2,3,4], [50,95,99]) = [2.5, 3.85, 3.97]
	in := []float64{4, 1, 3, 2} // 乱序，内部排序
	cases := map[float64]float64{0.50: 2.5, 0.95: 3.85, 0.99: 3.97}
	for p, want := range cases {
		got := Pct(in, p)
		if got == nil {
			t.Fatalf("p=%.2f 期望 %v，得到 nil", p, want)
		}
		if math.Abs(*got-want) > 1e-9 {
			t.Errorf("p=%.2f 期望 %v，得到 %v", p, want, *got)
		}
	}
}

func TestPctSingleAndEmpty(t *testing.T) {
	if got := Pct([]float64{5}, 0.95); got == nil || *got != 5 {
		t.Errorf("单元素期望 5，得到 %v", got)
	}
	if got := Pct(nil, 0.5); got != nil {
		t.Errorf("空切片应为 nil，得到 %v", *got)
	}
}

func TestMean(t *testing.T) {
	if got := Mean([]float64{2, 4}); got == nil || *got != 3 {
		t.Errorf("期望 3，得到 %v", got)
	}
	if got := Mean(nil); got != nil {
		t.Errorf("空切片应为 nil")
	}
}
