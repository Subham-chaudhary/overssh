import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LogBuffer,
  buildProjects,
  buildPruneCommands,
  buildRmArgs,
  buildRunArgs,
  classifyDockerError,
  cjoin,
  cparent,
  looksBinary,
  lsNeedsFallback,
  parseLsLa,
  composeArgs,
  composeErrorLine,
  composeValidateArgs,
  dedupePorts,
  eventKind,
  execShellCommand,
  formatBytes,
  friendlyDockerError,
  isBuiltinNetwork,
  parseComposeLs,
  parseContainers,
  parseDf,
  parseEventLine,
  parseHistory,
  parseImages,
  parseInfo,
  parseInspect,
  parseJsonLines,
  parseLabels,
  parseNetworks,
  parsePortsString,
  parseReclaimed,
  parseSize,
  parseStatLine,
  parseTable,
  parseTime,
  parseVolumes,
  projectServices,
  splitWords,
  stripAnsi,
} from "../../src/lib/docker/parse";

const ps = (o: Record<string, unknown>) => JSON.stringify(o);

test("parseSize handles docker units, spaces and junk", () => {
  assert.equal(parseSize("1.5GB"), 1.5e9);
  assert.equal(parseSize("300MiB"), 300 * 1024 ** 2);
  assert.equal(parseSize("12.3 kB"), 12300);
  assert.equal(parseSize("0B"), 0);
  assert.equal(parseSize("--"), 0);
  assert.equal(parseSize(""), 0);
  assert.equal(parseSize("abc"), 0);
  assert.equal(parseSize(2048), 2048);
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(0), "0 B");
});

test("parseJsonLines accepts lines, arrays, blank lines and skips malformed", () => {
  assert.deepEqual(parseJsonLines(""), []);
  assert.deepEqual(parseJsonLines('{"a":1}\n\n{bad\n{"b":2}\r\n'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseJsonLines('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseJsonLines("WARNING: something\n{\"a\":1}"), [{ a: 1 }]);
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
});

test("parseLabels from docker string and podman object", () => {
  assert.deepEqual(parseLabels("a=1,b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseLabels("com.docker.compose.project=app,x=a,b"), { "com.docker.compose.project": "app", x: "a,b" });
  assert.deepEqual(parseLabels({ a: "1", n: 2 }), { a: "1", n: "2" });
  assert.deepEqual(parseLabels(""), {});
});

test("parseTime", () => {
  assert.equal(parseTime("2024-05-01 10:00:00 +0000 UTC"), Date.parse("2024-05-01T10:00:00Z") / 1000);
  assert.equal(parseTime("2024-05-01 10:00:00 +0200 CEST"), Date.parse("2024-05-01T08:00:00Z") / 1000);
  assert.equal(parseTime(1700000000), 1700000000);
  assert.equal(parseTime("1700000000"), 1700000000);
  assert.equal(parseTime(""), 0);
  assert.equal(parseTime("yesterday"), 0);
});

test("parsePortsString: mappings, expose-only, ranges, ipv6 twins", () => {
  const p = parsePortsString("0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp, 127.0.0.1:9000-9001->9000-9001/udp");
  assert.equal(p.length, 5);
  assert.deepEqual(p[0], { hostIp: "0.0.0.0", hostPort: 8080, containerPort: 80, proto: "tcp" });
  assert.equal(p[1].hostIp, "::");
  assert.deepEqual(p[2], { hostIp: "", hostPort: null, containerPort: 443, proto: "tcp" });
  assert.equal(p[4].hostPort, 9001);
  assert.equal(dedupePorts(p).length, 4);
  assert.deepEqual(parsePortsString(""), []);
  assert.deepEqual(parsePortsString("garbage"), []);
});

test("parseContainers: docker ps -a json lines, compose labels, health", () => {
  const text = [
    ps({
      ID: "abc123def456",
      Names: "web",
      Image: "nginx:latest",
      Command: '"/docker-entrypoint.…"',
      CreatedAt: "2024-05-01 10:00:00 +0000 UTC",
      RunningFor: "2 hours ago",
      Ports: "0.0.0.0:8080->80/tcp, :::8080->80/tcp",
      State: "running",
      Status: "Up 2 hours (healthy)",
      Labels: "com.docker.compose.project=shop,com.docker.compose.service=web",
      Networks: "shop_default",
      Mounts: "shop_data,/etc/x",
    }),
    ps({ ID: "111", Names: "old", Image: "alpine", State: "exited", Status: "Exited (0) 3 days ago", Ports: "", Labels: "" }),
    "not json",
    ps({ nothing: true }),
  ].join("\n");
  const cs = parseContainers(text);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].name, "web");
  assert.equal(cs[0].state, "running");
  assert.equal(cs[0].health, "healthy");
  assert.equal(cs[0].project, "shop");
  assert.equal(cs[0].service, "web");
  assert.equal(cs[0].ports.length, 1);
  assert.deepEqual(cs[0].mounts, ["shop_data", "/etc/x"]);
  assert.equal(cs[1].state, "exited");
  assert.equal(cs[1].ports.length, 0);
});

test("parseContainers: older docker without State, unhealthy and paused", () => {
  const cs = parseContainers(
    [
      ps({ ID: "a1", Names: "a", Image: "i", Status: "Up 3 hours (Paused)" }),
      ps({ ID: "a2", Names: "b", Image: "i", Status: "Up 3 hours (unhealthy)" }),
      ps({ ID: "a3", Names: "c", Image: "i", Status: "Created" }),
      ps({ ID: "a4", Names: "d", Image: "i", Status: "Restarting (1) 5 seconds ago" }),
    ].join("\n"),
  );
  assert.deepEqual(cs.map((c) => c.state), ["paused", "running", "created", "restarting"]);
  assert.equal(cs[1].health, "unhealthy");
});

test("parseContainers: podman array form", () => {
  const text = JSON.stringify([
    {
      Id: "fedcba9876543210",
      Names: ["db"],
      Image: "docker.io/library/postgres:16",
      Command: ["postgres"],
      Created: 1700000000,
      State: "running",
      Status: "Up 5 minutes",
      Ports: [{ host_ip: "", container_port: 5432, host_port: 5432, range: 1, protocol: "tcp" }],
      Labels: { "io.podman.compose.project": "app", "io.podman.compose.service": "db" },
    },
  ]);
  const [c] = parseContainers(text);
  assert.equal(c.name, "db");
  assert.equal(c.id, "fedcba9876543210");
  assert.equal(c.createdAt, 1700000000);
  assert.equal(c.ports[0].hostPort, 5432);
  assert.equal(c.project, "app");
  assert.equal(c.service, "db");
});

test("parseContainers: empty list", () => {
  assert.deepEqual(parseContainers(""), []);
  assert.deepEqual(parseContainers("\n\n"), []);
  assert.deepEqual(parseContainers("[]"), []);
});

test("parseImages: tagged, dangling, registry port, podman names", () => {
  const imgs = parseImages(
    [
      ps({ ID: "sha256:aaaaaaaaaaaaaaaa", Repository: "nginx", Tag: "latest", Size: "187MB", CreatedSince: "2 weeks ago", Containers: "N/A" }),
      ps({ ID: "bbbbbbbbbbbb", Repository: "<none>", Tag: "<none>", Size: "1.2GB" }),
      ps({ ID: "cccccccccccc", Names: ["localhost:5000/team/app:1.2"], Size: 1048576 }),
      ps({ Id: "dddddddddddd", Names: ["<none>:<none>"] }),
    ].join("\n"),
  );
  assert.equal(imgs.length, 4);
  assert.equal(imgs[0].ref, "nginx:latest");
  assert.equal(imgs[0].id, "aaaaaaaaaaaa");
  assert.equal(imgs[0].size, 187e6);
  assert.equal(imgs[1].dangling, true);
  assert.equal(imgs[1].ref, "bbbbbbbbbbbb");
  assert.equal(imgs[2].repository, "localhost:5000/team/app");
  assert.equal(imgs[2].tag, "1.2");
  assert.equal(imgs[2].size, 1048576);
  assert.equal(imgs[3].dangling, true);
});

test("parseVolumes and parseNetworks", () => {
  const vols = parseVolumes(
    [ps({ Name: "pgdata", Driver: "local", Mountpoint: "/var/lib/docker/volumes/pgdata/_data", Labels: "com.docker.compose.project=shop", Scope: "local" }), ps({ Driver: "x" })].join("\n"),
  );
  assert.equal(vols.length, 1);
  assert.equal(vols[0].project, "shop");
  assert.equal(vols[0].mountpoint, "/var/lib/docker/volumes/pgdata/_data");
  const nets = parseNetworks(
    [ps({ ID: "0123456789abcdef", Name: "bridge", Driver: "bridge", Scope: "local", Internal: "false", IPv6: "false" }), ps({ Id: "ff", Name: "shop_default", Driver: "bridge", Internal: true })].join("\n"),
  );
  assert.equal(nets.length, 2);
  assert.equal(nets[0].id, "0123456789ab");
  assert.equal(isBuiltinNetwork(nets[0]), true);
  assert.equal(isBuiltinNetwork(nets[1]), false);
  assert.equal(nets[1].internal, true);
  assert.deepEqual(parseVolumes(""), []);
  assert.deepEqual(parseNetworks("garbage"), []);
});

test("compose ls and project merge from labels", () => {
  const ls = parseComposeLs('[{"Name":"shop","Status":"running(2), exited(1)","ConfigFiles":"/srv/shop/compose.yml,/srv/shop/override.yml"}]');
  assert.equal(ls[0].running, 2);
  assert.equal(ls[0].total, 3);
  assert.deepEqual(ls[0].configFiles, ["/srv/shop/compose.yml", "/srv/shop/override.yml"]);
  assert.deepEqual(parseComposeLs(""), []);
  assert.deepEqual(parseComposeLs("No resource found"), []);
  const cs = parseContainers(
    [
      ps({ ID: "1", Names: "shop-web-1", Image: "i", State: "running", Status: "Up", Labels: "com.docker.compose.project=shop,com.docker.compose.service=web" }),
      ps({
        ID: "2",
        Names: "blog-db-1",
        Image: "i",
        State: "exited",
        Status: "Exited (1)",
        Labels: "com.docker.compose.project=blog,com.docker.compose.service=db,com.docker.compose.project.config_files=/b/c.yml,com.docker.compose.project.working_dir=/b",
      }),
    ].join("\n"),
  );
  const merged = buildProjects(ls, cs);
  assert.deepEqual(merged.map((p) => p.name), ["blog", "shop"]);
  assert.equal(merged[0].configFiles[0], "/b/c.yml");
  assert.equal(merged[0].status, "exited(1)");
  assert.equal(merged[1].running, 1);
  assert.equal(projectServices("shop", cs)[0].service, "web");
});

test("parseDf docker and missing fields", () => {
  const rows = parseDf(
    [
      ps({ Type: "Images", TotalCount: "5", Active: "2", Size: "1.2GB", Reclaimable: "800MB (66%)" }),
      ps({ Type: "Containers", TotalCount: "3", Active: "1", Size: "10kB", Reclaimable: "5kB (50%)" }),
      ps({ Type: "Build Cache", TotalCount: "0", Active: "0", Size: "0B", Reclaimable: "0B" }),
    ].join("\n"),
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].reclaimable, 800e6);
  assert.equal(rows[0].percent, 66);
  assert.equal(rows[0].reclaimableText, "800MB");
  assert.equal(rows[2].percent, 0);
  assert.deepEqual(parseDf(""), []);
});

test("parseStatLine docker and malformed", () => {
  const s = parseStatLine(
    '\x1b[2J\x1b[H{"BlockIO":"1.5MB / 2kB","CPUPerc":"12.50%","Container":"abc","ID":"abc123456789xyz","MemPerc":"1.20%","MemUsage":"10MiB / 1.9GiB","Name":"web","NetIO":"1kB / 2kB","PIDs":"3"}',
    42,
  );
  assert.ok(s);
  assert.equal(s.name, "web");
  assert.equal(s.cpu, 12.5);
  assert.equal(s.memUsed, 10 * 1024 ** 2);
  assert.equal(s.netTx, 2000);
  assert.equal(s.blockRead, 1.5e6);
  assert.equal(s.pids, 3);
  assert.equal(s.t, 42);
  assert.equal(parseStatLine("CONTAINER ID  NAME"), null);
  const dash = parseStatLine('{"Name":"x","CPUPerc":"--","MemUsage":"0B / 0B","NetIO":"0B / 0B","BlockIO":"0B / 0B","MemPerc":"--","PIDs":"0"}');
  assert.equal(dash?.cpu, 0);
});

test("parseEventLine and eventKind", () => {
  const e = parseEventLine('{"status":"start","id":"abc","from":"nginx","Type":"container","Action":"start","Actor":{"ID":"abc","Attributes":{"name":"web"}},"time":1700000000}');
  assert.ok(e);
  assert.equal(e.type, "container");
  assert.equal(e.name, "web");
  assert.equal(eventKind(e), "containers");
  const x = parseEventLine('{"Type":"container","Action":"exec_start: sh","Actor":{"ID":"a","Attributes":{}}}');
  assert.equal(x?.action, "exec_start");
  assert.equal(eventKind(x!), null);
  // Healthchecks send exec_die every few seconds; it must not refresh the lists.
  assert.equal(eventKind(parseEventLine('{"Type":"container","Action":"exec_die","Actor":{"ID":"a","Attributes":{}}}')!), null);
  assert.equal(eventKind(parseEventLine('{"Type":"container","Action":"health_status: unhealthy","Actor":{"ID":"a","Attributes":{}}}')!), "containers");
  assert.equal(eventKind(parseEventLine('{"Type":"image","Action":"pull","Actor":{"ID":"i"}}')!), "images");
  assert.equal(eventKind(parseEventLine('{"Type":"volume","Action":"create","Actor":{"ID":"v"}}')!), "volumes");
  assert.equal(eventKind(parseEventLine('{"Type":"daemon","Action":"reload","Actor":{"ID":"v"}}')!), null);
  assert.equal(parseEventLine("{}"), null);
  assert.equal(parseEventLine("nope"), null);
});

test("parseInspect container", () => {
  const raw = [
    {
      Id: "abc123def4567890",
      Name: "/web",
      Created: "2024-05-01T10:00:00Z",
      RestartCount: 2,
      State: { Status: "running", Running: true, Paused: false, ExitCode: 0, StartedAt: "x", Pid: 99 },
      Config: {
        Image: "nginx",
        Env: ["PATH=/usr/bin", "DB_PASSWORD=s3cr=t", "EMPTY"],
        Cmd: ["nginx", "-g", "daemon off;"],
        Entrypoint: null,
        Labels: { a: "b" },
      },
      HostConfig: { RestartPolicy: { Name: "on-failure", MaximumRetryCount: 3 }, Privileged: false },
      Mounts: [{ Type: "bind", Source: "/srv/x", Destination: "/x", Mode: "ro", RW: false }, { Type: "volume", Name: "v", Source: "/var/lib/docker/volumes/v/_data", Destination: "/data", RW: true }],
      NetworkSettings: {
        Ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }], "443/tcp": null },
        Networks: { bridge: { IPAddress: "172.17.0.2", Gateway: "172.17.0.1", MacAddress: "02:42" } },
      },
    },
  ];
  const i = parseInspect(JSON.stringify(raw));
  assert.ok(i);
  assert.equal(i.name, "web");
  assert.equal(i.id, "abc123def456");
  assert.deepEqual(i.env[1], { key: "DB_PASSWORD", value: "s3cr=t" });
  assert.deepEqual(i.env[2], { key: "EMPTY", value: "" });
  assert.equal(i.restartPolicy, "on-failure:3");
  assert.equal(i.mounts.length, 2);
  assert.equal(i.mounts[0].rw, false);
  assert.equal(i.ports.length, 2);
  assert.equal(i.ports[0].hostPort, 8080);
  assert.equal(i.ports[1].hostPort, null);
  assert.equal(i.networks[0].ip, "172.17.0.2");
  assert.deepEqual(i.entrypoint, []);
  assert.equal(parseInspect("[]"), null);
  assert.equal(parseInspect("not json"), null);
  assert.equal(parseInspect(""), null);
});

test("parseHistory and parseTable", () => {
  const h = parseHistory(
    [
      ps({ ID: "sha256:abcdefabcdef1234", CreatedBy: "/bin/sh -c #(nop)  CMD [\"nginx\"]", CreatedSince: "2 weeks ago", Size: "0B" }),
      ps({ ID: "<missing>", CreatedBy: "/bin/sh -c apt-get update", Size: "55.1MB" }),
    ].join("\n"),
  );
  assert.equal(h[0].createdBy, 'CMD ["nginx"]');
  assert.equal(h[1].createdBy, "RUN apt-get update");
  assert.equal(h[1].size, 55.1e6);
  const t = parseTable("UID   PID   PPID  C  STIME  TTY  TIME  CMD\nroot  1234  1     0  10:00  ?    00:00:01  nginx: master process  -g\n");
  assert.equal(t.columns.length, 8);
  assert.equal(t.rows[0][7], "nginx: master process  -g");
  assert.deepEqual(parseTable(""), { columns: [], rows: [] });
});

test("classifyDockerError", () => {
  assert.equal(classifyDockerError(127, "", "env: 'docker': No such file or directory"), "missing");
  assert.equal(classifyDockerError(127, "", "sh: docker: command not found"), "missing");
  assert.equal(classifyDockerError(1, "", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"), "daemon-down");
  assert.equal(
    classifyDockerError(1, "", "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get http://x: dial unix /var/run/docker.sock: connect: permission denied"),
    "denied",
  );
  assert.equal(classifyDockerError(1, "", "sudo: a password is required"), "sudo-password");
  assert.equal(classifyDockerError(125, "", "Error: unable to connect to Podman socket"), "daemon-down");
  assert.equal(classifyDockerError(1, "", "something odd"), "error");
});

test("parseInfo docker, rootless and podman", () => {
  const d = parseInfo(
    ps({ ServerVersion: "26.1.0", OperatingSystem: "Ubuntu 22.04", Name: "vm1", Containers: 4, ContainersRunning: 2, Images: 9, SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"], ClientInfo: { Plugins: [{ Name: "compose", Version: "v2.27.0" }] } }),
  );
  assert.ok(d);
  assert.equal(d.engine, "docker");
  assert.equal(d.version, "26.1.0");
  assert.equal(d.rootless, true);
  assert.equal(d.composeVersion, "2.27.0");
  const p = parseInfo(JSON.stringify({ host: { hostname: "h", security: { rootless: true } }, version: { Version: "4.9.0" } }), "podman");
  assert.equal(p?.engine, "podman");
  assert.equal(p?.version, "4.9.0");
  assert.equal(p?.rootless, true);
  assert.equal(parseInfo(""), null);
});

test("friendlyDockerError trims prefixes and usage noise", () => {
  assert.equal(friendlyDockerError("Error response from daemon: No such container: x\n"), "No such container: x");
  assert.equal(friendlyDockerError(""), "docker command failed");
  assert.equal(friendlyDockerError("\x1b[31mError: bad\x1b[0m\nUsage: docker rm"), "bad");
});

test("argument builders", () => {
  assert.deepEqual(
    buildRunArgs({ image: " nginx ", name: "web", ports: ["8080:80", ""], env: ["A=1"], volumes: ["/h:/c:ro"], restart: "always", command: "sh -c 'echo hi there'" }),
    ["run", "-d", "--name", "web", "--restart", "always", "-p", "8080:80", "-e", "A=1", "-v", "/h:/c:ro", "nginx", "sh", "-c", "echo hi there"],
  );
  assert.deepEqual(buildRunArgs({ image: "alpine", detach: false, rm: true }), ["run", "--rm", "alpine"]);
  assert.deepEqual(buildRmArgs("web", { force: true, volumes: true }), ["rm", "-f", "-v", "web"]);
  assert.deepEqual(splitWords('a "b c" \'d e\' ""'), ["a", "b c", "d e", ""]);
  assert.equal(execShellCommand("docker", "abc"), "docker exec -it 'abc' sh -c 'command -v bash >/dev/null && exec bash || exec sh'");
  assert.ok(execShellCommand("sudo docker", "a'b").startsWith("sudo docker exec -it 'a'\\''b'"));
  assert.deepEqual(buildPruneCommands({ containers: true, images: true, allImages: true, volumes: false, networks: true, buildCache: false }), [
    ["container", "prune", "-f"],
    ["image", "prune", "-a", "-f"],
    ["network", "prune", "-f"],
  ]);
  assert.deepEqual(buildPruneCommands({ containers: false, images: true, allImages: false, volumes: true, networks: false, buildCache: true }), [
    ["image", "prune", "-f"],
    ["volume", "prune", "-f"],
    ["builder", "prune", "-f"],
  ]);
  assert.equal(parseReclaimed("Deleted\nTotal reclaimed space: 1.5GB"), 1.5e9);
  assert.equal(parseReclaimed("nothing"), 0);
});

test("LogBuffer splits chunks, keeps partial lines, caps", () => {
  const b = new LogBuffer(10);
  assert.equal(b.push("a\nb"), 1);
  assert.equal(b.pending(), "b");
  assert.equal(b.push("c\r\nd\n"), 2);
  assert.deepEqual(b.lines.map((l) => l.text), ["a", "bc", "d"]);
  b.push("err\n", "stderr");
  assert.equal(b.lines[3].stream, "stderr");
  b.push("tail");
  assert.equal(b.finish(), 1);
  assert.equal(b.lines[b.lines.length - 1].text, "tail");
  for (let i = 0; i < 30; i++) b.push(`l${i}\n`);
  assert.ok(b.lines.length <= 11);
  assert.ok(b.dropped > 0);
  assert.equal(b.lines[b.lines.length - 1].text, "l29");
  b.clear();
  assert.equal(b.lines.length, 0);
});

test("compose argument builders", () => {
  assert.deepEqual(composeArgs("shop", ["up", "-d"], { files: ["/a/c.yml", "/a/o.yml"], workdir: "/a" }), [
    "compose", "-p", "shop", "-f", "/a/c.yml", "-f", "/a/o.yml", "--project-directory", "/a", "up", "-d",
  ]);
  assert.deepEqual(composeArgs("shop", ["down"]), ["compose", "-p", "shop", "down"]);
  assert.deepEqual(composeValidateArgs(["/a/c.yml"]), ["compose", "-f", "/a/c.yml", "config", "-q"]);
  assert.equal(composeErrorLine("yaml: line 12: mapping values are not allowed here"), 12);
  assert.equal(composeErrorLine("/a/compose.yml:7:3 bad"), 7);
  assert.equal(composeErrorLine("no hint"), null);
});

test("parseLsLa: GNU epoch form, symlinks, spaces, device files", () => {
  const out = [
    "total 20",
    "drwxr-xr-x   1 root root 4096 1700000000 .",
    "drwxr-xr-x   1 root root 4096 1700000000 ..",
    "-rw-r--r--   1 root root  220 1699999999 .bashrc",
    "drwxr-xr-x   2 root root 4096 1700000100 etc",
    "lrwxrwxrwx   1 root root    7 1700000200 bin -> usr/bin",
    "-rw-r--r--   1 app  app    12 1700000300 my file.txt",
    "crw-rw-rw-   1 root root 1, 3 1700000400 null",
  ].join("\n");
  const e = parseLsLa(out);
  assert.deepEqual(e.map((x) => x.name), ["etc", ".bashrc", "bin", "my file.txt", "null"]);
  assert.equal(e[0].kind, "dir");
  assert.equal(e[2].kind, "link");
  assert.equal(e[2].target, "usr/bin");
  assert.equal(e[3].size, 12);
  assert.equal(e[3].mtime, 1700000300);
  assert.equal(e[4].kind, "other");
});

test("parseLsLa: busybox / default date forms", () => {
  const e = parseLsLa(
    [
      "total 8",
      "drwxr-xr-x    2 root     root          4096 Jan  1 12:00 bin",
      "-rw-r--r--    1 root     root           123 Dec 25  2023 notes.txt",
      "lrwxrwxrwx    1 root     root             9 Jan  1 12:00 lib -> /usr/lib",
      "garbage line",
    ].join("\n"),
  );
  assert.deepEqual(e.map((x) => x.name), ["bin", "lib", "notes.txt"]);
  assert.equal(e[2].mtimeText, "Dec 25  2023");
  assert.equal(e[2].mtime, 0);
  assert.equal(parseLsLa("").length, 0);
});

test("ls fallback detection and container paths", () => {
  assert.equal(lsNeedsFallback(1, "ls: unrecognized option: time-style=+%s"), true);
  assert.equal(lsNeedsFallback(2, "ls: /nope: No such file or directory"), false);
  assert.equal(lsNeedsFallback(0, ""), false);
  assert.equal(cjoin("/etc", "hosts"), "/etc/hosts");
  assert.equal(cjoin("/etc", ".."), "/");
  assert.equal(cjoin("/etc/x", "../y/./z"), "/etc/y/z");
  assert.equal(cjoin("/", "/abs"), "/abs");
  assert.equal(cparent("/"), "/");
  assert.equal(cparent("/a/b"), "/a");
  assert.equal(looksBinary("abc\0def"), true);
  assert.equal(looksBinary("plain text"), false);
});
