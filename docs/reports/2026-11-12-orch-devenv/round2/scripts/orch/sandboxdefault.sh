#!/bin/bash
# Sets the test profile's default sandbox for new chats (window and agent server stopped): off | workspace-write
DB=/tmp/v2-orch-ud/agentServer/application.vscdb
sqlite3 $DB "update ItemTable set value = json_set(value, '$.defaults.level', '$1') where key = 'volt.runtime.sandbox'"
sqlite3 $DB "select substr(value,1,80) from ItemTable where key = 'volt.runtime.sandbox'"
