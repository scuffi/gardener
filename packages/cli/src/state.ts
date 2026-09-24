import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writePrivateText(path: string, value: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}
