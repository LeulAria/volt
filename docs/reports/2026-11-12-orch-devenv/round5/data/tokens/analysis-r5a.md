| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before-r5a-b1 | 1 | claude-opus-5-5 | 2 | 13547 | 0 | 68 | 1 | 0 (0) | 13.6K | 0.1097 | yes |  |
| bare-r5a-b1 | 1 | claude-opus-5-5 | 2 | 18017 | 0 | 66 | 1 | 0 (0) | 18.1K | 0.1455 | yes |  |
| before-r5a-b1 | 2 | claude-opus-5-5 | 2 | 9293 | 4760 | 62 | 1 | 0 (0) | 14.1K | 0.0765 | yes |  |
| bare-r5a-b1 | 2 | claude-opus-5-5 | 2 | 0 | 18017 | 67 | 1 | 0 (0) | 18.1K | 0.0050 | yes |  |
| before-r5a-b1 | 3 | claude-opus-5-5 | 2 | 0 | 14053 | 64 | 1 | 0 (0) | 14.1K | 0.0041 | yes |  |
| bare-r5a-b1 | 3 | claude-opus-5-5 | 2 | 0 | 18017 | 65 | 1 | 0 (0) | 18.1K | 0.0049 | yes |  |
| before-r5a-b3 | 1 | claude-opus-5-5 | 6 | 9911 | 39489 | 2080 | 3 | 1337 (1) | 52.8K | 0.1291 | yes | volt-title 1337 |
| bare-r5a-b3 | 1 | claude-opus-5-5 | 6 | 7638 | 50575 | 2671 | 3 | 0 (0) | 60.9K | 0.1247 | yes |  |
| before-r5a-b3 | 2 | claude-opus-5-5 | 6 | 2165 | 47065 | 2133 | 3 | 1337 (1) | 52.7K | 0.0694 | yes | volt-title 1337 |
| bare-r5a-b3 | 2 | claude-opus-5-5 | 6 | 1224 | 57032 | 2583 | 3 | 0 (0) | 60.8K | 0.0729 | yes |  |
| before-r5a-b3 | 3 | claude-opus-5-5 | 6 | 847 | 48491 | 2157 | 3 | 1337 (1) | 52.8K | 0.0597 | yes | volt-title 1337 |
| bare-r5a-b3 | 3 | claude-opus-5-5 | 8 | 1523 | 77382 | 2975 | 4 | 0 (0) | 81.9K | 0.0872 | yes |  |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| before-r5a-b1 claude-opus-5-5 | 3 | 14.1K (13.6K-14.1K) | 14.1K | 0.0K | 0.0765 |
| bare-r5a-b1 claude-opus-5-5 | 3 | 18.1K (18.1K-18.1K) | 18.1K | 0.0K | 0.0050 |
| before-r5a-b3 claude-opus-5-5 | 3 | 52.8K (52.7K-52.8K) | 51.5K | 1.3K | 0.0694 |
| bare-r5a-b3 claude-opus-5-5 | 3 | 60.9K (60.8K-81.9K) | 60.9K | 0.0K | 0.0872 |
