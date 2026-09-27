import { execFile } from "node:child_process";

const ID = /^[a-z][a-z0-9-]{1,47}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
export const TEMPLATE_PROFILE_PREFIX = "local-template:";
export const TEMPLATE_IMAGE_TAG_PREFIX = "agentcloud-template-";

export function templateIdFromProfile(profileId) {
  if (typeof profileId !== "string" || !profileId.startsWith(TEMPLATE_PROFILE_PREFIX)) return null;
  const id = profileId.slice(TEMPLATE_PROFILE_PREFIX.length);
  return ID.test(id) ? id : null;
}

export function migrateContainerTemplates(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS container_template (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    image_ref TEXT NOT NULL,
    image_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('registry', 'archive')),
    verified_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
}

export function getContainerTemplate(db, id) {
  if (typeof id !== "string" || !ID.test(id)) return null;
  migrateContainerTemplates(db);
  return db.prepare("SELECT * FROM container_template WHERE id = ?").get(id) || null;
}

export function listContainerTemplates(db) {
  migrateContainerTemplates(db);
  return db.prepare("SELECT * FROM container_template ORDER BY created_at, id").all();
}

export function registerContainerTemplate(db, input) {
  if (!ID.test(input?.id || "")) throw new Error("Template ID must be 2-48 lowercase letters, digits, or hyphens");
  if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 100)
    throw new Error("Invalid template label");
  if (typeof input.imageRef !== "string" || !input.imageRef.trim() || input.imageRef.length > 512 || /\s/.test(input.imageRef))
    throw new Error("Invalid image reference");
  if (!IMAGE_ID.test(input.imageId || "")) throw new Error("Invalid immutable Docker image ID");
  if (!["registry", "archive"].includes(input.source)) throw new Error("Invalid template source");
  migrateContainerTemplates(db);
  const existing = getContainerTemplate(db, input.id);
  if (existing) {
    if (existing.image_id !== input.imageId || existing.image_ref !== input.imageRef ||
        existing.source !== input.source || existing.label !== input.label)
      throw new Error("Template ID is already registered with different content");
    return existing;
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO container_template
    (id, label, image_ref, image_id, source, verified_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.label.trim(), input.imageRef, input.imageId, input.source, now, now);
  return getContainerTemplate(db, input.id);
}

export function dockerCommand(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error(`Docker ${args[0]} failed`));
      resolve(String(stdout));
    });
  });
}

export async function inspectContainerImage(imageRef, { docker = dockerCommand } = {}) {
  if (typeof imageRef !== "string" || !imageRef.trim() || imageRef.length > 512 || /\s/.test(imageRef))
    throw new Error("Invalid image reference");
  const imageId = (await docker(["image", "inspect", "--format", "{{.Id}}", imageRef])).trim();
  if (!IMAGE_ID.test(imageId)) throw new Error("Docker did not return an immutable image ID");
  return imageId;
}

export async function loadContainerArchive(filename, { docker = dockerCommand } = {}) {
  if (typeof filename !== "string" || !filename.startsWith("/") || filename.includes("\0"))
    throw new Error("Archive path must be absolute");
  const output = await docker(["load", "--input", filename], { timeoutMs: 15 * 60_000 });
  return new Set(output.split(/\r?\n/).flatMap((line) => {
    const match = /^Loaded image(?: ID)?: (\S+)$/.exec(line.trim());
    return match ? [match[1]] : [];
  }));
}

export async function retainContainerImage(id, imageId, { docker = dockerCommand } = {}) {
  if (!ID.test(id || "") || !IMAGE_ID.test(imageId || "")) throw new Error("Invalid template image identity");
  const tag = `${TEMPLATE_IMAGE_TAG_PREFIX}${id}:pinned`;
  await docker(["tag", imageId, tag]);
  return tag;
}
