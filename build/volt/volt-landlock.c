/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// volt-landlock: the Linux sandbox's second filesystem layer (spec J.2, C4).
//
//   volt-landlock probe
//       Prints `abi <n>` (0 when the kernel has no Landlock, or it is disabled) and exits 0.
//
//   volt-landlock <abi> [-r PATH | -l PATH | -w PATH | -f PATH | -d PATH | -s]... -- <program> [args...]
//       bubblewrap's payload: inside the finished sandbox (mounts, namespaces, seccomp), before
//       anything else runs, restricts itself to a Landlock domain mirroring the run's mounts,
//       then execs <program> (the launch prologue). Rules:
//         -r  read, list and execute below PATH (the read roots)
//         -l  list PATH's folders only (`/` of a narrow sandbox)
//         -w  everything below PATH (the write roots and the private tmpfs masks)
//         -f  read and write the single file PATH (writeFiles)
//         -d  devices and procfs below PATH: read, write, truncate, ioctl
//         -s  (ABI 6+) scope abstract unix sockets and signals to the sandbox
//       A missing PATH is left out (bubblewrap's `-try` binds leave it out too): stricter, never
//       wider. <abi> is what Volt's probe measured: a kernel that reports less refuses the run.
//       Any failure exits 125 without running <program>, so a prologue that runs had the domain.
//
// Landlock only grants: a right on a folder holds for everything below it, so it cannot carve a
// read-only hole in a writable root (spec LNX-FS-3 stays best effort). What it adds is a second,
// independent check on every open: a mount the sandbox should not have (a bubblewrap setup bug,
// CVE-2026-87766's class) still cannot be read or written outside these sets.
// Built statically by build/volt/helpers/buildHelpers.mjs: cc -O2 -static.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

// Defined here, not from <linux/landlock.h>: build hosts may have headers older than the ABI used.
#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#endif
#ifndef SYS_landlock_add_rule
#define SYS_landlock_add_rule 445
#endif
#ifndef SYS_landlock_restrict_self
#define SYS_landlock_restrict_self 446
#endif

#define VOLT_LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define VOLT_LANDLOCK_RULE_PATH_BENEATH 1

#define FS_EXECUTE (1ULL << 0)
#define FS_WRITE_FILE (1ULL << 1)
#define FS_READ_FILE (1ULL << 2)
#define FS_READ_DIR (1ULL << 3)
#define FS_REMOVE_DIR (1ULL << 4)
#define FS_REMOVE_FILE (1ULL << 5)
#define FS_MAKE_CHAR (1ULL << 6)
#define FS_MAKE_DIR (1ULL << 7)
#define FS_MAKE_REG (1ULL << 8)
#define FS_MAKE_SOCK (1ULL << 9)
#define FS_MAKE_FIFO (1ULL << 10)
#define FS_MAKE_BLOCK (1ULL << 11)
#define FS_MAKE_SYM (1ULL << 12)
#define FS_REFER (1ULL << 13)    // ABI 2
#define FS_TRUNCATE (1ULL << 14) // ABI 3
#define FS_IOCTL_DEV (1ULL << 15) // ABI 5
#define SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0) // ABI 6
#define SCOPE_SIGNAL (1ULL << 1)               // ABI 6

#define FS_ABI1 ((1ULL << 13) - 1)
#define FS_READ (FS_READ_FILE | FS_READ_DIR | FS_EXECUTE)
#define FS_FILE_ONLY (FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV)

struct volt_ruleset_attr {
	uint64_t handled_access_fs;
	uint64_t handled_access_net;
	uint64_t scoped;
};

struct volt_path_beneath_attr {
	uint64_t allowed_access;
	int32_t parent_fd;
} __attribute__((packed));

static int abiVersion(void) {
	long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, VOLT_LANDLOCK_CREATE_RULESET_VERSION);
	return abi < 0 ? 0 : (int)abi;
}

static uint64_t handledFor(int abi) {
	uint64_t handled = FS_ABI1;
	if (abi >= 2) {
		handled |= FS_REFER;
	}
	if (abi >= 3) {
		handled |= FS_TRUNCATE;
	}
	if (abi >= 5) {
		handled |= FS_IOCTL_DEV;
	}
	return handled;
}

static int fail(const char *what, const char *detail) {
	fprintf(stderr, "volt-landlock: %s%s%s\n", what, detail ? ": " : "", detail ? detail : "");
	return 125;
}

/** Adds one rule; a missing path is skipped. Returns 0, or -1 with errno. */
static int addRule(int ruleset, const char *path, uint64_t access, uint64_t handled) {
	int fd = open(path, O_PATH | O_CLOEXEC);
	if (fd < 0) {
		return errno == ENOENT ? 0 : -1;
	}
	struct stat st;
	if (fstat(fd, &st) < 0) {
		int saved = errno;
		close(fd);
		errno = saved;
		return -1;
	}
	struct volt_path_beneath_attr rule = { .allowed_access = access & handled, .parent_fd = fd };
	if (!S_ISDIR(st.st_mode)) {
		rule.allowed_access &= FS_FILE_ONLY;
	}
	int result = rule.allowed_access ? (int)syscall(SYS_landlock_add_rule, ruleset, VOLT_LANDLOCK_RULE_PATH_BENEATH, &rule, 0) : 0;
	int saved = errno;
	close(fd);
	errno = saved;
	return result;
}

int main(int argc, char **argv) {
	if (argc == 2 && strcmp(argv[1], "probe") == 0) {
		printf("abi %d\n", abiVersion());
		return 0;
	}
	if (argc < 4) {
		return fail("usage: volt-landlock <abi> [rules] -- <program> [args...]", NULL);
	}
	char *end = NULL;
	long wanted = strtol(argv[1], &end, 10);
	if (!*argv[1] || *end || wanted < 1) {
		return fail("bad ABI argument", argv[1]);
	}
	int abi = abiVersion();
	if (abi < wanted) {
		char detail[64];
		snprintf(detail, sizeof(detail), "the kernel has ABI %d, Volt measured %ld", abi, wanted);
		return fail("Landlock is not available as probed", detail);
	}
	// Use what was probed, not more: the rules below were chosen for that ABI.
	uint64_t handled = handledFor((int)wanted);
	int scope = 0;
	int i = 2;
	for (; i < argc && strcmp(argv[i], "--") != 0; i++) {
		if (strcmp(argv[i], "-s") == 0) {
			scope = 1;
		} else if (argv[i][0] != '-' || !argv[i][1] || argv[i][2] || i + 1 >= argc) {
			return fail("bad rule", argv[i]);
		} else {
			i++; // The path, checked when the ruleset exists.
		}
	}
	if (i >= argc - 1) {
		return fail("no program after --", NULL);
	}
	struct volt_ruleset_attr attr = { .handled_access_fs = handled, .handled_access_net = 0, .scoped = 0 };
	if (scope && wanted >= 6) {
		attr.scoped = SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL;
	}
	size_t size = wanted >= 6 ? sizeof(attr) : wanted >= 4 ? 2 * sizeof(uint64_t) : sizeof(uint64_t);
	int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, size, 0);
	if (ruleset < 0) {
		return fail("landlock_create_ruleset", strerror(errno));
	}
	for (int r = 2; r < i; r++) {
		uint64_t access;
		switch (argv[r][1]) {
			case 's': continue;
			case 'r': access = FS_READ; break;
			case 'l': access = FS_READ_DIR; break;
			case 'w': access = handled; break;
			case 'f': access = FS_READ_FILE | FS_WRITE_FILE | FS_TRUNCATE; break;
			case 'd': access = FS_READ_FILE | FS_WRITE_FILE | FS_READ_DIR | FS_TRUNCATE | FS_IOCTL_DEV; break;
			default: return fail("bad rule", argv[r]);
		}
		r++;
		if (argv[r][0] != '/') {
			return fail("a rule's path must be absolute", argv[r]);
		}
		if (addRule(ruleset, argv[r], access, handled) < 0) {
			return fail("landlock_add_rule", argv[r]);
		}
	}
	// bubblewrap set it already (its seccomp filter needs it); Landlock requires it either way.
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
		return fail("PR_SET_NO_NEW_PRIVS", strerror(errno));
	}
	if (syscall(SYS_landlock_restrict_self, ruleset, 0) < 0) {
		return fail("landlock_restrict_self", strerror(errno));
	}
	close(ruleset);
	execv(argv[i + 1], &argv[i + 1]);
	fprintf(stderr, "volt-landlock: %s: %s\n", argv[i + 1], strerror(errno));
	return 127;
}
