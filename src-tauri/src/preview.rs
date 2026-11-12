use std::{fs, path::{Path, PathBuf}, time::{Duration, UNIX_EPOCH}};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
const PREVIEW_LIMIT: u64 = 4 * 1024 * 1024 * 1024;
const CACHE_LIMIT: u64 = 10 * 1024 * 1024 * 1024;
#[derive(Default)]
pub struct PreviewJobs { job: crate::process_job::JobSlot, preparation: std::sync::Mutex<()> }
struct Temp(PathBuf);
impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_file(&self.0); } }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct Progress { processed_seconds: f64 }
pub fn cache_path(app:&tauri::AppHandle,path:&str)->Result<PathBuf,String>{
 let meta=fs::metadata(path).map_err(|e|e.to_string())?;
 let modified=meta.modified().ok().and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|t|t.as_nanos()).unwrap_or(0);
 let canonical=fs::canonicalize(path).map_err(|e|e.to_string())?;
 let key=format!("preview-v1:{}:{}:{}",canonical.display(),meta.len(),modified);
 let dir=app.path().app_cache_dir().map_err(|e|e.to_string())?.join("previews");
 Ok(dir.join(format!("{:x}.mp4",Sha256::digest(key.as_bytes()))))
}
pub fn cached(app:&tauri::AppHandle,path:&str)->Option<PathBuf>{let p=cache_path(app,path).ok()?;fs::metadata(&p).ok().filter(|m|m.len()>0).map(|_|p)}

pub fn cancel(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<PreviewJobs>() { state.job.cancel(); }
}
#[tauri::command]
pub fn cancel_preview(app: tauri::AppHandle) { cancel(&app); }
fn conversion_command(ffmpeg: &Path, source: &str, output: &Path) -> std::process::Command {
    let mut command = crate::ffmpeg_setup::command(ffmpeg);
    command.args(["-nostdin", "-hide_banner", "-nostats", "-loglevel", "error", "-y", "-protocol_whitelist", "file", "-threads", "2", "-i", source,
        "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-filter_threads", "2", "-c:v", "libx264", "-threads:v", "2", "-threads:a", "2", "-preset", "fast", "-crf", "20",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-fs", &PREVIEW_LIMIT.to_string(), "-progress", "pipe:1"]);
    command.arg(output); command
}
// Reserve enough room for the largest new preview; remove only regenerable MP4 cache files.
fn reserve_cache(dir: &Path, budget: u64) -> Result<(), String> {
    let mut files = vec![]; let mut total = 0u64;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if meta.is_file() && entry.path().extension().and_then(|s| s.to_str()) == Some("mp4") {
            total = total.saturating_add(meta.len());
            files.push((meta.modified().unwrap_or(UNIX_EPOCH), entry.path(), meta.len()));
        }
    }
    files.sort_by_key(|f| f.0);
    for (_, path, size) in files {
        if total <= budget { break; }
        if fs::remove_file(path).is_ok() { total = total.saturating_sub(size); }
    }
    if total > budget { return Err("Preview cache is full. Close playback and try again to clear older previews.".into()); }
    Ok(())
}
#[tauri::command]
pub async fn prepare_video(app: tauri::AppHandle, path: String) -> Result<String, String> {
    { let state = app.state::<crate::Library>(); let doc = state.0.lock().map_err(|e| e.to_string())?;
      if !doc.videos.iter().any(|v| v.path == path) { return Err("This file is not in the library.".into()); } }
    tauri::async_runtime::spawn_blocking(move || {
        if cached(&app, &path).is_some() { return crate::media::media_url(app, path); }
        let state = app.state::<PreviewJobs>();
        let _preparation = state.preparation.try_lock().map_err(|_| "Another preview is being prepared. Wait or cancel it first.")?;
        let target = cache_path(&app, &path)?;
        let dir = target.parent().ok_or("Invalid preview cache")?;
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        reserve_cache(dir, CACHE_LIMIT - PREVIEW_LIMIT)?;
        let temp = Temp(dir.join(format!("{}.tmp.mp4", uuid::Uuid::new_v4())));
        let (ffmpeg, _, _) = crate::ffmpeg_setup::resolve(&app).ok_or("Set up FFmpeg to create this video preview.")?;
        let mut command = conversion_command(&ffmpeg, &path, &temp.0);
        let mut last = -1.0;
        state.job.run(&mut command, Duration::from_secs(6 * 3600), 16 * 1024 * 1024, 64 * 1024, |bytes| {
            let tail = &bytes[bytes.len().saturating_sub(8192)..];
            let text = String::from_utf8_lossy(tail);
            if let Some(seconds) = text.lines().rev().find_map(|line| line.strip_prefix("out_time_us=").and_then(|s| s.parse::<f64>().ok()).filter(|v| v.is_finite()).map(|n| n / 1_000_000.0)) {
                if seconds > last { last = seconds; let _ = app.emit_to("main", "preview-progress", Progress { processed_seconds: seconds }); }
            }
        })?;
        let size = fs::metadata(&temp.0).map_err(|e| e.to_string())?.len();
        // FFmpeg can report success after reaching -fs. Never publish a truncated preview.
        if size >= PREVIEW_LIMIT.saturating_sub(16 * 1024 * 1024) { return Err("This preview reached the 4 GiB limit. Use a smaller video or convert it outside the app.".into()); }
        if size == 0 { return Err("FFmpeg produced an empty preview.".into()); }
        fs::rename(&temp.0, &target).map_err(|e| e.to_string())?;
        crate::media::media_url(app.clone(), path)
    }).await.map_err(|e| e.to_string())?
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct MediaSource { url: String, prepared: bool }
#[tauri::command]
pub fn media_source(app: tauri::AppHandle, path: String) -> Result<MediaSource, String> {
    let prepared = cached(&app, &path).is_some();
    let url = crate::media::media_url(app, path)?;
    Ok(MediaSource { url, prepared })
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 #[ignore = "Uses an explicitly supplied FFmpeg executable for a real conversion smoke test"]
 fn converts_legacy_video_preview() {
  let ffmpeg=PathBuf::from(std::env::var_os("VIDCHAPTERBUDDY_TEST_FFMPEG").expect("set VIDCHAPTERBUDDY_TEST_FFMPEG"));
  let dir=std::env::temp_dir().join(format!("vidchapterbuddy-preview-test-{}",uuid::Uuid::new_v4()));fs::create_dir(&dir).unwrap();
  let source=dir.join("legacy.wmv");
  let status=crate::ffmpeg_setup::command(&ffmpeg).args(["-nostdin","-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=160x120:r=15","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","1","-c:v","wmv2","-c:a","wmav2"]).arg(&source).status().unwrap();assert!(status.success());
  let output=dir.join("compatible.mp4");
  assert!(conversion_command(&ffmpeg,source.to_str().unwrap(),&output).status().unwrap().success());
  assert!(fs::metadata(&output).unwrap().len()>0);
  assert!(crate::ffmpeg_setup::command(&ffmpeg).args(["-v","error","-i"]).arg(&output).args(["-f","null","-"]).status().unwrap().success());
  assert!(source.is_file());fs::remove_dir_all(dir).unwrap();
 }
 #[test]
 fn cache_quota_preserves_originals_and_ignores_symlinks() {
  let dir = std::env::temp_dir().join(format!("vidchapterbuddy-cache-test-{}", uuid::Uuid::new_v4()));
  fs::create_dir(&dir).unwrap();
  let original = dir.join("original.wmv"); fs::write(&original, [0; 100]).unwrap();
  for n in 0..3 { fs::write(dir.join(format!("{n}.mp4")), [0; 10]).unwrap(); }
  reserve_cache(&dir, 10).unwrap();
  let previews: Vec<_> = fs::read_dir(&dir).unwrap().flatten().filter(|e| e.path().extension().unwrap() == "mp4").collect();
  assert_eq!(previews.len(), 1);
  assert_eq!(fs::metadata(original).unwrap().len(), 100);
  #[cfg(unix)] {
   let outside = dir.with_extension("mp4"); fs::write(&outside, [0; 100]).unwrap();
   std::os::unix::fs::symlink(&outside, dir.join("link.mp4")).unwrap();
   reserve_cache(&dir, 0).unwrap();
   assert!(outside.exists()); fs::remove_file(outside).unwrap();
  }
  fs::remove_dir_all(dir).unwrap();
 }

}
