| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| base-r4c-b1 | 1 | claude-opus-5-5 | 2 | 0 | 23081 | 67 | 1 | 0 (0) | 23.1K | 0.0060 | yes |  |
| after-r4c-b1 | 1 | claude-opus-5-5 | 2 | 0 | 15556 | 68 | 1 | 0 (0) | 15.6K | 0.0045 | yes |  |
| bare-r4c-b1 | 1 | claude-opus-5-5 | 2 | 0 | 18034 | 66 | 1 | 0 (0) | 18.1K | 0.0049 | yes |  |
| base-r4c-b1 | 2 | claude-opus-5-5 | 2 | 0 | 23081 | 66 | 1 | 0 (0) | 23.1K | 0.0059 | yes |  |
| after-r4c-b1 | 2 | claude-opus-5-5 | 2 | 0 | 15556 | 69 | 1 | 0 (0) | 15.6K | 0.0045 | yes |  |
| bare-r4c-b1 | 2 | claude-opus-5-5 | 2 | 0 | 18034 | 79 | 1 | 0 (0) | 18.1K | 0.0052 | yes |  |
| base-r4c-b1 | 3 | claude-opus-5-5 | 2 | 0 | 23081 | 56 | 1 | 0 (0) | 23.1K | 0.0057 | yes |  |
| after-r4c-b1 | 3 | claude-opus-5-5 | 2 | 0 | 15556 | 66 | 1 | 0 (0) | 15.6K | 0.0044 | yes |  |
| bare-r4c-b1 | 3 | claude-opus-5-5 | 2 | 0 | 18034 | 70 | 1 | 0 (0) | 18.1K | 0.0050 | yes |  |
| base-r4c-b3 | 1 | claude-opus-5-5 | 6 | 1033 | 75575 | 2188 | 3 | 1337 (1) | 80.1K | 0.0672 | yes | volt-title 1337 |
| after-r4c-b3 | 1 | claude-opus-5-5 | 6 | 10022 | 43739 | 2075 | 3 | 1330 (1) | 57.2K | 0.1305 | yes | volt-title 1330 |
| bare-r4c-b3 | 1 | claude-opus-5-5 | 8 | 1058 | 77429 | 2928 | 4 | 0 (0) | 81.4K | 0.0825 | yes |  |
| base-r4c-b3 | 2 | claude-opus-5-5 | 6 | 2574 | 74151 | 2489 | 3 | 1337 (1) | 80.6K | 0.0852 | yes | volt-title 1337 |
| after-r4c-b3 | 2 | claude-opus-5-5 | 6 | 2341 | 51574 | 2075 | 3 | 1337 (1) | 57.3K | 0.0706 | yes | volt-title 1337 |
| bare-r4c-b3 | 2 | claude-opus-5-5 | 6 | 1387 | 57083 | 2749 | 3 | 0 (0) | 61.2K | 0.0775 | yes |  |
| base-r4c-b3 | 3 | claude-opus-5-5 | 6 | 982 | 75579 | 2287 | 3 | 1337 (1) | 80.2K | 0.0688 | yes | volt-title 1337 |
| after-r4c-b3 | 3 | claude-opus-5-5 | 6 | 765 | 53000 | 2331 | 3 | 1330 (1) | 57.4K | 0.0634 | yes | volt-title 1330 |
| bare-r4c-b3 | 3 | claude-opus-5-5 | 8 | 1284 | 77643 | 2905 | 4 | 0 (0) | 81.8K | 0.0839 | yes |  |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| base-r4c-b1 claude-opus-5-5 | 3 | 23.1K (23.1K-23.1K) | 23.1K | 0.0K | 0.0059 |
| after-r4c-b1 claude-opus-5-5 | 3 | 15.6K (15.6K-15.6K) | 15.6K | 0.0K | 0.0045 |
| bare-r4c-b1 claude-opus-5-5 | 3 | 18.1K (18.1K-18.1K) | 18.1K | 0.0K | 0.0050 |
| base-r4c-b3 claude-opus-5-5 | 3 | 80.2K (80.1K-80.6K) | 78.9K | 1.3K | 0.0688 |
| after-r4c-b3 claude-opus-5-5 | 3 | 57.3K (57.2K-57.4K) | 56.0K | 1.3K | 0.0706 |
| bare-r4c-b3 claude-opus-5-5 | 3 | 81.4K (61.2K-81.8K) | 81.4K | 0.0K | 0.0825 |
