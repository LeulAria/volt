/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// volt-fsd <read|write> <root> <relative path>: Volt's race-free file open on Linux (B-17, I.2).
//
// Volt reads and writes files for a sandboxed agent (ACP fs/*) outside the agent's sandbox. The
// agent can swap any folder of the path for a symlink between Volt's check and the open, so the
// open itself must refuse symlinks: openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
// RESOLVE_NO_MAGICLINKS) from the root, which Node cannot call. Node cannot receive a file
// descriptor over SCM_RIGHTS without a native addon either, so this helper does the I/O on the
// descriptor it opened and Volt talks to it over stdin/stdout:
//
//   stdout: {"ok":true,"path":<final path of the descriptor>,"nlink":N,"size":S,"created":0|1}\n
//           then the S bytes the file holds now.
//   read:   done. (Volt reads without the helper: safeOpenRead checks /proc/self/fd instead.)
//   write:  stdin: 'w' then the new content to EOF: the file is truncated and written through the
//           same descriptor, and {"ok":true}\n follows. Anything else (Volt refused the final
//           path or the link count): nothing is written, a file this call created is removed
//           relative to its folder's descriptor, and {"ok":true,"aborted":true}\n follows.
//   errors: {"ok":false,"error":"symlink|outside|missing|not-file|unsupported|usage|io","message":"..."}\n, exit 1.
//
// Missing folders of a write are created with mkdirat on descriptors opened the same way, so no
// folder or byte is ever created through a symlink. Built statically: gcc -O2 -static.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_openat2
#define SYS_openat2 437
#endif
#ifndef RESOLVE_NO_MAGICLINKS
#define RESOLVE_NO_MAGICLINKS 0x02
#endif
#ifndef RESOLVE_NO_SYMLINKS
#define RESOLVE_NO_SYMLINKS 0x04
#endif
#ifndef RESOLVE_BENEATH
#define RESOLVE_BENEATH 0x08
#endif

struct volt_open_how {
	uint64_t flags;
	uint64_t mode;
	uint64_t resolve;
};

static int open2(int dirfd, const char *path, uint64_t flags, uint64_t mode, uint64_t resolve) {
	struct volt_open_how how = { flags, mode, resolve };
	return (int)syscall(SYS_openat2, dirfd, path, &how, sizeof(how));
}

static void json_string(const char *text) {
	putchar('"');
	for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
		if (*p == '"' || *p == '\\') {
			printf("\\%c", *p);
		} else if (*p < 0x20) {
			printf("\\u%04x", *p);
		} else {
			putchar(*p);
		}
	}
	putchar('"');
}

static int fail(const char *code, const char *message) {
	printf("{\"ok\":false,\"error\":\"%s\",\"message\":", code);
	json_string(message);
	printf("}\n");
	fflush(stdout);
	return 1;
}

static int fail_errno(const char *what) {
	char message[512];
	snprintf(message, sizeof(message), "%s: %s", what, strerror(errno));
	switch (errno) {
		case ELOOP: return fail("symlink", message);
		case EXDEV: return fail("outside", message);
		case ENOENT: return fail("missing", message);
		case ENOSYS: case E2BIG: return fail("unsupported", message);
		case ENOTDIR: return fail("symlink", message);
		default: return fail("io", message);
	}
}

static const uint64_t RESOLVE = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS;

static int write_all(int fd, const char *data, size_t length) {
	size_t done = 0;
	while (done < length) {
		ssize_t n = pwrite(fd, data + done, length - done, (off_t)done);
		if (n < 0) {
			if (errno == EINTR) {
				continue;
			}
			return -1;
		}
		done += (size_t)n;
	}
	return 0;
}

int main(int argc, char **argv) {
	if (argc != 4 || (strcmp(argv[1], "read") != 0 && strcmp(argv[1], "write") != 0)) {
		return fail("usage", "volt-fsd <read|write> <root> <relative path>");
	}
	const int writing = strcmp(argv[1], "write") == 0;
	const char *root = argv[2];
	char rel[PATH_MAX];
	if (root[0] != '/' || strlen(argv[3]) == 0 || strlen(argv[3]) >= sizeof(rel) || argv[3][0] == '/') {
		return fail("usage", "the root must be absolute and the path relative to it");
	}
	strcpy(rel, argv[3]);

	// The root is a real path: no symlink in it either.
	int dirfd = open2(AT_FDCWD, root, O_PATH | O_DIRECTORY | O_CLOEXEC, 0, RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS);
	if (dirfd < 0) {
		return fail_errno("open root");
	}

	// Walk the folders one component at a time, creating missing ones for a write.
	char *name = rel;
	char *slash;
	while ((slash = strchr(name, '/')) != NULL) {
		*slash = '\0';
		if (*name == '\0' || strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
			return fail("outside", "the path has an empty, . or .. component");
		}
		int next = open2(dirfd, name, O_PATH | O_DIRECTORY | O_CLOEXEC, 0, RESOLVE);
		if (next < 0 && errno == ENOENT && writing) {
			if (mkdirat(dirfd, name, 0777) < 0 && errno != EEXIST) {
				return fail_errno("create folder");
			}
			next = open2(dirfd, name, O_PATH | O_DIRECTORY | O_CLOEXEC, 0, RESOLVE);
		}
		if (next < 0) {
			return fail_errno("open folder");
		}
		close(dirfd);
		dirfd = next;
		name = slash + 1;
	}
	if (*name == '\0' || strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
		return fail("outside", "the path names no file");
	}

	int created = 0;
	int fd = open2(dirfd, name, (writing ? O_RDWR : O_RDONLY) | O_CLOEXEC | O_NOCTTY | O_NONBLOCK, 0, RESOLVE);
	if (fd < 0 && errno == ENOENT && writing) {
		fd = open2(dirfd, name, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOCTTY, 0666, RESOLVE);
		created = fd >= 0;
	}
	if (fd < 0) {
		return fail_errno("open file");
	}
	struct stat st;
	if (fstat(fd, &st) < 0) {
		return fail_errno("stat");
	}
	if (!S_ISREG(st.st_mode)) {
		return fail("not-file", "not a regular file");
	}
	char link[64];
	char final[PATH_MAX];
	snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
	ssize_t length = readlink(link, final, sizeof(final) - 1);
	if (length < 0) {
		return fail_errno("final path");
	}
	final[length] = '\0';

	printf("{\"ok\":true,\"path\":");
	json_string(final);
	printf(",\"nlink\":%lu,\"size\":%lld,\"created\":%d}\n", (unsigned long)st.st_nlink, (long long)st.st_size, created);
	// What the file holds now: exactly `size` bytes (a file that changes meanwhile is cut or padded).
	char buffer[65536];
	off_t offset = 0;
	while (offset < st.st_size) {
		size_t want = (size_t)(st.st_size - offset) < sizeof(buffer) ? (size_t)(st.st_size - offset) : sizeof(buffer);
		ssize_t n = pread(fd, buffer, want, offset);
		if (n < 0 && errno == EINTR) {
			continue;
		}
		if (n <= 0) {
			memset(buffer, 0, want);
			n = (ssize_t)want;
		}
		fwrite(buffer, 1, (size_t)n, stdout);
		offset += n;
	}
	fflush(stdout);
	if (!writing) {
		return 0;
	}

	int command = getchar();
	if (command != 'w') {
		if (created) {
			unlinkat(dirfd, name, 0);
		}
		printf("{\"ok\":true,\"aborted\":true}\n");
		return 0;
	}
	size_t capacity = 1 << 16, used = 0;
	char *content = malloc(capacity);
	if (!content) {
		return fail("io", "out of memory");
	}
	size_t n;
	while ((n = fread(content + used, 1, capacity - used, stdin)) > 0) {
		used += n;
		if (used == capacity) {
			capacity *= 2;
			char *grown = realloc(content, capacity);
			if (!grown) {
				return fail("io", "out of memory");
			}
			content = grown;
		}
	}
	if (ftruncate(fd, 0) < 0 || write_all(fd, content, used) < 0) {
		return fail_errno("write");
	}
	close(fd);
	printf("{\"ok\":true}\n");
	return 0;
}
