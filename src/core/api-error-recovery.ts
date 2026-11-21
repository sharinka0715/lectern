/** Match error evidence for an already verified, current boxed retry hint.
 * Callers retain their own native-line, composer, and busy/dialog guards. */
export function hasCurrentApiErrorBeforeRetry(lines: readonly string[], retryIndex: number, native?: readonly boolean[]): boolean {
  const absoluteLowerBound = Math.max(0, retryIndex - 64);
  let end = retryIndex - 1; // Exclude the composer's top border.
  const previousInput = () => {
    for (let index = end - 1; index >= absoluteLowerBound; index--) {
      if ((!native || native[index]) && /^\s*[❯>]\s*\S/.test(lines[index])) return index;
    }
    return -1;
  };
  let input = previousInput();
  // Claude retains the retry hint after closing a settings menu.
  // Only exact, acknowledged blocks are transparent to the model-turn boundary.
  while (input >= absoluteLowerBound) {
    const command = /^\s*❯\s+\/(model|effort)\s*$/.exec(lines[input]);
    const response = lines.slice(input + 1, end).flatMap((line, offset) => line.trim() ? [{ line, index: input + 1 + offset }] : []);
    const acknowledged = command?.[1] === 'model'
      ? /^\s*⎿\s+(?:Kept model as\s+\S.*|Set model to\s+\S(?:.*\S)?\s+for this session only)\s*$/u.test(response[0]?.line ?? '')
      : command?.[1] === 'effort' && /^\s*⎿\s+Cancelled\s*$/u.test(response[0]?.line ?? '');
    if (response.length !== 1 || !acknowledged || (native && !native[response[0].index])) break;
    end = input;
    input = previousInput();
  }
  // Confirmed setting blocks do not consume the ordinary 20-line error window.
  // The whole search is still capped at 64 lines before the current retry hint;
  // a new user input, unknown command, or unknown acknowledgement cuts it off.
  return lines.slice(Math.max(input + 1, end - 20, absoluteLowerBound), end)
    .some(line => /^\s*(?:[⏺●⎿]\s*)?API Error:\s*[45]\d\d\b/i.test(line));
}
