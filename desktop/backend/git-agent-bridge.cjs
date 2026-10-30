// Only installed on Agent Deck's PATH. Other Windows / WSL Git installs are unchanged.
const fs = require("fs"),
  path = require("path"),
  { spawn } = require("child_process");
const { localPath } = require("./local-paths.cjs");
function route(args, cwd, environment = process.env) {
  const argv = [...args],
    env = { ...environment };
  // Git rejects an empty GIT_DIR; an empty value means "not set".
  for (const name of ["GIT_DIR", "GIT_WORK_TREE"])
    if (env[name] === "") delete env[name];
  let directory = cwd,
    explicit = !!env.GIT_DIR,
    command = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "-C") {
      directory = localPath(argv[i + 1], directory);
      argv[++i] = directory;
      continue;
    }
    if (arg.startsWith("-C") && arg.length > 2) {
      directory = localPath(arg.slice(2), directory);
      argv[i] = "-C" + directory;
      continue;
    }
    if (arg === "-c" || arg === "--config-env") {
      i++;
      continue;
    }
    if (
      arg === "--git-dir" ||
      arg === "--work-tree" ||
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=")
    )
      explicit = true;
    if (!arg.startsWith("-")) {
      command = arg;
      break;
    }
  }
  // init and clone create a new repository; pinning them to the enclosing
  // worktree would re-initialise or reject it instead.
  if (explicit || command === "init" || command === "clone")
    return { args: argv, env };
  let folder = directory;
  while (true) {
    const marker = path.join(folder, ".git");
    try {
      const info = fs.statSync(marker);
      if (info.isDirectory()) break;
      const value = fs.readFileSync(marker, "utf8").trim(),
        match = /^gitdir:\s*([a-z]:[\\/].*)$/i.exec(value);
      if (match) {
        const gitdir = localPath(match[1]);
        if (fs.statSync(gitdir).isDirectory()) {
          env.GIT_DIR = gitdir;
          env.GIT_WORK_TREE = folder;
          return { args: ["-c", "safe.directory=" + folder, ...argv], env };
        }
      }
      break;
    } catch (error) {
      if (error.code !== "ENOENT") break;
    }
    const parent = path.dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return { args: argv, env };
}
if (require.main === module) {
  try {
    const target = route(process.argv.slice(2), process.cwd()),
      child = spawn("/usr/bin/git", target.args, {
        env: target.env,
        stdio: "inherit",
      });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.on(signal, () => child.kill(signal));
    child.on("error", (e) => {
      process.stderr.write(e.message + "\n");
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      } else process.exitCode = code ?? 1;
    });
  } catch (e) {
    process.stderr.write(e.message + "\n");
    process.exitCode = 1;
  }
}
module.exports = { route };
