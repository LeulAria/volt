/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// volt-sandbox-helper: the macOS sandbox backend's native half (spec F.5, F.8, F.10, B-13).
//
//   volt-sandbox-helper spawn <program> [args...]
//       Becomes <program> (POSIX_SPAWN_SETEXEC: same pid, same fds) with TCC responsibility
//       disclaimed, so the sandbox root is its own responsible process and does not inherit
//       Volt's privacy grants. Exits 126 when the disclaim SPI is missing and 127 when the spawn
//       fails: it never runs the program without the disclaim.
//
//   volt-sandbox-helper serve
//       Answers requests about other processes, from outside them. One request per line on stdin,
//       tab separated: `<id>\t<a>\t<b>\t<c>`. One answer per line on stdout: `<id>\t<result>`,
//       where a negative number is `-<errno>`.
//       - `<id>\t<pid>\t<operation or ->\t<path or ->`: sandbox_check's return value (1: sandboxed,
//         or the operation is denied; 0: not sandboxed, or allowed).
//       - `<id>\tsweep\t<needle or ->\t<tracked root pid or ->`: `#<processes listed>`, then one
//         `pid:ppid:pgid:tagged:responsible` per process, space separated, where tagged is 1 when
//         the process's argv or environment (readable for this user's processes) contains the
//         needle. The run's process-tree sweep: what `ps -E` gives, without a process spawn or
//         megabytes of text per sweep. With the root of a tracked run, only processes created
//         after that root are listed (kernel unique ids, never reused): no older process can be
//         its descendant, join its new session's group or carry its tag.
//       - `<id>\ttrack\t<root pid>\t<process cap or ->`: starts tracking a run (F.10): kqueue
//         NOTE_FORK and NOTE_EXIT on the root and on every descendant it finds, so a process that
//         forks and exits at once still has its children recorded. With a cap, a fork that takes
//         the run past it kills the run at once (the fork watchdog, RES-MAC-2). Answers 0.
//       - `<id>\tstats\t<root pid>\t-`: `<members> <phys footprint bytes> <cap exceeded 0|1> <peak tracked>`.
//       - `<id>\tmembers\t<root pid>\t-`: the run's live pids, space separated.
//       - `<id>\tkill\t<root pid>\t-`: SIGKILLs every member until none is left; answers the count.
//       - `<id>\tuntrack\t<root pid>\t-`: forgets the run. Answers 0.
//       - `<id>\tuserprocs\t-\t-`: `<count> <hard RLIMIT_NPROC or -1>`: how many processes this
//         user has (RLIMIT_NPROC counts them all), and the most a child of Volt may set.
//       A run's members are the processes tracked from its root, plus every process whose
//       responsible process is the root (a disclaimed root is its own; its descendants keep it
//       through double forks, setsid and a cleared environment, measured on macOS 26.6). A process
//       that re-disclaims escapes both, and stays sandboxed. The responsible-process match is used
//       only while the root's pid still belongs to the root (or to nothing): a recycled pid is
//       somebody else's.
//
//   volt-sandbox-helper probe
//       Prints `ok` and exits 0 when the private SPIs exist on this system.
//
// sandbox_check, responsibility_spawnattrs_setdisclaim and
// responsibility_get_pid_responsible_for_pid are private SPI exported by libsystem_sandbox and
// libsystem_secinit (Chromium, Firefox, LLDB and WebKit use them). They are looked up at run time
// so a system without them refuses instead of failing to load.
// Built by build/volt/sandbox-helper/build.mjs.

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <unistd.h>

extern char **environ;

typedef int (*sandbox_check_fn)(pid_t pid, const char *operation, int type, ...);
typedef int (*setdisclaim_fn)(posix_spawnattr_t *attr, int disclaim);
typedef pid_t (*responsible_fn)(pid_t pid);

enum { SANDBOX_FILTER_NONE = 0, SANDBOX_FILTER_PATH = 1 };

/** `proc_pidinfo(PROC_PIDUNIQIDENTIFIERINFO)`: private in the SDK, stable in xnu's proc_info.h. */
#define VOLT_PROC_PIDUNIQIDENTIFIERINFO 17
struct volt_uniqidentifierinfo {
	uint8_t uuid[16];
	uint64_t uniqueid;
	uint64_t puniqueid;
	int32_t idversion;
	uint32_t reserve2;
	uint64_t reserve3;
	uint64_t reserve4;
};

static sandbox_check_fn sandboxCheck(void) {
	return (sandbox_check_fn)dlsym(RTLD_DEFAULT, "sandbox_check");
}

static setdisclaim_fn setDisclaim(void) {
	return (setdisclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
}

static responsible_fn responsibleFor(void) {
	return (responsible_fn)dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
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

/** The kernel's unique id of a live process (never reused, unlike pids), or 0. */
static uint64_t uniqueId(pid_t pid) {
	struct volt_uniqidentifierinfo info;
	return proc_pidinfo(pid, VOLT_PROC_PIDUNIQIDENTIFIERINFO, 0, &info, sizeof(info)) == (int)sizeof(info) ? info.uniqueid : 0;
}

/** Every process (created since `floor`, a unique id): parent, group, whether it carries the needle, and its responsible process. */
static void sweep(const char *id, const char *needle, uint64_t floor) {
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
	responsible_fn responsible = responsibleFor();
	printf("%s\t#%d ", id, count);
	for (int i = 0; i < count; i++) {
		struct proc_bsdinfo info;
		if (pids[i] <= 0 || (floor && uniqueId(pids[i]) < floor) || proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != (int)sizeof(info)) {
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
		printf("%d:%d:%d:%d:%d ", pids[i], info.pbi_ppid, info.pbi_pgid, tagged, responsible ? responsible(pids[i]) : -1);
	}
	printf("\n");
	free(pids);
	free(args);
}

// --- Run tracking (F.10) -------------------------------------------------------------------------

#define MAX_RUNS 256

typedef struct {
	pid_t root;
	uint64_t rootId;
	int cap;
	int exceeded;
	int peak;
	pid_t *pids;
	uint64_t *ids;
	int count;
	int capacity;
} Run;

static Run runs[MAX_RUNS];
static int kq = -1;

static Run *findRun(pid_t root) {
	for (int i = 0; i < MAX_RUNS; i++) {
		if (runs[i].root == root) {
			return &runs[i];
		}
	}
	return NULL;
}

static int hasPid(const Run *run, pid_t pid, uint64_t id) {
	for (int i = 0; i < run->count; i++) {
		if (run->pids[i] == pid && run->ids[i] == id) {
			return 1;
		}
	}
	return 0;
}

static void dropPid(Run *run, pid_t pid) {
	for (int i = 0; i < run->count; i++) {
		if (run->pids[i] == pid) {
			run->pids[i] = run->pids[run->count - 1];
			run->ids[i] = run->ids[run->count - 1];
			run->count--;
			return;
		}
	}
}

static void watch(pid_t pid, int add) {
	struct kevent change;
	EV_SET(&change, (uintptr_t)pid, EVFILT_PROC, add ? EV_ADD | EV_CLEAR : EV_DELETE, NOTE_FORK | NOTE_EXIT, 0, NULL);
	kevent(kq, &change, 1, NULL, 0, NULL);
}

static void killMembers(Run *run);

/** Records `pid` and its descendants (a child may fork before its parent's NOTE_FORK is read). */
static void adopt(Run *run, pid_t pid, int depth) {
	uint64_t id = uniqueId(pid);
	if (!id || (run->rootId && id < run->rootId) || hasPid(run, pid, id)) {
		return;
	}
	if (run->count == run->capacity) {
		int capacity = run->capacity ? run->capacity * 2 : 64;
		pid_t *pids = realloc(run->pids, (size_t)capacity * sizeof(pid_t));
		uint64_t *ids = pids ? realloc(run->ids, (size_t)capacity * sizeof(uint64_t)) : NULL;
		if (pids) {
			run->pids = pids;
		}
		if (!ids) {
			return;
		}
		run->ids = ids;
		run->capacity = capacity;
	}
	run->pids[run->count] = pid;
	run->ids[run->count] = id;
	run->count++;
	if (run->count > run->peak) {
		run->peak = run->count;
	}
	watch(pid, 1);
	if (run->cap > 0 && run->count > run->cap && !run->exceeded) {
		run->exceeded = 1;
		killMembers(run);
		return;
	}
	if (depth < 64) {
		pid_t children[512];
		// A count of pids (not bytes, unlike proc_listpids).
		int found = proc_listchildpids(pid, children, (int)sizeof(children));
		for (int i = 0; i < found && i < 512; i++) {
			adopt(run, children[i], depth + 1);
		}
	}
}

static void onProcessEvent(const struct kevent *event) {
	pid_t pid = (pid_t)event->ident;
	for (int i = 0; i < MAX_RUNS; i++) {
		Run *run = &runs[i];
		if (!run->root) {
			continue;
		}
		int member = 0;
		for (int j = 0; j < run->count; j++) {
			if (run->pids[j] == pid) {
				member = 1;
				break;
			}
		}
		if (!member) {
			continue;
		}
		if (event->fflags & NOTE_EXIT) {
			dropPid(run, pid);
		} else if (event->fflags & NOTE_FORK) {
			pid_t children[512];
			int found = proc_listchildpids(pid, children, (int)sizeof(children));
			for (int k = 0; k < found && k < 512; k++) {
				adopt(run, children[k], 1);
			}
		}
	}
}

/** Whether the run's root pid still names the root (or nothing): only then is its responsible-process match ours. */
static int rootPidIsOurs(const Run *run) {
	uint64_t id = uniqueId(run->root);
	return id == 0 || id == run->rootId;
}

/**
 * The run's live members: tracked pids that are still the processes we saw, and every other
 * process the root is responsible for, created after it.
 */
static int members(Run *run, pid_t *out, int capacity) {
	int count = 0;
	for (int i = 0; i < run->count && count < capacity; i++) {
		if (uniqueId(run->pids[i]) == run->ids[i]) {
			out[count++] = run->pids[i];
		}
	}
	responsible_fn responsible = responsibleFor();
	if (!responsible || !rootPidIsOurs(run)) {
		return count;
	}
	int total = proc_listallpids(NULL, 0);
	if (total <= 0) {
		return count;
	}
	pid_t *all = calloc((size_t)total + 256, sizeof(pid_t));
	if (!all) {
		return count;
	}
	total = proc_listallpids(all, (total + 256) * (int)sizeof(pid_t));
	for (int i = 0; i < total && count < capacity; i++) {
		pid_t pid = all[i];
		if (pid <= 1 || pid == getpid() || uniqueId(pid) < run->rootId || responsible(pid) != run->root) {
			continue;
		}
		int known = 0;
		for (int j = 0; j < count; j++) {
			if (out[j] == pid) {
				known = 1;
				break;
			}
		}
		if (!known) {
			out[count++] = pid;
		}
	}
	free(all);
	return count;
}

#define MEMBER_LIMIT 65536

static int listed(const pid_t *list, int count, pid_t pid) {
	for (int i = 0; i < count; i++) {
		if (list[i] == pid) {
			return 1;
		}
	}
	return 0;
}

static void killMembers(Run *run) {
	pid_t *list = malloc(MEMBER_LIMIT * sizeof(pid_t));
	pid_t *stopped = malloc(MEMBER_LIMIT * sizeof(pid_t));
	if (!list || !stopped) {
		free(list);
		free(stopped);
		return;
	}
	// Freeze first: a stopped process cannot fork, so a fork bomb cannot refill what the kill
	// takes. Rounds until one finds no member it had not stopped yet.
	int stoppedCount = 0;
	for (int round = 0; round < 64; round++) {
		int count = members(run, list, MEMBER_LIMIT);
		int fresh = 0;
		for (int i = 0; i < count; i++) {
			if (list[i] == getpid() || listed(stopped, stoppedCount, list[i])) {
				continue;
			}
			kill(list[i], SIGSTOP);
			if (stoppedCount < MEMBER_LIMIT) {
				stopped[stoppedCount++] = list[i];
			}
			fresh++;
		}
		if (!fresh) {
			break;
		}
	}
	free(stopped);
	// A member forked between a listing and its kill shows up in the next round.
	for (int round = 0; round < 64; round++) {
		int count = members(run, list, MEMBER_LIMIT);
		int alive = 0;
		for (int i = 0; i < count; i++) {
			if (list[i] != getpid() && kill(list[i], SIGKILL) == 0) {
				alive++;
			}
		}
		if (!alive) {
			break;
		}
		usleep(2000);
	}
	free(list);
}

static void handleTracking(const char *id, const char *verb, const char *pidText, const char *argument) {
	char *end = NULL;
	long root = strtol(pidText, &end, 10);
	if (!*pidText || *end || root <= 1) {
		printf("%s\t-%d\n", id, EINVAL);
		return;
	}
	Run *run = findRun((pid_t)root);
	if (strcmp(verb, "track") == 0) {
		if (run) {
			printf("%s\t-%d\n", id, EEXIST);
			return;
		}
		run = findRun(0);
		uint64_t rootId = uniqueId((pid_t)root);
		if (!run || !rootId) {
			printf("%s\t-%d\n", id, run ? ESRCH : ENOSPC);
			return;
		}
		memset(run, 0, sizeof(*run));
		run->root = (pid_t)root;
		run->rootId = rootId;
		run->cap = strcmp(argument, "-") == 0 ? 0 : atoi(argument);
		adopt(run, (pid_t)root, 0);
		printf("%s\t0\n", id);
		return;
	}
	if (!run) {
		printf("%s\t-%d\n", id, ENOENT);
		return;
	}
	if (strcmp(verb, "stats") == 0) {
		pid_t *list = malloc(MEMBER_LIMIT * sizeof(pid_t));
		int count = list ? members(run, list, MEMBER_LIMIT) : 0;
		uint64_t footprint = 0;
		for (int i = 0; i < count; i++) {
			struct rusage_info_v4 usage;
			if (proc_pid_rusage(list[i], RUSAGE_INFO_V4, (rusage_info_t *)&usage) == 0) {
				footprint += usage.ri_phys_footprint;
			}
		}
		free(list);
		printf("%s\t%d %llu %d %d\n", id, count, (unsigned long long)footprint, run->exceeded, run->peak);
	} else if (strcmp(verb, "members") == 0) {
		pid_t *list = malloc(MEMBER_LIMIT * sizeof(pid_t));
		int count = list ? members(run, list, MEMBER_LIMIT) : 0;
		printf("%s\t", id);
		for (int i = 0; i < count; i++) {
			printf("%d ", list[i]);
		}
		printf("\n");
		free(list);
	} else if (strcmp(verb, "kill") == 0) {
		pid_t *list = malloc(MEMBER_LIMIT * sizeof(pid_t));
		int count = list ? members(run, list, MEMBER_LIMIT) : 0;
		free(list);
		killMembers(run);
		printf("%s\t%d\n", id, count);
	} else if (strcmp(verb, "untrack") == 0) {
		for (int i = 0; i < run->count; i++) {
			watch(run->pids[i], 0);
		}
		free(run->pids);
		free(run->ids);
		memset(run, 0, sizeof(*run));
		printf("%s\t0\n", id);
	} else {
		printf("%s\t-%d\n", id, EINVAL);
	}
}

static void handleLine(char *line, sandbox_check_fn check, int flags) {
	char *fields[4] = { 0 };
	char *rest = line;
	int count = 0;
	while (count < 4 && rest) {
		fields[count++] = strsep(&rest, "\t");
	}
	if (count != 4 || rest) {
		printf("%s\t-%d\n", count ? fields[0] : "?", EINVAL);
		return;
	}
	if (strcmp(fields[1], "sweep") == 0) {
		uint64_t floor = 0;
		if (strcmp(fields[3], "-") != 0) {
			char *end = NULL;
			long root = strtol(fields[3], &end, 10);
			const Run *run = *fields[3] && !*end && root > 1 ? findRun((pid_t)root) : NULL;
			// Not a tracked run: every process, as without a root.
			floor = run ? run->rootId : 0;
		}
		sweep(fields[0], fields[2], floor);
		return;
	}
	if (strcmp(fields[1], "userprocs") == 0) {
		// Without a buffer the kernel answers with a size estimate for every process, not a count.
		int estimate = proc_listallpids(NULL, 0);
		pid_t *pids = estimate > 0 ? calloc((size_t)estimate + 256, sizeof(pid_t)) : NULL;
		int bytes = pids ? proc_listpids(PROC_UID_ONLY, (uint32_t)getuid(), pids, (estimate + 256) * (int)sizeof(pid_t)) : -1;
		int count = 0;
		for (int i = 0; bytes > 0 && i < bytes / (int)sizeof(pid_t); i++) {
			count += pids[i] > 0;
		}
		free(pids);
		// And the hard RLIMIT_NPROC Volt's children inherit (this helper is one): a run's limit can't pass it.
		struct rlimit nproc;
		long long hard = getrlimit(RLIMIT_NPROC, &nproc) == 0 && nproc.rlim_max != RLIM_INFINITY ? (long long)nproc.rlim_max : -1;
		if (bytes > 0) {
			printf("%s\t%d %lld\n", fields[0], count, hard);
		} else {
			printf("%s\t-%d\n", fields[0], EINVAL);
		}
		return;
	}
	if (strcmp(fields[1], "track") == 0 || strcmp(fields[1], "stats") == 0 || strcmp(fields[1], "members") == 0 || strcmp(fields[1], "kill") == 0 || strcmp(fields[1], "untrack") == 0) {
		handleTracking(fields[0], fields[1], fields[2], fields[3]);
		return;
	}
	char *end = NULL;
	long pid = strtol(fields[1], &end, 10);
	if (!*fields[1] || *end || pid <= 0) {
		printf("%s\t-%d\n", fields[0], EINVAL);
		return;
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

/** One loop for requests on stdin and the tracked processes' fork and exit events. */
static int serve(void) {
	sandbox_check_fn check = sandboxCheck();
	if (!check) {
		fprintf(stderr, "volt-sandbox-helper: sandbox_check is missing on this system\n");
		return 126;
	}
	int flags = noReport();
	setvbuf(stdout, NULL, _IOLBF, 0);
	kq = kqueue();
	if (kq < 0) {
		fprintf(stderr, "volt-sandbox-helper: kqueue: %s\n", strerror(errno));
		return 1;
	}
	struct kevent input;
	EV_SET(&input, STDIN_FILENO, EVFILT_READ, EV_ADD, 0, 0, NULL);
	if (kevent(kq, &input, 1, NULL, 0, NULL) < 0) {
		fprintf(stderr, "volt-sandbox-helper: kevent: %s\n", strerror(errno));
		return 1;
	}
	size_t capacity = 64 * 1024;
	size_t length = 0;
	char *buffer = malloc(capacity);
	if (!buffer) {
		return 1;
	}
	for (;;) {
		struct kevent events[64];
		int ready = kevent(kq, NULL, 0, events, 64, NULL);
		if (ready < 0) {
			if (errno == EINTR) {
				continue;
			}
			break;
		}
		for (int i = 0; i < ready; i++) {
			if (events[i].filter == EVFILT_PROC) {
				onProcessEvent(&events[i]);
				continue;
			}
			if (length == capacity) {
				// A line longer than the buffer is not a request.
				length = 0;
			}
			ssize_t got = read(STDIN_FILENO, buffer + length, capacity - length);
			if (got <= 0) {
				free(buffer);
				return 0;
			}
			length += (size_t)got;
			char *start = buffer;
			char *newline;
			while ((newline = memchr(start, '\n', length - (size_t)(start - buffer)))) {
				*newline = '\0';
				handleLine(start, check, flags);
				start = newline + 1;
			}
			length -= (size_t)(start - buffer);
			memmove(buffer, start, length);
		}
	}
	free(buffer);
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
