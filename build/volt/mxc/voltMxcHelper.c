/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * volt-mxc-helper: the small native helper of Volt's Windows sandbox backend (MXC ProcessContainer,
 * spec decision D-03). wxc-exec does not hand its caller the container's job or AppContainer SID,
 * so Volt collects that evidence itself:
 *
 *   volt-mxc-helper attest <pid>
 *     Runs OUTSIDE the sandbox, as the user. Opens <pid> and prints one JSON line: whether its
 *     token is an AppContainer token, the AppContainer SID, the integrity level, whether the
 *     process is in a job, its image path, parent pid and creation time. The workload cannot
 *     influence any of it.
 *
 *   volt-mxc-helper prologue <control-file>
 *     Runs INSIDE the container as its first process, before the workload exists. Reads its
 *     instructions from <control-file> (in a folder the container can only read), runs the
 *     canary (credential sentinel read, a connect to a non-route address and to Volt's canary
 *     listener), writes "ready" to the status file, then BLOCKS until the go file appears. Only
 *     then does it start the workload with exactly the standard handles (handle list), poll the
 *     job's CPU, memory and process count once a second, and exit with the workload's code.
 *
 *   volt-mxc-helper version
 *
 * Built with `zig cc` for aarch64 and x86_64 Windows (build/volt/mxc/buildHelper.mjs); no CRT
 * features beyond what mingw-w64 provides.
 */

#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define HELPER_VERSION "1"
#define EXIT_PROLOGUE_FAILED 125
#define EXIT_LIMIT 137
#define GO_TIMEOUT_MS 120000

/* ------------------------------------------------------------------------------------------ */
/* Output helpers                                                                              */

static void write_stdout(const char *text) {
	DWORD written = 0;
	WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, (DWORD)strlen(text), &written, NULL);
}

/** Appends `text` to a JSON string literal, escaped. */
static void json_escape(char *out, size_t cap, const char *text) {
	size_t n = strlen(out);
	for (const unsigned char *p = (const unsigned char *)text; *p && n + 8 < cap; p++) {
		if (*p == '"' || *p == '\\') {
			out[n++] = '\\';
			out[n++] = (char)*p;
		} else if (*p < 0x20) {
			n += (size_t)snprintf(out + n, cap - n, "\\u%04x", *p);
		} else {
			out[n++] = (char)*p;
		}
	}
	out[n] = 0;
}

static void wide_to_utf8(const wchar_t *in, char *out, int cap) {
	if (!WideCharToMultiByte(CP_UTF8, 0, in, -1, out, cap, NULL, NULL)) {
		out[0] = 0;
	}
}

/* ------------------------------------------------------------------------------------------ */
/* attest                                                                                      */

static DWORD parent_of(DWORD pid) {
	HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
	DWORD parent = 0;
	if (snap == INVALID_HANDLE_VALUE) {
		return 0;
	}
	PROCESSENTRY32W entry;
	entry.dwSize = sizeof(entry);
	if (Process32FirstW(snap, &entry)) {
		do {
			if (entry.th32ProcessID == pid) {
				parent = entry.th32ParentProcessID;
				break;
			}
		} while (Process32NextW(snap, &entry));
	}
	CloseHandle(snap);
	return parent;
}

static int attest(DWORD pid) {
	char json[8192];
	char sidText[256] = "";
	char integrity[64] = "";
	char image[2048] = "";
	BOOL inJob = FALSE;
	DWORD isAppContainer = 0;
	DWORD session = 0;
	unsigned long long created = 0;
	const char *error = NULL;

	HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
	if (!process) {
		snprintf(json, sizeof(json), "{\"pid\":%lu,\"ok\":false,\"error\":\"OpenProcess failed: %lu\"}\n", pid, GetLastError());
		write_stdout(json);
		return 2;
	}
	HANDLE token = NULL;
	if (!OpenProcessToken(process, TOKEN_QUERY, &token)) {
		error = "OpenProcessToken failed";
	} else {
		DWORD length = 0;
		GetTokenInformation(token, TokenIsAppContainer, &isAppContainer, sizeof(isAppContainer), &length);
		BYTE buffer[1024];
		if (GetTokenInformation(token, TokenAppContainerSid, buffer, sizeof(buffer), &length)) {
			TOKEN_APPCONTAINER_INFORMATION *info = (TOKEN_APPCONTAINER_INFORMATION *)buffer;
			LPWSTR text = NULL;
			if (info->TokenAppContainer && ConvertSidToStringSidW(info->TokenAppContainer, &text)) {
				wide_to_utf8(text, sidText, sizeof(sidText));
				LocalFree(text);
			}
		}
		if (GetTokenInformation(token, TokenIntegrityLevel, buffer, sizeof(buffer), &length)) {
			TOKEN_MANDATORY_LABEL *label = (TOKEN_MANDATORY_LABEL *)buffer;
			LPWSTR text = NULL;
			if (ConvertSidToStringSidW(label->Label.Sid, &text)) {
				wide_to_utf8(text, integrity, sizeof(integrity));
				LocalFree(text);
			}
		}
		CloseHandle(token);
	}
	IsProcessInJob(process, NULL, &inJob);
	ProcessIdToSessionId(pid, &session);
	wchar_t path[1024];
	DWORD size = 1024;
	if (QueryFullProcessImageNameW(process, 0, path, &size)) {
		wide_to_utf8(path, image, sizeof(image));
	}
	FILETIME c, e, k, u;
	if (GetProcessTimes(process, &c, &e, &k, &u)) {
		created = ((unsigned long long)c.dwHighDateTime << 32) | c.dwLowDateTime;
	}
	DWORD exitCode = 0;
	BOOL running = GetExitCodeProcess(process, &exitCode) && exitCode == STILL_ACTIVE;
	CloseHandle(process);

	snprintf(json, sizeof(json), "{\"pid\":%lu,\"ok\":%s,\"running\":%s,\"appContainer\":%s,\"inJob\":%s,\"sessionId\":%lu,\"parentPid\":%lu,\"created\":%llu,\"appContainerSid\":\"",
		pid, error ? "false" : "true", running ? "true" : "false", isAppContainer ? "true" : "false", inJob ? "true" : "false", session, parent_of(pid), created);
	json_escape(json, sizeof(json), sidText);
	strncat(json, "\",\"integrity\":\"", sizeof(json) - strlen(json) - 1);
	json_escape(json, sizeof(json), integrity);
	strncat(json, "\",\"image\":\"", sizeof(json) - strlen(json) - 1);
	json_escape(json, sizeof(json), image);
	strncat(json, "\"", sizeof(json) - strlen(json) - 1);
	if (error) {
		strncat(json, ",\"error\":\"", sizeof(json) - strlen(json) - 1);
		json_escape(json, sizeof(json), error);
		strncat(json, "\"", sizeof(json) - strlen(json) - 1);
	}
	strncat(json, "}\n", sizeof(json) - strlen(json) - 1);
	write_stdout(json);
	return error ? 2 : 0;
}

/* ------------------------------------------------------------------------------------------ */
/* prologue                                                                                    */

typedef struct {
	wchar_t nonce[80];
	wchar_t status[1024];
	wchar_t go[1024];
	wchar_t sentinel[1024];
	wchar_t net[16];
	wchar_t temp[1024];
	int canaryPort;
	unsigned long long cpuSeconds;
	unsigned long long memoryMB;
	unsigned long processes;
	wchar_t *cmd;
} PROLOGUE;

/** Reads `key=value` lines (UTF-8); `cmd=` is last and runs to the end of its line. */
static int read_control(const wchar_t *path, PROLOGUE *p) {
	HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
	if (file == INVALID_HANDLE_VALUE) {
		return 0;
	}
	char raw[65536];
	DWORD got = 0;
	BOOL ok = ReadFile(file, raw, sizeof(raw) - 1, &got, NULL);
	CloseHandle(file);
	if (!ok || got == 0 || got >= sizeof(raw) - 1) {
		return 0;
	}
	raw[got] = 0;
	static wchar_t text[65536];
	if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, raw, -1, text, 65536)) {
		return 0;
	}
	memset(p, 0, sizeof(*p));
	wchar_t *line = text;
	while (line && *line) {
		wchar_t *next = wcschr(line, L'\n');
		if (next) {
			*next++ = 0;
		}
		size_t len = wcslen(line);
		if (len && line[len - 1] == L'\r') {
			line[len - 1] = 0;
		}
		wchar_t *eq = wcschr(line, L'=');
		if (eq) {
			*eq = 0;
			const wchar_t *v = eq + 1;
			if (!wcscmp(line, L"nonce")) { wcsncpy(p->nonce, v, 79); }
			else if (!wcscmp(line, L"status")) { wcsncpy(p->status, v, 1023); }
			else if (!wcscmp(line, L"go")) { wcsncpy(p->go, v, 1023); }
			else if (!wcscmp(line, L"sentinel")) { wcsncpy(p->sentinel, v, 1023); }
			else if (!wcscmp(line, L"net")) { wcsncpy(p->net, v, 15); }
			else if (!wcscmp(line, L"temp")) { wcsncpy(p->temp, v, 1023); }
			else if (!wcscmp(line, L"canaryPort")) { p->canaryPort = _wtoi(v); }
			else if (!wcscmp(line, L"cpuSeconds")) { p->cpuSeconds = _wcstoui64(v, NULL, 10); }
			else if (!wcscmp(line, L"memoryMB")) { p->memoryMB = _wcstoui64(v, NULL, 10); }
			else if (!wcscmp(line, L"processes")) { p->processes = wcstoul(v, NULL, 10); }
			else if (!wcscmp(line, L"cmd")) { p->cmd = (wchar_t *)v; }
		}
		line = next;
	}
	return p->nonce[0] && p->status[0] && p->go[0] && p->cmd && p->cmd[0];
}

/** Appends one line to the status file (created on first use). */
static void status_line(const PROLOGUE *p, const char *text) {
	HANDLE file = CreateFileW(p->status, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, 0, NULL);
	if (file == INVALID_HANDLE_VALUE) {
		return;
	}
	DWORD written = 0;
	WriteFile(file, text, (DWORD)strlen(text), &written, NULL);
	FlushFileBuffers(file);
	CloseHandle(file);
}

/** The Winsock error of a TCP connect, or 0 when it connected; WSAETIMEDOUT if it did not settle in `ms`. */
static int try_connect(const char *ip, int port, int ms) {
	SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	if (s == INVALID_SOCKET) {
		return WSAGetLastError();
	}
	u_long nonBlocking = 1;
	ioctlsocket(s, FIONBIO, &nonBlocking);
	struct sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons((u_short)port);
	inet_pton(AF_INET, ip, &addr.sin_addr);
	int result = 0;
	if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) == SOCKET_ERROR) {
		result = WSAGetLastError();
		if (result == WSAEWOULDBLOCK) {
			fd_set w, e;
			FD_ZERO(&w); FD_ZERO(&e);
			FD_SET(s, &w); FD_SET(s, &e);
			struct timeval tv = { ms / 1000, (ms % 1000) * 1000 };
			int ready = select(0, NULL, &w, &e, &tv);
			if (ready == 0) {
				result = WSAETIMEDOUT;
			} else if (FD_ISSET(s, &e)) {
				int err = 0, len = sizeof(err);
				getsockopt(s, SOL_SOCKET, SO_ERROR, (char *)&err, &len);
				result = err ? err : WSAECONNREFUSED;
			} else {
				result = 0;
			}
		}
	}
	closesocket(s);
	return result;
}

static int wait_for_go(const PROLOGUE *p) {
	char nonce[160];
	wide_to_utf8(p->nonce, nonce, sizeof(nonce));
	char expected[200];
	snprintf(expected, sizeof(expected), "go %s", nonce);
	size_t length = strlen(expected);
	DWORD start = GetTickCount();
	while (GetTickCount() - start < GO_TIMEOUT_MS) {
		HANDLE file = CreateFileW(p->go, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
		if (file != INVALID_HANDLE_VALUE) {
			char raw[160] = { 0 };
			DWORD got = 0;
			ReadFile(file, raw, sizeof(raw) - 1, &got, NULL);
			CloseHandle(file);
			/* A file still being written is read again; complete content decides. */
			if (got >= length) {
				return strncmp(raw, expected, length) == 0;
			}
		}
		Sleep(5);
	}
	return 0;
}

/** Kills every other process of this job that the container can open (best effort; the job closes after us). */
static void kill_job_members(DWORD self) {
	BYTE buffer[sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + 4096 * sizeof(ULONG_PTR)];
	JOBOBJECT_BASIC_PROCESS_ID_LIST *list = (JOBOBJECT_BASIC_PROCESS_ID_LIST *)buffer;
	if (!QueryInformationJobObject(NULL, JobObjectBasicProcessIdList, list, sizeof(buffer), NULL)) {
		return;
	}
	for (DWORD i = 0; i < list->NumberOfProcessIdsInList; i++) {
		DWORD pid = (DWORD)list->ProcessIdList[i];
		if (pid != self) {
			HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
			if (h) {
				TerminateProcess(h, EXIT_LIMIT);
				CloseHandle(h);
			}
		}
	}
}

static int prologue(const wchar_t *controlPath) {
	PROLOGUE p;
	if (!read_control(controlPath, &p)) {
		return EXIT_PROLOGUE_FAILED;
	}
	SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
	char line[2048];
	char nonce[160];
	wide_to_utf8(p.nonce, nonce, sizeof(nonce));

	/* Self-report (supplementary: the parent's attestation is the evidence). */
	BOOL inJob = FALSE;
	IsProcessInJob(GetCurrentProcess(), NULL, &inJob);
	JOBOBJECT_BASIC_UI_RESTRICTIONS ui = { 0 };
	BOOL uiOk = QueryInformationJobObject(NULL, JobObjectBasicUIRestrictions, &ui, sizeof(ui), NULL);

	/* Canary: each must fail with the expected error class (the parent checks the classes). */
	DWORD sentinelError = 0;
	if (p.sentinel[0]) {
		HANDLE h = CreateFileW(p.sentinel, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
		if (h != INVALID_HANDLE_VALUE) {
			CloseHandle(h);
			sentinelError = 0;
		} else {
			sentinelError = GetLastError();
		}
	}
	int publicError = -1;
	int loopbackError = -1;
	if (wcscmp(p.net, L"host") != 0) {
		WSADATA wsa;
		if (WSAStartup(MAKEWORD(2, 2), &wsa) == 0) {
			DWORD t0 = GetTickCount();
			publicError = try_connect("192.0.2.1", 9, 50);
			DWORD publicMs = GetTickCount() - t0;
			if (publicError == WSAETIMEDOUT || publicMs > 50) {
				publicError = WSAETIMEDOUT;
			}
			if (p.canaryPort > 0) {
				loopbackError = try_connect("127.0.0.1", p.canaryPort, 200);
			}
			WSACleanup();
		}
	}
	snprintf(line, sizeof(line), "ready pid=%lu nonce=%s injob=%d ui=%s0x%lx sentinel=%lu public=%d loopback=%d\n",
		GetCurrentProcessId(), nonce, inJob ? 1 : 0, uiOk ? "" : "?", (unsigned long)ui.UIRestrictionsClass, sentinelError, publicError, loopbackError);
	status_line(&p, line);

	/* Nothing of the workload runs before the parent has attested this process from outside. */
	if (!wait_for_go(&p)) {
		status_line(&p, "nogo\n");
		return EXIT_PROLOGUE_FAILED;
	}

	/* MXC points TEMP and TMP at a per-container folder under LOCALAPPDATA that it does not
	 * create; the workload gets the run's own temp folder instead. */
	if (p.temp[0]) {
		SetEnvironmentVariableW(L"TEMP", p.temp);
		SetEnvironmentVariableW(L"TMP", p.temp);
	}

	/* The workload gets exactly the standard handles. */
	HANDLE handles[3];
	DWORD count = 0;
	DWORD kinds[3] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
	for (int i = 0; i < 3; i++) {
		HANDLE h = GetStdHandle(kinds[i]);
		if (h && h != INVALID_HANDLE_VALUE) {
			BOOL seen = FALSE;
			for (DWORD j = 0; j < count; j++) {
				seen |= handles[j] == h;
			}
			if (!seen && SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
				handles[count++] = h;
			}
		}
	}
	SIZE_T attrSize = 0;
	InitializeProcThreadAttributeList(NULL, 1, 0, &attrSize);
	LPPROC_THREAD_ATTRIBUTE_LIST attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attrSize);
	if (!attrs || !InitializeProcThreadAttributeList(attrs, 1, 0, &attrSize)) {
		status_line(&p, "error attributes\n");
		return EXIT_PROLOGUE_FAILED;
	}
	if (count && !UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, count * sizeof(HANDLE), NULL, NULL)) {
		status_line(&p, "error handle-list\n");
		return EXIT_PROLOGUE_FAILED;
	}
	STARTUPINFOEXW si;
	memset(&si, 0, sizeof(si));
	si.StartupInfo.cb = sizeof(si);
	si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
	si.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
	si.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
	si.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
	si.lpAttributeList = attrs;
	PROCESS_INFORMATION pi;
	if (!CreateProcessW(NULL, p.cmd, NULL, NULL, count ? TRUE : FALSE, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, NULL, NULL, &si.StartupInfo, &pi)) {
		snprintf(line, sizeof(line), "error spawn %lu\n", GetLastError());
		status_line(&p, line);
		fprintf(stderr, "Volt sandbox: could not start the command (Windows error %lu)\n", GetLastError());
		return 127;
	}
	CloseHandle(pi.hThread);
	snprintf(line, sizeof(line), "started pid=%lu\n", pi.dwProcessId);
	status_line(&p, line);

	/* Resource limits: MXC has no limit fields and its job cannot be nested, so poll it (best effort). */
	DWORD exitCode = 0;
	for (;;) {
		if (WaitForSingleObject(pi.hProcess, 1000) == WAIT_OBJECT_0) {
			GetExitCodeProcess(pi.hProcess, &exitCode);
			break;
		}
		JOBOBJECT_BASIC_ACCOUNTING_INFORMATION acct;
		const char *violated = NULL;
		unsigned long long value = 0;
		if (QueryInformationJobObject(NULL, JobObjectBasicAccountingInformation, &acct, sizeof(acct), NULL)) {
			unsigned long long cpu = (unsigned long long)(acct.TotalUserTime.QuadPart + acct.TotalKernelTime.QuadPart) / 10000000ULL;
			if (p.cpuSeconds && cpu > p.cpuSeconds) {
				violated = "cpu";
				value = cpu;
			} else if (p.processes && acct.ActiveProcesses > p.processes + 1) {
				violated = "processes";
				value = acct.ActiveProcesses - 1;
			}
		}
		if (!violated && p.memoryMB) {
			JOBOBJECT_EXTENDED_LIMIT_INFORMATION ext;
			if (QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation, &ext, sizeof(ext), NULL)) {
				unsigned long long mb = (unsigned long long)ext.PeakJobMemoryUsed / (1024ULL * 1024ULL);
				if (mb > p.memoryMB) {
					violated = "memory";
					value = mb;
				}
			}
		}
		if (violated) {
			snprintf(line, sizeof(line), "limit %s %llu\n", violated, value);
			status_line(&p, line);
			TerminateProcess(pi.hProcess, EXIT_LIMIT);
			kill_job_members(GetCurrentProcessId());
			exitCode = EXIT_LIMIT;
			break;
		}
	}
	CloseHandle(pi.hProcess);
	snprintf(line, sizeof(line), "exit %lu\n", exitCode);
	status_line(&p, line);
	return (int)exitCode;
}

int wmain(int argc, wchar_t **argv) {
	if (argc >= 2 && !wcscmp(argv[1], L"version")) {
		write_stdout("volt-mxc-helper " HELPER_VERSION "\n");
		return 0;
	}
	if (argc == 3 && !wcscmp(argv[1], L"attest")) {
		return attest((DWORD)wcstoul(argv[2], NULL, 10));
	}
	if (argc == 3 && !wcscmp(argv[1], L"prologue")) {
		return prologue(argv[2]);
	}
	write_stdout("usage: volt-mxc-helper attest <pid> | prologue <control-file> | version\n");
	return 2;
}
