/** Inline images are already local bytes; fetching them would require an
 * unnecessary CSP connect-src data: allowance. Keep the network policy intact. */
export async function readImageSourceBlob(sourceUrl: string): Promise<Blob> {
  if (sourceUrl.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(sourceUrl);
    if (!match || match[2]!.length > 90_000_000) throw new Error('Invalid inline image');
    const binary = atob(match[2]!);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new Blob([bytes], { type: match[1] });
  }
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error('Image could not be loaded');
  return response.blob();
}
