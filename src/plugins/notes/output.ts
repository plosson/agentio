import { writeJson } from '../../utils/output';
import type { Note, NoteOutputFormat, NotesFolder, NoteSummary } from './types';

/** `--json` writes `data`; otherwise `text` prints for people. */
function emit(json: boolean | undefined, data: unknown, text: () => void): void {
  if (json) writeJson(data, 2);
  else text();
}

function summaryLines(note: NoteSummary): void {
  console.log(note.name || '(untitled)');
  console.log(`  ID: ${note.id}`);
  if (note.folder) console.log(`  Folder: ${note.folder}`);
  if (note.modified) console.log(`  Modified: ${note.modified}`);
}

export function printFolders(folders: NotesFolder[], json?: boolean): void {
  emit(json, { folders }, () => {
    if (folders.length === 0) {
      console.log('No folders');
      return;
    }
    console.log(`Folders (${folders.length})\n`);
    for (const folder of folders) {
      console.log(`${folder.name}${folder.account ? ` (${folder.account})` : ''}`);
      console.log(`  ID: ${folder.id}`);
    }
  });
}

export function printNoteList(notes: NoteSummary[], json?: boolean): void {
  emit(json, { notes }, () => {
    if (notes.length === 0) {
      console.log('No notes found');
      return;
    }
    console.log(`Notes (${notes.length})\n`);
    for (const note of notes) {
      summaryLines(note);
      console.log('');
    }
  });
}

/** `get`: the metadata, then the body in the chosen format. */
export function printNote(note: Note, format: NoteOutputFormat, json?: boolean): void {
  emit(json, note, () => {
    summaryLines(note);
    if (note.created) console.log(`  Created: ${note.created}`);
    console.log('---');
    console.log(format === 'html' ? note.bodyHtml : format === 'text' ? note.body : note.bodyMarkdown);
  });
}

/** `create` and `update`: what the note is now, without its body. */
export function printSavedNote(note: Note, action: 'Created' | 'Updated', json?: boolean): void {
  const { id, name, folder, created, modified } = note;
  emit(json, { id, name, folder, created, modified }, () => {
    console.log(`${action} note`);
    summaryLines(note);
  });
}

export function printDeleted(id: string, json?: boolean): void {
  emit(json, { id, deleted: true }, () => console.log(`Moved to Recently Deleted: ${id}`));
}
