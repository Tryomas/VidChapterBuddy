//! Bounded, cancellable subprocesses. No shell is involved.
use std::{io::Read, process::{Child, Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};

#[derive(Default)]
pub struct JobSlot(Mutex<Option<Arc<AtomicBool>>>);
impl JobSlot {
    pub fn cancel(&self) {
        if let Ok(slot) = self.0.lock() { if let Some(flag) = &*slot { flag.store(true, Ordering::SeqCst); } }
    }
    pub fn run(&self, command: &mut Command, timeout: Duration, stdout_limit: usize, stderr_limit: usize,
        mut progress: impl FnMut(&[u8])) -> Result<(Vec<u8>, Vec<u8>), String> {
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut slot = self.0.lock().map_err(|e| e.to_string())?;
            if slot.is_some() { return Err("Another operation is already running. Wait or cancel it first.".into()); }
            *slot = Some(flag.clone());
        }
        let _reservation = Reservation(self);
        let mut child = Running(command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().map_err(|e| format!("Could not start FFmpeg: {e}"))?);
        let stdout = Arc::new(Mutex::new(Capture::default()));
        let stderr = Arc::new(Mutex::new(Capture::default()));
        let out_thread = reader(child.0.stdout.take().unwrap(), stdout.clone(), stdout_limit);
        let err_thread = reader(child.0.stderr.take().unwrap(), stderr.clone(), stderr_limit);
        let started = Instant::now();
        let result = (|| loop {
            if flag.load(Ordering::SeqCst) { return Err("Operation canceled.".to_string()); }
            if started.elapsed() >= timeout { return Err("Processing exceeded its time limit. Try a shorter video or add chapters manually.".into()); }
            for capture in [&stdout, &stderr] {
                let data = capture.lock().map_err(|e| e.to_string())?;
                if data.exceeded { return Err("FFmpeg output exceeded the safety limit. Try another file.".into()); }
                if data.failed { return Err("Could not read FFmpeg output.".into()); }
            }
            if let Ok(data) = stdout.lock() { progress(&data.bytes); }
            if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? { break Ok(status); }
            thread::sleep(Duration::from_millis(100));
        })();
        if result.is_err() { let _ = child.0.kill(); }
        let _ = child.0.wait();
        let _ = out_thread.join(); let _ = err_thread.join();
        let status = result?;
        let out = stdout.lock().map_err(|e| e.to_string())?;
        let err = stderr.lock().map_err(|e| e.to_string())?;
        if out.exceeded || err.exceeded { return Err("FFmpeg output exceeded the safety limit. Try another file.".into()); }
        if out.failed || err.failed { return Err("Could not read FFmpeg output.".into()); }
        if !status.success() {
            let text = String::from_utf8_lossy(&err.bytes);
            let detail = text.lines().rev().find(|s| !s.trim().is_empty()).unwrap_or("Unsupported or damaged media.");
            return Err(format!("FFmpeg failed: {}", detail.chars().take(500).collect::<String>()));
        }
        Ok((out.bytes.clone(), err.bytes.clone()))
    }
}
struct Reservation<'a>(&'a JobSlot);
impl Drop for Reservation<'_> { fn drop(&mut self) { if let Ok(mut slot) = self.0.0.lock() { *slot = None; } } }
struct Running(Child);
impl Drop for Running { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
#[derive(Default)]
struct Capture { bytes: Vec<u8>, exceeded: bool, failed: bool }
fn reader(mut stream: impl Read + Send + 'static, data: Arc<Mutex<Capture>>, limit: usize) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let Ok(mut capture) = data.lock() else { break; };
                    if capture.bytes.len().saturating_add(n) > limit { capture.exceeded = true; }
                    let keep = n.min(limit.saturating_sub(capture.bytes.len()));
                    capture.bytes.extend_from_slice(&buffer[..keep]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => { if let Ok(mut capture) = data.lock() { capture.failed = true; } break; }
            }
        }
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn kills_noisy_process_and_releases_slot() {
        let slot = JobSlot::default();
        let error = slot.run(Command::new("/bin/sh").args(["-c", "while :; do printf 'too much output\\n' >&2; done"]), Duration::from_secs(3), 1024, 1024, |_| {}).unwrap_err();
        assert!(error.contains("output exceeded"));
        assert!(slot.run(Command::new("/bin/sh").args(["-c", "printf ok"]), Duration::from_secs(2), 1024, 1024, |_| {}).is_ok());
    }
    #[test]
    fn times_out_and_cancels_running_processes() {
        let slot = Arc::new(JobSlot::default());
        let error = slot.run(Command::new("/bin/sh").args(["-c", "exec sleep 10"]), Duration::from_millis(150), 1024, 1024, |_| {}).unwrap_err();
        assert!(error.contains("time limit"));
        let other = slot.clone();
        let task = thread::spawn(move || other.run(Command::new("/bin/sh").args(["-c", "exec sleep 10"]), Duration::from_secs(3), 1024, 1024, |_| {}));
        while slot.0.lock().unwrap().is_none() { thread::yield_now(); }
        assert!(slot.run(&mut Command::new("/bin/true"), Duration::from_secs(1), 1024, 1024, |_| {}).is_err());
        slot.cancel();
        assert!(task.join().unwrap().unwrap_err().contains("canceled"));
    }
}
