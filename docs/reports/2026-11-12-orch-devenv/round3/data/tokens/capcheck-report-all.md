## cap
| Family | Prompt | Base: used / tools | After: used / tools |
|---|---|---|---|
| code | Which functions end up calling parseDay, directly or through other functions? Do not change any files. | yes / volt:find_symbol, find_symbol, volt:code_nav, code_nav, Read File, volt:instant_grep, instant_grep | yes / ToolSearch, volt:code_nav, code_nav, volt:find_symbol, grep, find_symbol, Terminal, Read File |
| tests | Run the invoice tests and tell me which ones fail and why. Do not change any files. | yes / volt:tests, tests, Terminal | yes / ToolSearch, volt:tests, tests, Terminal |
| debug | Stop at the return line of paginate in the debugger while the tests run and tell me the values of page and pageSize there. Do not change any files. | yes / volt:debug, debug, volt:instant_grep, instant_grep | yes / ToolSearch, volt:debug, debug, grep, Terminal |
| db | In shop.db, which sku brings in the most revenue (qty times price), and how much? | yes / volt:find_files, find_files, volt:ide, ide | no / Terminal |
| chart | Chart how many lines each file under src has. | yes / Terminal, ToolSearch, volt:render_chart, render_chart | yes / Terminal, ToolSearch, volt:render_chart, render_chart |
| scratch | Sketch the request flow of src/server.ts and src/api.ts on the whiteboard. | yes / Read File, ToolSearch, volt:scratch_draw, scratch_draw | yes / Read File, volt:scratch_read, scratch_read, volt:scratch_draw, scratch_draw |
| browser | Open https://example.com in the browser and tell me the main heading on the page. | yes / ToolSearch, volt:browser_navigate, browser_navigate, volt:browser_screenshot, browser_screenshot | yes / ToolSearch, volt:browser_navigate, browser_navigate, volt:browser_evaluate, browser_evaluate |
| threads | List my other chats in Volt and their titles. | yes / ToolSearch, volt:thread_list, thread_list | yes / ToolSearch, volt:thread_list, thread_list |
| ask | I want a function that formats invoice totals as money. Before you write any code, ask me how it should look (currency, decimals, symbol position). | not run | not run |
| ask-mc | I want a function that formats invoice totals as money. Before you write any code, give me multiple-choice questions about how it should look (currency, decimals, symbol position). | not run | not run |

## cap2
| Family | Prompt | Base: used / tools | After: used / tools |
|---|---|---|---|
| code | Which functions end up calling parseDay, directly or through other functions? Do not change any files. | not run | not run |
| tests | Run the invoice tests and tell me which ones fail and why. Do not change any files. | not run | not run |
| debug | Stop at the return line of paginate in the debugger while the tests run and tell me the values of page and pageSize there. Do not change any files. | not run | not run |
| db | In shop.db, which sku brings in the most revenue (qty times price), and how much? | not run | not run |
| chart | Chart how many lines each file under src has. | not run | not run |
| scratch | Sketch the request flow of src/server.ts and src/api.ts on the whiteboard. | not run | not run |
| browser | Open https://example.com in the browser and tell me the main heading on the page. | not run | not run |
| threads | List my other chats in Volt and their titles. | not run | not run |
| ask | I want a function that formats invoice totals as money. Before you write any code, ask me how it should look (currency, decimals, symbol position). | no / volt:instant_grep, instant_grep | no / none |
| ask-mc | I want a function that formats invoice totals as money. Before you write any code, give me multiple-choice questions about how it should look (currency, decimals, symbol position). | yes / volt:instant_grep, instant_grep, Asking for your input (question tray shown 4x)<br>yes / Asking for your input (question tray shown 4x)<br>yes / Asking for your input (question tray shown 4x) | no / Terminal<br>no / none |

## cap3
| Family | Prompt | Base: used / tools | After: used / tools |
|---|---|---|---|
| code | Which functions end up calling parseDay, directly or through other functions? Do not change any files. | not run | not run |
| tests | Run the invoice tests and tell me which ones fail and why. Do not change any files. | not run | not run |
| debug | Stop at the return line of paginate in the debugger while the tests run and tell me the values of page and pageSize there. Do not change any files. | not run | not run |
| db | In shop.db, which sku brings in the most revenue (qty times price), and how much? | not run | yes / ToolSearch, Terminal, volt:ide, ide<br>yes / ToolSearch, Terminal, volt:ide, ide |
| chart | Chart how many lines each file under src has. | not run | not run |
| scratch | Sketch the request flow of src/server.ts and src/api.ts on the whiteboard. | not run | not run |
| browser | Open https://example.com in the browser and tell me the main heading on the page. | not run | not run |
| threads | List my other chats in Volt and their titles. | not run | not run |
| ask | I want a function that formats invoice totals as money. Before you write any code, ask me how it should look (currency, decimals, symbol position). | not run | yes / ToolSearch, Read File, volt:ask_question (question tray shown 3x) |
| ask-mc | I want a function that formats invoice totals as money. Before you write any code, give me multiple-choice questions about how it should look (currency, decimals, symbol position). | not run | yes / ToolSearch, volt:ask_question, Terminal, Preparing file… (question tray shown 6x)<br>yes / ToolSearch, volt:ask_question, Terminal, Preparing file…, Edit (question tray shown 6x)<br>yes / ToolSearch, Read File, volt:ask_question, Terminal, Preparing file… (question tray shown 6x) |

