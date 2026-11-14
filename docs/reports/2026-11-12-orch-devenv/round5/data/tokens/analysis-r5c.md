| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before-r5c-b1 | 1 | claude-opus-5-5 | 2 | 0 | 14053 | 62 | 1 | 0 (0) | 14.1K | 0.0041 | yes |  |
| after-r5c-b1 | 1 | claude-opus-5-5 | 2 | 4634 | 7540 | 27 | 1 | 0 (0) | 12.2K | 0.0391 | yes |  |
| before-r5c-b1 | 2 | claude-opus-5-5 | 2 | 0 | 14053 | 62 | 1 | 0 (0) | 14.1K | 0.0041 | yes |  |
| after-r5c-b1 | 2 | claude-opus-5-5 | 2 | 0 | 12160 | 64 | 1 | 0 (0) | 12.2K | 0.0037 | yes |  |
| before-r5c-b1 | 3 | claude-opus-5-5 | 2 | 0 | 14053 | 54 | 1 | 0 (0) | 14.1K | 0.0039 | yes |  |
| after-r5c-b1 | 3 | claude-opus-5-5 | 2 | 0 | 12160 | 62 | 1 | 0 (0) | 12.2K | 0.0037 | yes |  |
| before-r5c-b3 | 1 | claude-opus-5-5 | 6 | 1083 | 48491 | 2151 | 3 | 1337 (1) | 53.1K | 0.0614 | yes | volt-title 1337 |
| after-r5c-b3 | 1 | claude-opus-5-5 | 6 | 749 | 42116 | 2194 | 3 | 1337 (1) | 46.4K | 0.0583 | yes | volt-title 1337 |
| before-r5c-b3 | 2 | claude-opus-5-5 | 6 | 768 | 48788 | 2164 | 3 | 1330 (1) | 53.1K | 0.0592 | yes | volt-title 1330 |
| after-r5c-b3 | 2 | claude-opus-5-5 | 6 | 804 | 42116 | 2169 | 3 | 1337 (1) | 46.4K | 0.0583 | yes | volt-title 1337 |
| before-r5c-b3 | 3 | claude-opus-5-5 | 6 | 945 | 48491 | 2246 | 3 | 1337 (1) | 53.0K | 0.0622 | yes | volt-title 1337 |
| after-r5c-b3 | 3 | claude-opus-5-5 | 6 | 716 | 42116 | 2016 | 3 | 1337 (1) | 46.2K | 0.0545 | yes | volt-title 1337 |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| before-r5c-b1 claude-opus-5-5 | 3 | 14.1K (14.1K-14.1K) | 14.1K | 0.0K | 0.0041 |
| after-r5c-b1 claude-opus-5-5 | 3 | 12.2K (12.2K-12.2K) | 12.2K | 0.0K | 0.0037 |
| before-r5c-b3 claude-opus-5-5 | 3 | 53.1K (53.0K-53.1K) | 51.7K | 1.3K | 0.0614 |
| after-r5c-b3 claude-opus-5-5 | 3 | 46.4K (46.2K-46.4K) | 45.1K | 1.3K | 0.0583 |
