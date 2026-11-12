# Private releases and installers

The [Build and publish release](https://github.com/Tryomas/VidChapterBuddy/actions/workflows/build-installers.yml) workflow runs only for pushes to `main`. PRs and other branch pushes do not build releases. A merged PR creates a push to `main` and starts the workflow. GitHub's `[skip ci]` commit-message marker skips a push build; the initial setup commit uses it so the follow-up PR merge starts the first release.

## Versioning

`version.txt` contains only the major/minor base (`1.0`). The commit establishing the base is `1.0.0`; subsequent first-parent mainline commits increment the patch. The initial follow-up PR merge produces `1.0.1`, the next mainline commit produces `1.0.2`, and so on. Branch-internal commits do not each increment a merge release. Pushing several mainline commits together can skip patch numbers between published releases. Skipped or failed builds still count as commits.

Changing the file to a higher base such as `1.1` starts that series at `1.1.0`. Whitespace edits do not reset the counter. Reusing a lower/previous base is rejected. The full Git history must be available; CI checks out the triggering SHA with `fetch-depth: 0`.

The same SHA always produces the same version. CI updates package.json, package-lock.json, Cargo.toml, Cargo.lock, and tauri.conf.json only inside the build workspace. It never pushes automatic version-bump commits. Local source manifests retain the development base version until explicitly stamped with `node scripts/release-version.mjs --write`.

## Build and publication

The workflow builds Linux x64 (AppImage, DEB, RPM), Windows x64 (NSIS setup EXE), and macOS universal (DMG for Intel and Apple Silicon). It runs the frontend logic tests and Rust unit/security tests before packaging. The optional real-FFmpeg integration test remains opt-in. Linux packaging verifies AppRun, builds DEB/RPM first, and retries AppImage bundling with diagnostic output.

After all platform jobs succeed, the publishing job downloads artifacts from that exact workflow run, requires all five matching-version installers, and generates `SHA256SUMS.txt`. It creates a draft release tagged `v<version>` at the triggering commit, uploads every installer and the checksums, and only then publishes it with generated release notes. If a platform build fails, no release is published. An interrupted upload leaves a draft that can be resumed on a rerun.

Both version preparation and publication verify that the repository is private. Releases and installers remain accessible only to people with repository access. Only the publishing job has `contents: write`; build jobs have read access. A conflicting existing tag or draft is rejected. A published release is never overwritten: rerunning that commit skips its builds when the matching published release already exists. Concurrent runs for different commits are allowed; GitHub's semantic-version-based latest selection prevents a slower older release from becoming the latest.

Download installers from [Releases](https://github.com/Tryomas/VidChapterBuddy/releases). Workflow artifacts are also retained privately for 14 days. Release assets remain available until explicitly deleted and are independent of workflow-artifact expiration. Builds use the account's available GitHub Actions minutes.

The standalone **Build Linux installers** workflow remains a manual diagnostic/repair build. It does not create a release or automatically run on pushes. Its artifacts use the checked-in development version unless that source revision was explicitly stamped. Use the main release workflow for official versioned installers.

## Runtime and moving data

Windows builds are unsigned. macOS builds are ad-hoc signed and not notarized. Test playback and projection on destination systems; operating systems may require their normal approval to open these installers. Windows requires Microsoft WebView2; the installer downloads it if needed. Linux AppImage packaging bundles the media framework. DEB packages require GStreamer base/good/libav packages; RPM packages require base/good, with H.264/AAC codecs also available on the target distribution.

SQLite is compiled into the app. FFmpeg is optional for chapter-boundary suggestions and compatibility previews. On first use, the app reuses an existing installation or offers a verified download after approval. Compatible playback and manual chapter markers work without FFmpeg. AppImage subprocesses avoid inherited AppImage dynamic-library overrides when using system FFmpeg.

Copy video files separately. Use Backup and Restore to move library metadata and Autoplay; backups contain friendly names, folders, paths, and chapter markers, not media files or preview caches. Source videos must be available at their saved paths. The active database is `library.sqlite`; close the app before manually copying it, or use Backup for a consistent snapshot while running.

The app is MIT licensed; third-party components retain their respective notices. Big Buck Bunny appears only in the README screenshot, with attribution, and is not shipped in installers or the repository. Current application behavior has been checked locally on Linux. Windows/macOS runtime and monitor placement require testing on those operating systems.
