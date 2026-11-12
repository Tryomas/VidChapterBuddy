use axum::{body::Body, extract::{Path, State}, http::{Request, StatusCode}, response::{IntoResponse, Response}, routing::get, Router};
use std::{collections::HashMap, net::TcpListener, sync::{Arc, RwLock}};
use tauri::Manager;
use tower::ServiceExt;
use tower_http::services::ServeFile;

// WebKitGTK cannot reliably stream media through Tauri's custom asset scheme.
// Keep this server on loopback and serve only registered library IDs behind an
// unpredictable per-process token, never arbitrary filesystem paths.
#[derive(Clone)]
struct MediaFiles {
    token: String,
    files: Arc<RwLock<HashMap<String, String>>>,
}
pub struct MediaServer {
    base: String,
    files: MediaFiles,
}
fn router(files: MediaFiles) -> Router {
    Router::new().route("/{token}/videos/{id}", get(serve_video)).with_state(files)
}
async fn serve_video(State(state): State<MediaFiles>, Path((token, id)): Path<(String, String)>, request: Request<Body>) -> Response {
    if token != state.token { return StatusCode::NOT_FOUND.into_response(); }
    let path = match state.files.read() {
        Ok(files) => files.get(&id).cloned(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let Some(path) = path else { return StatusCode::NOT_FOUND.into_response(); };
    // ServeFile handles HEAD, byte ranges, bounded reads, and streaming backpressure.
    match ServeFile::new(path).oneshot(request).await {
        Ok(response) => response.into_response(),
        Err(error) => match error {},
    }
}
pub fn start(app: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let files = MediaFiles { token: uuid::Uuid::new_v4().to_string(), files: Arc::new(RwLock::new(HashMap::new())) };
    let routes = router(files.clone());
    app.manage(MediaServer { base: format!("http://127.0.0.1:{port}"), files });
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => { if let Err(error) = axum::serve(listener, routes).await { eprintln!("Media stream stopped: {error}"); } }
            Err(error) => eprintln!("Cannot start media stream: {error}"),
        }
    });
    Ok(())
}
#[tauri::command]
pub fn media_url(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let library = app.state::<crate::Library>();
    let doc = library.0.lock().map_err(|e| e.to_string())?;
    let video = doc.videos.iter().find(|video| video.path == path).ok_or("This video is not in the library.")?;
    if !std::path::Path::new(&video.path).is_file() { return Err("The video's source file is missing. Check its location.".into()); }
    let server = app.state::<MediaServer>();
    let served=crate::preview::cached(&app,&video.path).map(|p|p.to_string_lossy().into_owned()).unwrap_or_else(||video.path.clone());
    server.files.files.write().map_err(|e| e.to_string())?.insert(video.id.clone(), served);
    let mut url = tauri::Url::parse(&server.base).map_err(|e| e.to_string())?;
    url.path_segments_mut().map_err(|_| "Invalid media URL")?.push(&server.files.token).push("videos").push(&video.id);
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn streams_ranges_and_head_without_exposing_other_paths() {
        let path = std::env::temp_dir().join(format!("vidchapterbuddy-media-{}.mp4", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"0123456789abcdef").unwrap();
        let state = MediaFiles { token: "secret".into(), files: Arc::new(RwLock::new(HashMap::from([("video".into(), path.to_string_lossy().to_string())]))) };
        let app = router(state);
        let response = app.clone().oneshot(Request::builder().uri("/secret/videos/video").header("Range", "bytes=4-7").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-range"], "bytes 4-7/16");
        assert_eq!(response.headers()["content-type"], "video/mp4");
        assert_eq!(&to_bytes(response.into_body(), 32).await.unwrap()[..], b"4567");
        let head = app.clone().oneshot(Request::builder().method("HEAD").uri("/secret/videos/video").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()["content-length"], "16");
        assert!(to_bytes(head.into_body(), 32).await.unwrap().is_empty());
        for uri in ["/wrong/videos/video", "/secret/videos/missing", "/etc/passwd"] {
            let response = app.clone().oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
        let bad_range = app.oneshot(Request::builder().uri("/secret/videos/video").header("Range", "bytes=100-200").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(bad_range.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        std::fs::remove_file(path).unwrap();
    }
}
