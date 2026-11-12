export type PlaybackState = {
    time: number;
    duration: number;
    paused: boolean;
    volume: number;
    muted: boolean;
    stopAt?: number;
};
export type LoadPlayback = PlaybackState & {
    path: string;
    stopAtEnd: boolean;
    blanked: boolean;
};
export type PlaybackCommand = {
    type: 'load';
    state: LoadPlayback;
} | {
    type: 'toggle';
} | {
    type: 'seek';
    time: number;
} | {
    type: 'chapter';
    autoplay: boolean;
    start: number;
    end: number;
    stopAtEnd: boolean;
} | {
    type: 'set-stop-at-end';
    enabled: boolean;
} | {
    type: 'blank';
    blanked: boolean;
} | {
    type: 'volume';
    volume: number;
} | {
    type: 'mute';
    muted: boolean;
};
export function clampSeek(time: number, duration: number): number {
    if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0)
        return 0;
    return Math.min(Math.max(time, 0), duration);
}
export function nextStopAfterSeek(time: number, stopAt?: number): number | undefined {
    return stopAt !== undefined && time < stopAt ? stopAt : undefined;
}
export function hasReachedChapterEnd(time: number, stopAt?: number): boolean {
    return stopAt !== undefined && time >= stopAt;
}
