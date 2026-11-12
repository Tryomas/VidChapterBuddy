import appIcon from './assets/vidchapterbuddy.svg?no-inline';
import { videoExtensions, mediaExtension, needsPreview } from './formats';
import { createPreview } from './preview';
import type { MediaSource } from './preview';
import './styles.css';
import { ensureFfmpeg } from './ffmpeg-setup';
import { invoke } from '@tauri-apps/api/core';
import { open, ask } from '@tauri-apps/plugin-dialog';
import { setupProjection } from './projection-controller';
import { parseTime, formatTime, validateChapter } from './time';
import { filename, matchingChapters, sortVideos, visibleVideos, folderTrail, removeFolder } from './library';
import type { Video, Chapter, LibraryDocument, SortField } from './library';
let document: LibraryDocument = { version: 2, videos: [], folders: [] };
let selected: string | undefined, editing: string | undefined, stopAt: number | undefined;
let busy = false, saving = false, switching = false;
let folderId: string | null | undefined = null;
let blanked = false;
let transferring = false;
let activeTab: 'library' | 'playing' = 'library';
const $ = <T extends HTMLElement>(id: string) => window.document.getElementById(id) as T;
window.document.querySelector('#app')!.innerHTML = `
<div class="app-shell">
<nav class="topbar"><div class="brand"><img src="${appIcon}" alt="" width="36" height="36"><div>VidChapterBuddy</div></div>
<div class="tabs" role="tablist" aria-label="App views"><button id="tab-library" role="tab" aria-controls="library-view" aria-selected="true">\u25A6 Library</button><button id="tab-playing" role="tab" aria-controls="playing-view" aria-selected="false">\u25B7 Now Playing</button></div>
<div class="nav-actions"><button id="cancel-analysis" hidden>Cancel analysis</button><button id="cancel-preview" hidden>Cancel preview</button><button id="playback-toggle" disabled>Play</button><button id="blank-screen" aria-pressed="false" disabled>Blank screen</button><span id="count">0 videos</span><button id="add" class="primary">\uFF0B Add videos</button></div></nav>
<main>
<div id="status" role="status">Ready to add your first video.</div>
<div id="library-view" role="tabpanel" aria-labelledby="tab-library">
<header><div><div class="eyebrow">YOUR COLLECTION</div><h1>Video library</h1><p>Keep your videos organized. Find a chapter and go straight to it.</p></div><div class="header-actions"><button id="backup-library">Backup</button><button id="restore-library">Restore</button><button id="new-folder">\uFF0B New folder</button></div></header>
<div class="library-toolbar"><input id="search" type="search" placeholder="Search all videos, filenames, and chapters\u2026" aria-label="Search all videos and chapters"><label>Sort by <select id="sort"><option value="friendly">Friendly name</option><option value="filename">Filename</option><option value="added">Date added</option><option value="modified">File modified date</option></select></label><select id="sort-direction" aria-label="Sort direction"><option value="asc">Ascending</option><option value="desc">Descending</option></select></div>
<label class="autoplay-option"><input id="autoplay" type="checkbox"> Autoplay videos selected from the library</label>
<div class="browse-bar"><nav id="breadcrumbs" aria-label="Library folder"></nav><button id="all-videos">Show all videos</button><span id="result-count"></span></div>
<div id="folders" class="folder-grid"></div><div id="library" class="video-grid"></div><div id="library-empty" class="library-empty" hidden></div>
<p class="library-footnote">Folders organize your library. Original video files stay in their current locations.</p>
</div>
<div id="playing-view" role="tabpanel" aria-labelledby="tab-playing" hidden>
<header><div><div class="eyebrow">NOW PLAYING</div><h1 id="title">Choose a video to play</h1><p id="subtitle">Open your library and select a video or a chapter.</p></div><div class="header-actions"><button id="back-library">Browse library</button><button id="rename" disabled>Rename video</button></div></header>
<div class="screen"><video id="player" controls preload="metadata"></video><div id="local-blank" class="blank-cover" hidden aria-hidden="true"></div><div id="empty"><div>\u25B7</div><h2>Your next chapter is waiting</h2><p>Select a video from the Library tab.</p></div></div>
<div class="output-bar"><label for="display">Playback output</label><select id="display" aria-label="Projection screen"><option value="">Loading screens\u2026</option></select><button id="refresh-displays">Refresh screens</button><button id="project" class="primary" disabled>Project fullscreen</button><button id="return" hidden>Play within app</button></div>
<div id="remote-controls" hidden><button id="remote-toggle">Play</button><input id="remote-seek" type="range" min="0" max="100" step="0.1" value="0" aria-label="Playback position"><span id="remote-time">0:00 / 0:00</span><label>Volume <input id="remote-volume" type="range" min="0" max="1" step="0.01" value="1"></label><button id="remote-mute">Mute</button></div><div id="projection-notice" hidden>Projecting video. Control playback here or choose a chapter. Escape returns playback to the app.</div>
<section><div class="section-heading"><div><div class="eyebrow">CHAPTERS</div><h2>Jump straight to the chapter</h2></div><button id="detect" disabled>\u2727 Suggest chapter boundaries</button></div><p class="hint">Suggestions use quiet gaps, not chapter recognition. Review each range and give it a name. (not useful for movies)</p>
<label class="chapter-end-option"><input id="stop-at-chapter-end" type="checkbox"> Stop at chapter end <span>Off by default \u2014 leave off to keep the video playing.</span></label>
<input id="chapter-search" type="search" placeholder="Search chapters in this video\u2026" aria-label="Search chapters in current video">
<div id="chapters"></div><form id="editor"><input id="chapter-name" placeholder="Chapter name" aria-label="Chapter name" required><div class="time-field"><input id="start" placeholder="0:00" aria-label="Start time" required><button type="button" id="mark-start">Use current time</button></div><span>\u2192</span><div class="time-field"><input id="end" placeholder="3:45" aria-label="End time" required><button type="button" id="mark-end">Use current time</button></div><button class="primary" id="save-chapter" disabled>Add chapter</button><button type="button" id="cancel" hidden>Cancel</button></form><p class="hint">Times: m:ss or h:mm:ss. Click a chapter to jump to its start. Playback continues unless Stop at chapter end is enabled.</p></section><button id="remove" class="danger" disabled>Remove video from library</button>
</div>
<footer class="app-footer"><a id="github-link" href="https://github.com/Tryomas/VidChapterBuddy" title="View the private repository on GitHub"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.4-1.22.72-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15a10.8 10.8 0 0 1 5.64 0c2.14-1.45 3.09-1.15 3.09-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.28-5.14 5.56.4.35.76 1.03.76 2.08v3.09c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z"/></svg>GitHub</a><a id="coffee-link" class="coffee-link" href="https://www.buymeacoffee.com/tyromas" title="Support VidChapterBuddy on Buy Me a Coffee"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h12v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z"/><path d="M16 9h2a3 3 0 1 1 0 6h-2M3 23h16M7 3v2m4-3v3m4-2v2"/></svg>Buy me a coffee</a><span>MIT license · © 2026 Tryomas</span><span>Backups contain library data, not video files.</span></footer>
</main>
<dialog id="remove-dialog" aria-labelledby="remove-title" aria-describedby="remove-details"><h2 id="remove-title">Remove video?</h2><p id="remove-description"></p><p id="remove-details">Its chapter markers will also be removed from the library. The original video file will stay on your computer.</p><div class="dialog-actions"><button id="remove-cancel" autofocus>Cancel</button><button id="remove-confirm" class="destructive">Remove from library</button></div></dialog>
<dialog id="name-dialog"><form id="name-form"><h2 id="dialog-title"></h2><input id="dialog-name" aria-label="Name" required maxlength="200"><div class="dialog-actions"><button type="button" id="dialog-cancel">Cancel</button><button class="primary">Save</button></div></form></dialog>
</div>`;
const autoplay = $<HTMLInputElement>('autoplay');
autoplay.onchange = () => void guard(async () => {
    try { await persist({ ...document, autoplay: autoplay.checked }); }
    finally { autoplay.checked = document.autoplay ?? false; }
});
const player = $<HTMLVideoElement>('player');
const projection = setupProjection(player, { status, current, getStop: () => stopAt, isBlanked: () => blanked, stopAtChapterEnd: () => $<HTMLInputElement>('stop-at-chapter-end').checked, setStop: value => { stopAt = value; } });
function current() { return document.videos.find(video => video.id === selected); }
function status(message: string) { $('status').textContent = message; }
async function guard(action: () => Promise<void>) { try {
    await action();
}
catch (e) {
    status(String(e));
} }
function button(text: string, action: () => void, className = '') {
    const element = window.document.createElement('button');
    element.textContent = text;
    element.className = className;
    element.onclick = action;
    return element;
}
function textElement(tag: string, text: string, className = '') {
    const element = window.document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
}
function folderName(id: string | null) { return folderTrail(document.folders, id).map(folder => folder.name).join(' / ') || 'Library'; }
function showTab(tab: 'library' | 'playing') {
    activeTab = tab;
    $('library-view').hidden = tab !== 'library';
    $('playing-view').hidden = tab !== 'playing';
    $('tab-library').setAttribute('aria-selected', String(tab === 'library'));
    $('tab-playing').setAttribute('aria-selected', String(tab === 'playing'));
}
function browse(id: string | null | undefined) { folderId = id; $<HTMLInputElement>('search').value = ''; showTab('library'); renderLibrary(); }
function askName(title: string, value = ''): Promise<string | undefined> {
    const dialog = $<HTMLDialogElement>('name-dialog'), input = $<HTMLInputElement>('dialog-name');
    $('dialog-title').textContent = title;
    input.value = value;
    return new Promise(resolve => {
        dialog.onclose = () => { resolve(dialog.returnValue === 'save' ? input.value.trim() : undefined); };
        $<HTMLFormElement>('name-form').onsubmit = event => {
            event.preventDefault();
            if (input.value.trim())
                dialog.close('save');
            else
                input.focus();
        };
        $('dialog-cancel').onclick = () => dialog.close('cancel');
        dialog.returnValue = '';
        dialog.showModal();
        input.focus();
        input.select();
    });
}
async function persist(next: LibraryDocument) {
    if (saving || transferring)
        throw Error('Please wait for the current library change to finish.');
    saving = true;
    try {
        await invoke('save_library', { document: next });
        document = next;
    }
    finally {
        saving = false;
        render();
    }
}
async function persistVideos(videos: Video[]) { await persist({ ...document, videos }); }
function resetEditor() { editing = undefined; $<HTMLFormElement>('editor').reset(); $('save-chapter').textContent = 'Add chapter'; $('cancel').hidden = true; }
function dateLabel(timestamp: number | null) { return timestamp ? new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Date unavailable'; }
function renderLibrary() {
    const query = $<HTMLInputElement>('search').value.trim();
    const field = $<HTMLSelectElement>('sort').value as SortField;
    const descending = $<HTMLSelectElement>('sort-direction').value === 'desc';
    const matches = sortVideos(visibleVideos(document, folderId, query), field, descending);
    const folders = query || folderId === undefined ? [] : document.folders.filter(folder => folder.parentId === folderId).sort((a, b) => {
        const comparison = field === 'added' || field === 'modified' ? a.createdAt - b.createdAt : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        return descending ? -comparison : comparison;
    });
    $('count').textContent = `${document.videos.length} video${document.videos.length === 1 ? '' : 's'}`;
    $('breadcrumbs').replaceChildren(button('Library', () => browse(null), 'crumb'));
    if (query)
        $('breadcrumbs').append(textElement('span', ' / Search all folders'));
    else if (folderId === undefined)
        $('breadcrumbs').append(textElement('span', ' / All videos'));
    else
        for (const folder of folderTrail(document.folders, folderId))
            $('breadcrumbs').append(textElement('span', ' / '), button(folder.name, () => browse(folder.id), 'crumb'));
    $('result-count').textContent = `${matches.length} video${matches.length === 1 ? '' : 's'}${query ? ` \u00B7 ${matches.reduce((sum, video) => sum + matchingChapters(video, query).length, 0)} matching chapters` : ''}`;
    $('all-videos').hidden = folderId === undefined && !query;
    $('folders').replaceChildren();
    for (const folder of folders) {
        const card = textElement('article', '', 'folder-card');
        const openFolder = button('', () => browse(folder.id), 'folder-open');
        openFolder.append(textElement('span', '\u25B0', 'folder-icon'), textElement('strong', folder.name), textElement('small', `${document.videos.filter(video => video.folderId === folder.id).length} videos \u00B7 ${document.folders.filter(item => item.parentId === folder.id).length} folders`));
        const actions = textElement('div', '', 'folder-actions');
        actions.append(button('Rename', () => void guard(async () => {
            const name = await askName('Rename folder', folder.name);
            if (!name)
                return;
            await persist({ ...document, folders: document.folders.map(item => item.id === folder.id ? { ...item, name } : item) });
        })), button('Delete', () => void guard(async () => {
            if (!await ask(`Delete the folder \u201C${folder.name}\u201D? Its videos and subfolders will move up one level. Original files will stay untouched.`, { title: 'Delete folder?', kind: 'warning' }))
                return;
            await persist(removeFolder(document, folder.id));
        })));
        card.append(openFolder, actions);
        $('folders').append(card);
    }
    $('library').replaceChildren();
    for (const video of matches) {
        const card = textElement('article', '', `video-card${video.id === selected ? ' selected' : ''}`);
        const play = button('', () => void guard(() => selectVideo(video.id)), 'video-open');
        const artwork = textElement('div', '', 'video-artwork');
        artwork.append(textElement('span', '\u25B6', 'play-icon'), textElement('span', mediaExtension(video.path).toUpperCase(), 'format-badge'));
        const info = textElement('div', '', 'video-info');
        info.append(textElement('strong', video.name), textElement('span', filename(video.path), 'filename'), textElement('small', `${video.chapters.length} chapter${video.chapters.length === 1 ? '' : 's'} \u00B7 ${folderName(video.folderId)}`));
        const date = field === 'modified' ? video.modifiedAt : video.addedAt;
        info.append(textElement('small', `${field === 'modified' ? 'Modified' : 'Added'}: ${dateLabel(date)}`, 'date'));
        play.append(artwork, info);
        const remove = button('×', () => void guard(() => removeVideo(video)), 'video-remove');
        remove.setAttribute('aria-label', `Remove ${video.name} from library`);
        remove.title = 'Remove from library';
        remove.disabled = saving || busy || switching || transferring;
        card.append(play, remove);
        const move = window.document.createElement('select');
        move.className = 'move-video';
        move.setAttribute('aria-label', `Move ${video.name} to folder`);
        const destinations = [{ id: '', name: 'Library (no folder)' }, ...document.folders.map(folder => ({ id: folder.id, name: folderName(folder.id) })).sort((a, b) => a.name.localeCompare(b.name))];
        for (const dest of destinations) {
            const option = window.document.createElement('option');
            option.value = dest.id;
            option.textContent = dest.name;
            move.append(option);
        }
        move.value = video.folderId ?? '';
        move.onchange = () => void guard(async () => {
            const dest = move.value || null;
            try {
                await persistVideos(document.videos.map(item => item.id === video.id ? { ...item, folderId: dest } : item));
                status(`Moved \u201C${video.name}\u201D to ${folderName(dest)}.`);
            }
            catch (e) {
                renderLibrary();
                throw e;
            }
        });
        const moveRow = textElement('label', '', 'move-row');
        moveRow.append(textElement('span', 'Folder'), move);
        card.append(moveRow);
        const hits = matchingChapters(video, query);
        if (hits.length) {
            const results = textElement('div', '', 'chapter-matches');
            for (const chapter of hits) {
                const hit = button('', () => void guard(() => selectVideo(video.id, chapter)), 'chapter-result');
                hit.append(textElement('span', `\u25B7 ${chapter.name}`), textElement('small', formatTime(chapter.start)));
                results.append(hit);
            }
            card.append(results);
        }
        $('library').append(card);
    }
    const empty = !matches.length && !folders.length;
    $('library-empty').hidden = !empty;
    $('library-empty').textContent = query ? 'No videos or chapters match your search. Try a different name.' : 'This folder is empty. Add videos or create a folder to get started.';
}
async function playChapter(chapter: Chapter, startPlayback = true) {
    if (projection.active())
        return projection.playChapter(chapter.start, chapter.end, startPlayback);
    player.currentTime = chapter.start;
    stopAt = chapter.end;
    if (startPlayback) return player.play();
    player.pause();
}
function renderChapters() {
    const video = current(), query = $<HTMLInputElement>('chapter-search').value.trim().toLocaleLowerCase();
    const chapters = [...(video?.chapters ?? [])].filter(chapter => chapter.name.toLocaleLowerCase().includes(query)).sort((a, b) => a.start - b.start);
    $('chapters').replaceChildren();
    if (!chapters.length)
        $('chapters').append(textElement('p', query ? 'No chapters match your search.' : 'No chapters marked yet. Add a chapter below, or suggest boundaries.', 'no-chapters'));
    for (const chapter of chapters) {
        const row = textElement('div', '', 'chapter');
        row.append(button(`\u25B6  ${chapter.name}`, () => void guard(() => playChapter(chapter)), 'chapter-play'), textElement('span', `${formatTime(chapter.start)} \u2014 ${formatTime(chapter.end)}`), button('Edit', () => {
            editing = chapter.id;
            $<HTMLInputElement>('chapter-name').value = chapter.name;
            $<HTMLInputElement>('start').value = formatTime(chapter.start);
            $<HTMLInputElement>('end').value = formatTime(chapter.end);
            $('save-chapter').textContent = 'Save chapter';
            $('cancel').hidden = false;
        }), button('Delete', () => void guard(async () => {
            if (!video || !await ask(`Delete the marker \u201C${chapter.name}\u201D?`, { title: 'Delete chapter?', kind: 'warning' }))
                return;
            await persistVideos(document.videos.map(item => item.id === video.id ? { ...item, chapters: item.chapters.filter(s => s.id !== chapter.id) } : item));
        })));
        $('chapters').append(row);
    }
}
function render() {
    for (const id of ['backup-library', 'restore-library']) $<HTMLButtonElement>(id).disabled = saving || busy || switching || transferring;
    autoplay.disabled = saving || transferring;
    renderLibrary();
    const video = current();
    $('title').textContent = video?.name ?? 'Choose a video to play';
    $('subtitle').textContent = video ? video.path : 'Open your library and select a video or a chapter.';
    for (const id of ['rename', 'remove', 'save-chapter', 'detect'])
        $<HTMLButtonElement>(id).disabled = !video || busy;
    $<HTMLButtonElement>('blank-screen').disabled = !video;
    $<HTMLButtonElement>('playback-toggle').disabled = !video;
    projection.refreshButtons();
    $('empty').hidden = !!video;
    renderChapters();
    showTab(activeTab);
}
async function waitForMedia() {
    if (player.readyState >= 1)
        return;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(Error('The video is taking too long to load. Check the source file and codecs.')), 15000);
        const loaded = () => finish();
        const failed = () => finish(Error('Cannot load this video. Check its location and installed codecs.'));
        function finish(error?: Error) { clearTimeout(timer); player.removeEventListener('loadedmetadata', loaded); player.removeEventListener('error', failed); if (error)
            reject(error);
        else
            resolve(); }
        player.addEventListener('loadedmetadata', loaded, { once: true });
        player.addEventListener('error', failed, { once: true });
    });
}
async function selectVideo(id: string, chapter?: Chapter) {
    if (transferring) { status('Please wait for the library backup or restore.'); return; }
    if (switching) { status('Please wait for the current video or cancel its preview.'); return; }
    switching = true;
    try {
        const changed = selected !== id;
        if (changed) {
            await projection.stop(); player.pause(); stopAt = undefined;
            selected = id; resetEditor(); $<HTMLInputElement>('chapter-search').value = '';
        }
        showTab('playing'); render();
        if (projection.active()) { if (chapter) await playChapter(chapter, autoplay.checked); status('Projection is active. Control playback here.'); return; }
        if (changed || player.readyState < 1 || player.error) {
            status('Loading video…');
            const video = current()!;
            const source = await invoke<MediaSource>('media_source', { path: video.path });
            let url: string | undefined = source.url;
            let prepared = source.prepared;
            if (!prepared && needsPreview(video.path)) {
                url = await createPreview(video.path, status); prepared = true;
            }
            if (!url) return;
            player.src = url; player.load();
            try { await waitForMedia(); }
            catch (error) {
                if (prepared) throw error;
                url = await createPreview(video.path, status);
                if (!url) return;
                player.src = url; player.load(); await waitForMedia();
            }
        }
        if (chapter) await playChapter(chapter, autoplay.checked);
        else if (autoplay.checked) await player.play();
        else player.pause();
        status(`${autoplay.checked ? 'Playing' : 'Loaded'} “${chapter?.name ?? current()!.name}”.${autoplay.checked ? '' : ' Press Play to start.'}`);
    } finally { switching = false; render(); }
}

$('tab-library').onclick = () => showTab('library');
$('tab-playing').onclick = () => showTab('playing');
$('back-library').onclick = () => showTab('library');
$('all-videos').onclick = () => browse(undefined);
// Tabs support the standard left/right keyboard navigation without interrupting playback.
for (const id of ['tab-library', 'tab-playing'])
    $(id).onkeydown = event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const next = id === 'tab-library' ? 'playing' : 'library';
            showTab(next);
            $(next === 'playing' ? 'tab-playing' : 'tab-library').focus();
        }
    };
$('search').oninput = renderLibrary;
$('chapter-search').oninput = renderChapters;
$('sort').onchange = renderLibrary;
$('sort-direction').onchange = renderLibrary;
$('new-folder').onclick = () => void guard(async () => {
    const parentId = folderId ?? null, name = await askName('New folder');
    if (!name)
        return;
    await persist({ ...document, folders: [...document.folders, { id: crypto.randomUUID(), name, parentId, createdAt: Date.now() }] });
    status(`Created folder \u201C${name}\u201D.`);
});
$('add').onclick = () => void guard(async () => {
    const paths = await open({ multiple: true, filters: [{ name: 'Videos', extensions: videoExtensions }] });
    if (!paths)
        return;
    const incoming = (Array.isArray(paths) ? paths : [paths]).filter(path => !document.videos.some(video => video.path === path));
    if (!incoming.length) {
        status('These videos are already in the library.');
        return;
    }
    const metadata = await invoke<{
        path: string;
        modifiedAt: number | null;
    }[]>('inspect_videos', { paths: incoming });
    const added = metadata.map(item => ({ id: crypto.randomUUID(), name: filename(item.path).replace(/\.[^.]+$/, ''), path: item.path, chapters: [], folderId: folderId ?? null, addedAt: Date.now(), modifiedAt: item.modifiedAt }));
    await persistVideos([...document.videos, ...added]);
    showTab('library');
    status(`Added ${added.length} video${added.length === 1 ? '' : 's'}. Select one to play.`);
});
$('rename').onclick = () => void guard(async () => {
    const video = current();
    if (!video)
        return;
    const name = await askName('Friendly video name', video.name);
    if (!name)
        return;
    await persistVideos(document.videos.map(item => item.id === video.id ? { ...item, name } : item));
});
function confirmRemoval(video: Video): Promise<boolean> {
    const dialog = $<HTMLDialogElement>('remove-dialog');
    $('remove-description').textContent = `Remove “${video.name}” from your library?`;
    dialog.returnValue = '';
    return new Promise(resolve => {
        dialog.onclose = () => resolve(dialog.returnValue === 'remove');
        $('remove-cancel').onclick = () => dialog.close('cancel');
        $('remove-confirm').onclick = () => dialog.close('remove');
        dialog.showModal();
        $('remove-cancel').focus();
    });
}
async function removeVideo(video: Video) {
    if (saving || busy || switching || transferring) throw Error('Wait for the current operation to finish.');
    if (!await confirmRemoval(video)) return;
    const wasSelected = selected === video.id;
    if (wasSelected) await projection.stop();
    await persistVideos(document.videos.filter(item => item.id !== video.id));
    if (wasSelected) {
        player.pause(); player.removeAttribute('src'); player.load();
        selected = undefined; stopAt = undefined; resetEditor(); showTab('library'); render();
    }
    status(`Removed “${video.name}” from the library. The original file was kept.`);
}
$('remove').onclick = () => void guard(async () => { const video = current(); if (video) await removeVideo(video); });
$('mark-start').onclick = () => { $<HTMLInputElement>('start').value = formatTime(projection.time()); };
$('mark-end').onclick = () => { $<HTMLInputElement>('end').value = formatTime(projection.time()); };
$('cancel').onclick = resetEditor;
$('playback-toggle').onclick = () => void guard(async () => {
    if (projection.active())
        await projection.togglePlayback();
    else if (player.paused)
        await player.play();
    else
        player.pause();
});
for (const event of ['play', 'pause', 'ended'])
    player.addEventListener(event, () => {
        if (!projection.active())
            $('playback-toggle').textContent = player.paused ? 'Play' : 'Pause';
        if (event === 'play' && !projection.active() && current()) status(`Playing “${current()!.name}”.`);
    });
$('blank-screen').onclick = () => void guard(async () => {
    blanked = !blanked;
    $('local-blank').hidden = !blanked;
    $('blank-screen').textContent = blanked ? 'Show video' : 'Blank screen';
    $('blank-screen').setAttribute('aria-pressed', String(blanked));
    await projection.setBlanked(blanked);
    status(blanked ? 'Video output is blanked. Playback and audio continue.' : 'Video output is visible again.');
});
$('stop-at-chapter-end').onchange = () => void guard(async () => {
    const enabled = $<HTMLInputElement>('stop-at-chapter-end').checked;
    await projection.setStopAtChapterEnd(enabled);
    status(enabled ? 'Stop at chapter end is on for selected chapters.' : 'Stop at chapter end is off. Selected chapters will continue into the rest of the video.');
});
$('editor').onsubmit = event => {
    event.preventDefault();
    void guard(async () => {
        const video = current();
        if (!video)
            return;
        const chapter = { id: editing ?? crypto.randomUUID(), name: $<HTMLInputElement>('chapter-name').value.trim(), start: parseTime($<HTMLInputElement>('start').value), end: parseTime($<HTMLInputElement>('end').value) };
        validateChapter(chapter, player.duration);
        await persistVideos(document.videos.map(item => item.id === video.id ? { ...item, chapters: [...item.chapters.filter(s => s.id !== chapter.id), chapter] } : item));
        resetEditor();
        status('Chapter marker saved.');
    });
};
$('detect').onclick = () => void guard(async () => {
    const video = current();
    if (!video)
        return;
    if (!Number.isFinite(player.duration))
        throw Error('Wait for video metadata to load.');
    busy = true;
    render();
    status('Checking chapter suggestions setup\u2026');
    try {
        if (!await ensureFfmpeg()) {
            status('Setup skipped. You can keep playing videos and add chapter markers manually.');
            return;
        }
        const cancel = $<HTMLButtonElement>('cancel-analysis');
        cancel.hidden = false; cancel.disabled = false;
        cancel.onclick = () => { cancel.disabled = true; void invoke('cancel_analysis'); };
        status('Analyzing audio for quiet gaps\u2026 This may take a few minutes.');
        const ranges = await invoke<[
            number,
            number
        ][]>('detect_chapters', { id: video.id, duration: player.duration });
        if (!ranges.length) {
            status('No usable chapter ranges found. Add markers manually.');
            return;
        }
        if (await ask(`Found ${ranges.length} possible chapter ranges. Add them as editable suggestions? Existing markers will be kept.`, { title: 'Add suggested chapters?', kind: 'info' })) {
            await persistVideos(document.videos.map(item => item.id === video.id ? { ...item, chapters: [...item.chapters, ...ranges.map(([start, end], n) => ({ id: crypto.randomUUID(), name: `Suggested chapter ${n + 1}`, start, end }))] } : item));
        }
        status('Analysis complete. Review and name the suggested chapters.');
    }
    finally {
        $('cancel-analysis').hidden = true;
        busy = false;
        render();
    }
});
player.ontimeupdate = () => { if (stopAt !== undefined && player.currentTime >= stopAt) {
    if ($<HTMLInputElement>('stop-at-chapter-end').checked)
        player.pause();
    stopAt = undefined;
} };
player.onseeking = () => { if (stopAt !== undefined && player.currentTime > stopAt)
    stopAt = undefined; };
player.onerror = () => status('Cannot play this video. Check that the file still exists and your system supports its audio/video codecs.');
$('backup-library').onclick = () => void guard(async () => {
    if (saving || busy || switching || transferring) throw Error('Wait for the current operation to finish.');
    transferring = true; render();
    try {
        const path = await invoke<string | null>('backup_library');
        status(path ? `Library backed up to ${path}. Video files are not included.` : 'Backup canceled.');
    } finally { transferring = false; render(); }
});
$('restore-library').onclick = () => void guard(async () => {
    if (saving || busy || switching || transferring) throw Error('Wait for the current operation to finish.');
    transferring = true; render();
    try {
        await projection.stop(); player.pause();
        const restored = await invoke<{document: LibraryDocument; previousBackup: string} | null>('restore_library');
        if (restored) {
            document = restored.document; selected = undefined; editing = undefined; stopAt = undefined; folderId = null;
            player.removeAttribute('src'); player.load();
            $<HTMLInputElement>('search').value = ''; $<HTMLInputElement>('chapter-search').value = '';
            autoplay.checked = document.autoplay ?? false; resetEditor(); showTab('library');
            status(`Library restored. Safety backup saved to ${restored.previousBackup}. Video files must be at their saved locations.`);
        } else status('Restore canceled. Your library is unchanged.');
    } finally { transferring = false; render(); }
});
$('coffee-link').onclick = event => { event.preventDefault(); void guard(async () => { await invoke('open_support'); }); };
$('github-link').onclick = event => { event.preventDefault(); void guard(async () => { await invoke('open_repository'); }); };
void guard(async () => { document = await invoke<LibraryDocument>('load_library'); autoplay.checked = document.autoplay ?? false; render(); });
