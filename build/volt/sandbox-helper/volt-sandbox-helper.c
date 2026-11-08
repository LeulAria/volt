/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// volt-sandbox-helper: the macOS sandbox backend's native half (spec F.5, B-13).
//
//   volt-sandbox-helper spawn <program> [args...]
//       Becomes <program> (POSIX_SPAWN_SETEXEC: same pid, same fds) with TCC responsibility
//       disclaimed, so the sandbox root is its own responsible process and does not inherit
//       Volt's privacy grants. Exits 126 when the disclaim SPI is missing and 127 when the spawn
//       fails: it never runs the program without the disclaim.
//
//   volt-sandbox-helper serve
//       Answers sandbox checks about other processes, from outside them. One request per line on
//       stdin, tab separated: `<id>\t<pid>\t<operation or ->\t<path or ->`. One answer per line on
//       stdout: `<id>\t<result>`, where result is sandbox_check's return value (1: sandboxed, or
//       the operation is denied; 0: not sandboxed, or allowed) or `-<errno>`.
//       `<id>\tsweep\t<needle or ->\t-` answers `<id>\t` and one `pid:ppid:pgid:tagged`
//       per process, space separated, where tagged is 1 when the process's argv or environment
//       (readable for this user's processes) contains the needle. The run's process-tree sweep:
//       what `ps -E` gives, without a process spawn or megabytes of text per sweep.
//
//   volt-sandbox-helper probe
//       Prints `ok` and exits 0 when both private SPIs exist on this system.
//
// sandbox_check and responsibility_spawnattrs_setdisclaim are private SPI exported by
// libsystem_sandbox and libsystem_secinit (Chromium, Firefox, LLDB and WebKit use them). They
// are looked up at run time so a system without them refuses instead of failing to load.
// Built by build/volt/sandbox-helper/build.mjs.

#include <dlfcn.h>
#include <errno.h>
#include <libproc.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <unistd.h>

extern char **environ;

typedef int (*sandbox_check_fn)(pid_t pid, const char *operation, int type, ...);
typedef int (*setdisclaim_fn)(posix_spawnattr_t *attr, int disclaim);

enum { SANDBOX_FILTER_NONE = 0, SANDBOX_FILTER_PATH = 1 };

static sandbox_check_fn sandboxCheck(void) {
	return (sandbox_check_fn)dlsym(RTLD_DEFAULT, "sandbox_check");
}

static setdisclaim_fn setDisclaim(void) {
	return (setdisclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
}

/** `SANDBOX_CHECK_NO_REPORT`: a check must not log a violation (the run's denial monitor reads the log). */
static int noReport(void) {
	const int *flag = (const int *)dlsym(RTLD_DEFAULT, "SANDBOX_CHECK_NO_REPORT");
	return flag ? *flag : 0;
}

static int spawnDisclaimed(int argc, char **argv) {
	if (argc < 3 || argv[2][0] != '/') {
		fprintf(stderr, "volt-sandbox-helper: spawn needs an absolute program path\n");
		return 2;
	}
	setdisclaim_fn disclaim = setDisclaim();
	if (!disclaim) {
		fprintf(stderr, "volt-sandbox-helper: responsibility_spawnattrs_setdisclaim is missing on this system\n");
		return 126;
	}
	posix_spawnattr_t attributes;
	posix_spawnattr_init(&attributes);
	if (disclaim(&attributes, 1) != 0) {
		fprintf(stderr, "volt-sandbox-helper: could not disclaim responsibility\n");
		return 126;
	}
	posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC);
	pid_t pid;
	int error = posix_spawn(&pid, argv[2], NULL, &attributes, argv + 2, environ);
	// Only reached when the spawn failed: never exec without the disclaim.
	fprintf(stderr, "volt-sandbox-helper: %s: %s\n", argv[2], strerror(error));
	return 127;
}

/** Every process: parent, group and whether it carries the needle. */
static void sweep(const char *id, const char *needle) {
	int count = proc_listallpids(NULL, 0);
	int argmax = 0;
	size_t size = sizeof(argmax);
	if (count <= 0 || sysctlbyname("kern.argmax", &argmax, &size, NULL, 0) != 0 || argmax <= 0) {
		printf("%s\t-%d\n", id, errno ? errno : EINVAL);
		return;
	}
	int capacity = count + 256;
	pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
	char *args = malloc((size_t)argmax);
	if (!pids || !args) {
		free(pids);
		free(args);
		printf("%s\t-%d\n", id, ENOMEM);
		return;
	}
	count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
	size_t needleLength = strcmp(needle, "-") == 0 ? 0 : strlen(needle);
	printf("%s\t", id);
	for (int i = 0; i < count; i++) {
		struct proc_bsdinfo info;
		if (pids[i] <= 0 || proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != (int)sizeof(info)) {
			continue;
		}
		int tagged = 0;
		if (needleLength) {
			int mib[3] = { CTL_KERN, KERN_PROCARGS2, pids[i] };
			size_t length = (size_t)argmax;
			if (sysctl(mib, 3, args, &length, NULL, 0) == 0) {
				tagged = memmem(args, length, needle, needleLength) != NULL;
			}
		}
		printf("%d:%d:%d:%d ", pids[i], info.pbi_ppid, info.pbi_pgid, tagged);
	}
	printf("\n");
	free(pids);
	free(args);
}

static int serve(void) {
	sandbox_check_fn check = sandboxCheck();
	if (!check) {
		fprintf(stderr, "volt-sandbox-helper: sandbox_check is missing on this system\n");
		return 126;
	}
	int flags = noReport();
	setvbuf(stdout, NULL, _IOLBF, 0);
	char *line = NULL;
	size_t capacity = 0;
	ssize_t length;
	while ((length = getline(&line, &capacity, stdin)) > 0) {
		if (line[length - 1] == '\n') {
			line[length - 1] = '\0';
		}
		char *fields[4] = { 0 };
		char *rest = line;
		int count = 0;
		while (count < 4 && rest) {
			fields[count++] = strsep(&rest, "\t");
		}
		if (count != 4 || rest) {
			printf("%s\t-%d\n", count ? fields[0] : "?", EINVAL);
			continue;
		}
		if (strcmp(fields[1], "sweep") == 0) {
			sweep(fields[0], fields[2]);
			continue;
		}
		char *end = NULL;
		long pid = strtol(fields[1], &end, 10);
		if (!*fields[1] || *end || pid <= 0) {
			printf("%s\t-%d\n", fields[0], EINVAL);
			continue;
		}
		errno = 0;
		int result;
		if (strcmp(fields[2], "-") == 0) {
			result = check((pid_t)pid, NULL, SANDBOX_FILTER_NONE | flags);
		} else if (strcmp(fields[3], "-") == 0) {
			result = check((pid_t)pid, fields[2], SANDBOX_FILTER_NONE | flags);
		} else {
			result = check((pid_t)pid, fields[2], SANDBOX_FILTER_PATH | flags, fields[3]);
		}
		if (result < 0) {
			printf("%s\t-%d\n", fields[0], errno ? errno : EINVAL);
		} else {
			printf("%s\t%d\n", fields[0], result);
		}
	}
	free(line);
	return 0;
}

int main(int argc, char **argv) {
	if (argc >= 2 && strcmp(argv[1], "spawn") == 0) {
		return spawnDisclaimed(argc, argv);
	}
	if (argc == 2 && strcmp(argv[1], "serve") == 0) {
		return serve();
	}
	if (argc == 2 && strcmp(argv[1], "probe") == 0) {
		if (!sandboxCheck() || !setDisclaim()) {
			printf("missing:%s%s\n", sandboxCheck() ? "" : " sandbox_check", setDisclaim() ? "" : " responsibility_spawnattrs_setdisclaim");
			return 1;
		}
		printf("ok\n");
		return 0;
	}
	fprintf(stderr, "usage: volt-sandbox-helper spawn <program> [args...] | serve | probe\n");
	return 2;
}
