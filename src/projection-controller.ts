import { emitTo, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, getCurrentWindow } from '@tauri-apps/api/window';
import type { Monitor } from '@tauri-apps/api/window';
import type { LoadPlayback, PlaybackCommand, PlaybackState } from './playback';
import { formatTime } from './time';
type Hooks = {
    status: (message: string) => void;
    current: () => {
        path: string;
    } | undefined;
    getStop: () => number | undefined;
    stopAtChapterEnd: () => boolean;
    isBlanked: () => boolean;
    setStop: (value: number | undefined) => void;
};
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const key = (m: Monitor) => `${m.name}:${m.position.x}:${m.position.y}:${m.size.width}:${m.size.height}`;
export function setupProjection(player: HTMLVideoElement, hooks: Hooks) {
    let monitors: Monitor[] = [];
    let output: WebviewWindow | undefined;
    let snapshot: PlaybackState | undefined;
    let initial: LoadPlayback | undefined;
    let target: Monitor | undefined;
    let starting = false;
    let ready = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolveStopped: (() => void) | undefined;
    let stopping: Promise<void> | undefined;
    const screen = $<HTMLSelectElement>('display');
    const seek = $<HTMLInputElement>('remote-seek');
    function refreshButtons() {
        $<HTMLButtonElement>('project').disabled = !hooks.current() || !monitors.length || !!output || starting;
        screen.disabled = !!output || starting;
        $<HTMLButtonElement>('refresh-displays').disabled = !!output || starting;
        $('return').hidden = !output;
    }
    function updateTransport() {
        if (!snapshot)
            return;
        $('remote-toggle').textContent = snapshot.paused ? 'Play' : 'Pause';
        $('playback-toggle').textContent = snapshot.paused ? 'Play' : 'Pause';
        seek.max = String(snapshot.duration);
        if (!seek.matches(':active'))
            seek.value = String(snapshot.time);
        $('remote-time').textContent = `${formatTime(snapshot.time)} / ${formatTime(snapshot.duration)}`;
        $<HTMLInputElement>('remote-volume').value = String(snapshot.volume);
        $('remote-mute').textContent = snapshot.muted ? 'Unmute' : 'Mute';
    }
    async function send(command: PlaybackCommand) {
        if (!output || !ready)
            throw Error('The projection is still loading.');
        await emitTo(output.label, 'projection-command', command);
    }
    async function restore() {
        if (!output)
            return;
        clearTimeout(timeout);
        output = undefined;
        ready = false;
        starting = false;
        target = undefined;
        $('remote-controls').hidden = true;
        $('projection-notice').hidden = true;
        player.hidden = false;
        const last = snapshot;
        snapshot = undefined;
        initial = undefined;
        if (last) {
            player.currentTime = last.time;
            player.volume = last.volume;
            player.muted = last.muted;
            hooks.setStop(last.stopAt);
            if (!last.paused) {
                try {
                    await player.play();
                }
                catch (e) {
                    hooks.status(`Returned to app. Press Play to resume: ${String(e)}`);
                }
            }
        }
        refreshButtons();
        resolveStopped?.();
        resolveStopped = undefined;
        stopping = undefined;
    }
    async function stop() {
        if (!output)
            return;
        if (stopping)
            return stopping;
        const current = output;
        stopping = new Promise<void>(resolve => { resolveStopped = resolve; });
        const completion = stopping;
        try {
            // The projection sends its latest position before closing itself.
            await emitTo(current.label, 'projection-close');
            setTimeout(() => {
                if (output === current)
                    void current.close().catch(e => hooks.status(`Unable to close projection: ${String(e)}`));
            }, 1500);
        }
        catch (e) {
            stopping = undefined;
            throw e;
        }
        return completion;
    }
    async function refreshDisplays() {
        const previous = screen.value;
        monitors = await availableMonitors();
        screen.replaceChildren();
        monitors.forEach((monitor, index) => {
            const option = document.createElement('option');
            option.value = key(monitor);
            option.textContent = `${index + 1}. ${monitor.name || 'Display'} \u2014 ${monitor.size.width} \u00D7 ${monitor.size.height}`;
            screen.append(option);
        });
        if (monitors.some(m => key(m) === previous))
            screen.value = previous;
        if (!monitors.length) {
            const option = document.createElement('option');
            option.textContent = 'No screens detected';
            screen.append(option);
            hooks.status('No screens detected. Connect a display and refresh.');
        }
        refreshButtons();
    }
    async function start() {
        const video = hooks.current();
        if (!video || output || starting)
            return;
        if (!Number.isFinite(player.duration))
            throw Error('Wait for the selected video to load before projecting.');
        // Recheck monitor identity immediately before creating the output window.
        const chosen = screen.value;
        const fresh = await availableMonitors();
        target = fresh.find(m => key(m) === chosen);
        if (!target) {
            await refreshDisplays();
            throw Error('That screen is no longer available. Select a connected screen.');
        }
        initial = { path: video.path, time: player.currentTime, duration: player.duration, paused: player.paused,
            volume: player.volume, muted: player.muted, stopAt: hooks.getStop(), stopAtEnd: hooks.stopAtChapterEnd(), blanked: hooks.isBlanked() };
        snapshot = initial;
        player.pause();
        hooks.setStop(undefined);
        starting = true;
        ready = false;
        // It stays hidden until the projection listener is ready and fullscreen is set.
        const win = new WebviewWindow('projection', { url: 'index.html?projection', title: 'VidChapterBuddy \u2014 Projection',
            visible: false, decorations: false, backgroundColor: '#000000', width: 960, height: 540 });
        output = win;
        refreshButtons();
        hooks.status('Opening projection on the selected screen\u2026');
        await win.once('tauri://error', event => {
            hooks.status(`Unable to open projection: ${String(event.payload)}`);
            void restore();
        });
        await win.once('tauri://destroyed', () => {
            hooks.status('Playback returned to the app.');
            void restore();
        });
        timeout = setTimeout(() => {
            if (output === win && !ready) {
                hooks.status('Projection did not start. Returning playback to the app.');
                void win.close().catch(() => restore());
            }
        }, 15000);
    }
    async function safely(action: () => Promise<void>) {
        try {
            await action();
        }
        catch (e) {
            hooks.status(String(e));
        }
    }
    const initialized = (async () => {
        await listen('projection-ready', () => void safely(async () => {
            if (!output || !target || !initial)
                return;
            try {
                await output.setFullscreenOnMonitor(target.position);
                await output.show();
                ready = true;
                starting = false;
                clearTimeout(timeout);
                player.hidden = true;
                $('remote-controls').hidden = false;
                $('projection-notice').hidden = false;
                updateTransport();
                await send({ type: 'load', state: { ...initial, stopAtEnd: hooks.stopAtChapterEnd(), blanked: hooks.isBlanked() } });
                hooks.status(`Projecting on ${target.name || 'selected display'}.`);
                refreshButtons();
            }
            catch (e) {
                await output?.close();
                throw Error(`Could not project on that screen: ${String(e)}`);
            }
        }));
        await listen<PlaybackState>('projection-state', event => {
            if (!output || !ready)
                return;
            snapshot = event.payload;
            updateTransport();
        });
        await listen<PlaybackState>('projection-return', event => { if (output)
            snapshot = event.payload; });
        await listen<string>('projection-error', event => hooks.status(event.payload));
        await getCurrentWindow().onCloseRequested(async () => { await output?.close(); });
        await refreshDisplays();
    })();
    void initialized.catch(e => hooks.status(`Display setup failed: ${String(e)}`));
    $('project').onclick = () => void safely(async () => { await initialized; await start(); });
    $('return').onclick = () => void safely(stop);
    $('refresh-displays').onclick = () => void safely(refreshDisplays);
    $('remote-toggle').onclick = () => void safely(() => send({ type: 'toggle' }));
    seek.onchange = () => void safely(() => send({ type: 'seek', time: Number(seek.value) }));
    $<HTMLInputElement>('remote-volume').oninput = event => void safely(() => send({ type: 'volume', volume: Number((event.target as HTMLInputElement).value) }));
    $('remote-mute').onclick = () => void safely(() => send({ type: 'mute', muted: !snapshot?.muted }));
    document.addEventListener('keydown', event => {
        if (output && event.key === 'Escape') {
            event.preventDefault();
            void safely(stop);
        }
    });
    // Hot-unplugging a projector must not leave playback running on a lost output.
    let checking = false;
    setInterval(() => {
        if (!output || !target || checking)
            return;
        checking = true;
        void availableMonitors().then(async (connected) => {
            if (target && !connected.some(m => key(m) === key(target!))) {
                await stop();
                hooks.status('Projection screen disconnected. Playback returned to the app.');
                await refreshDisplays();
            }
        }).catch(e => hooks.status(`Unable to check projection screen: ${String(e)}`)).finally(() => { checking = false; });
    }, 2000);
    return { active: () => !!output, time: () => snapshot?.time ?? player.currentTime,
        playChapter: (start: number, end: number, autoplay = true) => send({ type: 'chapter', start, end, autoplay, stopAtEnd: hooks.stopAtChapterEnd() }),
        togglePlayback: () => send({ type: 'toggle' }),
        setBlanked: async (blanked: boolean) => { if (output && ready)
            await send({ type: 'blank', blanked }); },
        setStopAtChapterEnd: async (enabled: boolean) => { if (output && ready)
            await send({ type: 'set-stop-at-end', enabled }); }, stop, refreshButtons };
}
