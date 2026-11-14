| Task | Arm | n | Score | Tokens | Fresh | $ | Tool calls | grep-like | Reads | New ops used | Wall (load) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| t1-impact | before | 1 | 1/1 | 115.1K (115.1K-115.1K) | 19.7K (19.7K-19.7K) | 0.0064 | 12 (12-12) | 10 | 2 | 0/1 | 26.8 s (26.8 s-26.8 s) (69.66 (69.66-69.66)) |
| t1-impact | after | 1 | 1/1 | 79.3K (79.3K-79.3K) | 14.5K (14.5K-14.5K) | 0.0046 | 4 (4-4) | 2 | 0 | 1/1 | 24.6 s (24.6 s-24.6 s) (61.23 (61.23-61.23)) |
| t2-importers | before | 1 | 1/1 | 57.0K (57.0K-57.0K) | 11.0K (11.0K-11.0K) | 0.0043 | 3 (3-3) | 2 | 0 | 0/1 | 19.6 s (19.6 s-19.6 s) (48.23 (48.23-48.23)) |
| t2-importers | after | 1 | 1/1 | 63.3K (63.3K-63.3K) | 14.3K (14.3K-14.3K) | 0.0055 | 3 (3-3) | 1 | 0 | 0/1 | 23.5 s (23.5 s-23.5 s) (45.93 (45.93-45.93)) |
| t3-callers | before | 1 | 1/1 | 78.0K (78.0K-78.0K) | 14.2K (14.2K-14.2K) | 0.0046 | 6 (6-6) | 3 | 0 | 0/1 | 18.6 s (18.6 s-18.6 s) (46.97 (46.97-46.97)) |
| t3-callers | after | 1 | 1/1 | 57.3K (57.3K-57.3K) | 10.7K (10.7K-10.7K) | 0.0034 | 3 (3-3) | 2 | 0 | 0/1 | 14.6 s (14.6 s-14.6 s) (49.17 (49.17-49.17)) |
| t4-body | before | 1 | 1/1 | 58.1K (58.1K-58.1K) | 28.3K (28.3K-28.3K) | 0.0066 | 1 (1-1) | 0 | 1 | 0/1 | 10.4 s (10.4 s-10.4 s) (52.67 (52.67-52.67)) |
| t4-body | after | 1 | 1/1 | 51.8K (51.8K-51.8K) | 10.0K (10.0K-10.0K) | 0.0028 | 2 (2-2) | 1 | 0 | 1/1 | 9.8 s (9.8 s-9.8 s) (54.62 (54.62-54.62)) |
| t5-structural | before | 1 | 1/1 | 247.7K (247.7K-247.7K) | 27.4K (27.4K-27.4K) | 0.0109 | 10 (10-10) | 5 | 0 | 0/1 | 47.6 s (47.6 s-47.6 s) (42.77 (42.77-42.77)) |
| t5-structural | after | 1 | 1/1 | 204.2K (204.2K-204.2K) | 30.9K (30.9K-30.9K) | 0.0124 | 14 (14-14) | 7 | 6 | 0/1 | 48.7 s (48.7 s-48.7 s) (36.95 (36.95-36.95)) |
| t6-implementations | before | 1 | 1/1 | 54.6K (54.6K-54.6K) | 10.3K (10.3K-10.3K) | 0.0029 | 4 (4-4) | 2 | 0 | 0/1 | 10.3 s (10.3 s-10.3 s) (35.33 (35.33-35.33)) |
| t6-implementations | after | 1 | 1/1 | 56.8K (56.8K-56.8K) | 2.0K (2.0K-2.0K) | 0.0013 | 3 (3-3) | 1 | 0 | 0/1 | 9.3 s (9.3 s-9.3 s) (39.44 (39.44-39.44)) |
| t7-rename | before | 1 | 1/1 | 93.1K (93.1K-93.1K) | 11.6K (11.6K-11.6K) | 0.0039 | 9 (9-9) | 2 | 3 | 0/1 | 14.4 s (14.4 s-14.4 s) (39.84 (39.84-39.84)) |
| t7-rename | after | 1 | 1/1 | 94.0K (94.0K-94.0K) | 10.6K (10.6K-10.6K) | 0.0038 | 9 (9-9) | 2 | 3 | 0/1 | 17.4 s (17.4 s-17.4 s) (40.84 (40.84-40.84)) |
| t8-signature | before | 1 | 1/1 | 158.5K (158.5K-158.5K) | 22.0K (22.0K-22.0K) | 0.0087 | 21 (21-21) | 3 | 9 | 0/1 | 29.5 s (29.5 s-29.5 s) (35.11 (35.11-35.11)) |
| t8-signature | after | 1 | 1/1 | 280.9K (280.9K-280.9K) | 27.6K (27.6K-27.6K) | 0.0119 | 23 (23-23) | 3 | 7 | 0/1 | 44.6 s (44.6 s-44.6 s) (43.44 (43.44-43.44)) |

| Arm | Runs | Right | Sum of per-task median tokens | Sum of median $ | Sum of median tool calls | Runs using a new op |
|---|---|---|---|---|---|---|
| before | 8 | 8/8 | 862.0K | 0.0483 | 66 | 0/8 |
| after | 8 | 8/8 | 887.5K | 0.0457 | 61 | 2/8 |

Ops per run (after):
- r5a-after-t1-impact r1: volt:find_symbol volt:instant_grep ToolSearch code_nav:impact
- r5a-after-t2-importers r1: ToolSearch volt:instant_grep code_nav:references
- r5a-after-t3-callers r1: code_nav:callers volt:instant_grep volt:instant_grep
- r5a-after-t4-body r1: volt:find_symbol code_nav:body
- r5a-after-t5-structural r1: ToolSearch volt:instant_grep volt:instant_grep volt:instant_grep volt:instant_grep volt:instant_grep Read Read Read Read Read Read volt:instant_grep volt:instant_grep
- r5a-after-t6-implementations r1: ToolSearch code_nav:implementations volt:find_symbol
- r5a-after-t7-rename r1: code_nav:references volt:instant_grep Read Read Read Edit Edit Edit volt:instant_grep
- r5a-after-t8-signature r1: volt:find_symbol ToolSearch Read code_nav:references volt:instant_grep Read Read Read Read Read Read Edit Edit Edit Edit Edit Edit Edit Edit Edit volt:instant_grep ToolSearch volt:diagnostics
