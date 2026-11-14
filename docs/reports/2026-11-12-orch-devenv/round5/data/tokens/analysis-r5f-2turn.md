| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before-r5f-2turn | 1 | claude-opus-5-5 | 6 | 676 | 48491 | 2068 | 3 | 70985 (5) | 122.2K | 0.1569 | yes | volt-title 1337, subagent/fork 65955, volt-predictor 3693 |
| after-r5f-2turn | 1 | claude-opus-5-5 | 6 | 968 | 42116 | 2315 | 3 | 81091 (5) | 126.5K | 0.1774 | yes | volt-title 1337, subagent/fork 79754 |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| before-r5f-2turn claude-opus-5-5 | 1 | 122.2K (122.2K-122.2K) | 51.2K | 71.0K | 0.1569 |
| after-r5f-2turn claude-opus-5-5 | 1 | 126.5K (126.5K-126.5K) | 45.4K | 81.1K | 0.1774 |
