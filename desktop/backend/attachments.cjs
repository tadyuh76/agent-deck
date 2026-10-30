const fs = require("fs/promises"),
  path = require("path"),
  { randomUUID } = require("crypto");
const MAX_FILE = 20 * 1024 * 1024,
  MAX_TOTAL = 50 * 1024 * 1024,
  MAX_COUNT = 12;
function imageType(b) {
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255)
    return "image/jpeg";
  if (/^GIF8[79]a/.test(b.subarray(0, 6).toString())) return "image/gif";
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  return null;
}
class Attachments {
  constructor(root) {
    this.root = path.resolve(root);
    this.pending = new Set();
  }
  async folder(session) {
    if (!/^[\w-]{1,100}$/.test(session || ""))
      throw new Error("Invalid conversation");
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const folder = path.join(this.root, session);
    await fs.mkdir(folder, { mode: 0o700 }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    if ((await fs.realpath(folder)) !== folder)
      throw new Error("Unsafe attachment folder");
    return folder;
  }
  async read(session, id) {
    if (!/^[a-f0-9-]{36}$/.test(id || ""))
      throw new Error("Invalid attachment");
    const folder = await this.folder(session),
      meta = JSON.parse(
        await fs.readFile(path.join(folder, id + ".json"), "utf8"),
      );
    if (
      meta.id !== id ||
      meta.session !== session ||
      path.basename(meta.stored) !== meta.stored
    )
      throw new Error("Invalid attachment owner");
    const file = path.join(folder, meta.stored);
    if ((await fs.realpath(file)) !== file)
      throw new Error("Unsafe attachment");
    return { ...meta, file };
  }
  async public(meta, preview = true) {
    const { id, name, bytes, mime } = meta;
    return {
      id,
      name,
      bytes,
      mime,
      ...(preview && mime?.startsWith("image/")
        ? {
            src: `data:${mime};base64,${(await fs.readFile(meta.file)).toString("base64")}`,
          }
        : {}),
    };
  }
  async drafts(session, preview = true) {
    const folder = await this.folder(session),
      result = [];
    for (const name of await fs.readdir(folder))
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        const meta = await this.read(session, name.slice(0, -5));
        if (!meta.queued) result.push(await this.public(meta, preview));
      }
    return result;
  }
  async stage(session, { name, data }) {
    if (this.pending.has(session)) throw new Error("Đang thêm tệp trước");
    this.pending.add(session);
    try {
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 255 ||
        /[\0\r\n]/.test(name) ||
        typeof data !== "string" ||
        data.length > Math.ceil(MAX_FILE / 3) * 4 ||
        data.length % 4 !== 0 ||
        /[^A-Za-z0-9+/=]/.test(data)
      )
        throw new Error("Tệp không hợp lệ hoặc lớn hơn 20 MB");
      const buffer = Buffer.from(data, "base64");
      if (buffer.toString("base64") !== data)
        throw new Error("Invalid attachment encoding");
      if (buffer.length > MAX_FILE) throw new Error("Mỗi tệp tối đa 20 MB");
      const folder = await this.folder(session),
        // Sizes only: building image previews here would re-read every draft.
        drafts = await this.drafts(session, false);
      if (
        drafts.length >= MAX_COUNT ||
        drafts.reduce((s, f) => s + f.bytes, 0) + buffer.length > MAX_TOTAL
      )
        throw new Error("Tối đa 12 tệp / 50 MB mỗi tin nhắn");
      const id = randomUUID(),
        safe =
          path
            .basename(name.replace(/\\/g, "/"))
            .replace(/[^a-zA-Z0-9._-]/g, "_")
            .slice(-120) || "file",
        stored = id + "-" + safe;
      const meta = {
        id,
        session,
        name: path.basename(name.replace(/\\/g, "/")),
        stored,
        bytes: buffer.length,
        mime: imageType(buffer) || "application/octet-stream",
        queued: false,
        createdAt: Date.now(),
      };
      const file = path.join(folder, stored);
      await fs.writeFile(file, buffer, { mode: 0o600, flag: "wx" });
      await fs.writeFile(
        path.join(folder, id + ".json"),
        JSON.stringify(meta),
        { mode: 0o600, flag: "wx" },
      );
      return this.public({ ...meta, file });
    } finally {
      this.pending.delete(session);
    }
  }
  // `reserved` names a queued message whose files may be sent now.
  async selected(session, ids, reserved) {
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_COUNT ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Invalid attachments");
    const files = await Promise.all(ids.map((id) => this.read(session, id)));
    if (
      files.some((f) => f.queued && (!reserved || f.sendId !== reserved)) ||
      files.reduce((s, f) => s + f.bytes, 0) > MAX_TOTAL
    )
      throw new Error("Tệp đã gửi hoặc quá giới hạn");
    return files;
  }
  async committed(files, sendId) {
    for (const { file, ...meta } of files)
      await fs.writeFile(
        path.join(path.dirname(file), meta.id + ".json"),
        JSON.stringify({ ...meta, queued: true, sendId }),
        { mode: 0o600 },
      );
  }
  // A delivery that failed before typing anything gives its files back to
  // the composer draft.
  async release(session, sendId) {
    const folder = await this.folder(session),
      result = [];
    for (const name of await fs.readdir(folder))
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        const { file, ...meta } = await this.read(session, name.slice(0, -5));
        if (!meta.queued || meta.sendId !== sendId) continue;
        await fs.writeFile(
          path.join(folder, name),
          JSON.stringify({ ...meta, queued: false, sendId: undefined }),
          { mode: 0o600 },
        );
        result.push(await this.public({ ...meta, file }));
      }
    return result;
  }
  async remove(session, id) {
    const meta = await this.read(session, id);
    if (meta.queued) throw new Error("Tệp này đã gửi, cần giữ cho hội thoại");
    await fs.unlink(meta.file);
    await fs.unlink(path.join(path.dirname(meta.file), id + ".json"));
    return true;
  }
  async open(session, id) {
    const meta = await this.read(session, id);
    if (meta.mime.startsWith("image/"))
      return { kind: "image", path: meta.name, ...(await this.public(meta)) };
    if (meta.bytes > 2 * 1024 * 1024)
      return { kind: "binary", path: meta.name, bytes: meta.bytes };
    const buffer = await fs.readFile(meta.file);
    return buffer.includes(0)
      ? { kind: "binary", path: meta.name, bytes: meta.bytes }
      : {
          kind: "text",
          path: meta.name,
          text: buffer.toString("utf8"),
          readOnly: true,
        };
  }
  async purge(session) {
    const folder = await this.folder(session);
    if (
      path.dirname(folder) !== this.root ||
      (await fs.realpath(folder)) !== folder
    )
      throw new Error("Unsafe attachment folder");
    await fs.rm(folder, { recursive: true, force: true });
  }
}
module.exports = { Attachments, imageType, MAX_FILE };
