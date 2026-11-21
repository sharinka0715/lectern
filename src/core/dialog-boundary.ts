// A separator can also be literal output. Keep the ownership of the preceding
// response until a real user command, including when the copied dialog has a ruler.
export function inTranscriptExample(before: readonly string[]): boolean {
  let fenced = false;
  let response = false;
  for (const value of before) {
    const line = value.trim();
    if (/^```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^[❯>]\s/.test(line)) response = false;
    else if (/^[●⏺]\s/.test(line)) response = !/^[●⏺]\s+(?:Unknown command: \/[\w-]+\.?$|API Error: [45]\d\d\b)/.test(line);
  }
  return fenced || response;
}
