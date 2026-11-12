import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ensureFfmpeg } from './ffmpeg-setup';
import { formatTime } from './time';
export type MediaSource = { url: string; prepared: boolean };
async function confirmPreview(): Promise<boolean> {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<h2>Create a compatible video preview</h2><p>This video needs a compatible preview for playback on this computer.</p><p>The preview uses additional disk space in the app’s cache. Your original file will not be changed.</p><div class="dialog-actions"><button id="preview-decline">Cancel</button><button id="preview-accept" class="primary">Create preview</button></div>`;
  document.body.append(dialog);
  return new Promise(resolve => {
    let accepted = false;
    dialog.onclose = () => { dialog.remove(); resolve(accepted); };
    dialog.querySelector<HTMLButtonElement>('#preview-decline')!.onclick = () => dialog.close();
    dialog.querySelector<HTMLButtonElement>('#preview-accept')!.onclick = () => {
      accepted = true;
      dialog.close();
    };
    dialog.showModal();
  });
}
export async function createPreview(path: string, status: (text: string) => void): Promise<string | undefined> {
  const accepted = await confirmPreview();
  if (!accepted) { status('Preview creation skipped.'); return; }
  if (!await ensureFfmpeg('preview')) { status('FFmpeg setup skipped. This file needs a compatible preview to play here.'); return; }
  const cancel = document.getElementById('cancel-preview') as HTMLButtonElement;
  cancel.hidden = false; cancel.disabled = false; cancel.textContent = 'Cancel preview';
  cancel.onclick = () => { cancel.disabled = true; cancel.textContent = 'Canceling…'; void invoke('cancel_preview'); };
  const unlisten = await listen<{processedSeconds: number}>('preview-progress', ({ payload }) => status(`Preparing compatible preview… ${formatTime(payload.processedSeconds)} processed. You can cancel from the top bar.`));
  status('Preparing compatible preview… Your original file stays untouched.');
  try { return await invoke<string>('prepare_video', { path }); }
  finally { unlisten(); cancel.hidden = true; }
}
