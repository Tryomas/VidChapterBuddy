use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
#[derive(serde::Serialize)]
#[serde(rename_all="camelCase")]
pub struct RestoreResult { document: crate::LibraryDocument, previous_backup: String }
#[tauri::command]
pub async fn backup_library(app: tauri::AppHandle) -> Result<Option<String>, String> {
 tauri::async_runtime::spawn_blocking(move || {
  let Some(file)=app.dialog().file().set_title("Back up library").add_filter("SQLite library",&["sqlite"]).set_file_name("VidChapterBuddy-backup.sqlite").blocking_save_file() else {return Ok(None);};
  let path=file.into_path().map_err(|e|e.to_string())?;
  let state=app.state::<crate::Library>();let _guard=state.0.lock().map_err(|e|e.to_string())?;
  crate::database::backup(&crate::data_directory(&app)?,&path)?;
  Ok(Some(path.to_string_lossy().into_owned()))
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn restore_library(app: tauri::AppHandle) -> Result<Option<RestoreResult>, String> {
 tauri::async_runtime::spawn_blocking(move || {
  let Some(file)=app.dialog().file().set_title("Restore library").add_filter("SQLite library",&["sqlite","db"]).blocking_pick_file() else {return Ok(None);};
  let path=file.into_path().map_err(|e|e.to_string())?;
  let mut document=crate::database::read_backup(&path)?;
  let chapters:usize=document.videos.iter().map(|v|v.chapters.len()).sum();
  let confirmed=app.dialog().message(format!("Replace the current library with {} videos, {} folders, and {} chapters? A safety backup of the current library will be saved first. Video files are not included in backups and must remain at their saved locations.",document.videos.len(),document.folders.len(),chapters))
   .title("Restore library?").kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancel).blocking_show();
  if !confirmed {return Ok(None);}
  for v in &mut document.videos {v.modified_at=crate::modified_time(&v.path).or(v.modified_at);}
  crate::validate(&app,&document)?;
  let state=app.state::<crate::Library>();let mut guard=state.0.lock().map_err(|e|e.to_string())?;
  let previous=crate::database::restore(&crate::data_directory(&app)?,&document)?;
  *guard=document.clone();
  Ok(Some(RestoreResult{document,previous_backup:previous.to_string_lossy().into_owned()}))
 }).await.map_err(|e|e.to_string())?
}
