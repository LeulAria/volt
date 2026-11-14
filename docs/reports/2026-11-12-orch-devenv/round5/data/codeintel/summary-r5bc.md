| Task | Arm | n | Score | Tokens | Fresh | $ | Tool calls | grep-like | Reads | New ops used | Wall (load) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| t1-impact | before | 6 | 5.5/6 | 94.6K (86.0K-129.6K) | 8.6K (5.7K-14.7K) | 0.0040 | 7.5 (6-12) | 5.5 | 1 | 0/6 | 25.6 s (20.4 s-33.0 s) (25.955 (17.89-47.36)) |
| t1-impact | after | 6 | 6/6 | 61.5K (41.3K-82.7K) | 12.5K (4.9K-13.8K) | 0.0043 | 4 (2-6) | 2 | 0.5 | 5/6 | 24.1 s (18.5 s-40.4 s) (21.18 (16.96-29.11)) |
| t2-importers | before | 6 | 6/6 | 66.6K (42.2K-105.9K) | 3.8K (2.4K-7.5K) | 0.0031 | 3.5 (2-5) | 2.5 | 0 | 0/6 | 23.3 s (17.4 s-24.7 s) (23.045 (17.29-35.98)) |
| t2-importers | after | 6 | 6/6 | 84.6K (58.4K-101.0K) | 6.8K (3.9K-14.8K) | 0.0043 | 4 (3-6) | 2.5 | 0 | 0/6 | 22.7 s (16.4 s-29.1 s) (21.979999999999997 (18.64-31.4)) |
| t3-callers | before | 6 | 6/6 | 79.6K (62.9K-81.1K) | 6.1K (3.8K-8.5K) | 0.0029 | 6 (6-7) | 2.5 | 0 | 0/6 | 19.3 s (15.4 s-27.6 s) (22.91 (16.49-26.95)) |
| t3-callers | after | 6 | 6/6 | 83.4K (57.9K-121.2K) | 9.6K (3.0K-17.8K) | 0.0039 | 5.5 (4-9) | 2 | 0 | 4/6 | 18.0 s (12.4 s-24.6 s) (20.985 (18.52-35.57)) |
| t4-body | before | 6 | 6/6 | 53.4K (51.7K-56.1K) | 10.9K (1.2K-20.7K) | 0.0031 | 2 (1-2) | 0 | 1 | 0/6 | 10.0 s (7.3 s-18.8 s) (19.87 (17.29-22.95)) |
| t4-body | after | 6 | 6/6 | 55.7K (53.8K-57.4K) | 6.2K (1.5K-28.1K) | 0.0023 | 2.5 (1-3) | 0.5 | 1 | 2/6 | 10.6 s (9.4 s-14.5 s) (17.965 (16.68-21)) |
| t5-structural | before | 6 | 6/6 | 224.5K (177.4K-266.8K) | 17.8K (14.2K-27.9K) | 0.0095 | 8.5 (6-29) | 3.5 | 0 | 0/6 | 51.5 s (41.4 s-80.9 s) (18.63 (17.09-25.57)) |
| t5-structural | after | 6 | 4/6 | 119.1K (64.7K-320.7K) | 15.5K (7.3K-29.2K) | 0.0069 | 8 (3-23) | 3 | 0 | 2/6 | 34.6 s (17.5 s-70.3 s) (17.880000000000003 (14.87-25.1)) |
| t6-implementations | before | 6 | 6/6 | 54.3K (38.0K-54.7K) | 2.2K (1.0K-2.8K) | 0.0013 | 3.5 (2-4) | 1.5 | 0 | 0/6 | 9.5 s (6.4 s-14.7 s) (19.615000000000002 (15.14-26.41)) |
| t6-implementations | after | 6 | 6/6 | 36.3K (34.4K-78.3K) | 2.1K (0.0K-12.2K) | 0.0013 | 2 (2-4) | 1 | 0 | 0/6 | 7.9 s (6.4 s-15.6 s) (20.15 (13.06-27.18)) |
| t7-rename | before | 6 | 6/6 | 90.3K (71.6K-90.7K) | 2.0K (1.8K-2.1K) | 0.0020 | 9 (9-9) | 2 | 3 | 0/6 | 14.4 s (12.4 s-18.9 s) (19.82 (16.02-26.45)) |
| t7-rename | after | 6 | 6/6 | 92.1K (75.5K-101.5K) | 3.1K (2.7K-13.4K) | 0.0024 | 7.5 (5-9) | 2 | 1.5 | 0/6 | 19.0 s (16.4 s-22.1 s) (17.615000000000002 (15.81-27.51)) |
| t8-signature | before | 6 | 6/6 | 139.2K (124.8K-205.8K) | 13.6K (12.3K-18.9K) | 0.0066 | 17.5 (17-19) | 3 | 5 | 0/6 | 27.5 s (25.5 s-35.6 s) (20.135 (15.15-31.81)) |
| t8-signature | after | 6 | 6/6 | 180.1K (132.4K-210.8K) | 16.0K (13.5K-23.8K) | 0.0086 | 20.5 (16-24) | 2 | 5 | 0/6 | 42.8 s (26.4 s-178.8 s) (18.5 (15.56-25.01)) |

| Arm | Runs | Right | Sum of per-task median tokens | Sum of median $ | Sum of median tool calls | Runs using a new op |
|---|---|---|---|---|---|---|
| before | 48 | 47.5/48 | 802.5K | 0.0324 | 57.5 | 0/48 |
| after | 48 | 46/48 | 712.8K | 0.0340 | 54 | 13/48 |

Ops per run (after):
- r5b-after-t1-impact r1: volt:find_symbol volt:instant_grep code_nav:impact code_nav:references Read volt:instant_grep
- r5b-after-t1-impact r2: ToolSearch code_nav:impact volt:find_symbol
- r5b-after-t1-impact r3: code_nav:impact code_nav:references
- r5c-after-t1-impact r1: volt:find_symbol volt:instant_grep code_nav:impact Read
- r5c-after-t1-impact r2: volt:find_symbol code_nav:references volt:instant_grep code_nav:callers volt:find_files Read
- r5c-after-t1-impact r3: ToolSearch volt:find_symbol code_nav:impact volt:instant_grep
- r5b-after-t2-importers r1: volt:find_symbol ToolSearch volt:instant_grep volt:instant_grep volt:instant_grep volt:find_files
- r5b-after-t2-importers r2: ToolSearch volt:instant_grep volt:find_files volt:instant_grep
- r5b-after-t2-importers r3: ToolSearch volt:instant_grep volt:instant_grep volt:find_files
- r5c-after-t2-importers r1: ToolSearch code_nav:references volt:instant_grep volt:instant_grep
- r5c-after-t2-importers r2: ToolSearch volt:instant_grep volt:find_files
- r5c-after-t2-importers r3: ToolSearch volt:instant_grep volt:find_files
- r5b-after-t3-callers r1: ToolSearch volt:find_symbol code_nav:callers code_nav:callers code_nav:body code_nav:callers
- r5b-after-t3-callers r2: ToolSearch volt:find_symbol code_nav:callers code_nav:references volt:find_symbol
- r5b-after-t3-callers r3: ToolSearch volt:find_symbol code_nav:callers code_nav:references volt:instant_grep volt:find_symbol code_nav:body
- r5c-after-t3-callers r1: ToolSearch code_nav:callers volt:find_symbol code_nav:references code_nav:body
- r5c-after-t3-callers r2: ToolSearch volt:find_symbol code_nav:callers code_nav:references code_nav:callers code_nav:symbols code_nav:callers volt:instant_grep code_nav:body
- r5c-after-t3-callers r3: code_nav:callers volt:instant_grep code_nav:callers volt:instant_grep
- r5b-after-t4-body r1: ToolSearch volt:find_symbol code_nav:body
- r5b-after-t4-body r2: Bash:cd Read
- r5b-after-t4-body r3: volt:find_symbol Read code_nav:body
- r5c-after-t4-body r1: Read
- r5c-after-t4-body r2: volt:find_symbol volt:instant_grep Read
- r5c-after-t4-body r3: Bash:cd Read
- r5b-after-t5-structural r1: ToolSearch volt:instant_grep volt:instant_grep volt:instant_grep Read Read Read Read Read
- r5b-after-t5-structural r2: Bash:cd Bash:cd Bash:cd
- r5b-after-t5-structural r3: ToolSearch volt:instant_grep volt:instant_grep volt:instant_grep code_nav:structural code_nav:structural code_nav:structural code_nav:structural code_nav:structural code_nav:structural code_nav:structural volt:instant_grep code_nav:structural code_nav:structural code_nav:structural code_nav:structural code_nav:structural code_nav:structural code_nav:structural code_nav:structural code_nav:structural volt:instant_grep volt:instant_grep
- r5c-after-t5-structural r1: ToolSearch volt:instant_grep volt:instant_grep ToolSearch code_nav:structural code_nav:structural code_nav:structural
- r5c-after-t5-structural r2: ToolSearch volt:instant_grep volt:instant_grep volt:instant_grep
- r5c-after-t5-structural r3: volt:instant_grep volt:instant_grep volt:instant_grep volt:instant_grep volt:instant_grep Read Read Read Read Read Read Read
- r5b-after-t6-implementations r1: volt:find_symbol volt:instant_grep ToolSearch code_nav:implementations
- r5b-after-t6-implementations r2: ToolSearch volt:find_symbol code_nav:implementations volt:instant_grep
- r5b-after-t6-implementations r3: code_nav:implementations volt:find_symbol
- r5c-after-t6-implementations r1: volt:find_symbol code_nav:implementations
- r5c-after-t6-implementations r2: volt:find_symbol code_nav:implementations
- r5c-after-t6-implementations r3: volt:find_symbol code_nav:implementations
- r5b-after-t7-rename r1: ToolSearch volt:instant_grep volt:code_action volt:instant_grep Bash:cd Bash:cd
- r5b-after-t7-rename r2: code_nav:references volt:instant_grep Read Read Read Edit Edit Edit volt:instant_grep
- r5b-after-t7-rename r3: code_nav:references volt:instant_grep volt:code_action Bash:cd volt:instant_grep
- r5c-after-t7-rename r1: volt:instant_grep volt:find_symbol Read Read Read Edit Edit Edit volt:instant_grep
- r5c-after-t7-rename r2: code_nav:references volt:instant_grep Read Read Read Edit Edit Edit volt:instant_grep
- r5c-after-t7-rename r3: code_nav:callers volt:instant_grep Bash:cd volt:code_action Bash:cd
- r5b-after-t8-signature r1: Read code_nav:references volt:instant_grep Read Read Read Read Read Read Edit Edit Edit Edit Edit Edit Edit Edit Edit Edit Edit volt:instant_grep
- r5b-after-t8-signature r2: Bash:cd code_nav:callers code_nav:references volt:instant_grep Read Read Read Read Read Read Read Read Read Edit Edit Edit Edit Edit Edit Edit Edit Edit volt:diagnostics Bash:cd
- r5b-after-t8-signature r3: Bash:cd code_nav:undefined Bash:cd Bash:cd Bash:cd Read Read Read Read Read Edit Edit Edit Edit Edit Edit Edit Edit Edit Edit Edit Bash:cd
- r5c-after-t8-signature r1: Bash:cd code_nav:undefined volt:instant_grep code_nav:references Bash:cd Read Read Read Read Read Edit Edit Edit Edit Edit Edit Edit Edit Edit volt:instant_grep
- r5c-after-t8-signature r2: Read volt:instant_grep Edit Read Read Read Read Edit Edit Edit Edit Edit Edit Edit Edit volt:instant_grep
- r5c-after-t8-signature r3: Bash:cd code_nav:undefined code_nav:references volt:instant_grep Bash:cd Read Read Read Read Read Edit Edit Edit Edit Edit Edit Edit Edit Edit volt:instant_grep
