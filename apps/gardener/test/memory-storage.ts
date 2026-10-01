/** A sorted in-memory stand-in for Durable Object storage's get/put/list. */
export class MemoryStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    const entries = typeof keyOrEntries === "string" ? { [keyOrEntries]: value } : keyOrEntries;
    for (const [key, entry] of Object.entries(entries)) this.values.set(key, structuredClone(entry));
  }

  async list<T>(options: { prefix: string; limit?: number; startAfter?: string }): Promise<Map<string, T>> {
    this.lists.push(options);
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(options.prefix) && (options.startAfter === undefined || key > options.startAfter))
      .sort()
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
    return new Map(keys.map((key) => [key, structuredClone(this.values.get(key)) as T]));
  }

  readonly lists: { prefix: string; limit?: number; startAfter?: string }[] = [];
}
