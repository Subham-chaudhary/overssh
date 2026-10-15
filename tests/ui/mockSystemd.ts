// Fake systemd for the UI harness (docs/GUIDE.md §15.3.V): answers the `systemd_*` commands
// the Services tab calls. Scenarios drive it through `window.__systemd`.
// Chained into mockBackend.ts like mockSync.ts: returns `undefined` for commands it does not own.

interface FUnit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}
interface FFile {
  unit: string;
  state: string;
  preset: string | null;
}

export interface SystemdFake {
  /** "ok" | "nosystemd" (OpenRC host: probe says unavailable). */
  mode: "ok" | "nosystemd";
  /** "ok" = actions succeed; "password" = sudo -n fails with "a password is required". */
  sudo: "ok" | "password";
  /** 1500 extra units for the huge-list case. */
  big: boolean;
  /** Makes systemd_list reject with this message. */
  listError: string | null;
  /** systemd_list answers after this many ms (0 = at once): a refresh still in flight when the view changes. */
  listDelayMs: number;
  units: FUnit[];
  files: FFile[];
  calls: { cmd: string; args: Record<string, unknown> }[];
  actions: { action: string; unit: string | null; user: boolean; now: boolean }[];
}

const BS = String.fromCharCode(92);

function seed(): Pick<SystemdFake, "units" | "files"> {
  const u = (unit: string, active: string, sub: string, description: string, load = "loaded"): FUnit => ({ unit, load, active, sub, description });
  return {
    units: [
      u("ssh.service", "active", "running", "OpenBSD Secure Shell server"),
      u("nginx.service", "active", "running", "A high performance web server"),
      u("cron.service", "active", "running", "Regular background program processing daemon"),
      u("broken-job.service", "failed", "failed", "Nightly broken job"),
      u("backup.service", "inactive", "dead", "Backup run"),
      u("foo@bar.service", "active", "exited", "Foo instance bar"),
      u(`systemd-fsck@dev-disk-by${BS}x2duuid-ABCD.service`, "inactive", "dead", "File System Check on /dev/disk/by-uuid/ABCD"),
    ],
    files: [
      { unit: "ssh.service", state: "enabled", preset: "enabled" },
      { unit: "nginx.service", state: "enabled", preset: "enabled" },
      { unit: "cron.service", state: "enabled", preset: "enabled" },
      { unit: "broken-job.service", state: "disabled", preset: "disabled" },
      { unit: "backup.service", state: "static", preset: null },
      { unit: "foo@.service", state: "disabled", preset: null },
      { unit: "systemd-fsck@.service", state: "static", preset: null },
      { unit: "legacy.service", state: "disabled", preset: "disabled" },
      { unit: "masked-one.service", state: "masked", preset: "enabled" },
    ],
  };
}

export const fake: SystemdFake = {
  mode: "ok",
  sudo: "ok",
  big: false,
  listError: null,
  listDelayMs: 0,
  ...seed(),
  calls: [],
  actions: [],
};

declare global {
  interface Window {
    __systemd: {
      calls: () => { cmd: string; args: Record<string, unknown> }[];
      actions: () => SystemdFake["actions"];
      set: (patch: Partial<Pick<SystemdFake, "mode" | "sudo" | "big" | "listError" | "listDelayMs">>) => void;
      reset: () => void;
      unit: (name: string) => FUnit | undefined;
    };
  }
}

window.__systemd = {
  calls: () => fake.calls.map((c) => ({ cmd: c.cmd, args: { ...c.args } })),
  actions: () => fake.actions.map((a) => ({ ...a })),
  set: (patch) => Object.assign(fake, patch),
  reset: () => {
    Object.assign(fake, { mode: "ok", sudo: "ok", big: false, listError: null, listDelayMs: 0, ...seed(), calls: [], actions: [] });
  },
  unit: (name) => fake.units.find((x) => x.unit === name),
};

function allUnits(user: boolean): FUnit[] {
  if (user) return [{ unit: "pipewire.service", load: "loaded", active: "active", sub: "running", description: "PipeWire Multimedia Service" }];
  if (!fake.big) return fake.units;
  const extra: FUnit[] = [];
  for (let i = 0; i < 1500; i++) {
    extra.push({
      unit: `bulk${String(i).padStart(4, "0")}.service`,
      load: "loaded",
      active: i % 3 === 0 ? "inactive" : "active",
      sub: i % 3 === 0 ? "dead" : "running",
      description: `Bulk unit ${i}`,
    });
  }
  return [...fake.units, ...extra];
}

let cpuTick = 0;

export function systemdCommand(cmd: string, args: Record<string, unknown>): unknown {
  if (!cmd.startsWith("systemd_")) return undefined;
  fake.calls.push({ cmd, args: { ...args } });
  const user = args.user === true;
  switch (cmd) {
    case "systemd_probe":
      return fake.mode === "ok"
        ? { available: true, uid: 1000, user: "testuser", isRoot: false, sudo: true, version: "systemd 252 (252.22-1)", pid1: "systemd", userBus: true }
        : { available: false, uid: 1000, user: "testuser", isRoot: false, sudo: false, version: null, pid1: "openrc-init", userBus: false };

    case "systemd_list":
      if (fake.listError) throw { kind: "Other", message: fake.listError };
      if (fake.listDelayMs > 0) {
        const reply = { units: allUnits(user), unitFiles: user ? [] : fake.files, json: true };
        return new Promise((resolve) => setTimeout(() => resolve(reply), fake.listDelayMs));
      }
      return { units: allUnits(user), unitFiles: user ? [] : fake.files, json: true };

    case "systemd_failed":
      return allUnits(user)
        .filter((x) => x.active === "failed")
        .map((x) => x.unit);

    case "systemd_stats": {
      cpuTick += 1;
      return (args.units as string[]).map((unit, i) => ({
        unit,
        memory: unit === "nginx.service" ? 52 * 1024 * 1024 : (i + 1) * 1024 * 1024,
        cpuNs: cpuTick * (unit === "nginx.service" ? 400_000_000 : 1_000_000),
        tasks: 3,
        mainPid: 1000 + i,
      }));
    }

    case "systemd_show": {
      const unit = String(args.unit);
      const u = fake.units.find((x) => x.unit === unit);
      const f = fake.files.find((x) => x.unit === unit);
      return [
        { key: "Id", value: unit },
        { key: "Description", value: u?.description ?? "" },
        { key: "LoadState", value: u?.load ?? "not-found" },
        { key: "ActiveState", value: u?.active ?? "inactive" },
        { key: "SubState", value: u?.sub ?? "dead" },
        { key: "UnitFileState", value: f?.state ?? "" },
        { key: "FragmentPath", value: `/lib/systemd/system/${unit}` },
        { key: "MainPID", value: u?.active === "active" ? "1234" : "0" },
        { key: "MemoryCurrent", value: "54525952" },
        { key: "ExecStart", value: "{ path=/usr/sbin/nginx ; argv[]=/usr/sbin/nginx -g daemon on; ; ignore_errors=no }" },
        { key: "Restart", value: "on-failure" },
        { key: "WantedBy", value: "multi-user.target" },
        { key: "NeedDaemonReload", value: "no" },
      ];
    }

    case "systemd_text": {
      const unit = String(args.unit);
      switch (args.kind) {
        case "cat":
          return {
            code: 0,
            stdout: `# /lib/systemd/system/${unit}\n[Unit]\nDescription=${unit}\n\n[Service]\nExecStart=/usr/sbin/nginx\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n`,
            stderr: "",
          };
        case "deps":
          return {
            code: 0,
            stdout: `● ${unit}\n● ├─system.slice\n● ├─sysinit.target\n● │ ├─apparmor.service\n× │ └─broken-dep.service\n● └─-.mount\n`,
            stderr: "",
          };
        case "revdeps":
          return { code: 0, stdout: `● ${unit}\n● └─multi-user.target\n●   └─graphical.target\n`, stderr: "" };
        default:
          return { code: 0, stdout: `● ${unit} - fake\n     Active: active (running)\n`, stderr: "" };
      }
    }

    case "systemd_timers":
      return [
        { unit: "apt-daily.timer", activates: "apt-daily.service", next: (Date.now() + 3_600_000) * 1000, last: (Date.now() - 3_600_000) * 1000, text: "" },
        { unit: "backup.timer", activates: "backup.service", next: (Date.now() + 7_200_000) * 1000, last: null, text: "" },
      ];

    case "systemd_action": {
      const action = String(args.action);
      const unit = (args.unit as string | null) ?? null;
      fake.actions.push({ action, unit, user, now: args.now === true });
      const command = `${user ? "systemctl --user" : "sudo systemctl"} ${action}${unit ? ` ${unit}` : ""}`;
      if (!user && fake.sudo === "password") {
        return { ok: false, code: 1, stdout: "", stderr: "sudo: a password is required\n", error: "sudoPassword", command };
      }
      if (unit === "broken-job.service" && (action === "start" || action === "restart")) {
        return {
          ok: false,
          code: 1,
          stdout: "",
          stderr: "Job for broken-job.service failed because the control process exited with error code.\nSee \"systemctl status broken-job.service\" for details.\n",
          error: "failed",
          command,
        };
      }
      const u = fake.units.find((x) => x.unit === unit);
      const f = fake.files.find((x) => x.unit === unit);
      if (u) {
        if (action === "start" || action === "restart" || action === "reload-or-restart") Object.assign(u, { active: "active", sub: "running" });
        if (action === "stop" || action === "reset-failed") Object.assign(u, { active: "inactive", sub: "dead" });
      }
      if (f) {
        if (action === "enable") f.state = "enabled";
        if (action === "disable") f.state = "disabled";
        if (action === "mask") f.state = "masked";
        if (action === "unmask") f.state = "disabled";
      }
      return { ok: true, code: 0, stdout: "", stderr: "", error: null, command };
    }

    default:
      return null;
  }
}
