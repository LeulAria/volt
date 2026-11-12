| task | picked the IDE tool | Volt tool errors | wall s median | cost $ median | Volt tools used | shell steps median |
|---|---|---|---|---|---|---|
| tests | 2/3 | 2 | 44 | 0.0060 | tests.list, instant_grep, find_files, tests.run | 4 |
| debug | 3/3 | 1 | 60 | 0.0074 | find_symbol, tests.run, tests.list, find_files, debug.start, debug.evaluate, instant_grep, debug.breakpoints, debug.state, debug.stop | 3 |
| http | 2/3 | 2 | 21 | 0.0067 | ide:http.list, ide:http.envs, find_files, ide:http.send | 3 |
| docker | 0/3 | 0 | 8 | 0.0041 | instant_grep | 1 |
| db | 3/3 | 0 | 12 | 0.0053 | find_files, ide:db.tables, ide:db.schema, ide:db.query | 0 |
| profile | 3/3 | 3 | 20 | 0.0060 | ide:profile.cpu, ide:profile.help, ide:profile.analyze | 2 |
| notebook | 3/3 | 6 | 44 | 0.0068 | find_files, ide:notebook.cells, ide:notebook.run, ide:notebook.kernel, ide:notebook.outputs, ide:db.query | 0 |
| rename | 3/3 | 0 | 21 | 0.0051 | find_symbol, code_action.rename, diagnostics, code_nav.references | 1 |
| scratch | 0/3 | 0 | 15 | 0.0067 | scratch_read | 1 |
| canvas | 3/3 | 0 | 27 | 0.0078 | find_files, instant_grep, canvas_render, canvas_update, canvas_read | 1 |

Picked: 22/30
