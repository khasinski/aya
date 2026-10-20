# Adding files to a terminal prompt

Drop files on a terminal to type their quoted paths at the prompt without submitting them. For local projects Aya uses the original file paths. For remote projects Aya copies files to a private folder on that machine and types those paths. Pasting an image saves it to a private per-project folder and types its path. Aya refuses these actions when a pane is waiting for an answer or when its prompt changes while a remote copy is in progress.

Keyboard and file-picker attachment controls are a follow-up; this first version supports drag and drop for files and paste for clipboard images.

File paths are obtained in Electron's isolated preload only from trusted drop events. Main-process attachment requests use a short-lived, one-use token bound to that window and terminal; Aya Web cannot invoke these channels. Clipboard images are read by the main process only after a trusted image-paste event in the focused terminal.
