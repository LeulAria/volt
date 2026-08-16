#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

SHELL := /bin/bash
.DEFAULT_GOAL := help

NVM_DIR ?= $(HOME)/.nvm
NODE_VERSION ?= 22.19.0
WATCH_PID := .build/volt-watch.pid
WATCH_LOG := .build/volt-watch.log

.PHONY: help start run watch reload stop restart

help:
	@echo "make start    - start file watcher + launch Volt"
	@echo "make run      - same as start (hot reload on save)"
	@echo "make watch    - recompile src/ into out/ on save"
	@echo "make reload   - relaunch Volt, keep the watcher"
	@echo "make stop     - stop Volt and the watcher"
	@echo "make restart  - stop everything, then start"
	@echo
	@echo "Save a file: gulp recompiles, then Volt reloads the window."

start run: watch
	@set -e; \
	. "$(NVM_DIR)/nvm.sh"; \
	nvm use $(NODE_VERSION); \
	unset ELECTRON_RUN_AS_NODE CXXFLAGS npm_config_cxxflags; \
	export VSCODE_SKIP_PRELAUNCH=1; \
	echo "Launching Volt (save a file → compile → window reloads)..."; \
	./scripts/code.sh

watch:
	@set -e; \
	mkdir -p .build; \
	if [ -f "$(WATCH_PID)" ] && kill -0 "$$(cat "$(WATCH_PID)")" 2>/dev/null; then \
		echo "Watcher already running (pid $$(cat "$(WATCH_PID)"))"; \
	else \
		. "$(NVM_DIR)/nvm.sh"; \
		nvm use $(NODE_VERSION); \
		unset ELECTRON_RUN_AS_NODE CXXFLAGS npm_config_cxxflags; \
		nohup npm run watch-client > "$(WATCH_LOG)" 2>&1 & echo $$! > "$(WATCH_PID)"; \
		echo "Watcher started (pid $$(cat "$(WATCH_PID)")). Log: $(WATCH_LOG)"; \
		echo "Waiting for first compile..."; \
		for i in $$(seq 1 180); do \
			if grep -aE -q "Finished .*compilation" "$(WATCH_LOG)" 2>/dev/null && [ -f out/vs/code/electron-browser/workbench/workbench.js ]; then \
				break; \
			fi; \
			sleep 1; \
		done; \
		if [ ! -f out/vs/code/electron-browser/workbench/workbench.js ]; then \
			echo "Compile did not produce workbench.js. Last log:"; \
			tail -n 20 "$(WATCH_LOG)" || true; \
			exit 1; \
		fi; \
		tail -n 8 "$(WATCH_LOG)" || true; \
	fi

reload:
	@pkill -9 -f "Code - OSS" >/dev/null 2>&1 || true; \
	pkill -9 -f "scripts/code.sh" >/dev/null 2>&1 || true; \
	sleep 1; \
	$(MAKE) start

stop:
	@echo "Stopping Volt..."; \
	pkill -9 -f "Code - OSS" >/dev/null 2>&1 || true; \
	pkill -9 -f "scripts/code.sh" >/dev/null 2>&1 || true; \
	if [ -f "$(WATCH_PID)" ]; then \
		pid=$$(cat "$(WATCH_PID)"); \
		if kill -0 "$$pid" 2>/dev/null; then \
			echo "Stopping watcher (pid $$pid)..."; \
			kill "$$pid" >/dev/null 2>&1 || true; \
			pkill -P "$$pid" >/dev/null 2>&1 || true; \
		fi; \
		rm -f "$(WATCH_PID)"; \
	fi; \
	pkill -9 -f "gulp.js watch-client" >/dev/null 2>&1 || true; \
	echo "Stopped."

restart: stop
	@sleep 1
	@$(MAKE) start
