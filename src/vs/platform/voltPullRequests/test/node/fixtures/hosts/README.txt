Pull request client fixtures - real API responses recorded 2026-10-08
=====================================================================

All requests were unauthenticated GETs (curl -sS -H 'Accept: application/json').
Nothing was signed in to, and no write requests were made.

Processing applied to every *.json file:
  - Every JSON array (at any depth) is trimmed to its first 3 items. Count/size/next
    fields are left as the server returned them, so they can exceed the trimmed array
    length (for example azure/threads.json "count": 7 with 3 threads kept).
  - Email addresses are replaced with "user@example.com" (git@host SSH remotes kept).
  - Pretty-printed with 2-space indentation.
  - bitbucket/diff.txt is the raw text/plain diff (followed redirects with -L), cut to the first 200 lines.
  - Files named *_error.json hold the error body the host returned (HTTP status listed below).

Projects used
-------------
GitLab:    gitlab.com, project gitlab-org/cli (id 34675721), MR !3995
           ("feat: package delete via --name", opened, source branch feature/8579/package-delete-via-name,
           head sha 2e119adb8b5939136f4e2221d3fa5d7640e32483, head_pipeline 2921893506 success).
           NOTE: this MR comes from a FORK: source_project_id 45049979 (gitlab-community/gitlab-org/cli),
           target/project_id 34675721. Its pipelines run in the fork project, see jobs below.
Bitbucket: api.bitbucket.org, repository atlassian/atlassian-connect-express, PR #547
           ("[ONECLOUD-13509]: ACE can operate without descriptor", MERGED, 30 comments of which 22 inline,
           one SUCCESSFUL build status). atlassian/python-bitbucket and tutorials/tutorials.bitbucket.org
           returned 404 anonymously. The comments page (pagelen=3) holds 2 general comments and 1 inline comment.
           The by-branch query returns 2 PRs (#547 and #551) from the same source branch.
Azure:     dev.azure.com, organization dnceng-public, project public, repository dotnet-public-wiki
           (id 2459d599-fdb2-4d28-9810-daeec061cf90, the only repo in that project), PR 5
           ("Inventory bootstrapping", completed, sourceRefName refs/heads/invBootstrap). The repo has only 2 PRs (5 and 1).
           Every Azure request also sent 'X-TFS-FedAuthRedirect: Suppress' and did NOT follow redirects.
           Without that header, anonymous requests that need auth return HTTP 302 to
           https://spsprodcus4.vssps.visualstudio.com/_signin?... (HTML body). With it they return HTTP 401 JSON (TF400813).
           Other public projects probed (azure-sdk/public, azure-public/vside, dnceng/public, ms/react-native-windows)
           only expose disabled repos (isDisabled=true), and ms/vscode, ms/terminal, ms/calculator,
           mseng/AzureDevOpsRoadmap return 401, so dnceng-public is the only one used.
           None of PR 5's threads (or PR 1's single thread) has threadContext.filePath. threads.json keeps
           thread 8 (system: reviewers updated), 10 (system: status/BypassPolicy) and 11 (text comment, closed).
           The iterations list is 401, so lastIterationId could not be read. Iteration 1 was used for changes.json;
           iteration 2 returns "The requested pull request iteration '2' cannot be found.", so 1 is the last.

Files (HTTP status, file, exact URL)
------------------------------------
200  gitlab/project.json                           https://gitlab.com/api/v4/projects/gitlab-org%2Fcli
200  gitlab/merge_requests_opened.json             https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/merge_requests?state=opened&per_page=3&order_by=updated_at
200  gitlab/merge_requests_merged.json             https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/merge_requests?state=merged&per_page=3
200  gitlab/merge_request.json                     https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/merge_requests/3995
200  gitlab/merge_request_by_branch.json           https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/merge_requests?source_branch=feature%2F8579%2Fpackage-delete-via-name&state=all
401  gitlab/notes_error.json                       https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/merge_requests/3995/notes?per_page=3
401  gitlab/discussions_error.json                 https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/merge_requests/3995/discussions?per_page=5
200  gitlab/diffs.json                             https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/merge_requests/3995/diffs?per_page=3
200  gitlab/commits.json                           https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/merge_requests/3995/commits?per_page=3
200  gitlab/pipelines.json                         https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/merge_requests/3995/pipelines?per_page=2
200  gitlab/approvals.json                         https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/merge_requests/3995/approvals
200  gitlab/branches.json                          https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/repository/branches?per_page=3
404  gitlab/jobs_error.json                        https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/pipelines/2921893506/jobs?per_page=3
401  gitlab/statuses_error.json                    https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/repository/commits/2e119adb8b5939136f4e2221d3fa5d7640e32483/statuses
401  gitlab/version_unauth.txt                     https://gitlab.com/api/v4/version
200  gitlab/jobs.json                              https://gitlab.com/api/v4/projects/45049979/pipelines/2921893506/jobs?per_page=3
401  gitlab/statuses_source_project_error.json     https://gitlab.com/api/v4/projects/45049979/repository/commits/2e119adb8b5939136f4e2221d3fa5d7640e32483/statuses
200  bitbucket/repository.json                     https://api.bitbucket.org/2.0/repositories/atlassian/atlassian-connect-express
200  bitbucket/pullrequests.json                   https://api.bitbucket.org/2.0/repositories/atlassian/atlassian-connect-express/pullrequests?state=OPEN&state=MERGED&state=DECLINED&pagelen=3
200  bitbucket/pullrequest.json                    https://api.bitbucket.org/2.0/repositories/atlassian/atlassian-connect-express/pullrequests/547
200  bitbucket/pullrequests_by_branch.json         https://api.bitbucket.org/2.0/repositories/atlassian/atlassian-connect-express/pullrequests?q=source.branch.name%3D%22ONECLOUD-13509%2Foperate-without-descriptor%22&state=OPEN&state=MERGED&state=DECLINED
200  bitbucket/statuses.json                       https://api.bitbucket.org/2.0/repositories/atlassian/atlassian-connect-express/pullrequests/547/statuses
200  bitbucket/comments.json                       https://api.bitbucket.org/2.0/repositories/atlassian/atlassian-connect-express/pullrequests/547/comments?pagelen=3
200  bitbucket/diffstat.json                       https://api.bitbucket.org/2.0/repositories/atlassian/atlassian-connect-express/pullrequests/547/diffstat?pagelen=3
200  bitbucket/commits.json                        https://api.bitbucket.org/2.0/repositories/atlassian/atlassian-connect-express/pullrequests/547/commits?pagelen=3
200  bitbucket/branches.json                       https://api.bitbucket.org/2.0/repositories/atlassian/atlassian-connect-express/refs/branches?pagelen=3
200  bitbucket/diff.txt                            https://api.bitbucket.org/2.0/repositories/atlassian/atlassian-connect-express/pullrequests/547/diff
200  azure/repositories.json                       https://dev.azure.com/dnceng-public/public/_apis/git/repositories?api-version=7.1
200  azure/pullrequests.json                       https://dev.azure.com/dnceng-public/public/_apis/git/repositories/dotnet-public-wiki/pullrequests?searchCriteria.status=all&$top=3&api-version=7.1
200  azure/pullrequest.json                        https://dev.azure.com/dnceng-public/public/_apis/git/repositories/dotnet-public-wiki/pullrequests/5?api-version=7.1
200  azure/pullrequests_by_branch.json             https://dev.azure.com/dnceng-public/public/_apis/git/repositories/dotnet-public-wiki/pullrequests?searchCriteria.sourceRefName=refs%2Fheads%2FinvBootstrap&searchCriteria.status=all&api-version=7.1
401  azure/statuses_error.json                     https://dev.azure.com/dnceng-public/public/_apis/git/repositories/dotnet-public-wiki/pullrequests/5/statuses?api-version=7.1
200  azure/threads.json                            https://dev.azure.com/dnceng-public/public/_apis/git/repositories/dotnet-public-wiki/pullrequests/5/threads?api-version=7.1
401  azure/iterations_error.json                   https://dev.azure.com/dnceng-public/public/_apis/git/repositories/dotnet-public-wiki/pullrequests/5/iterations?api-version=7.1
200  azure/changes.json                            https://dev.azure.com/dnceng-public/public/_apis/git/repositories/dotnet-public-wiki/pullrequests/5/iterations/1/changes?$top=3&api-version=7.1
200  azure/commits.json                            https://dev.azure.com/dnceng-public/public/_apis/git/repositories/dotnet-public-wiki/pullrequests/5/commits?$top=3&api-version=7.1
200  azure/refs.json                               https://dev.azure.com/dnceng-public/public/_apis/git/repositories/dotnet-public-wiki/refs?filter=heads/&$top=3&api-version=7.1
200  azure/connectionData.json                     https://dev.azure.com/dnceng-public/_apis/connectionData

Failures and notes
------------------
gitlab/notes_error.json                   401 {"message":"401 Unauthorized"} - gitlab.com MR notes need auth (also 401 on gitlab-org/gitlab-runner !7544).
gitlab/discussions_error.json             401 same. No DiffNote/position fixture could be recorded anonymously.
gitlab/statuses_error.json                401 commit statuses need auth on gitlab.com (also 401 for same-project MR !4013's sha).
gitlab/statuses_source_project_error.json 401 same request against the fork project 45049979.
gitlab/jobs_error.json                    404 {"message":"404 Not found"} - the pipeline belongs to the fork project, not the target.
gitlab/jobs.json                          200 the same pipeline's jobs fetched from the fork project 45049979 (jobs for a
                                          same-project pipeline, gitlab-org/cli pipeline 2925048050, also return 200 anonymously).
gitlab/version_unauth.txt                 401 {"message":"401 Unauthorized"} (first line of the file is the HTTP status).
gitlab/diffs.json                         200 (the /diffs endpoint worked, so /changes was not needed).
gitlab/commits.json                       200 MR !3995 has a single commit.
azure/statuses_error.json                 401 TF400813 (anonymous user not authorized) with X-TFS-FedAuthRedirect: Suppress; 302 to sign-in without it.
azure/iterations_error.json               401 TF400813, same as above.
azure/connectionData.json                 200 shows the anonymous identity (id aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,
                                          descriptor System:PublicAccess;..., providerDisplayName "Anonymous").
One transient 503 (HTML error page) from dev.azure.com for pullrequests/5 was retried; the retry returned 200 and is what's saved.
