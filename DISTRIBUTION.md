# Private installer builds

Both installer workflows use `workflow_dispatch` only: commits and pushes do not start them. No public release is created.

Run **Build installers** from the private repository's Actions tab. The workflow uploads private artifacts for Linux x64 (AppImage, DEB, RPM), Windows x64 (NSIS setup EXE), and macOS universal (DMG for Intel and Apple Silicon). It creates no release and does not publish the app. Artifacts are retained for 14 days. GitHub Actions uses the account's available runner minutes.

Builds are unsigned for Windows and ad-hoc signed, not notarized, for macOS. Test playback and projection on the destination systems. Windows requires Microsoft WebView2; the default installer downloads it if needed. The Linux AppImage bundles the media framework. DEB packages require GStreamer base/good/libav packages. RPM packages require GStreamer base/good; H.264/AAC codecs must also be available on the target distribution. FFmpeg is optional for chapter-boundary suggestions and compatibility previews. On first use, the app reuses an existing installation or offers a verified download after user approval. Manual tagging works without it.

Copy the installers and your video files separately to a flash drive. Library metadata is stored in `library.sqlite` per computer and references the original video paths. Use Backup and Restore to move library metadata and settings; copy video files separately and preserve their paths. Installing the app alone does not carry the library or videos to another computer.

System FFmpeg subprocesses run without AppImage dynamic-library overrides, so bundled media libraries do not conflict with the host FFmpeg installation.

For Linux-only packaging, use **Build Linux installers**. It verifies the downloaded AppRun tool, builds DEB/RPM packages first, and retries AppImage bundling with diagnostic output. All artifacts remain private to [Tryomas/VidChapterBuddy](https://github.com/Tryomas/VidChapterBuddy) and people with repository access.

SQLite is bundled into the executable. FFmpeg is downloaded separately only after first-use consent if no working installation is found. The app is MIT licensed; bundled and downloaded third-party components keep their respective licenses. Big Buck Bunny is shown only in the README screenshot and is not included in installers or the repository.

Current source has been checked locally on Linux. New Windows/macOS installers have not yet been built or runtime-tested for this version. The unsigned/ad-hoc-signed installers may require the operating system's normal approval to open.
