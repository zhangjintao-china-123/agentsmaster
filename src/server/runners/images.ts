import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ImagePayload } from "../../shared/protocol.js";

export async function saveImages(images: ImagePayload[] | undefined): Promise<string[]> {
  if (!images?.length) return [];
  const dir = path.join(os.tmpdir(), "agentsmaster-uploads");
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const image of images) {
    const ext = image.mediaType.includes("png")
      ? "png"
      : image.mediaType.includes("jpeg") || image.mediaType.includes("jpg")
        ? "jpg"
        : "img";
    const file = path.join(dir, `${randomUUID()}.${ext}`);
    await writeFile(file, Buffer.from(image.data, "base64"));
    paths.push(file);
  }
  return paths;
}

export function promptWithImages(text: string, imagePaths: string[]): string {
  if (!imagePaths.length) return text;
  const lines = imagePaths.map((file) => `- ${file}`).join("\n");
  return `${text}\n\n图片文件：\n${lines}`;
}
