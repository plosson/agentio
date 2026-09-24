package google

import (
	"math"
	"math/big"
	"strconv"
)

// FormatBytes is Bun format.ts formatBytes: one decimal, trailing ".0"
// dropped, units up to GB (a larger value prints "undefined" as Bun does).
func FormatBytes(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}
	sizes := []string{"B", "KB", "MB", "GB"}
	i := int(math.Floor(math.Log(float64(bytes)) / math.Log(1024)))
	unit := "undefined"
	if i >= 0 && i < len(sizes) {
		unit = sizes[i]
	}
	value := float64(bytes) / math.Pow(1024, float64(i))
	return strconv.FormatFloat(toFixed1(value), 'f', -1, 64) + " " + unit
}

// toFixed1 is parseFloat(x.toFixed(1)): the exact binary value rounded to one
// decimal, a tie going up (JavaScript picks the larger n).
func toFixed1(x float64) float64 {
	exact := new(big.Float).SetPrec(256).SetFloat64(x)
	exact.Mul(exact, big.NewFloat(10))
	floor, _ := exact.Int(nil)
	if exact.Sign() < 0 && new(big.Float).SetInt(floor).Cmp(exact) != 0 {
		floor.Sub(floor, big.NewInt(1))
	}
	rem := new(big.Float).SetPrec(256).Sub(exact, new(big.Float).SetInt(floor))
	if rem.Cmp(big.NewFloat(0.5)) >= 0 {
		floor.Add(floor, big.NewInt(1))
	}
	n, _ := new(big.Float).SetInt(floor).Float64()
	return n / 10
}
