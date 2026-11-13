| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| base-opus-b1 | 1 | claude-opus-5-5 | 2 | 11652 | 16256 | 73 | 1 | 10777 (5) | 38.8K | 0.1062 | yes | cc-session-title 3136, volt-predictor 2919, cc-prompt-suggestion 3471, volt-title 1251 |
| after-opus-b1 | 1 | claude-opus-5-5 | 2 | 22970 | 0 | 26 | 1 | 0 (0) | 23.0K | 0.1843 | yes |  |
| bare-opus-b1 | 1 | claude-opus-5-5 | 2 | 7254 | 10763 | 72 | 1 | 0 (0) | 18.1K | 0.0616 | yes |  |
| base-opus-b1 | 2 | claude-opus-5-5 | 2 | 0 | 27908 | 65 | 1 | 3152 (2) | 31.1K | 0.0147 | yes | cc-session-title 1901, volt-title 1251 |
| after-opus-b1 | 2 | claude-opus-5-5 | 2 | 0 | 22970 | 48 | 1 | 0 (0) | 23.0K | 0.0056 | yes |  |
| bare-opus-b1 | 2 | claude-opus-5-5 | 2 | 0 | 18017 | 62 | 1 | 0 (0) | 18.1K | 0.0049 | yes |  |
| base-opus-b1 | 3 | claude-opus-5-5 | 2 | 0 | 27908 | 66 | 1 | 3152 (2) | 31.1K | 0.0147 | yes | cc-session-title 1901, volt-title 1251 |
| after-opus-b1 | 3 | claude-opus-5-5 | 2 | 0 | 22970 | 55 | 1 | 0 (0) | 23.0K | 0.0057 | yes |  |
| bare-opus-b1 | 3 | claude-opus-5-5 | 2 | 0 | 18017 | 58 | 1 | 0 (0) | 18.1K | 0.0048 | yes |  |
| base-opus-b3 | 1 | claude-opus-5-5 | 6 | 11727 | 77013 | 2366 | 3 | 43683 (5) | 134.8K | 0.1871 | yes | volt-predictor 3344, cc-session-title 2353, cc-prompt-suggestion 36678, volt-title 1308 |
| after-opus-b3 | 1 | claude-opus-5-5 | 6 | 11454 | 64219 | 2443 | 3 | 4516 (2) | 82.6K | 0.1537 | yes | volt-predictor 3208, volt-title 1308 |
| bare-opus-b3 | 1 | claude-opus-5-5 | 6 | 7195 | 50575 | 2342 | 3 | 0 (0) | 60.1K | 0.1145 | yes |  |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| base-opus-b1 claude-opus-5-5 | 3 | 31.1K (31.1K-38.8K) | 28.0K | 3.2K | 0.0147 |
| after-opus-b1 claude-opus-5-5 | 3 | 23.0K (23.0K-23.0K) | 23.0K | 0.0K | 0.0057 |
| bare-opus-b1 claude-opus-5-5 | 3 | 18.1K (18.1K-18.1K) | 18.1K | 0.0K | 0.0049 |
| base-opus-b3 claude-opus-5-5 | 1 | 134.8K (134.8K-134.8K) | 91.1K | 43.7K | 0.1871 |
| after-opus-b3 claude-opus-5-5 | 1 | 82.6K (82.6K-82.6K) | 78.1K | 4.5K | 0.1537 |
| bare-opus-b3 claude-opus-5-5 | 1 | 60.1K (60.1K-60.1K) | 60.1K | 0.0K | 0.1145 |
