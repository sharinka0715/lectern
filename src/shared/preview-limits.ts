/** A text file up to this size opens at once. A larger one asks first, then opens up to
 * LARGE_TEXT_BYTES (the rest is left to a download). Both sides need them: the backend reads,
 * the file panel words its question and turns syntax highlighting off above TEXT_OPEN_BYTES. */
export const TEXT_OPEN_BYTES = 1024 * 1024;
export const LARGE_TEXT_BYTES = 16 * 1024 * 1024;
