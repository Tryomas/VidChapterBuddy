use std::path::Path;
pub const VIDEO_EXTENSIONS: &[&str] = &["mp4","m4v","mov","mkv","webm","avi","wmv","mpg","mpeg","m2v","mts","m2ts","ts","vob","ogv","ogg","3gp","3g2","flv","f4v","asf","mxf","rm","rmvb","h264","h265","hevc","av1","nut"];
pub fn extension(path: &str) -> String { Path::new(path).extension().map(|s|s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default() }
pub fn supported(path: &str) -> bool { VIDEO_EXTENSIONS.contains(&extension(path).as_str()) }
#[cfg(test)] mod tests { use super::*; #[test] fn accepts_major_formats_case_insensitively(){for ext in VIDEO_EXTENSIONS{assert!(supported(&format!("video.{}",ext.to_uppercase())));}assert!(!supported("notes.txt"));assert!(!supported("archive.zip"));assert!(!supported("photo.HEIC"));assert!(!supported("photo.heif"));} }
