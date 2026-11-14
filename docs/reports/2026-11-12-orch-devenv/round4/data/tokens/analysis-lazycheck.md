| Label | Rep | Model | Fresh | Cache write | Cache read | Output | Main calls | Side tokens (calls) | Total | $ | Canary | Side kinds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| lazy-base-agent | 1 | claude-opus-5-5 | 4 | 14613 | 37000 | 2146 | 2 | 89990 (6) | 143.8K | 0.3530 | yes | volt-predictor 2978, subagent/fork 85664, volt-title 1348 |
| lazy-after-agent | 1 | claude-opus-5-5 | 8 | 15587 | 41416 | 2228 | 3 | 71623 (5) | 130.9K | 0.3472 | yes | subagent/fork 70276, volt-title 1347 |
| lazy-base-agent-natural | 1 | claude-opus-5-5 | 4 | 9606 | 39206 | 676 | 2 | 44674 (3) | 94.2K | 0.1973 | yes | subagent/fork 44674 |
| lazy-after-agent-natural | 1 | claude-opus-5-5 | 8 | 10900 | 43273 | 1087 | 3 | 26680 (3) | 81.9K | 0.2062 | yes | subagent/fork 25364, volt-title 1316 |
| lazy-base-workflow | 1 | claude-opus-5-5 | 8 | 15807 | 69763 | 444 | 3 | 16647 (2) | 102.7K | 0.2273 | yes | subagent/fork 15305, volt-title 1342 |
| lazy-after-workflow | 1 | claude-opus-5-5 | 8 | 16910 | 50310 | 488 | 3 | 144250 (6) | 212.0K | 0.4565 | yes | subagent/fork 95331, other 47577, volt-title 1342 |
| lazy-base-wakeup | 1 | claude-opus-5-5 | 4 | 8535 | 39103 | 245 | 2 | 119965 (5) | 167.9K | 0.1336 | yes | subagent/fork 69291, other 47577, volt-predictor 3097 |
| lazy-after-wakeup | 1 | claude-opus-5-5 | 8 | 9364 | 43030 | 336 | 3 | 4229 (2) | 57.0K | 0.0905 | yes | volt-predictor 2890, volt-title 1339 |
| lazy-base-findings | 1 | claude-opus-5-5 | 8 | 10154 | 89404 | 1001 | 4 | 1331 (1) | 101.9K | 0.1194 | yes | volt-title 1331 |
| lazy-after-findings | 1 | claude-opus-5-5 | 10 | 10321 | 62718 | 1087 | 4 | 52621 (4) | 126.8K | 0.1303 | yes | volt-predictor 3000, subagent/fork 48294, volt-title 1327 |
| lazy-base-listagents | 1 | claude-opus-5-5 | 4 | 8826 | 39079 | 433 | 2 | 4501 (2) | 52.8K | 0.0874 | yes | volt-predictor 3192, volt-title 1309 |
| lazy-after-listagents | 1 | claude-opus-5-5 | 8 | 8529 | 42000 | 505 | 3 | 1309 (1) | 52.4K | 0.0868 | yes | volt-title 1309 |
| lazyh-base-agent | 1 | claude-haiku-5-5 | 4 | 13417 | 37774 | 1153 | 2 | 163387 (8) | 215.7K | 0.0114 | yes | subagent/fork 162036, volt-title 1351 |
| lazyh-after-agent | 1 | claude-haiku-5-5 | 6 | 22162 | 36906 | 2576 | 3 | 76320 (5) | 138.0K | 0.0115 | yes | subagent/fork 74969, volt-title 1351 |
| lazyh-base-agent-natural | 1 | claude-haiku-5-5 | 4 | 9953 | 40684 | 1437 | 2 | 65144 (5) | 117.2K | 0.0066 | yes | subagent/fork 63821, volt-title 1323 |
| lazyh-after-agent-natural | 1 | claude-haiku-5-5 | 8 | 10666 | 45523 | 1135 | 3 | 41343 (4) | 98.7K | 0.0059 | yes | subagent/fork 40027, volt-title 1316 |
| lazyh-base-workflow | 1 | claude-haiku-5-5 | 8 | 15935 | 72323 | 625 | 3 | 17195 (2) | 106.1K | 0.0063 | yes | subagent/fork 15853, volt-title 1342 |
| lazyh-after-workflow | 1 | claude-haiku-5-5 | 8 | 17181 | 52553 | 1028 | 3 | 164152 (7) | 234.9K | 0.0192 | yes | subagent/fork 115230, other 47580, volt-title 1342 |
| lazyh-base-wakeup | 1 | claude-haiku-5-5 | 4 | 8963 | 40581 | 744 | 2 | 120391 (4) | 170.7K | 0.0160 | yes | subagent/fork 72631, other 47760 |
| lazyh-after-wakeup | 1 | claude-haiku-5-5 | 8 | 9923 | 45725 | 1007 | 3 | 1340 (1) | 58.0K | 0.0030 | yes | volt-title 1340 |
| lazyh-base-findings | 1 | claude-haiku-5-5 | 8 | 11251 | 93439 | 2200 | 4 | 52175 (3) | 159.1K | 0.0049 | yes | subagent/fork 50845, volt-title 1330 |
| lazyh-after-findings | 1 | claude-haiku-5-5 | 8 | 10513 | 45873 | 1623 | 3 | 1331 (1) | 59.3K | 0.0034 | yes | volt-title 1331 |
| lazyh-base-listagents | 1 | claude-haiku-5-5 | 4 | 8649 | 40557 | 392 | 2 | 1309 (1) | 50.9K | 0.0023 | yes | volt-title 1309 |
| lazyh-after-listagents | 1 | claude-haiku-5-5 | 8 | 8240 | 43928 | 518 | 3 | 21207 (2) | 73.9K | 0.0026 | yes | subagent/fork 19899, volt-title 1308 |

| Arm | N | Median total (range) | Median main | Median side | Median $ |
|---|---|---|---|---|---|
| lazy-base-agent claude-opus-5-5 | 1 | 143.8K (143.8K-143.8K) | 53.8K | 90.0K | 0.3530 |
| lazy-after-agent claude-opus-5-5 | 1 | 130.9K (130.9K-130.9K) | 59.2K | 71.6K | 0.3472 |
| lazy-base-agent-natural claude-opus-5-5 | 1 | 94.2K (94.2K-94.2K) | 49.5K | 44.7K | 0.1973 |
| lazy-after-agent-natural claude-opus-5-5 | 1 | 81.9K (81.9K-81.9K) | 55.3K | 26.7K | 0.2062 |
| lazy-base-workflow claude-opus-5-5 | 1 | 102.7K (102.7K-102.7K) | 86.0K | 16.6K | 0.2273 |
| lazy-after-workflow claude-opus-5-5 | 1 | 212.0K (212.0K-212.0K) | 67.7K | 144.3K | 0.4565 |
| lazy-base-wakeup claude-opus-5-5 | 1 | 167.9K (167.9K-167.9K) | 47.9K | 120.0K | 0.1336 |
| lazy-after-wakeup claude-opus-5-5 | 1 | 57.0K (57.0K-57.0K) | 52.7K | 4.2K | 0.0905 |
| lazy-base-findings claude-opus-5-5 | 1 | 101.9K (101.9K-101.9K) | 100.6K | 1.3K | 0.1194 |
| lazy-after-findings claude-opus-5-5 | 1 | 126.8K (126.8K-126.8K) | 74.1K | 52.6K | 0.1303 |
| lazy-base-listagents claude-opus-5-5 | 1 | 52.8K (52.8K-52.8K) | 48.3K | 4.5K | 0.0874 |
| lazy-after-listagents claude-opus-5-5 | 1 | 52.4K (52.4K-52.4K) | 51.0K | 1.3K | 0.0868 |
| lazyh-base-agent claude-haiku-5-5 | 1 | 215.7K (215.7K-215.7K) | 52.3K | 163.4K | 0.0114 |
| lazyh-after-agent claude-haiku-5-5 | 1 | 138.0K (138.0K-138.0K) | 61.6K | 76.3K | 0.0115 |
| lazyh-base-agent-natural claude-haiku-5-5 | 1 | 117.2K (117.2K-117.2K) | 52.1K | 65.1K | 0.0066 |
| lazyh-after-agent-natural claude-haiku-5-5 | 1 | 98.7K (98.7K-98.7K) | 57.3K | 41.3K | 0.0059 |
| lazyh-base-workflow claude-haiku-5-5 | 1 | 106.1K (106.1K-106.1K) | 88.9K | 17.2K | 0.0063 |
| lazyh-after-workflow claude-haiku-5-5 | 1 | 234.9K (234.9K-234.9K) | 70.8K | 164.2K | 0.0192 |
| lazyh-base-wakeup claude-haiku-5-5 | 1 | 170.7K (170.7K-170.7K) | 50.3K | 120.4K | 0.0160 |
| lazyh-after-wakeup claude-haiku-5-5 | 1 | 58.0K (58.0K-58.0K) | 56.7K | 1.3K | 0.0030 |
| lazyh-base-findings claude-haiku-5-5 | 1 | 159.1K (159.1K-159.1K) | 106.9K | 52.2K | 0.0049 |
| lazyh-after-findings claude-haiku-5-5 | 1 | 59.3K (59.3K-59.3K) | 58.0K | 1.3K | 0.0034 |
| lazyh-base-listagents claude-haiku-5-5 | 1 | 50.9K (50.9K-50.9K) | 49.6K | 1.3K | 0.0023 |
| lazyh-after-listagents claude-haiku-5-5 | 1 | 73.9K (73.9K-73.9K) | 52.7K | 21.2K | 0.0026 |
