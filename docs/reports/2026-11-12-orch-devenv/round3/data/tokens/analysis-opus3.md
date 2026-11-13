| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| base-opus3-b1 | 1 | claude-opus-5-5 | 2 | 27910 | 0 | 48 | 1 | 10703 (5) | 38.7K | 0.2328 | yes | cc-session-title 3136, volt-predictor 2886, volt-title 1251, cc-prompt-suggestion 3430 |
| after-opus3-b1 | 1 | claude-opus-5-5 | 2 | 20970 | 0 | 60 | 1 | 0 (0) | 21.0K | 0.1690 | yes |  |
| bare-opus3-b1 | 1 | claude-opus-5-5 | 2 | 0 | 18005 | 68 | 1 | 0 (0) | 18.1K | 0.0050 | yes |  |
| base-opus3-b1 | 2 | claude-opus-5-5 | 2 | 11652 | 16256 | 57 | 1 | 3152 (2) | 31.1K | 0.1054 | yes | cc-session-title 1901, volt-title 1251 |
| after-opus3-b1 | 2 | claude-opus-5-5 | 2 | 10310 | 10658 | 52 | 1 | 0 (0) | 21.0K | 0.0857 | yes |  |
| bare-opus3-b1 | 2 | claude-opus-5-5 | 2 | 0 | 18005 | 57 | 1 | 0 (0) | 18.1K | 0.0047 | yes |  |
| base-opus3-b1 | 3 | claude-opus-5-5 | 2 | 8859 | 18893 | 54 | 1 | 2996 (2) | 30.8K | 0.0829 | yes | cc-session-title 1745, volt-title 1251 |
| after-opus3-b1 | 3 | claude-opus-5-5 | 2 | 0 | 20968 | 50 | 1 | 0 (0) | 21.0K | 0.0052 | yes |  |
| bare-opus3-b1 | 3 | claude-opus-5-5 | 2 | 0 | 18005 | 69 | 1 | 0 (0) | 18.1K | 0.0050 | yes |  |
| base-opus3-b3 | 1 | claude-opus-5-5 | 6 | 11763 | 77013 | 2204 | 3 | 36179 (3) | 127.2K | 0.1829 | yes | cc-session-title 2353, volt-title 1308, cc-prompt-suggestion 32518 |
| after-opus3-b3 | 1 | claude-opus-5-5 | 6 | 11062 | 58936 | 2167 | 3 | 4184 (2) | 76.4K | 0.1438 | yes | volt-predictor 2876, volt-title 1308 |
| bare-opus3-b3 | 1 | claude-opus-5-5 | 6 | 7523 | 50539 | 2398 | 3 | 0 (0) | 60.5K | 0.1183 | yes |  |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| base-opus3-b1 claude-opus-5-5 | 3 | 31.1K (30.8K-38.7K) | 28.0K | 3.2K | 0.1054 |
| after-opus3-b1 claude-opus-5-5 | 3 | 21.0K (21.0K-21.0K) | 21.0K | 0.0K | 0.0857 |
| bare-opus3-b1 claude-opus-5-5 | 3 | 18.1K (18.1K-18.1K) | 18.1K | 0.0K | 0.0050 |
| base-opus3-b3 claude-opus-5-5 | 1 | 127.2K (127.2K-127.2K) | 91.0K | 36.2K | 0.1829 |
| after-opus3-b3 claude-opus-5-5 | 1 | 76.4K (76.4K-76.4K) | 72.2K | 4.2K | 0.1438 |
| bare-opus3-b3 claude-opus-5-5 | 1 | 60.5K (60.5K-60.5K) | 60.5K | 0.0K | 0.1183 |
