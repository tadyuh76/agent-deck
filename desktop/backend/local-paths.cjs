const path = require("path"),
  os = require("os");
function localPath(value, base = os.homedir()) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 8192 ||
    /[\0\r\n]/.test(value)
  )
    throw new Error("Đường dẫn không hợp lệ");
  let name = value.trim().replace(/^"([\s\S]*)"$/, "$1");
  if (/^file:\/\//i.test(name)) {
    try {
      name = decodeURIComponent(name.replace(/^file:\/\//i, ""));
    } catch {
      throw new Error("Đường dẫn file không hợp lệ");
    }
  }
  name = name.replace(/\\/g, "/");
  const wsl = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i.exec(name);
  if (wsl) {
    const distribution = process.env.WSL_DISTRO_NAME || "Ubuntu-24.04";
    if (wsl[1].toLowerCase() !== distribution.toLowerCase())
      throw new Error(
        "Chọn đường dẫn trong " + distribution + " hoặc ổ đĩa Windows",
      );
    name = wsl[2] || "/";
  } else if (name.startsWith("//"))
    throw new Error("Network share chưa được mount trong WSL");
  if (/^\/[a-z]:\//i.test(name)) name = name.slice(1);
  if (/^[a-z]:\//i.test(name))
    name = "/mnt/" + name[0].toLowerCase() + name.slice(2);
  else if (/^[a-z][\w+.-]*:/i.test(name))
    throw new Error("Chỉ mở đường dẫn file trên máy");
  if (name === "~" || name.startsWith("~/"))
    name = os.homedir() + name.slice(1);
  return path.posix.resolve(base, name);
}
function fileReference(value, base) {
  if (typeof value !== "string") throw new Error("Invalid file reference");
  let name = value,
    line;
  if (!/^file:\/\//i.test(name) && /%[a-f0-9]{2}/i.test(name))
    try {
      name = decodeURIComponent(name);
    } catch {}
  const location = /(?:#L|:)(\d+)(?::\d+)?$/.exec(name);
  if (location) {
    line = Number(location[1]);
    name = name.slice(0, location.index);
  }
  return {
    absolute: localPath(name, base),
    line,
    relative: !/^[/\\~]|^[a-z][\w+.-]*:/i.test(name),
  };
}
module.exports = { localPath, fileReference };
