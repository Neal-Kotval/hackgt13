import { chromium, expect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { prepareAuth } from "./auth-fixture.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-select-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
const fixture = await prepareAuth(directory);
const origin = "http://127.0.0.1:3162";
process.env.BETTER_AUTH_URL = origin;
const server = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3162",
  ],
  { env: process.env, stdio: "ignore" },
);
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + "/sign-in")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw Error("Select browser server did not start");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const width of [375, 768, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    await context.addCookies(
      fixture.users[0].cookie.split("; ").map((cookie) => {
        const index = cookie.indexOf("=");
        return {
          name: cookie.slice(0, index),
          value: cookie.slice(index + 1),
          url: origin,
        };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/design-system");
    const specimen = page.getByRole("combobox", { name: "Activity view" });
    await specimen.focus();
    await page.keyboard.press("Space");
    await expect(
      page.getByRole("option", { name: "All activity", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("option", { name: "Agent activity", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(specimen).toHaveText("Agent activity");
    await expect(specimen).toBeFocused();
    await specimen.press("Space");
    await expect(
      page.getByRole("option", { name: "Agent activity", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("h");
    await expect(
      page.getByRole("option", { name: "Human activity", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(specimen).toHaveText("Human activity");
    await specimen.press("Space");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(specimen).toBeFocused();
    await expect(page.getByRole("listbox")).toHaveCount(0);

    await page.goto(origin + "/projects/new");
    await page
      .getByLabel("Project name", { exact: true })
      .fill(`Select review ${width}`);
    await page
      .getByLabel("Git repository")
      .fill("https://github.com/example/select-review");
    await page.getByRole("combobox", { name: /Template/ }).click();
    await page
      .getByRole("option", { name: "React + Python API", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await page
      .getByRole("heading", { name: `Select review ${width}`, exact: true })
      .waitFor();
    const projectId = new URL(page.url()).pathname.split("/").pop();
    const readProject = async () =>
      (
        await (await page.request.get(origin + "/api/state")).json()
      ).projects.find((project) => project.id === projectId);
    expect((await readProject()).template).toBe("React + Python API");
    const agent = await page.request.post(origin + "/api/state", {
      data: {
        type: "addAgent",
        projectId,
        client: "Codex",
        role: "Browser verification",
      },
    });
    expect(agent.ok()).toBeTruthy();
    await page.reload();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("combobox", { name: /Depends on/ }).click();
    await expect(page.getByRole("listbox")).toBeVisible();
    expect(
      await page
        .getByRole("listbox")
        .evaluate((element) => Boolean(element.closest("dialog"))),
    ).toBeTruthy();
    await expect(
      page.getByRole("option", { name: "No dependency", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page
      .getByRole("option", { name: "No dependency", exact: true })
      .click();
    await page.getByLabel("What needs to be done?").fill("No dependency task");
    await page
      .getByRole("button", { name: "Create task", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const task = (await readProject()).tasks[0];
    expect(task.title).toBe("No dependency task");
    expect(task.dependency ?? "").toBe("");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("combobox", { name: /Depends on/ }).click();
    await page
      .getByRole("option", { name: "No dependency task", exact: true })
      .click();
    expect(
      await page
        .getByRole("dialog")
        .locator("form")
        .evaluate((form) => new FormData(form).get("dependency")),
    ).toBe(task.id);
    await page.getByRole("combobox", { name: /Depends on/ }).click();
    await page
      .getByRole("option", { name: "No dependency", exact: true })
      .click();
    expect(
      await page
        .getByRole("dialog")
        .locator("form")
        .evaluate((form) => new FormData(form).get("dependency")),
    ).toBe("");
    await page.keyboard.press("Escape");

    await page.getByRole("link", { name: "Resources", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Resources", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("link", { name: "Workspace", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.goto(origin + "/organizations");
    await page
      .getByRole("button", { name: "Grant project access", exact: true })
      .click();
    await expect(
      page.locator('[role="combobox"][aria-invalid="true"]'),
    ).toHaveCount(2);
    await expect(
      page.getByText("Choose an option.", { exact: true }),
    ).toHaveCount(2);
    await page.getByRole("combobox", { name: "Active organization" }).click();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    expect(
      await listbox.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= 0 &&
          rect.right <= innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= innerHeight
        );
      }),
    ).toBeTruthy();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
    console.log(
      `PASS ${width}px: keyboard/typeahead, form submission, empty values, required validation, dialog portal, navigation and menu bounds`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
  fixture.getDatabase().close();
  await rm(directory, { recursive: true, force: true });
}
