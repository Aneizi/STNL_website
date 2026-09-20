/** Shared by HQ composers, Telegram and the reporting service. */
export const MAX_BODY_LENGTH = 280;
export const UPDATE_LENGTH_HINT = `${MAX_BODY_LENGTH} characters maximum, excluding whitespace.`;

/** Count Unicode code points, excluding spaces, line breaks and other whitespace. */
export function updateCharacterCount(body: string): number {
  return Array.from(body.replace(/\s/gu, "")).length;
}

export function validUpdateBody(body: string): boolean {
  const count = updateCharacterCount(body);
  return count > 0 && count <= MAX_BODY_LENGTH;
}
