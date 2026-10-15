// Fake docker CLI + streams for the UI harness (docs/GUIDE.md §15.3.D).
// Chained into mockBackend.ts: `docker_run` -> dockerRun(), `docker_*_start/stop` -> the stream fns.
// Answers like `docker`/`podman` on a VM. State lives in `dockerFake`; scenarios change it through
// `window.__harness.dockerFakeSet(...)` and read what the app ran through `dockerCalls()`.

import { emit } from "@tauri-apps/api/event";

export interface FakeContainer {
  name: string;
  id: string;
  image: string;
  state: "running" | "exited" | "paused" | "created";
  status: string;
  ports: string;
  project?: string;
  service?: string;
  env: string[];
  mounts: { type: string; name?: string; source: string; destination: string; rw: boolean }[];
}

const hex = (seed: string) => {
  let h = "";
  let n = 0;
  for (let i = 0; h.length < 64; i++) {
    n = (n * 31 + seed.charCodeAt(i % seed.length) + i * 7) >>> 0;
    h += (n & 0xffff).toString(16).padStart(4, "0");
  }
  return h.slice(0, 64);
};

function initialContainers(): FakeContainer[] {
  return [
    {
      name: "shop-web-1",
      id: hex("web"),
      image: "nginx:latest",
      state: "running",
      status: "Up 2 hours (healthy)",
      ports: "0.0.0.0:8080->80/tcp, :::8080->80/tcp",
      project: "shop",
      service: "web",
      env: ["PATH=/usr/local/bin", "API_TOKEN=tok_live_12345", "DB_PASSWORD=hunter2"],
      mounts: [{ type: "bind", source: "/srv/shop/html", destination: "/usr/share/nginx/html", rw: false }],
    },
    {
      name: "shop-db-1",
      id: hex("db"),
      image: "postgres:16",
      state: "running",
      status: "Up 2 hours",
      ports: "5432/tcp",
      project: "shop",
      service: "db",
      env: ["POSTGRES_PASSWORD=secret"],
      mounts: [{ type: "volume", name: "pgdata", source: "/var/lib/docker/volumes/pgdata/_data", destination: "/var/lib/postgresql/data", rw: true }],
    },
    { name: "cache", id: hex("cache"), image: "redis:7", state: "exited", status: "Exited (0) 3 days ago", ports: "", env: [], mounts: [] },
    { name: "solo", id: hex("solo"), image: "alpine:3", state: "running", status: "Up 5 minutes", ports: "", env: ["A=1"], mounts: [] },
  ];
}

export const dockerFake = {
  installed: true,
  daemon: true,
  /** Plain `docker` is denied on the socket; `sudo docker` works. */
  denied: false,
  /** busybox `ls` (no --time-style). */
  busybox: false,
  /** Compose validation fails with this message while set. */
  composeInvalid: "",
  containers: initialContainers(),
  images: [
    { id: "a1a1a1a1a1a1", repo: "nginx", tag: "latest", size: "187MB" },
    { id: "b2b2b2b2b2b2", repo: "postgres", tag: "16", size: "432MB" },
    { id: "c3c3c3c3c3c3", repo: "redis", tag: "7", size: "117MB" },
    { id: "d4d4d4d4d4d4", repo: "<none>", tag: "<none>", size: "55.1MB" },
  ],
  volumes: ["pgdata", "webdata"],
  networks: ["bridge", "host", "none", "shop_default"],
  /** Every docker_run: args plus the command setting. */
  calls: [] as { args: string[]; command: string | null; stdin: string | null }[],
  logStreams: [] as { id: string; target: string; compose: boolean; follow: boolean; opts: unknown }[],
  statsRunning: 0,
  eventsRunning: 0,
};

let streamCounter = 0;
const timers = new Map<string, ReturnType<typeof setInterval>>();
const ended = new Set<string>();
const kinds = new Map<string, "logs" | "stats" | "events">();
let eventsStreamId: string | null = null;

const find = (ref: string) => dockerFake.containers.find((c) => c.id === ref || c.id.startsWith(ref) || c.name === ref);

function psLine(c: FakeContainer): string {
  const labels = c.project ? `com.docker.compose.project=${c.project},com.docker.compose.service=${c.service}` : "";
  return JSON.stringify({
    ID: c.id,
    Names: c.name,
    Image: c.image,
    Command: '"/entrypoint.sh"',
    CreatedAt: "2024-05-01 10:00:00 +0000 UTC",
    RunningFor: "2 hours ago",
    Ports: c.state === "running" ? c.ports : "",
    State: c.state,
    Status: c.status,
    Labels: labels,
    Networks: c.project ? "shop_default" : "bridge",
    Mounts: c.mounts.map((m) => m.name ?? m.source).join(","),
  });
}

export function emitEvent(type: string, action: string, name: string, id: string): void {
  if (!eventsStreamId) return;
  void emit("docker://events", {
    streamId: eventsStreamId,
    lines: [JSON.stringify({ Type: type, Action: action, Actor: { ID: id, Attributes: { name } }, time: Math.floor(Date.now() / 1000) })],
  });
}

function endLogsFor(target: string): void {
  for (const s of dockerFake.logStreams) {
    if ((s.target === target || find(s.target)?.name === target) && !ended.has(s.id)) endStream(s.id, "logs-end");
  }
}

function endStream(id: string, event: string): void {
  if (ended.has(id)) return;
  ended.add(id);
  const t = timers.get(id);
  if (t) clearInterval(t);
  timers.delete(id);
  void emit(`docker://${event}`, { streamId: id, code: 0 });
}

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", truncated: false });
const fail = (stderr: string, code = 1) => ({ code, stdout: "", stderr, truncated: false });

const FS: Record<string, { name: string; kind: "d" | "f" | "l"; size: number; target?: string }[]> = {
  "/": [
    { name: "etc", kind: "d", size: 4096 },
    { name: "app", kind: "d", size: 4096 },
    { name: "bin", kind: "l", size: 7, target: "usr/bin" },
    { name: "hello.txt", kind: "f", size: 12 },
  ],
  "/etc": [
    { name: "hosts", kind: "f", size: 40 },
    { name: "blob.bin", kind: "f", size: 8 },
  ],
  "/app": [{ name: "main.py", kind: "f", size: 30 }],
};
const FILES: Record<string, string> = {
  "/hello.txt": "hello world\n",
  "/etc/hosts": "127.0.0.1 localhost\n::1 localhost\n",
  "/etc/blob.bin": "AB\0CD\0EF",
  "/app/main.py": "print('hi from container')\n",
};

function lsOutput(path: string, epoch: boolean): string {
  const dir = path.replace(/\/+$/, "") || "/";
  const list = FS[dir];
  if (!list) return "";
  const date = (i: number) => (epoch ? String(1700000000 + i * 100) : "Jan  1 12:00");
  const lines = ["total 8", `drwxr-xr-x 1 root root 4096 ${date(0)} .`, `drwxr-xr-x 1 root root 4096 ${date(0)} ..`];
  list.forEach((e, i) => {
    const perm = e.kind === "d" ? "drwxr-xr-x" : e.kind === "l" ? "lrwxrwxrwx" : "-rw-r--r--";
    lines.push(`${perm} 1 root root ${e.size} ${date(i + 1)} ${e.name}${e.target ? ` -> ${e.target}` : ""}`);
  });
  return lines.join("\n") + "\n";
}

function inspectJson(c: FakeContainer): string {
  const ports: Record<string, unknown> = {};
  for (const m of c.ports.matchAll(/(?:[\d.]+:)?(\d+)->(\d+)\/(\w+)/g)) ports[`${m[2]}/${m[3]}`] = [{ HostIp: "0.0.0.0", HostPort: m[1] }];
  for (const m of c.ports.matchAll(/(?:^|, )(\d+)\/(\w+)(?=,|$)/g)) ports[`${m[1]}/${m[2]}`] = null;
  return JSON.stringify([
    {
      Id: c.id,
      Name: `/${c.name}`,
      Created: "2024-05-01T10:00:00Z",
      RestartCount: 0,
      State: { Status: c.state, Running: c.state === "running", Paused: c.state === "paused", ExitCode: 0, StartedAt: "2024-05-01T10:00:01Z", Pid: 4242 },
      Config: { Image: c.image, Env: c.env, Cmd: ["run"], Labels: c.project ? { "com.docker.compose.project": c.project } : {} },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
      Mounts: c.mounts.map((m) => ({ Type: m.type, Name: m.name, Source: m.source, Destination: m.destination, RW: m.rw, Mode: m.rw ? "rw" : "ro" })),
      NetworkSettings: { Ports: ports, Networks: { bridge: { IPAddress: "172.17.0.2", Gateway: "172.17.0.1", MacAddress: "02:42:ac:11:00:02" } } },
    },
  ]);
}

function composeLs(): string {
  const names = [...new Set(dockerFake.containers.map((c) => c.project).filter(Boolean))] as string[];
  return JSON.stringify(
    names.map((n) => {
      const cs = dockerFake.containers.filter((c) => c.project === n);
      const run = cs.filter((c) => c.state === "running").length;
      return { Name: n, Status: `running(${run})${cs.length - run ? `, exited(${cs.length - run})` : ""}`, ConfigFiles: `/home/testuser/projects/docker-compose.yml` };
    }),
  );
}

function setState(c: FakeContainer, state: FakeContainer["state"], status: string, action: string): void {
  c.state = state;
  c.status = status;
  if (state !== "running" && state !== "paused") endLogsFor(c.name);
  emitEvent("container", action, c.name, c.id);
}

/** The fake `docker` / `podman` command line interpreter. */
export function dockerRun(args: string[], command: string | null, stdin: string | null): { code: number; stdout: string; stderr: string; truncated: boolean } {
  dockerFake.calls.push({ args: [...args], command, stdin });
  const cmd = command ?? "docker";
  if (!dockerFake.installed) return fail("env: 'docker': No such file or directory", 127);
  if (dockerFake.denied && cmd === "docker") {
    return fail("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: connect: permission denied");
  }
  if (!dockerFake.daemon) return fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");

  const [a, b, ...rest] = args;
  switch (a) {
    case "info":
      return ok(
        JSON.stringify({
          ServerVersion: "26.1.0",
          OperatingSystem: "Ubuntu 22.04",
          Name: "vm1",
          Containers: dockerFake.containers.length,
          ContainersRunning: dockerFake.containers.filter((c) => c.state === "running").length,
          Images: dockerFake.images.length,
          SecurityOptions: ["name=seccomp,profile=builtin"],
          ClientInfo: { Plugins: [{ Name: "compose", Version: "v2.27.0" }] },
        }),
      );
    case "ps":
      return ok(dockerFake.containers.map(psLine).join("\n") + "\n");
    case "images":
      return ok(
        dockerFake.images
          .map((i) => JSON.stringify({ ID: i.id, Repository: i.repo, Tag: i.tag, Size: i.size, CreatedSince: "2 weeks ago", Containers: "N/A" }))
          .join("\n") + "\n",
      );
    case "volume":
      if (b === "ls") return ok(dockerFake.volumes.map((v) => JSON.stringify({ Name: v, Driver: "local", Mountpoint: `/var/lib/docker/volumes/${v}/_data`, Scope: "local", Labels: "" })).join("\n") + "\n");
      if (b === "rm") {
        dockerFake.volumes = dockerFake.volumes.filter((v) => v !== rest[0]);
        return ok(rest[0]);
      }
      if (b === "prune") return ok("Total reclaimed space: 100MB\n");
      break;
    case "network":
      if (b === "ls") return ok(dockerFake.networks.map((n, i) => JSON.stringify({ ID: hex(n).slice(0, 12), Name: n, Driver: n === "host" ? "host" : n === "none" ? "null" : "bridge", Scope: "local", Internal: "false", IPv6: "false", Labels: "", CreatedAt: "2024-05-01 10:00:00 +0000 UTC", i })).join("\n") + "\n");
      if (b === "rm") {
        dockerFake.networks = dockerFake.networks.filter((n) => n !== rest[0]);
        return ok(rest[0]);
      }
      if (b === "prune") return ok("Total reclaimed space: 0B\n");
      break;
    case "system":
      if (b === "df")
        return ok(
          [
            { Type: "Images", TotalCount: "4", Active: "3", Size: "791MB", Reclaimable: "55.1MB (6%)" },
            { Type: "Containers", TotalCount: String(dockerFake.containers.length), Active: "3", Size: "10kB", Reclaimable: "5kB (50%)" },
            { Type: "Local Volumes", TotalCount: "2", Active: "1", Size: "300MB", Reclaimable: "100MB (33%)" },
            { Type: "Build Cache", TotalCount: "0", Active: "0", Size: "0B", Reclaimable: "0B" },
          ]
            .map((r) => JSON.stringify(r))
            .join("\n") + "\n",
        );
      break;
    case "container":
      if (b === "prune") {
        const before = dockerFake.containers.length;
        dockerFake.containers = dockerFake.containers.filter((c) => c.state === "running" || c.state === "paused");
        return ok(`Total reclaimed space: ${(before - dockerFake.containers.length) * 5}kB\n`);
      }
      break;
    case "image":
      if (b === "prune") {
        dockerFake.images = dockerFake.images.filter((i) => i.repo !== "<none>");
        return ok("Total reclaimed space: 55.1MB\n");
      }
      break;
    case "builder":
      if (b === "prune") return ok("Total reclaimed space: 0B\n");
      break;
    case "inspect": {
      const ref = args[args.length - 1];
      const c = find(ref);
      if (c) return ok(inspectJson(c));
      if (dockerFake.images.some((i) => i.id === ref)) return ok(JSON.stringify([{ Id: `sha256:${ref}`, RepoTags: ["x:latest"], Os: "linux" }]));
      if (dockerFake.volumes.includes(ref)) return ok(JSON.stringify([{ Name: ref, Driver: "local" }]));
      if (dockerFake.networks.includes(ref)) return ok(JSON.stringify([{ Name: ref, Driver: "bridge" }]));
      return fail(`Error: No such object: ${ref}`);
    }
    case "start":
    case "stop":
    case "restart":
    case "pause":
    case "unpause":
    case "kill": {
      const c = find(b);
      if (!c) return fail(`Error response from daemon: No such container: ${b}`);
      if (a === "start") setState(c, "running", "Up 1 second", "start");
      else if (a === "stop" || a === "kill") setState(c, "exited", "Exited (0) 1 second ago", a === "stop" ? "die" : "kill");
      else if (a === "restart") {
        endLogsFor(c.name);
        setState(c, "running", "Up 1 second", "restart");
      } else if (a === "pause") setState(c, "paused", "Up 2 hours (Paused)", "pause");
      else setState(c, "running", "Up 2 hours", "unpause");
      return ok(c.name + "\n");
    }
    case "rm": {
      const ref = args[args.length - 1];
      const c = find(ref);
      if (!c) return fail(`Error response from daemon: No such container: ${ref}`);
      if (c.state === "running" && !args.includes("-f")) return fail("Error response from daemon: cannot remove container: container is running: stop the container before removing or force remove");
      endLogsFor(c.name);
      dockerFake.containers = dockerFake.containers.filter((x) => x !== c);
      emitEvent("container", "destroy", c.name, c.id);
      return ok(c.name + "\n");
    }
    case "rename": {
      const c = find(b);
      if (!c) return fail(`Error response from daemon: No such container: ${b}`);
      c.name = rest[0];
      emitEvent("container", "rename", c.name, c.id);
      return ok();
    }
    case "top": {
      const c = find(b);
      if (!c || c.state !== "running") return fail(`Error response from daemon: container ${b} is not running`);
      return ok("UID  PID   PPID  C  STIME  TTY  TIME      CMD\nroot 4242  4200  0  10:00  ?    00:00:01  nginx: master process nginx -g daemon off;\n");
    }
    case "history":
      return ok(
        [
          { ID: "sha256:aaaaaaaaaaaa", CreatedBy: '/bin/sh -c #(nop)  CMD ["nginx"]', CreatedSince: "2 weeks ago", Size: "0B" },
          { ID: "<missing>", CreatedBy: "/bin/sh -c apt-get install -y nginx", CreatedSince: "2 weeks ago", Size: "55.1MB" },
        ]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      );
    case "pull":
      if (b.includes("nope")) return fail(`Error response from daemon: pull access denied for ${b}, repository does not exist`);
      if (!dockerFake.images.some((i) => `${i.repo}:${i.tag}` === b)) {
        const [repo, tag = "latest"] = b.split(":");
        dockerFake.images.push({ id: hex(b).slice(0, 12), repo, tag, size: "10MB" });
        void emit("docker://events", { streamId: eventsStreamId, lines: [JSON.stringify({ Type: "image", Action: "pull", Actor: { ID: b, Attributes: {} } })] });
      }
      return ok(`Status: Downloaded newer image for ${b}\n`);
    case "tag":
      return ok();
    case "rmi": {
      const ref = args[args.length - 1];
      dockerFake.images = dockerFake.images.filter((i) => i.id !== ref && `${i.repo}:${i.tag}` !== ref);
      return ok(`Untagged: ${ref}\n`);
    }
    case "run": {
      const nameIdx = args.indexOf("--name");
      const image = args.filter((x) => !x.startsWith("-")).slice(-1)[0];
      const name = nameIdx >= 0 ? args[nameIdx + 1] : "random_name";
      if (dockerFake.containers.some((c) => c.name === name)) return fail(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`, 125);
      const pIdx = args.indexOf("-p");
      const ports = pIdx >= 0 ? args[pIdx + 1].replace(/^(\d+):(\d+)$/, "0.0.0.0:$1->$2/tcp") : "";
      const c: FakeContainer = { name, id: hex("run" + name), image, state: "running", status: "Up 1 second", ports, env: [], mounts: [] };
      dockerFake.containers.push(c);
      emitEvent("container", "create", name, c.id);
      return ok(c.id + "\n");
    }
    case "compose": {
      // compose [-p name] [-f file…] [--project-directory d] <sub> …
      const sub = args.filter((x, i) => !["compose"].includes(x) && !(args[i - 1] === "-p" || args[i - 1] === "-f" || args[i - 1] === "--project-directory") && !["-p", "-f", "--project-directory"].includes(x));
      const s = sub[0];
      if (s === "ls") return ok(composeLs());
      if (s === "config") return dockerFake.composeInvalid ? fail(dockerFake.composeInvalid, 15) : ok();
      if (s === "up") {
        const p = args[args.indexOf("-p") + 1];
        for (const c of dockerFake.containers.filter((x) => x.project === p)) setState(c, "running", "Up 1 second", "start");
        return ok(`[+] Running 2/2\n ✔ Container ${p}-db-1   Started\n ✔ Container ${p}-web-1  Started\n`);
      }
      if (s === "down") {
        const p = args[args.indexOf("-p") + 1];
        for (const c of dockerFake.containers.filter((x) => x.project === p)) setState(c, "exited", "Exited (0) 1 second ago", "die");
        return ok(`[+] Running 2/2\n ✔ Container ${p}-web-1  Removed\n`);
      }
      if (s === "restart" || s === "stop" || s === "pull") return ok(`${s} done\n`);
      break;
    }
    case "exec": {
      const c = find(b);
      if (!c) return fail(`Error response from daemon: No such container: ${b}`);
      if (c.state !== "running") return fail(`Error response from daemon: container ${c.id} is not running`);
      const [prog, ...pa] = rest;
      if (prog === "ls") {
        const epoch = pa.some((x) => x.startsWith("--time-style"));
        if (epoch && dockerFake.busybox) return fail("ls: unrecognized option: time-style=+%s\nBusyBox v1.36.1 multi-call binary.", 1);
        const target = pa[pa.length - 1];
        const out = lsOutput(target, epoch);
        return out ? ok(out) : fail(`ls: ${target}: No such file or directory`, 2);
      }
      if (prog === "head") {
        const path = pa[pa.length - 1];
        const data = FILES[path];
        return data !== undefined ? ok(data) : fail(`head: ${path}: No such file or directory`, 1);
      }
      return fail("fake exec: unknown program");
    }
    case "cp":
      return ok();
  }
  return fail(`fake docker: unsupported command: ${args.join(" ")}`);
}

// --- streams ------------------------------------------------------------------------

export function logsStart(sessionId: string, target: string, opts: Record<string, unknown>): string {
  streamCounter += 1;
  const id = `dlog-${streamCounter}`;
  kinds.set(id, "logs");
  const compose = opts?.compose === true;
  const follow = opts?.follow !== false;
  dockerFake.logStreams.push({ id, target, compose, follow, opts });
  const ts = opts?.timestamps === true ? "2024-05-01T10:00:00.000000000Z " : "";
  setTimeout(() => {
    void emit("docker://logs", { streamId: id, chunk: `${ts}starting ${target}\n${ts}\u001b[32mINFO\u001b[0m listening on :80\n${ts}warn: slow disk\n`, stream: "stdout" });
    void emit("docker://logs", { streamId: id, chunk: `${ts}error: connection reset\n`, stream: "stderr" });
    if (!follow) setTimeout(() => endStream(id, "logs-end"), 50);
  }, 40);
  if (follow) {
    let n = 0;
    timers.set(
      id,
      setInterval(() => {
        n += 1;
        void emit("docker://logs", { streamId: id, chunk: `${ts}tick ${n}\n`, stream: "stdout" });
      }, 300),
    );
  }
  return id;
}

export function streamStop(id: string): void {
  const k = kinds.get(id);
  if (k === "logs") endStream(id, "logs-end");
  else if (k === "stats") {
    dockerFake.statsRunning = Math.max(0, dockerFake.statsRunning - 1);
    endStream(id, "stats-end");
  } else if (k === "events") {
    dockerFake.eventsRunning = Math.max(0, dockerFake.eventsRunning - 1);
    if (eventsStreamId === id) eventsStreamId = null;
    endStream(id, "events-end");
  }
}

export function statsStart(): string {
  streamCounter += 1;
  const id = `dstats-${streamCounter}`;
  kinds.set(id, "stats");
  dockerFake.statsRunning += 1;
  let n = 0;
  timers.set(
    id,
    setInterval(() => {
      n += 1;
      const lines = dockerFake.containers
        .filter((c) => c.state === "running")
        .map((c) =>
          JSON.stringify({
            BlockIO: `${n}MB / 0B`,
            CPUPerc: `${(5 + (n % 7) * 3).toFixed(2)}%`,
            Container: c.id.slice(0, 12),
            ID: c.id.slice(0, 12),
            MemPerc: "1.20%",
            MemUsage: `${20 + n}MiB / 1.9GiB`,
            Name: c.name,
            NetIO: `${n}kB / ${n * 2}kB`,
            PIDs: "5",
          }),
        );
      if (lines.length) void emit("docker://stats", { streamId: id, lines });
    }, 400),
  );
  return id;
}

export function eventsStart(): string {
  streamCounter += 1;
  const id = `devents-${streamCounter}`;
  kinds.set(id, "events");
  eventsStreamId = id;
  dockerFake.eventsRunning += 1;
  return id;
}

/** Test helper: push a log chunk into every open stream of `target`. */
export function pushLog(target: string, text: string): void {
  for (const s of dockerFake.logStreams) if (s.target === target && !ended.has(s.id)) void emit("docker://logs", { streamId: s.id, chunk: text, stream: "stdout" });
}

export function resetDocker(): void {
  Object.assign(dockerFake, {
    installed: true,
    daemon: true,
    denied: false,
    busybox: false,
    composeInvalid: "",
    containers: initialContainers(),
    calls: [],
  });
}
