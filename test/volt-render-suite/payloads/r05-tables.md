Benchmark results across regions:

| Region | Provider | p50 (ms) | p95 (ms) | p99 (ms) | Errors | Throughput (rps) | Cost / 1M req | Status | Notes |
|:-------|:---------|---------:|---------:|---------:|-------:|-----------------:|--------------:|:------:|:------|
| us-east-1 | AWS | 12 | 48 | 91 | 0.01% | 18,400 | $0.42 | ✅ | `c7g.xlarge` |
| us-west-2 | AWS | 14 | 52 | 103 | 0.02% | 17,900 | $0.42 | ✅ | baseline |
| eu-west-1 | AWS | 19 | 61 | 120 | 0.03% | 15,200 | $0.46 | ✅ | GDPR |
| eu-central-1 | GCP | 21 | 66 | 131 | 0.05% | 14,700 | $0.39 | ⚠️ | cold starts |
| ap-south-1 | Azure | 33 | 98 | 210 | 0.11% | 9,800 | $0.51 | ⚠️ | see [incident](https://example.com/inc/42) |
| ap-northeast-1 | AWS | 27 | 80 | 160 | 0.04% | 12,100 | $0.48 | ✅ | — |
| sa-east-1 | GCP | 41 | 120 | 260 | 0.20% | 7,300 | $0.55 | ❌ | **degraded** |
| af-south-1 | Azure | 55 | 150 | 330 | 0.31% | 5,100 | $0.61 | ❌ | new region |

A small two-column table:

| Key | Value |
|---|---|
| `timeout` | 30s |
| `retries` | 3 |
| `backoff` | exponential, *jittered* |
