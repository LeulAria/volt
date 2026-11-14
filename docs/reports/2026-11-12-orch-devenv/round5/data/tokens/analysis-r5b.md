| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before-r5b-b1 | 1 | claude-opus-5-5 | 2 | 5811 | 8411 | 48 | 1 | 0 (0) | 14.3K | 0.0491 | yes |  |
| after-r5b-b1 | 1 | claude-opus-5-5 | 2 | 3789 | 8411 | 69 | 1 | 0 (0) | 12.3K | 0.0334 | yes |  |
| bare-r5b-b1 | 1 | claude-opus-5-5 | 2 | 0 | 18017 | 65 | 1 | 0 (0) | 18.1K | 0.0049 | yes |  |
| before-r5b-b1 | 2 | claude-opus-5-5 | 2 | 0 | 14053 | 44 | 1 | 0 (0) | 14.1K | 0.0037 | yes |  |
| after-r5b-b1 | 2 | claude-opus-5-5 | 2 | 3749 | 8411 | 67 | 1 | 0 (0) | 12.2K | 0.0330 | yes |  |
| bare-r5b-b1 | 2 | claude-opus-5-5 | 2 | 0 | 18017 | 63 | 1 | 0 (0) | 18.1K | 0.0049 | yes |  |
| before-r5b-b1 | 3 | claude-opus-5-5 | 2 | 0 | 14053 | 60 | 1 | 0 (0) | 14.1K | 0.0040 | yes |  |
| after-r5b-b1 | 3 | claude-opus-5-5 | 2 | 0 | 12160 | 68 | 1 | 0 (0) | 12.2K | 0.0038 | yes |  |
| bare-r5b-b1 | 3 | claude-opus-5-5 | 2 | 0 | 18017 | 71 | 1 | 0 (0) | 18.1K | 0.0050 | yes |  |
| before-r5b-b3 | 1 | claude-opus-5-5 | 6 | 1034 | 48491 | 2144 | 3 | 1337 (1) | 53.0K | 0.0609 | yes | volt-title 1337 |
| after-r5b-b3 | 1 | claude-opus-5-5 | 6 | 7955 | 35142 | 2298 | 3 | 1337 (1) | 46.7K | 0.1167 | yes | volt-title 1337 |
| bare-r5b-b3 | 1 | claude-opus-5-5 | 10 | 2298 | 98638 | 4130 | 5 | 0 (0) | 105.1K | 0.1208 | no |  |
| before-r5b-b3 | 2 | claude-opus-5-5 | 6 | 10208 | 39590 | 2222 | 3 | 4520 (2) | 56.5K | 0.1342 | yes | volt-predictor 3183, volt-title 1337 |
| after-r5b-b3 | 2 | claude-opus-5-5 | 6 | 7994 | 35340 | 2345 | 3 | 1337 (1) | 47.0K | 0.1180 | yes | volt-title 1337 |
| bare-r5b-b3 | 2 | claude-opus-5-5 | 6 | 1362 | 57032 | 2611 | 3 | 0 (0) | 61.0K | 0.0745 | yes |  |
| before-r5b-b3 | 3 | claude-opus-5-5 | 6 | 849 | 48788 | 2268 | 3 | 1337 (1) | 53.2K | 0.0620 | yes | volt-title 1337 |
| after-r5b-b3 | 3 | claude-opus-5-5 | 6 | 987 | 42116 | 2255 | 3 | 1337 (1) | 46.7K | 0.0615 | yes | volt-title 1337 |
| bare-r5b-b3 | 3 | claude-opus-5-5 | 6 | 1428 | 57032 | 2679 | 3 | 0 (0) | 61.1K | 0.0764 | yes |  |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| before-r5b-b1 claude-opus-5-5 | 3 | 14.1K (14.1K-14.3K) | 14.1K | 0.0K | 0.0040 |
| after-r5b-b1 claude-opus-5-5 | 3 | 12.2K (12.2K-12.3K) | 12.2K | 0.0K | 0.0330 |
| bare-r5b-b1 claude-opus-5-5 | 3 | 18.1K (18.1K-18.1K) | 18.1K | 0.0K | 0.0049 |
| before-r5b-b3 claude-opus-5-5 | 3 | 53.2K (53.0K-56.5K) | 51.9K | 1.3K | 0.0620 |
| after-r5b-b3 claude-opus-5-5 | 3 | 46.7K (46.7K-47.0K) | 45.4K | 1.3K | 0.1167 |
| bare-r5b-b3 claude-opus-5-5 | 3 | 61.1K (61.0K-105.1K) | 61.1K | 0.0K | 0.0764 |
