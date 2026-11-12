use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, process::Command, sync::Mutex, time::Duration};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

pub struct InstallLock(pub Mutex<()>);
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct FfmpegStatus { available: bool, source: Option<String>, version: Option<String>, download_bytes: Option<u64> }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase")]
struct Download { url: String, archive_sha256: String, binary_sha256: String, member: String, download_bytes: u64, version: String, upstream_url: String }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct Progress { downloaded: u64, total: u64 }
struct TempPath(PathBuf);
impl Drop for TempPath { fn drop(&mut self) { let _=fs::remove_file(&self.0); } }

pub fn command(path: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command=Command::new(path);
    #[cfg(target_os="windows")]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    #[cfg(target_os="linux")]
    if std::env::var_os("APPIMAGE").is_some() { command.env_remove("LD_LIBRARY_PATH").env_remove("LD_PRELOAD"); }
    command
}
fn download_spec() -> Option<Download> {
    let key=format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH);
    let specs: std::collections::HashMap<String, Download>=serde_json::from_str(include_str!("../ffmpeg-downloads.json")).ok()?;
    specs.get(&key).cloned()
}
fn managed_path(app: &tauri::AppHandle) -> Result<PathBuf,String> {
    let exe=if cfg!(windows) {"ffmpeg.exe"} else {"ffmpeg"};
    Ok(app.path().app_data_dir().map_err(|e|e.to_string())?.join("tools").join(exe))
}
fn probe(path: &Path) -> Option<String> {
    let (stdout, _)=crate::process_job::JobSlot::default().run(command(path).args(["-nostdin","-version"]),Duration::from_secs(5),64*1024,16*1024,|_|{}).ok()?;
    let version=String::from_utf8_lossy(&stdout).lines().next()?.to_owned();
    version.starts_with("ffmpeg version ").then_some(version)
}
pub fn resolve(app: &tauri::AppHandle) -> Option<(PathBuf,String,String)> {
    let mut candidates=vec![];
    if let Ok(path)=managed_path(app) { if path.is_file() { candidates.push((path,"App-managed download")); } }
    candidates.push((PathBuf::from("ffmpeg"),"Existing installation"));
    #[cfg(target_os="macos")]
    { candidates.push((PathBuf::from("/opt/homebrew/bin/ffmpeg"),"Existing installation")); candidates.push((PathBuf::from("/usr/local/bin/ffmpeg"),"Existing installation")); }
    for (path,source) in candidates { if let Some(version)=probe(&path) {return Some((path,source.into(),version));} }
    None
}
fn status(app: &tauri::AppHandle) -> FfmpegStatus {
    let found=resolve(app);
    FfmpegStatus {available:found.is_some(),source:found.as_ref().map(|x|x.1.clone()),version:found.map(|x|x.2),download_bytes:download_spec().map(|d|d.download_bytes)}
}
#[tauri::command]
pub async fn ffmpeg_status(app: tauri::AppHandle) -> Result<FfmpegStatus,String> {
    tauri::async_runtime::spawn_blocking(move || status(&app)).await.map_err(|e|e.to_string())
}
fn checked_hash(actual: &str, expected: &str) -> Result<(),String> {
    if actual==expected {Ok(())} else {Err("The FFmpeg download failed its integrity check. Please retry.".into())}
}
fn unpack_binary(archive: &Path, target: &Path, spec: &Download) -> Result<(),String> {
    let mut zip=zip::ZipArchive::new(fs::File::open(archive).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let mut member=zip.by_name(&spec.member).map_err(|e|format!("FFmpeg executable missing from download: {e}"))?;
    if member.size()>300*1024*1024 {return Err("Unexpected FFmpeg executable size.".into());}
    let mut out=fs::File::create(target).map_err(|e|e.to_string())?;
    let mut hash=Sha256::new(); let mut buffer=[0u8;65536];
    loop {let n=member.read(&mut buffer).map_err(|e|e.to_string())?;if n==0 {break;} hash.update(&buffer[..n]);out.write_all(&buffer[..n]).map_err(|e|e.to_string())?;}
    out.sync_all().map_err(|e|e.to_string())?;
    checked_hash(&format!("{:x}",hash.finalize()),&spec.binary_sha256)?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt;fs::set_permissions(target,fs::Permissions::from_mode(0o755)).map_err(|e|e.to_string())?; }
    Ok(())
}
#[tauri::command]
pub async fn install_ffmpeg(app: tauri::AppHandle) -> Result<FfmpegStatus,String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state=app.state::<InstallLock>();let _guard=state.0.lock().map_err(|e|e.to_string())?;
        if resolve(&app).is_some() {return Ok(status(&app));}
        let spec=download_spec().ok_or("An automatic FFmpeg download is not available for this system. Manual tagging still works.")?;
        let target=managed_path(&app)?;let dir=target.parent().ok_or("Invalid tool directory")?;
        fs::create_dir_all(dir).map_err(|e|e.to_string())?;
        let archive=TempPath(dir.join(format!("download-{}.zip",uuid::Uuid::new_v4())));
        let binary=TempPath(dir.join(if cfg!(windows){format!("ffmpeg-{}.exe",uuid::Uuid::new_v4())}else{format!("ffmpeg-{}",uuid::Uuid::new_v4())}));
        let client=reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(600)).build().map_err(|e|e.to_string())?;
        let mut response=client.get(&spec.url).send().and_then(|r|r.error_for_status()).map_err(|e|format!("Could not download FFmpeg. Check your connection and retry: {e}"))?;
        let mut out=fs::File::create(&archive.0).map_err(|e|e.to_string())?;
        let mut hash=Sha256::new();let mut downloaded=0;let mut reported=0;let mut buffer=[0u8;65536];
        let _=app.emit_to("main","ffmpeg-download-progress",Progress{downloaded:0,total:spec.download_bytes});
        loop {
            let n=response.read(&mut buffer).map_err(|e|e.to_string())?;if n==0 {break;}
            downloaded+=n as u64;if downloaded>spec.download_bytes {return Err("FFmpeg download was larger than expected.".into());}
            hash.update(&buffer[..n]);out.write_all(&buffer[..n]).map_err(|e|e.to_string())?;
            if downloaded-reported>=256*1024 {let _=app.emit_to("main","ffmpeg-download-progress",Progress{downloaded,total:spec.download_bytes});reported=downloaded;}
        }
        drop(out);
        if downloaded!=spec.download_bytes {return Err("The FFmpeg download was incomplete. Please retry.".into());}
        checked_hash(&format!("{:x}",hash.finalize()),&spec.archive_sha256)?;
        unpack_binary(&archive.0,&binary.0,&spec)?;
        if probe(&binary.0).is_none() {return Err("The downloaded FFmpeg could not run on this computer. Manual tagging still works.".into());}
        // License notices and provenance stay alongside the app-managed executable.
        fs::write(dir.join("COPYING.GPLv3"),include_str!("../licenses/COPYING.GPLv3")).map_err(|e|e.to_string())?;
        fs::write(dir.join("COPYING.LGPLv2.1"),include_str!("../licenses/COPYING.LGPLv2.1")).map_err(|e|e.to_string())?;
        fs::write(dir.join("FFMPEG-NOTICE.txt"),include_str!("../licenses/FFMPEG-NOTICE.txt")).map_err(|e|e.to_string())?;
        fs::write(dir.join("download-info.json"),serde_json::to_vec_pretty(&spec).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        fs::rename(&binary.0,&target).map_err(|e|e.to_string())?;
        let _=app.emit_to("main","ffmpeg-download-progress",Progress{downloaded,total:spec.download_bytes});
        Ok(status(&app))
    }).await.map_err(|e|e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_changed_download_content() {
        let good=format!("{:x}",Sha256::digest(b"verified tool"));
        assert!(checked_hash(&format!("{:x}",Sha256::digest(b"verified tool")),&good).is_ok());
        assert!(checked_hash(&format!("{:x}",Sha256::digest(b"different executable")),&good).is_err());
    }
    #[test] fn downloads_are_pinned_https_and_have_exact_members() {
        let specs:std::collections::HashMap<String,Download>=serde_json::from_str(include_str!("../ffmpeg-downloads.json")).unwrap();
        assert_eq!(specs.len(),4);
        for spec in specs.values() { assert!(spec.url.starts_with("https://files.pythonhosted.org/"));assert_eq!(spec.archive_sha256.len(),64);assert_eq!(spec.binary_sha256.len(),64);assert!(spec.member.starts_with("imageio_ffmpeg/binaries/ffmpeg-"));assert!(!spec.member.contains("..")); }
    }
    #[test] fn executable_checksum_is_checked_before_execution() {
        use zip::write::SimpleFileOptions;
        let dir=std::env::temp_dir().join(format!("vidchapterbuddy-ffmpeg-test-{}",uuid::Uuid::new_v4()));fs::create_dir(&dir).unwrap();
        let archive=dir.join("tool.zip");let output=dir.join("ffmpeg");
        let mut zip=zip::ZipWriter::new(fs::File::create(&archive).unwrap());zip.start_file("tool",SimpleFileOptions::default()).unwrap();zip.write_all(b"test binary").unwrap();zip.finish().unwrap();
        let mut spec=download_spec().unwrap();spec.member="tool".into();spec.binary_sha256=format!("{:x}",Sha256::digest(b"test binary"));
        unpack_binary(&archive,&output,&spec).unwrap();assert_eq!(fs::read(&output).unwrap(),b"test binary");
        spec.binary_sha256="0".repeat(64);assert!(unpack_binary(&archive,&output,&spec).is_err());fs::remove_dir_all(dir).unwrap();
    }
}
