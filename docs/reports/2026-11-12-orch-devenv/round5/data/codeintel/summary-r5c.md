| Task | Arm | n | Score | Tokens | Fresh | $ | Tool calls | grep-like | Reads | New ops used | Wall (load) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| t1-impact | before | 3 | 2.5/3 | 88.1K (86.6K-101.2K) | 8.3K (5.7K-9.0K) | 0.0038 | 7 (6-12) | 6 | 1 | 0/3 | 23.2 s (20.4 s-29.0 s) (25.97 (17.89-47.36)) |
| t1-impact | after | 3 | 3/3 | 62.6K (58.6K-62.8K) | 12.0K (7.8K-13.0K) | 0.0042 | 4 (4-6) | 2 | 1 | 2/3 | 25.6 s (18.5 s-40.4 s) (27.82 (16.96-29.11)) |
| t2-importers | before | 3 | 3/3 | 56.6K (42.2K-75.5K) | 3.1K (2.4K-3.9K) | 0.0028 | 3 (2-4) | 2 | 0 | 0/3 | 22.7 s (21.9 s-24.7 s) (26.52 (17.29-35.98)) |
| t2-importers | after | 3 | 3/3 | 58.5K (58.4K-84.6K) | 4.3K (3.9K-14.8K) | 0.0029 | 3 (3-4) | 2 | 0 | 0/3 | 22.7 s (16.4 s-22.8 s) (26.2 (18.64-31.4)) |
| t3-callers | before | 3 | 3/3 | 79.1K (74.8K-80.2K) | 5.5K (3.8K-6.1K) | 0.0029 | 6 (6-7) | 3 | 2 | 0/3 | 16.4 s (15.4 s-18.4 s) (25.18 (16.49-26.95)) |
| t3-callers | after | 3 | 3/3 | 83.6K (73.6K-121.2K) | 11.9K (3.0K-16.7K) | 0.0047 | 5 (4-9) | 2 | 0 | 2/3 | 20.8 s (13.7 s-24.6 s) (22.36 (19.46-35.57)) |
| t4-body | before | 3 | 3/3 | 52.2K (51.7K-54.7K) | 1.4K (1.3K-20.3K) | 0.0013 | 2 (1-2) | 0 | 1 | 0/3 | 10.4 s (9.4 s-18.8 s) (20.3 (18.96-22.95)) |
| t4-body | after | 3 | 3/3 | 55.1K (53.8K-56.4K) | 2.1K (1.5K-28.1K) | 0.0015 | 2 (1-3) | 0 | 1 | 0/3 | 10.8 s (10.4 s-14.5 s) (18.22 (17.12-20.45)) |
| t5-structural | before | 3 | 3/3 | 255.3K (199.2K-266.8K) | 21.0K (14.2K-27.9K) | 0.0118 | 19 (9-29) | 4 | 14 | 0/3 | 59.0 s (41.4 s-80.9 s) (18.38 (17.85-25.57)) |
| t5-structural | after | 3 | 2/3 | 126.6K (64.7K-168.4K) | 16.2K (7.3K-19.9K) | 0.0078 | 7 (4-12) | 3 | 0 | 1/3 | 38.8 s (17.5 s-40.5 s) (18.37 (17.39-25.1)) |
| t6-implementations | before | 3 | 3/3 | 54.6K (52.6K-54.6K) | 2.2K (1.0K-2.7K) | 0.0013 | 4 (3-4) | 2 | 0 | 0/3 | 10.5 s (9.4 s-14.7 s) (17.95 (15.14-26.41)) |
| t6-implementations | after | 3 | 3/3 | 34.4K (34.4K-37.8K) | 0.0K (0.0K-8.3K) | 0.0006 | 2 (2-2) | 1 | 0 | 0/3 | 6.5 s (6.4 s-10.7 s) (19.16 (14.69-26.02)) |
| t7-rename | before | 3 | 3/3 | 90.7K (90.0K-90.7K) | 2.1K (1.9K-2.1K) | 0.0020 | 9 (9-9) | 2 | 3 | 0/3 | 14.5 s (14.4 s-18.9 s) (17.15 (16.97-26.45)) |
| t7-rename | after | 3 | 3/3 | 90.4K (75.5K-91.7K) | 3.1K (3.0K-10.4K) | 0.0024 | 9 (5-9) | 2 | 3 | 0/3 | 20.5 s (16.4 s-22.1 s) (16.21 (15.81-27.51)) |
| t8-signature | before | 3 | 3/3 | 150.9K (126.9K-205.8K) | 13.8K (13.5K-18.9K) | 0.0067 | 17 (17-19) | 3 | 5 | 0/3 | 32.5 s (28.6 s-35.6 s) (17.6 (16.39-23.71)) |
| t8-signature | after | 3 | 3/3 | 179.5K (132.4K-199.0K) | 13.8K (13.5K-23.8K) | 0.0074 | 20 (16-20) | 2 | 5 | 0/3 | 38.6 s (26.4 s-56.8 s) (18.45 (15.56-25.01)) |

| Arm | Runs | Right | Sum of per-task median tokens | Sum of median $ | Sum of median tool calls | Runs using a new op |
|---|---|---|---|---|---|---|
| before | 24 | 23.5/24 | 827.4K | 0.0326 | 67 | 0/24 |
| after | 24 | 23/24 | 690.7K | 0.0315 | 52 | 5/24 |

Ops per run (after):
- r5c-after-t1-impact r1: volt:find_symbol volt:instant_grep code_nav:impact Read
- r5c-after-t1-impact r2: volt:find_symbol code_nav:references volt:instant_grep code_nav:callers volt:find_files Read
- r5c-after-t1-impact r3: ToolSearch volt:find_symbol code_nav:impact volt:instant_grep
- r5c-after-t2-importers r1: ToolSearch code_nav:references volt:instant_grep volt:instant_grep
- r5c-after-t2-importers r2: ToolSearch volt:instant_grep volt:find_files
- r5c-after-t2-importers r3: ToolSearch volt:instant_grep volt:find_files
- r5c-after-t3-callers r1: ToolSearch code_nav:callers volt:find_symbol code_nav:references code_nav:body
- r5c-after-t3-callers r2: ToolSearch volt:find_symbol code_nav:callers code_nav:references code_nav:callers code_nav:symbols code_nav:callers volt:instant_grep code_nav:body
- r5c-after-t3-callers r3: code_nav:callers volt:instant_grep code_nav:callers volt:instant_grep
- r5c-after-t4-body r1: Read
- r5c-after-t4-body r2: volt:find_symbol volt:instant_grep Read
- r5c-after-t4-body r3: Bash:cd Read
- r5c-after-t5-structural r1: ToolSearch volt:instant_grep volt:instant_grep ToolSearch code_nav:structural code_nav:structural code_nav:structural
- r5c-after-t5-structural r2: ToolSearch volt:instant_grep volt:instant_grep volt:instant_grep
- r5c-after-t5-structural r3: volt:instant_grep volt:instant_grep volt:instant_grep volt:instant_grep volt:instant_grep Read Read Read Read Read Read Read
- r5c-after-t6-implementations r1: volt:find_symbol code_nav:implementations
- r5c-after-t6-implementations r2: volt:find_symbol code_nav:implementations
- r5c-after-t6-implementations r3: volt:find_symbol code_nav:implementations
- r5c-after-t7-rename r1: volt:instant_grep volt:find_symbol Read Read Read Edit Edit Edit volt:instant_grep
- r5c-after-t7-rename r2: code_nav:references volt:instant_grep Read Read Read Edit Edit Edit volt:instant_grep
- r5c-after-t7-rename r3: code_nav:callers volt:instant_grep Bash:cd volt:code_action Bash:cd
- r5c-after-t8-signature r1: Bash:cd code_nav:undefined volt:instant_grep code_nav:references Bash:cd Read Read Read Read Read Edit Edit Edit Edit Edit Edit Edit Edit Edit volt:instant_grep
- r5c-after-t8-signature r2: Read volt:instant_grep Edit Read Read Read Read Edit Edit Edit Edit Edit Edit Edit Edit volt:instant_grep
- r5c-after-t8-signature r3: Bash:cd code_nav:undefined code_nav:references volt:instant_grep Bash:cd Read Read Read Read Read Edit Edit Edit Edit Edit Edit Edit Edit Edit volt:instant_grep
