merged-opus-b1 1 24 MAIN claude-opus-5-5 {"input":2,"cache_write":23081,"cache_write_1h":23081,"cache_read":0,"output":62} 15
merged-opus-b1 2 65 MAIN claude-opus-5-5 {"input":2,"cache_write":0,"cache_write_1h":0,"cache_read":23081,"output":69} 15
merged-opus-b1 3 106 MAIN claude-opus-5-5 {"input":2,"cache_write":0,"cache_write_1h":0,"cache_read":23081,"output":76} 15
| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| merged-opus-b1 | 1 | claude-opus-5-5 | 2 | 23081 | 0 | 62 | 1 | 0 (0) | 23.1K | 0.1859 | yes |  |
| merged-opus-b1 | 2 | claude-opus-5-5 | 2 | 0 | 23081 | 69 | 1 | 0 (0) | 23.2K | 0.0060 | yes |  |
| merged-opus-b1 | 3 | claude-opus-5-5 | 2 | 0 | 23081 | 76 | 1 | 0 (0) | 23.2K | 0.0061 | yes |  |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| merged-opus-b1 claude-opus-5-5 | 3 | 23.2K (23.1K-23.2K) | 23.2K | 0.0K | 0.0061 |
