| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| base-r4b-b1 | 1 | claude-opus-5-5 | 2 | 0 | 23081 | 62 | 1 | 0 (0) | 23.1K | 0.0059 | yes |  |
| after-r4b-b1 | 1 | claude-opus-5-5 | 2 | 0 | 16588 | 73 | 1 | 0 (0) | 16.7K | 0.0048 | yes |  |
| bare-r4b-b1 | 1 | claude-opus-5-5 | 2 | 18034 | 0 | 71 | 1 | 0 (0) | 18.1K | 0.1457 | yes |  |
| base-r4b-b1 | 2 | claude-opus-5-5 | 2 | 0 | 23081 | 82 | 1 | 0 (0) | 23.2K | 0.0063 | yes |  |
| after-r4b-b1 | 2 | claude-opus-5-5 | 2 | 0 | 16588 | 71 | 1 | 0 (0) | 16.7K | 0.0047 | yes |  |
| bare-r4b-b1 | 2 | claude-opus-5-5 | 2 | 0 | 18034 | 60 | 1 | 0 (0) | 18.1K | 0.0048 | yes |  |
| base-r4b-b1 | 3 | claude-opus-5-5 | 2 | 0 | 23081 | 66 | 1 | 0 (0) | 23.1K | 0.0059 | yes |  |
| after-r4b-b1 | 3 | claude-opus-5-5 | 2 | 0 | 16588 | 66 | 1 | 0 (0) | 16.7K | 0.0046 | yes |  |
| bare-r4b-b1 | 3 | claude-opus-5-5 | 2 | 0 | 18034 | 64 | 1 | 0 (0) | 18.1K | 0.0049 | yes |  |
| base-r4b-b3 | 1 | claude-opus-5-5 | 6 | 10899 | 65311 | 2171 | 3 | 4185 (2) | 82.6K | 0.1441 | yes | volt-predictor 2848, volt-title 1337 |
| bare-r4b-b3 | 1 | claude-opus-5-5 | 10 | 8858 | 89809 | 3948 | 5 | 1337 (1) | 104.0K | 0.1678 | yes | volt-title 1337 |
| base-r4b-b3 | 2 | claude-opus-5-5 | 6 | 10940 | 64999 | 2167 | 3 | 1337 (1) | 79.4K | 0.1439 | yes | volt-title 1337 |
| after-r4b-b3 | 2 | claude-opus-5-5 | 6 | 1601 | 55822 | 2560 | 3 | 1337 (1) | 61.3K | 0.0752 | yes | volt-title 1337 |
| bare-r4b-b3 | 2 | claude-opus-5-5 | 6 | 1607 | 57083 | 3059 | 3 | 0 (0) | 61.8K | 0.0855 | yes |  |
| base-r4b-b3 | 3 | claude-opus-5-5 | 6 | 1177 | 75107 | 2255 | 3 | 1337 (1) | 79.9K | 0.0696 | yes | volt-title 1337 |
| after-r4b-b3 | 3 | claude-opus-5-5 | 6 | 2305 | 54300 | 2190 | 3 | 1330 (1) | 60.1K | 0.0731 | yes | volt-title 1330 |
| bare-r4b-b3 | 3 | claude-opus-5-5 | 8 | 1306 | 77589 | 3201 | 4 | 0 (0) | 82.1K | 0.0900 | yes |  |
| after-r4b-b3 | 4 | claude-opus-5-5 | 6 | 553 | 55822 | 1842 | 3 | 1337 (1) | 59.6K | 0.0525 | yes | volt-title 1337 |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| base-r4b-b1 claude-opus-5-5 | 3 | 23.1K (23.1K-23.2K) | 23.1K | 0.0K | 0.0059 |
| after-r4b-b1 claude-opus-5-5 | 3 | 16.7K (16.7K-16.7K) | 16.7K | 0.0K | 0.0047 |
| bare-r4b-b1 claude-opus-5-5 | 3 | 18.1K (18.1K-18.1K) | 18.1K | 0.0K | 0.0049 |
| base-r4b-b3 claude-opus-5-5 | 3 | 79.9K (79.4K-82.6K) | 78.4K | 1.3K | 0.1439 |
| bare-r4b-b3 claude-opus-5-5 | 3 | 82.1K (61.8K-104.0K) | 82.1K | 0.0K | 0.0900 |
| after-r4b-b3 claude-opus-5-5 | 3 | 60.1K (59.6K-61.3K) | 58.8K | 1.3K | 0.0731 |
