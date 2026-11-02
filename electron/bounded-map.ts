/** Preserve input order while bounding concurrent filesystem/process work. */
export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, map: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('Concurrency must be a positive integer');
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await map(items[index], index);
    }
  }));
  return result;
}
