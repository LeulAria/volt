/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// disclaim <program> [args...]: execs program as its own responsible process on macOS.
// A dev Volt started from a terminal or T3 Code otherwise borrows that app's privacy permissions:
// its microphone records silence and the speech helper is killed. scripts/code.sh builds this
// into .build/volt-disclaim. Same pid as an exec, so signals and output behave as before.

#include <dlfcn.h>
#include <spawn.h>
#include <stdio.h>
#include <unistd.h>

extern char **environ;

int main(int argc, char **argv) {
	if (argc < 2) {
		fprintf(stderr, "usage: %s program [args...]\n", argv[0]);
		return 2;
	}
	posix_spawnattr_t attributes;
	posix_spawnattr_init(&attributes);
	int (*setDisclaim)(posix_spawnattr_t *, int) = dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
	if (setDisclaim) {
		setDisclaim(&attributes, 1);
	}
	posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC);
	pid_t pid;
	posix_spawn(&pid, argv[1], NULL, &attributes, argv + 1, environ);
	// Only reached when the spawn failed: run it the ordinary way.
	execv(argv[1], argv + 1);
	perror(argv[1]);
	return 127;
}
