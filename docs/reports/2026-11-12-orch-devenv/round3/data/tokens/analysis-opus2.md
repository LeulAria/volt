| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| base-opus2-b1 | 1 | claude-opus-5-5 | 2 | 8859 | 18893 | 62 | 1 | 2996 (2) | 30.8K | 0.0831 | yes | cc-session-title 1745, volt-title 1251 |
| after-opus2-b1 | 1 | claude-opus-5-5 | 2 | 10304 | 12206 | 44 | 1 | 0 (0) | 22.6K | 0.0858 | yes |  |
| bare-opus2-b1 | 1 | claude-opus-5-5 | 2 | 18005 | 0 | 68 | 1 | 0 (0) | 18.1K | 0.1454 | yes |  |
| base-opus2-b1 | 2 | claude-opus-5-5 | 2 | 0 | 27908 | 26 | 1 | 10903 (5) | 38.8K | 0.0144 | yes | cc-session-title 3136, volt-predictor 2916, volt-title 1251, cc-prompt-suggestion 3600 |
| after-opus2-b1 | 2 | claude-opus-5-5 | 2 | 0 | 22510 | 70 | 1 | 0 (0) | 22.6K | 0.0059 | yes |  |
| bare-opus2-b1 | 2 | claude-opus-5-5 | 2 | 0 | 18005 | 64 | 1 | 0 (0) | 18.1K | 0.0049 | yes |  |
| base-opus2-b1 | 3 | claude-opus-5-5 | 2 | 0 | 27752 | 72 | 1 | 2996 (2) | 30.8K | 0.0142 | yes | cc-session-title 1745, volt-title 1251 |
| after-opus2-b1 | 3 | claude-opus-5-5 | 2 | 0 | 22510 | 52 | 1 | 0 (0) | 22.6K | 0.0056 | yes |  |
| bare-opus2-b1 | 3 | claude-opus-5-5 | 2 | 0 | 18005 | 61 | 1 | 0 (0) | 18.1K | 0.0048 | yes |  |
| base-opus2-b3 | 1 | claude-opus-5-5 | 6 | 11365 | 76701 | 2182 | 3 | 35870 (3) | 126.1K | 0.1802 | yes | cc-session-title 2195, volt-title 1308, cc-prompt-suggestion 32367 |
| after-opus2-b3 | 1 | claude-opus-5-5 | 6 | 11162 | 63665 | 2172 | 3 | 1308 (1) | 78.3K | 0.1455 | yes | volt-title 1308 |
| bare-opus2-b3 | 1 | claude-opus-5-5 | 6 | 7246 | 50539 | 2243 | 3 | 0 (0) | 60.0K | 0.1130 | yes |  |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| base-opus2-b1 claude-opus-5-5 | 3 | 30.8K (30.8K-38.8K) | 27.8K | 3.0K | 0.0144 |
| after-opus2-b1 claude-opus-5-5 | 3 | 22.6K (22.6K-22.6K) | 22.6K | 0.0K | 0.0059 |
| bare-opus2-b1 claude-opus-5-5 | 3 | 18.1K (18.1K-18.1K) | 18.1K | 0.0K | 0.0049 |
| base-opus2-b3 claude-opus-5-5 | 1 | 126.1K (126.1K-126.1K) | 90.3K | 35.9K | 0.1802 |
| after-opus2-b3 claude-opus-5-5 | 1 | 78.3K (78.3K-78.3K) | 77.0K | 1.3K | 0.1455 |
| bare-opus2-b3 claude-opus-5-5 | 1 | 60.0K (60.0K-60.0K) | 60.0K | 0.0K | 0.1130 |
