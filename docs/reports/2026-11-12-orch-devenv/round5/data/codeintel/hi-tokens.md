| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| r5h-after-hi | 1 | claude-haiku-5-5 | 2 | 0 | 14707 | 80 | 1 | 0 (0) | 14.8K | 0.0002 | no |  |
| r5h-before-hi | 1 | claude-haiku-5-5 | 2 | 0 | 14793 | 66 | 1 | 0 (0) | 14.9K | 0.0002 | no |  |
| r5h-after-hi | 2 | claude-haiku-5-5 | 2 | 0 | 14707 | 82 | 1 | 0 (0) | 14.8K | 0.0002 | no |  |
| r5h-before-hi | 2 | claude-haiku-5-5 | 2 | 0 | 14707 | 84 | 1 | 0 (0) | 14.8K | 0.0002 | no |  |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| r5h-after-hi claude-haiku-5-5 | 2 | 14.8K (14.8K-14.8K) | 14.8K | 0.0K | 0.0002 |
| r5h-before-hi claude-haiku-5-5 | 2 | 14.8K (14.8K-14.9K) | 14.8K | 0.0K | 0.0002 |
