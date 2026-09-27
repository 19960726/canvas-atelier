/** Every local decode settles, allowing the serial validation queue to recover. */
export async function decodeImageWithTimeout(image: HTMLImageElement): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([image.decode(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { image.src = ''; reject(new Error('图层图片读取超时，请重新读取')); }, 30_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
