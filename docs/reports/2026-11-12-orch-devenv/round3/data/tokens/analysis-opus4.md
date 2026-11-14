| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| base-opus4-b1 | 1 | claude-opus-5-5 | 2 | 0 | 27908 | 52 | 1 | 3152 (2) | 31.1K | 0.0145 | yes | cc-session-title 1901, volt-title 1251 |
| bare-opus4-b1 | 1 | claude-opus-5-5 | 2 | 4117 | 13888 | 63 | 1 | 22461 (1) | 40.5K | 0.1357 | yes | subagent/fork 22461 |
| base-opus4-b1 | 2 | claude-opus-5-5 | 2 | 0 | 27752 | 64 | 1 | 4564 (3) | 32.4K | 0.0144 | yes | volt-title 2819, cc-session-title 1745 |
| after-opus4-b1 | 2 | claude-opus-5-5 | 2 | 7716 | 13325 | 59 | 1 | 0 (0) | 21.1K | 0.0656 | yes |  |
| bare-opus4-b1 | 2 | claude-opus-5-5 | 2 | 0 | 18005 | 65 | 1 | 0 (0) | 18.1K | 0.0049 | yes |  |
| base-opus4-b1 | 3 | claude-opus-5-5 | 2 | 0 | 27752 | 55 | 1 | 2996 (2) | 30.8K | 0.0139 | yes | cc-session-title 1745, volt-title 1251 |
| after-opus4-b1 | 3 | claude-opus-5-5 | 2 | 0 | 21041 | 68 | 1 | 0 (0) | 21.1K | 0.0056 | yes |  |
| bare-opus4-b1 | 3 | claude-opus-5-5 | 2 | 0 | 18005 | 73 | 1 | 0 (0) | 18.1K | 0.0051 | yes |  |
| after-opus4-b3 | 1 | claude-opus-5-5 | 6 | 11243 | 59155 | 2244 | 3 | 32675 (1) | 105.3K | 0.1669 | yes | cc-prompt-suggestion 32675 |
| bare-opus4-b3 | 1 | claude-opus-5-5 | 10 | 8981 | 92258 | 3751 | 5 | 0 (0) | 105.0K | 0.1654 | yes |  |
| base-opus4-b3 | 2 | claude-opus-5-5 | 6 | 591 | 87425 | 2157 | 3 | 35781 (3) | 126.0K | 0.0956 | yes | cc-session-title 2195, volt-title 1308, cc-prompt-suggestion 32278 |
| after-opus4-b3 | 2 | claude-opus-5-5 | 6 | 11531 | 58843 | 2345 | 3 | 1308 (1) | 74.0K | 0.1510 | yes | volt-title 1308 |
| bare-opus4-b3 | 2 | claude-opus-5-5 | 6 | 1072 | 56996 | 2623 | 3 | 0 (0) | 60.7K | 0.0725 | yes |  |
| base-opus4-b3 | 3 | claude-opus-5-5 | 6 | 11788 | 77013 | 2445 | 3 | 36437 (3) | 127.7K | 0.1895 | yes | cc-session-title 2353, cc-prompt-suggestion 32776, volt-title 1308 |
| after-opus4-b3 | 3 | claude-opus-5-5 | 6 | 1164 | 68990 | 2442 | 3 | 1308 (1) | 73.9K | 0.0720 | yes | volt-title 1308 |
| bare-opus4-b3 | 3 | claude-opus-5-5 | 6 | 1172 | 56996 | 2807 | 3 | 0 (0) | 61.0K | 0.0769 | yes |  |
| after-opus4-b1 | 4 | claude-opus-5-5 | 2 | 0 | 21041 | 72 | 1 | 0 (0) | 21.1K | 0.0057 | yes |  |
| base-opus4-b3 | 4 | claude-opus-5-5 | 6 | 913 | 87425 | 2437 | 3 | 40060 (5) | 130.8K | 0.1028 | yes | cc-session-title 3482, volt-predictor 2797, volt-title 1308, cc-prompt-suggestion 32473 |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| base-opus4-b1 claude-opus-5-5 | 3 | 31.1K (30.8K-32.4K) | 27.8K | 3.2K | 0.0144 |
| bare-opus4-b1 claude-opus-5-5 | 3 | 18.1K (18.1K-40.5K) | 18.1K | 0.0K | 0.0051 |
| after-opus4-b1 claude-opus-5-5 | 3 | 21.1K (21.1K-21.1K) | 21.1K | 0.0K | 0.0057 |
| after-opus4-b3 claude-opus-5-5 | 3 | 74.0K (73.9K-105.3K) | 72.6K | 1.3K | 0.1510 |
| bare-opus4-b3 claude-opus-5-5 | 3 | 61.0K (60.7K-105.0K) | 61.0K | 0.0K | 0.0769 |
| base-opus4-b3 claude-opus-5-5 | 3 | 127.7K (126.0K-130.8K) | 90.8K | 36.4K | 0.1028 |
