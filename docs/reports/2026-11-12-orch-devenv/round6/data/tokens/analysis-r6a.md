| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before-r6a-b1 | 1 | claude-opus-5-5 | 2 | 7405 | 4760 | 70 | 1 | 0 (0) | 12.2K | 0.0616 | yes |  |
| after-r6a-b1 | 1 | claude-opus-5-5 | 2 | 11399 | 0 | 69 | 1 | 0 (0) | 11.5K | 0.0926 | yes |  |
| bare-r6a-b1 | 1 | claude-opus-5-5 | 2 | 18017 | 0 | 65 | 1 | 0 (0) | 18.1K | 0.1454 | yes |  |
| before-r6a-b1 | 2 | claude-opus-5-5 | 2 | 4643 | 7540 | 62 | 1 | 0 (0) | 12.2K | 0.0399 | yes |  |
| after-r6a-b1 | 2 | claude-opus-5-5 | 2 | 3938 | 7447 | 66 | 1 | 0 (0) | 11.5K | 0.0343 | yes |  |
| bare-r6a-b1 | 2 | claude-opus-5-5 | 2 | 0 | 18017 | 58 | 1 | 0 (0) | 18.1K | 0.0048 | yes |  |
| before-r6a-b1 | 3 | claude-opus-5-5 | 2 | 0 | 12183 | 70 | 1 | 0 (0) | 12.3K | 0.0038 | yes |  |
| after-r6a-b1 | 3 | claude-opus-5-5 | 2 | 0 | 11385 | 70 | 1 | 0 (0) | 11.5K | 0.0037 | yes |  |
| bare-r6a-b1 | 3 | claude-opus-5-5 | 2 | 0 | 18017 | 66 | 1 | 0 (0) | 18.1K | 0.0049 | yes |  |
| before-r6a-b3 | 1 | claude-opus-5-5 | 6 | 7971 | 35316 | 2280 | 3 | 4133 (2) | 49.7K | 0.1169 | yes | volt-predictor 2796, volt-title 1337 |
| after-r6a-b3 | 1 | claude-opus-5-5 | 6 | 14771 | 25948 | 2355 | 3 | 1200 (1) | 44.3K | 0.1707 | yes | volt-title 1200 |
| bare-r6a-b3 | 1 | claude-opus-5-5 | 6 | 7452 | 50575 | 2397 | 3 | 0 (0) | 60.4K | 0.1177 | yes |  |
| before-r6a-b3 | 2 | claude-opus-5-5 | 6 | 1027 | 42377 | 2277 | 3 | 1341 (1) | 47.0K | 0.0623 | yes | volt-title 1341 |
| after-r6a-b3 | 2 | claude-opus-5-5 | 6 | 861 | 39635 | 2275 | 3 | 1200 (1) | 44.0K | 0.0604 | yes | volt-title 1200 |
| bare-r6a-b3 | 2 | claude-opus-5-5 | 6 | 1217 | 57032 | 2490 | 3 | 0 (0) | 60.7K | 0.0710 | yes |  |
| before-r6a-b3 | 3 | claude-opus-5-5 | 6 | 1114 | 42377 | 2573 | 3 | 1337 (1) | 47.4K | 0.0689 | yes | volt-title 1337 |
| after-r6a-b3 | 3 | claude-opus-5-5 | 6 | 794 | 39635 | 2118 | 3 | 1200 (1) | 43.8K | 0.0567 | yes | volt-title 1200 |
| bare-r6a-b3 | 3 | claude-opus-5-5 | 6 | 711 | 57032 | 2150 | 3 | 0 (0) | 59.9K | 0.0601 | yes |  |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| before-r6a-b1 claude-opus-5-5 | 3 | 12.2K (12.2K-12.3K) | 12.2K | 0.0K | 0.0399 |
| after-r6a-b1 claude-opus-5-5 | 3 | 11.5K (11.5K-11.5K) | 11.5K | 0.0K | 0.0343 |
| bare-r6a-b1 claude-opus-5-5 | 3 | 18.1K (18.1K-18.1K) | 18.1K | 0.0K | 0.0049 |
| before-r6a-b3 claude-opus-5-5 | 3 | 47.4K (47.0K-49.7K) | 45.7K | 1.3K | 0.0689 |
| after-r6a-b3 claude-opus-5-5 | 3 | 44.0K (43.8K-44.3K) | 42.8K | 1.2K | 0.0604 |
| bare-r6a-b3 claude-opus-5-5 | 3 | 60.4K (59.9K-60.7K) | 60.4K | 0.0K | 0.0710 |
