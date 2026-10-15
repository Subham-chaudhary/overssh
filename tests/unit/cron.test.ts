import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSchedule, nextRuns, parseCrontab, serializeCrontab, validateSchedule } from "../../src/lib/cron";

const from = new Date(2026, 9, 15, 10, 0, 0); // Thu 15 Oct 2026 10:00 local

test("a step that does not divide 60 is not described as 'every N minutes'", () => {
  // `*/45` runs at :00 and :45 of every hour, so 10:45 is followed by 11:00.
  const runs = nextRuns("*/45 * * * *", from, 2).map((d) => `${d.getHours()}:${d.getMinutes()}`);
  assert.deepEqual(runs, ["10:45", "11:0"]);
  assert.equal(describeSchedule("*/45 * * * *"), "every hour at minutes 0, 45");
  assert.equal(describeSchedule("*/90 * * * *"), "every hour");
  assert.equal(describeSchedule("*/7 * * * *"), "every hour at minutes 0, 7, 14, 21, 28, 35, 42, 49, 56");
  // Steps that divide the range keep the short text.
  assert.equal(describeSchedule("*/5 * * * *"), "every 5 minutes");
  assert.equal(describeSchedule("*/15 * * * *"), "every 15 minutes");
});

test("a step that does not divide 24 is not described as 'every N hours'", () => {
  assert.ok(!/every 7 hours/.test(describeSchedule("0 */7 * * *")));
  assert.ok(!/every 5 hours/.test(describeSchedule("0 */5 * * *")));
  assert.match(describeSchedule("0 */4 * * *"), /every 4 hours/);
});

test("a step that does not divide 12 is not described as 'every Nth month'", () => {
  assert.ok(!/5th month/.test(describeSchedule("0 0 1 */5 *")));
  assert.match(describeSchedule("0 0 1 */3 *"), /3rd month/);
});

test("day of week 7 is Sunday and ranges to 7 fold onto it", () => {
  const v = validateSchedule("0 0 * * 7");
  assert.ok(v.ok && v.parsed.dow.values.join() === "0");
  const r = validateSchedule("0 0 * * 5-7");
  assert.ok(r.ok && r.parsed.dow.values.join() === "0,5,6");
  assert.equal(describeSchedule("0 0 * * 0-7"), "every day at 00:00");
});

test("impossible dates never run, and nextRuns terminates", () => {
  assert.deepEqual(nextRuns("0 0 30 2 *", from, 3), []);
  assert.deepEqual(nextRuns("0 0 31 4 *", from, 3), []);
  const leap = nextRuns("0 0 29 2 *", from, 1);
  assert.equal(leap[0].getFullYear(), 2028);
});

test("@reboot and names", () => {
  assert.equal(describeSchedule("@reboot"), "at system startup");
  assert.deepEqual(nextRuns("@reboot", from), []);
  assert.equal(describeSchedule("0 9 * * mon-fri"), "at 09:00 on weekdays (Mon-Fri)");
  assert.ok(!validateSchedule("5-1 * * * *").ok);
  assert.ok(!validateSchedule("*/0 * * * *").ok);
  assert.ok(!validateSchedule("60 * * * *").ok);
  assert.ok(!validateSchedule("* * * * * *").ok);
});

test("day-of-month and day-of-week are OR-ed when both are restricted", () => {
  const runs = nextRuns("0 0 15 * 1", from, 3).map((d) => `${d.getMonth() + 1}/${d.getDate()}`);
  // Mon 19, Mon 26 (the 15th of this month is today at 00:00, already past), then 2 Nov.
  assert.deepEqual(runs, ["10/19", "10/26", "11/2"]);
});

test("crontab round trip keeps every non-job line verbatim", () => {
  const text = "# m h dom mon dow\nMAILTO=me@example.com\n\n*/5 * * * * /bin/true\n#0 3 * * * /bin/old\nnot a job\n";
  const lines = parseCrontab(text);
  assert.equal(serializeCrontab(lines), text);
  assert.deepEqual(
    lines.map((l) => l.kind),
    ["comment", "env", "blank", "job", "job", "unknown"],
  );
});
