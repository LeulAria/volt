| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| after-r6b-b1 | 1 | claude-opus-5-5 | 2 | 0 | 11320 | 67 | 1 | 0 (0) | 11.4K | 0.0036 | yes |  |
| after-r6b-b1 | 2 | claude-opus-5-5 | 2 | 3896 | 7410 | 66 | 1 | 0 (0) | 11.4K | 0.0340 | yes |  |
| after-r6b-b1 | 3 | claude-opus-5-5 | 2 | 0 | 11306 | 62 | 1 | 0 (0) | 11.4K | 0.0035 | yes |  |
| after-r6b-b3 | 1 | claude-opus-5-5 | 6 | 7344 | 33322 | 2290 | 3 | 4118 (2) | 47.1K | 0.1114 | yes | volt-predictor 2918, volt-title 1200 |
| after-r6b-b3 | 2 | claude-opus-5-5 | 6 | 1026 | 39581 | 2525 | 3 | 1200 (1) | 44.3K | 0.0667 | yes | volt-title 1200 |
| after-r6b-b3 | 3 | claude-opus-5-5 | 6 | 807 | 39581 | 2295 | 3 | 1200 (1) | 43.9K | 0.0603 | yes | volt-title 1200 |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| after-r6b-b1 claude-opus-5-5 | 3 | 11.4K (11.4K-11.4K) | 11.4K | 0.0K | 0.0036 |
| after-r6b-b3 claude-opus-5-5 | 3 | 44.3K (43.9K-47.1K) | 43.0K | 1.2K | 0.0667 |
