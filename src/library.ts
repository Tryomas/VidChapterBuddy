export type Chapter = {
    id: string;
    name: string;
    start: number;
    end: number;
};
export type Video = {
    id: string;
    name: string;
    path: string;
    chapters: Chapter[];
    folderId: string | null;
    addedAt: number;
    modifiedAt: number | null;
};
export type Folder = {
    id: string;
    name: string;
    parentId: string | null;
    createdAt: number;
};
export type LibraryDocument = {
    version: 2;
    autoplay?: boolean;
    videos: Video[];
    folders: Folder[];
};
export type SortField = 'friendly' | 'filename' | 'added' | 'modified';
export const filename = (path: string) => path.split(/[\\/]/).pop() || path;
const compareNames = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
export function sortVideos(videos: Video[], field: SortField, descending: boolean): Video[] {
    return [...videos].sort((a, b) => {
        let result: number;
        if (field === 'friendly' || field === 'filename') {
            result = compareNames(field === 'friendly' ? a.name : filename(a.path), field === 'friendly' ? b.name : filename(b.path));
        }
        else {
            const av = field === 'added' ? a.addedAt : a.modifiedAt;
            const bv = field === 'added' ? b.addedAt : b.modifiedAt;
            // Unknown dates stay at the end in either direction, including legacy imports.
            if (!av || !bv)
                return av ? -1 : bv ? 1 : compareNames(a.name, b.name);
            result = av - bv;
        }
        return (descending ? -result : result) || compareNames(a.name, b.name) || a.id.localeCompare(b.id);
    });
}
export function matchingChapters(video: Video, query: string): Chapter[] {
    const term = query.trim().toLocaleLowerCase();
    return term ? video.chapters.filter(chapter => chapter.name.toLocaleLowerCase().includes(term)) : [];
}
export function visibleVideos(doc: LibraryDocument, folderId: string | null | undefined, query: string): Video[] {
    const term = query.trim().toLocaleLowerCase();
    return doc.videos.filter(video => term
        ? [video.name, filename(video.path)].some(text => text.toLocaleLowerCase().includes(term)) || matchingChapters(video, term).length > 0
        : folderId === undefined || video.folderId === folderId);
}
export function folderTrail(folders: Folder[], folderId: string | null): Folder[] {
    const trail: Folder[] = [], visited = new Set<string>();
    let id = folderId;
    while (id && !visited.has(id)) {
        visited.add(id);
        const folder = folders.find(item => item.id === id);
        if (!folder)
            break;
        trail.unshift(folder);
        id = folder.parentId;
    }
    return trail;
}
export function removeFolder(doc: LibraryDocument, id: string): LibraryDocument {
    const folder = doc.folders.find(item => item.id === id);
    if (!folder)
        return doc;
    return { ...doc, folders: doc.folders.filter(item => item.id !== id).map(item => item.parentId === id ? { ...item, parentId: folder.parentId } : item),
        videos: doc.videos.map(item => item.folderId === id ? { ...item, folderId: folder.parentId } : item) };
}
