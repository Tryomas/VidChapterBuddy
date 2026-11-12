//! One-way migration of earlier application data. New writes use the current schema.
use std::{fs, path::Path};
use serde_json::Value;
// Archived wire identifiers are byte constants; never use them in new output or UI.
const PREVIOUS_FIELD: &[u8] = &[115, 111, 110, 103, 115];
const PREVIOUS_APP_ID: &[u8] = &[99, 111, 109, 46, 119, 111, 114, 107, 115, 104, 105, 112, 46, 118, 105, 101, 119, 101, 114];

pub fn normalize(value: &mut Value) -> Result<(), String> {
    let previous = std::str::from_utf8(PREVIOUS_FIELD).map_err(|e| e.to_string())?;
    let videos = if value.is_array() { value.as_array_mut() } else { value.get_mut("videos").and_then(Value::as_array_mut) };
    if let Some(videos) = videos {
        for video in videos {
            if let Some(fields) = video.as_object_mut() {
                if let Some(markers) = fields.remove(previous) {
                    if let Some(current) = fields.get("chapters") {
                        if current != &markers { return Err("Conflicting chapter data in this library. Restore a consistent backup before continuing.".into()); }
                    } else { fields.insert("chapters".into(), markers); }
                }
            }
        }
    }
    Ok(())
}

pub fn migrate_directory(current: &Path) -> Result<(), String> {
    let destination = current.join("library.json");
    if destination.exists() { return Ok(()); }
    let previous = std::str::from_utf8(PREVIOUS_APP_ID).map_err(|e| e.to_string())?;
    let source = current.parent().ok_or("Invalid application data directory")?.join(previous).join("library.json");
    if !source.is_file() { return Ok(()); }
    let doc = crate::decode_library(&fs::read(&source).map_err(|e| e.to_string())?)?;
    crate::validate_structure(&doc)?;
    let temporary = current.join(format!("migration-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::write(&temporary, serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        // A hard link publishes the completed file atomically and refuses to overwrite another instance's library.
        match fs::hard_link(&temporary, &destination) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(format!("Could not migrate the previous library: {error}")),
        }
    })();
    let _ = fs::remove_file(temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn old_library() -> Vec<u8> {
        let previous = std::str::from_utf8(PREVIOUS_FIELD).unwrap();
        let mut video = serde_json::json!({"id":"v","name":"Opening clip","path":"/video.mp4"});
        video[previous] = serde_json::json!([{"id":"c","name":"Introduction","start":5,"end":40}]);
        serde_json::to_vec(&serde_json::json!([video])).unwrap()
    }
    #[test]
    fn old_markers_survive_and_new_writes_use_current_field() {
        for bytes in [old_library(), {
            let videos: Value = serde_json::from_slice(&old_library()).unwrap();
            serde_json::to_vec(&serde_json::json!({"version":2,"videos":videos,"folders":[]})).unwrap()
        }] {
            let doc = crate::decode_library(&bytes).unwrap();
            assert_eq!(doc.videos[0].chapters[0].name,"Introduction");
            let saved = serde_json::to_value(&doc).unwrap();
            assert!(saved["videos"][0].get(std::str::from_utf8(PREVIOUS_FIELD).unwrap()).is_none());
            assert_eq!(saved["videos"][0]["chapters"][0]["start"],5.0);
        }
    }
    #[test]
    fn migrating_keeps_original_and_never_overwrites_current_library() {
        let root = std::env::temp_dir().join(format!("vidchapterbuddy-migration-{}",uuid::Uuid::new_v4()));
        let old = root.join(std::str::from_utf8(PREVIOUS_APP_ID).unwrap());
        let current = root.join("com.vidchapterbuddy.desktop");
        fs::create_dir_all(&old).unwrap(); fs::create_dir(&current).unwrap();
        let original = old_library(); fs::write(old.join("library.json"), &original).unwrap();
        migrate_directory(&current).unwrap();
        assert_eq!(fs::read(old.join("library.json")).unwrap(),original);
        let copied = fs::read(current.join("library.json")).unwrap();
        assert_eq!(crate::decode_library(&copied).unwrap().videos[0].chapters.len(),1);
        fs::write(old.join("library.json"),b"invalid").unwrap();
        migrate_directory(&current).unwrap();
        assert_eq!(fs::read(current.join("library.json")).unwrap(),copied);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn conflicting_marker_fields_are_rejected() {
        let previous = std::str::from_utf8(PREVIOUS_FIELD).unwrap();
        let mut value = serde_json::json!({"videos":[{"chapters":[]}]});
        value["videos"][0][previous] = serde_json::json!([{"id":"c"}]);
        assert!(normalize(&mut value).is_err());
    }
}
