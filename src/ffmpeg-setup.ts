import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
type Status = {
    available: boolean;
    source?: string;
    version?: string;
    downloadBytes?: number;
};
let pending: Promise<boolean> | undefined;
export function ensureFfmpeg(reason: 'chapters' | 'preview' = 'chapters'): Promise<boolean> {
    if (pending)
        return pending;
    pending = setup(reason).finally(() => { pending = undefined; });
    return pending;
}
async function setup(reason: 'chapters' | 'preview'): Promise<boolean> {
    const info = await invoke<Status>('ffmpeg_status');
    if (info.available)
        return true;
    const dialog = document.createElement('dialog');
    dialog.className = 'ffmpeg-dialog';
    dialog.innerHTML = `<h2>${reason === 'preview' ? 'Set up compatible previews' : 'Set up chapter suggestions'}</h2><p>Chapter suggestions and compatibility previews use FFmpeg. We couldn\u2019t find a working copy on this computer.</p><p>Download it once for this app, without administrator access. Your videos stay on your computer. Playback of compatible videos and manual chapter markers work without it.</p><p class="hint">Download provided by imageio-ffmpeg on PyPI. License notices are saved with the tool.</p><progress hidden max="100" value="0" aria-label="FFmpeg download progress"></progress><p class="setup-status" role="status"></p><div class="dialog-actions"><button class="setup-cancel">Not now</button><button class="setup-download primary">Download FFmpeg</button></div>`;
    const download = dialog.querySelector('.setup-download') as HTMLButtonElement;
    const cancel = dialog.querySelector('.setup-cancel') as HTMLButtonElement;
    const message = dialog.querySelector('.setup-status') as HTMLElement;
    const progress = dialog.querySelector('progress') as HTMLProgressElement;
    const size = info.downloadBytes ? Math.ceil(info.downloadBytes / 1000000) : undefined;
    download.textContent = size ? `Download FFmpeg (${size} MB)` : 'Download unavailable';
    download.disabled = !size;
    if (!size)
        message.textContent = 'Automatic setup isn\u2019t available on this system. You can install FFmpeg separately or add markers manually.';
    let downloading = false;
    const unlisten = await listen<{
        downloaded: number;
        total: number;
    }>('ffmpeg-download-progress', ({ payload }) => {
        progress.hidden = false;
        progress.value = payload.total ? payload.downloaded / payload.total * 100 : 0;
        message.textContent = payload.downloaded >= payload.total ? 'Verifying and setting up FFmpeg\u2026' : `Downloading\u2026 ${Math.floor(progress.value)}%`;
    });
    document.body.append(dialog);
    return new Promise<boolean>(resolve => {
        dialog.oncancel = event => { if (downloading)
            event.preventDefault(); };
        dialog.onclose = () => { unlisten(); dialog.remove(); resolve(dialog.returnValue === 'ready'); };
        cancel.onclick = () => dialog.close('cancel');
        download.onclick = async () => {
            downloading = true;
            download.disabled = true;
            cancel.disabled = true;
            progress.hidden = false;
            message.textContent = 'Downloading FFmpeg\u2026';
            try {
                const installed = await invoke<Status>('install_ffmpeg');
                if (!installed.available)
                    throw Error('FFmpeg setup did not complete. Please retry.');
                dialog.close('ready');
            }
            catch (error) {
                message.textContent = String(error);
                downloading = false;
                download.disabled = false;
                cancel.disabled = false;
                download.textContent = 'Retry download';
                progress.hidden = true;
            }
        };
        dialog.showModal();
    });
}
