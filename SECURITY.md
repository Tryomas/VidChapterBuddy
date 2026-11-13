# Local security review and fixes

## Public repository and pull request security (2026-11-12)

Reviewed GitHub's public `Tryomas/VidChapterBuddy` repository at commit `9df9197b07be71cc0e6b3e69e15267f9e787a6d1`; local workflow blobs matched GitHub. Neither workflow runs on pull requests, comments, `pull_request_target`, or `workflow_run`. The release workflow runs only after a push to `main`; the Linux diagnostic workflow is manual. Opening a pull request does not execute its code in this repository. Merging code into `main` trusts that code, including its build scripts and dependencies, so review workflow and executable-code changes before merging or manually building a contributor's branch.

Verified or enabled these live repository settings:

- Secret scanning and secret push protection enabled; the alert API returned no findings at review time. Scanning can be asynchronous and does not recognize every possible secret.
- Dependabot vulnerability alerts enabled; the alert API returned no findings immediately after enabling. Dependency indexing and advisory scans can take time. Automated dependency-update PRs remain disabled.
- Default Actions token permissions are read-only; Actions cannot approve pull requests. Only the release publication job explicitly receives repository contents-write permission. No personal access token is referenced by either workflow.
- All outside contributors require approval for fork pull request workflows, including repeat contributors. This setting is additional protection if ordinary PR workflows are added later; it does not make privileged triggers safe.
- Actions must be pinned to full commit SHAs. Existing action references already meet this policy, and checkout disables persisted credentials.
- `main` requires a pull request for non-admin changes and resolved conversations; force pushes and deletion are disabled. Required approving review count is zero so a solo maintainer can merge their own PRs. Administrators retain bypass permission. These settings do not require independent review or prevent the owner from bypassing them.
- No repository Actions secrets, self-hosted runners, deploy keys, or webhooks were configured. The only listed collaborator was the owner's account, `tryonlinux`.

A local pattern scan of all seven reachable commits and 230 distinct blobs found no recognized GitHub/AWS/Google/Slack credentials, private-key headers, suspicious credential assignments, or sensitive credential/database filenames. This was a limited pattern scan, not proof that all history or files contain no private information; unreachable/deleted remote objects, account-wide credentials, installed GitHub Apps, and account authentication settings were outside this review.

The repository is already public. GitHub Actions artifacts in a public repository must be treated as publicly accessible to signed-in users; workflow step names do not change visibility. Release publishing now supports public and private repositories, so this public repository publishes publicly downloadable installers. Preparation and publication still reject conflicting tags/drafts, and published releases remain immutable on reruns.

Do not add personal account tokens to build workflows, run untrusted PR code using privileged triggers, or execute contributor code locally with personal credentials available. See [GitHub's guidance on privileged pull request workflows](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

Last reviewed and tested on Linux on 2026-11-11. The main release workflow runs on pushes to `main`; branch pushes and PRs do not publish releases. The standalone Linux repair workflow remains manual.

## Dependency findings

- Updated ZIP from 2.6.1 to 9.5.0. The FFmpeg installer still verifies the pinned archive SHA-256 before opening it, reads one fixed archive member, and verifies the executable SHA-256 before execution. It never bulk-extracts archive-controlled paths.
- Backported the upstream mutable out-pointer fix for RUSTSEC-2024-0429 into a local copy of GLib 0.18.5. Tauri's GTK3 stack requires the 0.18 series, so simply adding GLib 0.20 would leave the affected transitive dependency in place. See `src-tauri/vendor/glib/SECURITY-PATCH.md`. The package retains its real version; version-only scanners may still flag it. Do not broadly suppress this advisory.
- All 468 registry packages in the updated lockfile were checked against OSV. The remaining registry notice is RUSTSEC-2024-0370, an unmaintained notice for proc-macro-error 1.0.4, required by the upstream GTK3/GLib build macros. It is not a confirmed exploitable vulnerability. The locally patched GLib is reviewed separately because registry-version scans do not recognize a source backport.
- npm audit reported zero known vulnerabilities during the review.

## Window permissions

All custom commands are enrolled in Tauri's application ACL. The main window has explicit permissions for its commands. The projection window is allowed only `media_url`, playback events, and its window close/destroy operations. Remote origins have no command grants. The regression test resolves the generated manifests using Tauri's own permission resolver and verifies that projection cannot save the library, download executables, inspect files, or start/cancel conversion or analysis.

## FFmpeg resource limits

- Shared process supervision kills and reaps canceled, timed-out, or excessively noisy jobs. Separate job slots reject simultaneous duplicate analysis/conversion work. Both jobs are canceled when the main window closes.
- Chapter analysis has a visible Cancel analysis button, a two-hour processing timeout, a 24-hour input-duration limit, and at most 4 MiB captured diagnostics.
- Preview conversion has a six-hour processing timeout, 64 KiB diagnostics, 16 MiB progress output, a 4 GiB output limit, and a 10 GiB cache budget. Old regenerable MP4 previews are removed to reserve room for a new preview. A preview reaching the size limit is rejected rather than published as a completed video. Original media files are never evicted.
- Progress and error output are captured in bounded memory instead of unbounded files. Temporary preview files are removed after failure or cancellation.
- Existing-FFmpeg version checks have a five-second timeout and bounded output.
- FFmpeg media inputs use a `file`-only protocol allowlist. Decoder, filter, and encoding thread settings limit normal processing concurrency. These settings are not a complete operating-system sandbox or a hard total-memory limit; codecs and system media frameworks must still receive security updates.

## Verification

- Frontend TypeScript/Vite build and all 20 JavaScript/TypeScript logic and release-automation tests passed.
- All 24 Rust tests passed, including SQLite migration, round trips, backup portability, restore safety snapshots, transactional rollback, invalid backup rejection, the real FFmpeg WMV-to-MP4 smoke test, process timeout/output/cancellation, cache eviction, media range/authentication, and resolved window permissions.
- The GLib regression exercises next, next_back, nth, nth_back, last, and collection with GLib compiled at optimization level 3, where the original undefined behavior was exposed.
- Browser smoke checks passed for analysis cancellation and retry, existing-FFmpeg reuse, optional download consent/skip/retry, local playback/blanking, projection blanking, SQLite-backed autoplay, backup/restore controls, and video removal confirmation/cancellation. These browser tests use a fake library and do not edit the user's saved library.
- Latest local Linux app rebuilt and restarted. Windows and macOS runtime behavior has not been retested here; release runtime testing still requires those target systems.

Sources: https://rustsec.org/advisories/RUSTSEC-2024-0429.html and https://github.com/gtk-rs/gtk-rs-core/pull/1343 ; https://github.com/zip-rs/zip2/security/advisories ; https://tauri.app/security/capabilities/

## SQLite storage and transfer controls (2026-11-11)

SQLite is bundled through rusqlite. Data writes are parameterized and transactional. Imported backups open read-only, with defensive mode, trusted schema disabled, triggers/views disabled, query time and field limits, quick integrity checking, explicit application/schema identifiers, and rejection of unexpected schema objects. Backup/restore file paths come from native dialogs inside the Rust backend; frontend commands cannot supply arbitrary destination paths. Only the main window has these commands. Restore requires native confirmation and preserves the previous library as a separate safety snapshot. The GitHub footer likewise opens a fixed URL through the backend, rather than accepting a frontend-supplied URL.

Autoplay is now part of the database and backups. JSON source files are preserved during migration. Backups exclude source videos, FFmpeg binaries, and preview caches.

The GitHub link uses the same small cross-platform `open` library used by Tauri's opener plugin, but does not include unused file-manager/D-Bus integration or grant arbitrary URL/path opening to frontend code. The screenshot uses a separate demo library and real video playback; it does not expose the user library.

## Automated release controls

Release versions derive from a validated major/minor file and first-parent Git history; build inputs are pinned to the triggering SHA. Read-only jobs verify release state and detect previously published versions. Only the final publication job receives contents-write access. Public and private repositories are supported; releases follow repository visibility. All five installers and their checksums must be uploaded to a draft before publication. Conflicting tags/drafts fail rather than being overwritten; already-published assets are never replaced on reruns. Actions are pinned to commit SHAs and checkout does not persist credentials. Release automation tests cover version increments, merges, base changes, consistent manifest stamping, missing installers, public and private repositories, conflicting tags, upload failures, and idempotent publication.
