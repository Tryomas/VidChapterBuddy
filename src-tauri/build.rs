fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["load_library", "save_library", "backup_library", "restore_library", "open_repository", "inspect_videos", "detect_chapters", "cancel_analysis", "media_url", "ffmpeg_status", "install_ffmpeg", "media_source", "prepare_video", "cancel_preview"])
    )).expect("Tauri build failed");
}
