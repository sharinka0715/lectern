// The main Return key and the numeric keypad's Enter both submit.
interface EnterKey { key: string; code?: string }
interface ImeKey extends EnterKey { isComposing?: boolean; keyCode?: number }

export function isEnterKey(event: EnterKey) {
  return event.key === 'Enter' || event.code === 'NumpadEnter';
}

/**
 * True when the keystroke belongs to the input method (choosing or committing
 * a candidate) and must not submit or move anything. Some macOS input methods
 * report the keypad Enter as an IME key (keyCode 229) even with nothing being
 * composed; with no composition in progress that is still a plain Enter.
 */
export function imeOwnsKey(event: ImeKey, composing = false) {
  if (composing || event.isComposing) return true;
  return event.keyCode === 229 && event.code !== 'NumpadEnter';
}
