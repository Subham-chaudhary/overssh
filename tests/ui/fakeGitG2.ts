// Fake `git_run` for the commit graph / details / diff scenarios 60-61 (docs/GUIDE.md §14.4.G2).
// It answers the exact argument shapes GitView sends and records every call.
// mockBackend.ts tries the handlers in `gitHandlers` in order; a handler returns
// null for args it does not know.

export interface GitOut {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export type GitHandler = (req: { repo: string; args: string[]; stdin: string | null }) => GitOut | null;

export const FAKE_REPO = "/home/testuser/projects";

const sha = (c: string) => c.repeat(40);
export const C1 = sha("1");
export const C2 = sha("2");
export const C3 = sha("3");
export const F1 = sha("a");
export const F2 = sha("b");
export const M1 = sha("f");

interface FakeCommit {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  at: number;
  subject: string;
  body?: string;
  refs: string;
}

const T = 1_700_000_000;
const SMALL: FakeCommit[] = [
  { sha: M1, parents: [C3, F2], author: "Ann Dev", email: "ann@example.com", at: T + 500, subject: "Merge branch 'feature'", refs: "HEAD -> main, origin/main" },
  { sha: F2, parents: [F1], author: "Bob Builder", email: "bob@example.com", at: T + 400, subject: "Add feature B", refs: "feature" },
  { sha: C3, parents: [C2], author: "Ann Dev", email: "ann@example.com", at: T + 300, subject: "Fix bug in parser", body: "The parser dropped the last token.\n\nCloses #12", refs: "" },
  { sha: F1, parents: [C2], author: "Bob Builder", email: "bob@example.com", at: T + 200, subject: "Add feature A", refs: "" },
  { sha: C2, parents: [C1], author: "Ann Dev", email: "ann@example.com", at: T + 100, subject: "Update readme", refs: "tag: v1.0" },
  { sha: C1, parents: [], author: "Ann Dev", email: "ann@example.com", at: T, subject: "Initial commit", refs: "" },
];

const FILES: Record<string, { ns: string; num: string }> = {
  [C1]: {
    ns: "A\0README.md\0A\0app.js\0",
    num: "1\t0\tREADME.md\0" + "1\t0\tapp.js\0",
  },
  [C2]: {
    ns: "M\0README.md\0R092\0old-name.txt\0docs/guide.md\0D\0legacy.txt\0M\0logo.png\0",
    num: "2\t1\tREADME.md\0" + "1\t1\t\0old-name.txt\0docs/guide.md\0" + "0\t3\tlegacy.txt\0" + "-\t-\tlogo.png\0",
  },
  [C3]: { ns: "M\0app.js\0", num: "1\t0\tapp.js\0" },
  [F1]: { ns: "A\0feature.txt\0", num: "1\t0\tfeature.txt\0" },
  [F2]: { ns: "M\0feature.txt\0", num: "1\t1\tfeature.txt\0" },
  [`${C3}>${M1}`]: { ns: "A\0feature.txt\0", num: "1\t0\tfeature.txt\0" },
  [`${F2}>${M1}`]: { ns: "M\0app.js\0", num: "1\t0\tapp.js\0" },
};

const BLOBS: Record<string, string> = {
  [`${C1}:README.md`]: "# Project\n",
  [`${C2}:README.md`]: "# Project\n\nA readme with more words.\n",
  [`${C1}:old-name.txt`]: "old line\nkept line\n",
  [`${C2}:docs/guide.md`]: "new line\nkept line\n",
  [`${C1}:legacy.txt`]: "legacy 1\nlegacy 2\nlegacy 3\n",
  [`${C1}:logo.png`]: "PNG\0\0binary",
  [`${C2}:logo.png`]: "PNG\0\0binary2",
  [`${C1}:app.js`]: "console.log('hi');\n",
  [`${C2}:app.js`]: "console.log('hi');\n",
  [`${C3}:app.js`]: "console.log('hi');\nconsole.log('fixed-parser');\n",
  [`${M1}:app.js`]: "console.log('hi');\nconsole.log('fixed-parser');\n",
  [`${F1}:feature.txt`]: "feature-a\n",
  [`${F2}:feature.txt`]: "feature-b\n",
  [`${M1}:feature.txt`]: "feature-b\n",
  // Index versions.
  [":app.js"]: "console.log('hello-index');\n",
  ["HEAD:app.js"]: "console.log('hi');\n",
};

const REFS = [
  "refs/heads/feature",
  "refs/heads/main",
  "refs/remotes/origin/HEAD",
  "refs/remotes/origin/main",
  "refs/tags/v1.0",
];

export const gitFake = {
  /** Scenarios 60-61 switch this on first; while off, this handler answers nothing (agent G1 mocks its own). */
  active: false,
  /** "small" (the 6-commit repo above) or "big" (1200 linear commits). */
  mode: "small" as "small" | "big",
  dirty: [" M app.js", "?? index.html"] as string[],
  calls: [] as { args: string[] }[],
  failNext: null as string | null,
  reset(): void {
    this.active = false;
    this.mode = "small";
    this.dirty = [" M app.js", "?? index.html"];
    this.calls = [];
    this.failNext = null;
  },
};

const BIG_COUNT = 1200;
function bigCommit(i: number): FakeCommit {
  // i = 0 is the newest commit.
  const n = BIG_COUNT - i;
  return {
    sha: n.toString(16).padStart(40, "0"),
    parents: i === BIG_COUNT - 1 ? [] : [(n - 1).toString(16).padStart(40, "0")],
    author: "Bulk Author",
    email: "bulk@example.com",
    at: T + n * 60,
    subject: `Bulk commit ${n}`,
    refs: i === 0 ? "HEAD -> main" : "",
  };
}

function commitList(max: number): FakeCommit[] {
  if (gitFake.mode === "small") return SMALL.slice(0, max);
  const out: FakeCommit[] = [];
  for (let i = 0; i < Math.min(max, BIG_COUNT); i++) out.push(bigCommit(i));
  return out;
}

const ok = (stdout = ""): GitOut => ({ code: 0, stdout, stderr: "", truncated: false });
const fail = (stderr: string, code = 128): GitOut => ({ code, stdout: "", stderr, truncated: false });
const FS = "\x1f";

export const gitHandlerG2: GitHandler = ({ args }) => {
  if (!gitFake.active) return null;
  const [cmd] = args;
  const mutating = ["checkout", "branch", "tag", "cherry-pick", "revert", "reset", "merge"].includes(cmd);
  gitFake.calls.push({ args: [...args] });

  if (mutating) {
    if (gitFake.failNext) {
      const m = gitFake.failNext;
      gitFake.failNext = null;
      return fail(m);
    }
    return ok();
  }

  switch (cmd) {
    case "rev-parse":
      return ok(args.includes("--show-toplevel") ? `${FAKE_REPO}\n` : "");

    case "log": {
      const max = Number(args.find((a) => a.startsWith("--max-count="))?.slice(12)) || 500;
      const out = commitList(max)
        .map((c) => [c.sha, c.parents.join(" "), c.author, c.email, String(c.at), String(c.at + 5), c.subject, c.refs].join(FS))
        .join("\0");
      return ok(out ? out + "\0" : "");
    }

    case "for-each-ref":
      return ok(gitFake.mode === "small" ? REFS.join("\n") + "\n" : "refs/heads/main\n");

    case "status":
      if (!args.includes("--porcelain=v1") || args.includes("--branch")) return null;
      return ok(gitFake.dirty.map((d) => d + "\0").join(""));

    case "show": {
      const target = args[args.length - 1];
      const c = SMALL.find((x) => x.sha === target) ?? (gitFake.mode === "big" ? bigCommit(BIG_COUNT - Number.parseInt(target, 16)) : undefined);
      if (!c) return fail(`fatal: bad object ${target}`);
      return ok(
        [
          c.sha,
          c.parents.join(" "),
          c.author,
          c.email,
          String(c.at),
          c.author,
          c.email,
          String(c.at + 5),
          c.refs,
          c.subject + (c.body ? `\n\n${c.body}` : "") + "\n",
        ].join(FS),
      );
    }

    case "diff-tree": {
      const numstat = args.includes("--numstat");
      const target = args[args.length - 1];
      const base = args[args.length - 2];
      const key = base === "--root" || !SMALL.some((c) => c.sha === base) ? target : `${base}>${target}`;
      const f = FILES[key] ?? FILES[target] ?? { ns: "", num: "" };
      return ok(numstat ? f.num : f.ns);
    }

    case "cat-file": {
      const spec = args[args.length - 1];
      const blob = BLOBS[spec];
      if (blob === undefined) {
        const path = spec.slice(spec.indexOf(":") + 1);
        return fail(`fatal: path '${path}' does not exist in '${spec.slice(0, spec.indexOf(":")) || "index"}'`);
      }
      return ok(blob);
    }

    default:
      return null;
  }
};
