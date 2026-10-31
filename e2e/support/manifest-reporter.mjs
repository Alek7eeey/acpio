/**
 * The run's own index: one entry per finished test, with the paths of the
 * screenshot and the trace the run left behind.
 *
 * The HTML report keeps all of that inside its generated page, which nothing
 * outside the browser can read — so the slideshow (`npm run test:e2e:gallery`)
 * reads this file instead. Paths are relative to `tmp/e2e`, the folder that is
 * served when the slideshow is open.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "..", "tmp", "e2e", "manifest.json");
const BASE = path.dirname(OUT);

/** A path as the served page sees it: `artifacts/<test>/test-finished-1.png`. */
function relative(file) {
  if (!file) return null;
  return path.relative(BASE, file).split(path.sep).join("/");
}

export default class ManifestReporter {
  constructor() {
    this.tests = [];
  }

  onTestEnd(test, result) {
    const attachment = (name) => relative(result.attachments.find((a) => a.name === name)?.path);
    // titlePath() carries the project, the spec file and the test's own title
    // around the describe() chain — the slideshow only wants the chain.
    const project = test.parent.project()?.name ?? "";
    const group = test
      .titlePath()
      .filter((title) => title && title !== test.title && title !== project)
      .filter((title) => !/\.(spec|test)\.[cm]?[jt]sx?$/.test(title))
      .join(" › ");
    this.tests.push({
      project,
      group,
      title: test.title,
      file: relative(test.location.file),
      line: test.location.line,
      status: result.status,
      retry: result.retry,
      duration: Math.round(result.duration),
      screenshot: attachment("screenshot"),
      trace: attachment("trace"),
    });
  }

  onEnd() {
    fs.mkdirSync(BASE, { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(this.tests, null, 2));
  }
}
