import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { clampSeek, hasReachedChapterEnd, nextStopAfterSeek } from './playback';
import type { LoadPlayback, PlaybackCommand, PlaybackState } from './playback';
// This window owns playback while projecting: the controller's decoder is paused.
document.title = 'VidChapterBuddy \u2014 Projection';
document.head.insertAdjacentHTML('beforeend', `<style>
html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#000;cursor:none}
video{width:100%;height:100%;object-fit:contain;display:block}
#blank{position:fixed;inset:0;background:#000;z-index:10;pointer-events:none}#blank[hidden]{display:none}#message{position:absolute;bottom:24px;left:24px;right:24px;color:white;font:18px system-ui;text-align:center}
</style>`);
document.getElementById('app')!.innerHTML = '<video id="output" playsinline></video><div id="blank" hidden aria-hidden="true"></div><div id="message" role="status"></div>';
const video = document.getElementById('output') as HTMLVideoElement;
const windowHandle = getCurrentWindow();
let stopAt: number | undefined;
let stopAtEnd = false;
let pending: LoadPlayback | undefined;
let loaded = false;
let closing = false;
function state(): PlaybackState {
    return { time: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : 0,
        paused: video.paused, volume: video.volume, muted: video.muted, stopAt };
}
async function report() {
    if (loaded && !closing)
        await emitTo('main', 'projection-state', state());
}
async function fail(error: unknown) {
    video.pause();
    const message = `Projection playback failed: ${String(error)}`;
    document.getElementById('message')!.textContent = message;
    await emitTo('main', 'projection-error', message);
}
async function play() { try {
    await video.play();
}
catch (e) {
    await fail(e);
} }
async function close() {
    if (closing)
        return;
    // Capture before pausing, so returning to the app preserves play/pause state.
    const last = state();
    closing = true;
    video.pause();
    if (loaded)
        await emitTo('main', 'projection-return', last);
    await windowHandle.close();
}
video.onloadedmetadata = () => {
    const initial = pending;
    if (!initial)
        return;
    pending = undefined;
    loaded = true;
    video.currentTime = clampSeek(initial.time, video.duration);
    video.volume = initial.volume;
    video.muted = initial.muted;
    stopAt = nextStopAfterSeek(video.currentTime, initial.stopAt);
    if (!initial.paused)
        void play();
    void report();
};
video.ontimeupdate = () => {
    if (hasReachedChapterEnd(video.currentTime, stopAt)) {
        if (stopAtEnd) {
            video.pause();
            video.currentTime = Math.min(stopAt!, video.duration);
        }
        stopAt = undefined;
    }
    void report();
};
for (const event of ['play', 'pause', 'seeked', 'volumechange', 'ended'])
    video.addEventListener(event, () => void report());
video.onerror = () => void fail('Check that the video file exists and its audio/video codecs are supported.');
async function initialize() {
    await listen<PlaybackCommand>('projection-command', async ({ payload: command }) => {
        if (closing)
            return;
        if (command.type === 'load') {
            loaded = false;
            pending = command.state;
            document.getElementById('blank')!.hidden = !command.state.blanked;
            stopAtEnd = command.state.stopAtEnd;
            video.src = await invoke<string>('media_url', { path: command.state.path });
            video.load();
            return;
        }
        // Honor preference changes even while the video's metadata is still loading.
        if (command.type === 'blank') {
            document.getElementById('blank')!.hidden = !command.blanked;
            return;
        }
        if (command.type === 'set-stop-at-end') {
            stopAtEnd = command.enabled;
            await report();
            return;
        }
        if (!loaded)
            return;
        switch (command.type) {
            case 'toggle':
                if (video.paused)
                    await play();
                else
                    video.pause();
                break;
            case 'seek':
                video.currentTime = clampSeek(command.time, video.duration);
                stopAt = nextStopAfterSeek(video.currentTime, stopAt);
                break;
            case 'chapter':
                video.currentTime = clampSeek(command.start, video.duration);
                stopAt = command.end;
                stopAtEnd = command.stopAtEnd;
                if (command.autoplay) await play(); else video.pause();
                break;
            case 'volume':
                video.volume = Math.max(0, Math.min(1, command.volume));
                break;
            case 'mute':
                video.muted = command.muted;
                break;
        }
        await report();
    });
    await listen('projection-close', () => void close());
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            void close();
        }
        if (event.code === 'Space') {
            event.preventDefault();
            if (video.paused)
                void play();
            else
                video.pause();
        }
    });
    await windowHandle.onCloseRequested(event => {
        if (!closing) {
            event.preventDefault();
            void close();
        }
    });
    await emitTo('main', 'projection-ready');
}
void initialize().catch(fail);
