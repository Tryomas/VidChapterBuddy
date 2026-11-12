mod media;
mod database;
mod transfers;
mod legacy;
mod process_job;
mod analysis;
mod formats;
mod preview;
mod ffmpeg_setup;
use std::{collections::HashSet, fs, path::PathBuf, time::UNIX_EPOCH};
use tauri::{Manager, State};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize)]
struct Chapter { id: String, name: String, start: f64, end: f64 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Video {
 id: String, name: String, path: String, chapters: Vec<Chapter>,
 #[serde(default)] folder_id: Option<String>,
 #[serde(default)] added_at: u64,
 #[serde(default)] modified_at: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Folder {
 id: String, name: String,
 #[serde(default)] parent_id: Option<String>,
 #[serde(default)] created_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryDocument {
 version: u32,
 #[serde(default)] autoplay: bool,
 videos: Vec<Video>,
 #[serde(default)] folders: Vec<Folder>,
}
impl Default for LibraryDocument {
 fn default() -> Self { Self { version: 2, autoplay: false, videos: vec![], folders: vec![] } }
}
#[derive(Deserialize)]
#[serde(untagged)]
enum SavedLibrary { Document(LibraryDocument), Legacy(Vec<Video>) }
fn decode_library(bytes: &[u8]) -> Result<LibraryDocument, String> {
 let mut value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
 legacy::normalize(&mut value)?;
 match serde_json::from_value::<SavedLibrary>(value).map_err(|e| e.to_string())? {
  SavedLibrary::Document(doc) if doc.version == 2 => Ok(doc),
  SavedLibrary::Document(_) => Err("This library was saved by an unsupported app version.".into()),
  SavedLibrary::Legacy(videos) => Ok(LibraryDocument { videos, ..LibraryDocument::default() }),
 }
}
struct Library(Mutex<LibraryDocument>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoMetadata { path: String, modified_at: Option<u64> }
fn modified_time(path: &str) -> Option<u64> {
 fs::metadata(path).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|t| t.as_millis() as u64)
}
fn validate_structure(doc: &LibraryDocument) -> Result<(), String> {
 if doc.version != 2 { return Err("Unsupported library version.".into()); }
 let mut ids = HashSet::new();
 let mut folder_names = HashSet::new();
 for folder in &doc.folders {
  if folder.name.trim().is_empty() || !ids.insert(&folder.id) { return Err("Folders need names and unique IDs.".into()); }
  if !folder_names.insert((folder.parent_id.clone(), folder.name.trim().to_lowercase())) {return Err("A folder with that name already exists here.".into());}
 }
 let by_id: std::collections::HashMap<_,_> = doc.folders.iter().map(|f|(f.id.as_str(),f)).collect();
 let mut finished=HashSet::new();
 for folder in &doc.folders {
  let mut ancestors=HashSet::new(); let mut chain=vec![]; let mut parent=Some(folder.id.as_str());
  while let Some(id)=parent {
   if finished.contains(id) {break;}
   if !ancestors.insert(id) {return Err("Folders cannot contain themselves.".into());}
   let entry=by_id.get(id).ok_or("Parent folder not found.")?;
   chain.push(id);parent=entry.parent_id.as_deref();
  }
  finished.extend(chain);
 }

 let mut video_ids = HashSet::new();
 for video in &doc.videos {
  if !video_ids.insert(&video.id) {return Err("Duplicate video ID.".into());}
  if let Some(folder_id) = &video.folder_id {
   if !ids.contains(folder_id) {return Err("The video's folder no longer exists.".into());}
  }
 }
 Ok(())
}
fn data_directory(app: &tauri::AppHandle) -> Result<PathBuf,String> {
 app.path().app_data_dir().map_err(|e|e.to_string())
}
fn validate_metadata(doc: &LibraryDocument) -> Result<(),String> {
 if doc.folders.len()>4096 || doc.videos.len()>100_000 || doc.videos.iter().map(|v|v.chapters.len()).sum::<usize>()>100_000 {return Err("The library exceeds the supported record limit.".into());}
 for f in &doc.folders {if f.id.trim().is_empty() || f.id.len()>4096 || f.name.len()>4096 {return Err("A folder needs a valid ID and name.".into());}}
 validate_structure(doc)?;
 for v in &doc.videos {
  if !formats::supported(&v.path) || v.path.len()>32768 {return Err("This media format or path is not supported.".into());}
  if v.id.trim().is_empty() || v.id.len()>4096 || v.name.trim().is_empty() || v.name.len()>4096 {return Err("A video needs an ID and a friendly name.".into());}
  let mut ids=HashSet::new();
  for c in &v.chapters {if c.id.trim().is_empty() || c.id.len()>4096 || !ids.insert(&c.id) || c.name.trim().is_empty() || c.name.len()>4096 || !c.start.is_finite() || !c.end.is_finite() || c.start<0.0 || c.end<=c.start {return Err("Chapters need unique IDs, names, and valid time ranges.".into());}}
 }
 Ok(())
}
fn validate(app: &tauri::AppHandle, doc: &LibraryDocument) -> Result<(),String> {
 validate_metadata(doc)?;
 for v in &doc.videos {app.asset_protocol_scope().allow_file(&v.path).map_err(|e|e.to_string())?;}
 Ok(())
}
#[tauri::command]
fn load_library(app: tauri::AppHandle, state: State<Library>) -> Result<LibraryDocument,String> {
 let mut guard=state.0.lock().map_err(|e|e.to_string())?;
 let mut doc=database::load(&data_directory(&app)?)?;
 for video in &mut doc.videos { video.modified_at = modified_time(&video.path).or(video.modified_at); }
 validate(&app,&doc)?;
 *guard=doc.clone(); Ok(doc)
}
#[tauri::command]
fn save_library(app: tauri::AppHandle, state: State<Library>, document: LibraryDocument) -> Result<(),String> {
 validate(&app,&document)?;
 let mut guard=state.0.lock().map_err(|e|e.to_string())?;
 database::save(&data_directory(&app)?, &document)?;
 *guard=document; Ok(())
}
#[tauri::command]
fn inspect_videos(paths: Vec<String>) -> Result<Vec<VideoMetadata>,String> {
 paths.into_iter().map(|path| {
  if !formats::supported(&path) || !PathBuf::from(&path).is_file() {
   return Err(format!("Cannot add this media file: {path}"));
  }
  Ok(VideoMetadata { modified_at: modified_time(&path), path })
 }).collect()
}
#[tauri::command]
async fn open_repository() -> Result<(),String> {
 tauri::async_runtime::spawn_blocking(||open::that("https://github.com/Tryomas/VidChapterBuddy").map_err(|e|e.to_string())).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn open_support() -> Result<(),String> {
 tauri::async_runtime::spawn_blocking(||open::that("https://www.buymeacoffee.com/tryomas").map_err(|e|e.to_string())).await.map_err(|e|e.to_string())?
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
 tauri::Builder::default().plugin(tauri_plugin_dialog::init()).manage(Library(Mutex::new(LibraryDocument::default()))).manage(ffmpeg_setup::InstallLock(Mutex::new(()))).manage(preview::PreviewJobs::default()).manage(analysis::AnalysisJobs::default())
 .setup(|app| { media::start(app.handle().clone())?; Ok(()) })
 .on_window_event(|window,event|{if window.label()=="main" && matches!(event,tauri::WindowEvent::CloseRequested{..}){preview::cancel(window.app_handle());analysis::cancel(window.app_handle());}})
 .invoke_handler(tauri::generate_handler![load_library,save_library,open_repository,open_support,transfers::backup_library,transfers::restore_library,inspect_videos,analysis::detect_chapters,analysis::cancel_analysis,media::media_url,ffmpeg_setup::ffmpeg_status,ffmpeg_setup::install_ffmpeg,preview::media_source,preview::prepare_video,preview::cancel_preview])
 .run(tauri::generate_context!()).expect("error running VidChapterBuddy");
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn preserves_legacy_videos_and_chapter_markers() {
  let doc=decode_library(br#"[{"id":"v","name":"Sunday","path":"/chapters.mp4","chapters":[{"id":"s","name":"Grace","start":5,"end":40}]}]"#).unwrap();
  assert_eq!(doc.version,2); assert!(doc.folders.is_empty());
  assert_eq!(doc.videos[0].chapters[0].name,"Grace");
  assert_eq!(doc.videos[0].folder_id,None); assert_eq!(doc.videos[0].added_at,0);
 }
 #[test]
 fn folder_assignments_survive_round_trip() {
  let doc=decode_library(br#"{"version":2,"folders":[{"id":"f","name":"Sunday","parentId":null,"createdAt":123}],"videos":[{"id":"v","name":"Chapters","path":"/chapters.mp4","chapters":[],"folderId":"f","addedAt":456,"modifiedAt":789}]}"#).unwrap();
  validate_structure(&doc).unwrap();
  let restored=decode_library(&serde_json::to_vec(&doc).unwrap()).unwrap();
  assert_eq!(restored.videos[0].folder_id.as_deref(),Some("f"));
  assert_eq!(restored.videos[0].added_at,456);
 }
 #[test]
 fn rejects_folder_cycles_and_dangling_assignments() {
  let cycle=decode_library(br#"{"version":2,"folders":[{"id":"f","name":"Loop","parentId":"f"}],"videos":[]}"#).unwrap();
  assert!(validate_structure(&cycle).is_err());
  let missing=decode_library(br#"{"version":2,"folders":[],"videos":[{"id":"v","name":"Chapter","path":"/s.mp4","chapters":[],"folderId":"missing"}]}"#).unwrap();
  assert!(validate_structure(&missing).is_err());
 }
 #[cfg(target_os = "linux")]
 #[test]
 fn glib_string_iterator_security_regression() {
  use glib::prelude::*;
  let variant = ["zero", "one", "two", "three", "four", "five"].to_variant();
  let mut iter = variant.array_iter_str().unwrap();
  assert_eq!(iter.next(), Some("zero"));
  assert_eq!(iter.next_back(), Some("five"));
  assert_eq!(iter.nth(1), Some("two"));
  assert_eq!(iter.nth_back(0), Some("four"));
  assert_eq!(iter.last(), Some("three"));
  assert_eq!(variant.array_iter_str().unwrap().collect::<Vec<_>>(), vec!["zero", "one", "two", "three", "four", "five"]);
 }
 #[test]
 fn projection_cannot_invoke_privileged_commands() {
  use tauri::{ipc::Origin, utils::{acl::{manifest::Manifest, capability::Capability, resolved::Resolved}, platform::Target}};
  use std::collections::BTreeMap;
  let manifests: BTreeMap<String, Manifest> = serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/acl-manifests.json"))).unwrap();
  let capabilities: BTreeMap<String, Capability> = serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/capabilities.json"))).unwrap();
  let resolved = Resolved::resolve(&manifests, capabilities, Target::current()).unwrap();
  assert!(resolved.has_app_acl);
  let authority = tauri::runtime_authority!(manifests, resolved);
  for command in ["plugin:dialog|message", "load_library", "save_library", "backup_library", "restore_library", "open_repository", "open_support", "inspect_videos", "detect_chapters", "cancel_analysis", "ffmpeg_status", "install_ffmpeg", "media_source", "prepare_video", "cancel_preview"] {
   assert!(authority.resolve_access(command, "main", "main", &Origin::Local).is_some(), "main must retain {command}");
   assert!(authority.resolve_access(command, "projection", "projection", &Origin::Local).is_none(), "projection must deny {command}");
  }
  assert!(authority.resolve_access("media_url", "projection", "projection", &Origin::Local).is_some());
  assert!(authority.resolve_access("media_url", "unknown", "unknown", &Origin::Local).is_none());
  assert!(authority.resolve_access("save_library", "main", "main", &Origin::Remote {url: "https://example.com".parse().unwrap()}).is_none());
 }

}
