export const videoExtensions = ['mp4','m4v','mov','mkv','webm','avi','wmv','mpg','mpeg','m2v','mts','m2ts','ts','vob','ogv','ogg','3gp','3g2','flv','f4v','asf','mxf','rm','rmvb','h264','h265','hevc','av1','nut'];
export const mediaExtension = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';
export const needsPreview = (path: string) => !['mp4','m4v','mov','webm','ogv','ogg','mkv'].includes(mediaExtension(path));
