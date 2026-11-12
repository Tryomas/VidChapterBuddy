use std::time::Duration;
use tauri::Manager;
#[derive(Default)]
pub struct AnalysisJobs(pub crate::process_job::JobSlot);
pub fn cancel(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AnalysisJobs>() { state.0.cancel(); }
}
#[tauri::command]
pub fn cancel_analysis(app: tauri::AppHandle) { cancel(&app); }
#[tauri::command]
pub async fn detect_chapters(app: tauri::AppHandle, state: tauri::State<'_, crate::Library>, id: String, duration: f64) -> Result<Vec<(f64, f64)>, String> {
    if !duration.is_finite() || duration <= 0.0 || duration > 24.0 * 3600.0 { return Err("Chapter analysis supports videos up to 24 hours long.".into()); }
    let path = state.0.lock().map_err(|e| e.to_string())?.videos.iter().find(|v| v.id == id).map(|v| v.path.clone()).ok_or("Video not found")?;
    tauri::async_runtime::spawn_blocking(move || {
        let (executable, _, _) = crate::ffmpeg_setup::resolve(&app).ok_or("Set up FFmpeg for chapter suggestions, or add chapters manually.")?;
        let mut command = crate::ffmpeg_setup::command(executable);
        command.args(["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-protocol_whitelist", "file", "-threads", "2", "-i", &path,
            "-t", &duration.to_string(), "-vn", "-sn", "-dn", "-filter_threads", "2", "-af", "silencedetect=noise=-35dB:d=1.5", "-f", "null", "-"]);
        let state = app.state::<AnalysisJobs>();
        let (_, stderr) = state.0.run(&mut command, Duration::from_secs(2 * 3600), 4096, 4 * 1024 * 1024, |_| {})?;
        Ok(parse_ranges(&String::from_utf8_lossy(&stderr), duration))
    }).await.map_err(|e| e.to_string())?
}
fn parse_ranges(log: &str, duration: f64) -> Vec<(f64, f64)> {
    let mut cursor = 0.0; let mut ranges = vec![];
    for line in log.lines() {
        if let Some(v) = value(line, "silence_start: ", duration) {
            if v - cursor >= 15.0 { ranges.push((cursor, v)); }
        }
        if let Some(v) = value(line, "silence_end: ", duration) { cursor = v; }
    }
    if duration - cursor >= 15.0 { ranges.push((cursor, duration)); }
    ranges
}
fn value(line: &str, key: &str, duration: f64) -> Option<f64> {
    line.split(key).nth(1)?.split_whitespace().next()?.parse::<f64>().ok().filter(|v| v.is_finite()).map(|v| v.clamp(0.0, duration))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_ignore_invalid_numbers_and_stay_inside_video() {
        assert_eq!(parse_ranges("silence_start: NaN\nsilence_start: 30\nsilence_end: 35", 90.0), vec![(0.0,30.0),(35.0,90.0)]);
    }
}
