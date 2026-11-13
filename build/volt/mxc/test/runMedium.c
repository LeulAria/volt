/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Test-only: runs a command at Medium integrity with administrator rights filtered out, the way
 * a normal user runs Volt. GitHub's hosted Windows runners log in as an elevated administrator
 * (High integrity), which is not what MXC's loopback rules are written for. Never shipped.
 *
 *   run-medium <command line...>      exits with the command's exit code
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <stdio.h>
#include <wchar.h>

int wmain(void) {
	/* Everything after the first argument, verbatim. */
	wchar_t *line = GetCommandLineW();
	BOOL quoted = FALSE;
	for (; *line; line++) {
		if (*line == L'"') {
			quoted = !quoted;
		} else if (!quoted && (*line == L' ' || *line == L'\t')) {
			break;
		}
	}
	while (*line == L' ' || *line == L'\t') {
		line++;
	}
	if (!*line) {
		fwprintf(stderr, L"usage: run-medium <command line>\n");
		return 2;
	}
	HANDLE self = NULL;
	HANDLE restricted = NULL;
	if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &self)
		|| !CreateRestrictedToken(self, LUA_TOKEN | DISABLE_MAX_PRIVILEGE, 0, NULL, 0, NULL, 0, NULL, &restricted)) {
		fwprintf(stderr, L"run-medium: token error %lu\n", GetLastError());
		return 3;
	}
	PSID medium = NULL;
	ConvertStringSidToSidW(L"S-1-16-8192", &medium);
	TOKEN_MANDATORY_LABEL label = { { medium, SE_GROUP_INTEGRITY } };
	if (!SetTokenInformation(restricted, TokenIntegrityLevel, &label, sizeof(label) + GetLengthSid(medium))) {
		fwprintf(stderr, L"run-medium: integrity error %lu\n", GetLastError());
		return 3;
	}
	/*
	 * An elevated token owns new objects through BUILTIN\Administrators, which LUA_TOKEN makes
	 * deny-only: the child could not open its own processes and pipes. Give ownership and the
	 * default DACL to the user, as a UAC-filtered login token has them.
	 */
	BYTE userBuffer[256];
	DWORD length = 0;
	if (!GetTokenInformation(restricted, TokenUser, userBuffer, sizeof(userBuffer), &length)) {
		fwprintf(stderr, L"run-medium: user error %lu\n", GetLastError());
		return 3;
	}
	PSID user = ((TOKEN_USER *)userBuffer)->User.Sid;
	TOKEN_OWNER owner = { user };
	PSECURITY_DESCRIPTOR sd = NULL;
	LPWSTR userSid = NULL;
	wchar_t sddl[256];
	ConvertSidToStringSidW(user, &userSid);
	swprintf(sddl, 256, L"D:(A;;GA;;;%ls)(A;;GA;;;SY)", userSid);
	PACL dacl = NULL;
	BOOL present = FALSE, defaulted = FALSE;
	if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &sd, NULL)
		|| !GetSecurityDescriptorDacl(sd, &present, &dacl, &defaulted)) {
		fwprintf(stderr, L"run-medium: dacl error %lu\n", GetLastError());
		return 3;
	}
	TOKEN_DEFAULT_DACL defaultDacl = { dacl };
	if (!SetTokenInformation(restricted, TokenOwner, &owner, sizeof(owner))
		|| !SetTokenInformation(restricted, TokenDefaultDacl, &defaultDacl, sizeof(defaultDacl))) {
		fwprintf(stderr, L"run-medium: owner error %lu\n", GetLastError());
		return 3;
	}
	STARTUPINFOW si = { sizeof(si) };
	si.dwFlags = STARTF_USESTDHANDLES;
	si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
	si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
	si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
	PROCESS_INFORMATION pi;
	if (!CreateProcessAsUserW(restricted, NULL, line, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
		fwprintf(stderr, L"run-medium: CreateProcessAsUser error %lu\n", GetLastError());
		return 3;
	}
	WaitForSingleObject(pi.hProcess, INFINITE);
	DWORD code = 0;
	GetExitCodeProcess(pi.hProcess, &code);
	return (int)code;
}
