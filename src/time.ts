export function parseTime(value: string): number {
    const parts = value.trim().split(':');
    if (parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p)))
        throw Error('Enter a time such as 3:45 or 1:02:30.');
    if (parts.slice(1).some(p => Number(p) >= 60))
        throw Error('Seconds and minutes after a colon must be below 60.');
    return parts.reduce((n, p) => n * 60 + Number(p), 0);
}
export function formatTime(n: number): string {
    n = Math.max(0, Math.floor(n));
    const s = String(n % 60).padStart(2, '0'), m = Math.floor(n / 60) % 60, h = Math.floor(n / 3600);
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
export function validateChapter(s: {
    name: string;
    start: number;
    end: number;
}, duration: number) {
    if (!s.name || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start)
        throw Error('Give the chapter a name and an end time after its start.');
    if (!Number.isFinite(duration) || s.end > duration + 0.1)
        throw Error('The chapter must fit within the loaded video.');
}
