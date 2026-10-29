#!/usr/bin/env node

// Exit codes: 0 = success, 1 = the command ran but failed, 2 = usage error.

// Flags each command accepts; anything else is a usage error (a typo in a
// flag must never silently fall back to a different behaviour).
const ALLOWED_FLAGS = {
  troubleshoot: ["--reset-profile", "--reset-config"],
  uninstall: ["--yes"],
};

async function printHelp(toStderr = false) {
  const { HELP_LINES } = await import("../dist/cli/common.min.js");
  const out = toStderr ? console.error : console.log;
  out("");
  out(HELP_LINES.join("\n"));
  out("");
}

/** Prints a command's report lines and sets the exit code from its `ok` flag. */
function finish(lines) {
  console.log(lines.join("\n"));
  if (lines.ok === false) process.exitCode = 1;
}

function usageError(message) {
  console.error("\x1b[31m" + message + "\x1b[0m");
  console.error("Run `web-mcp help` for usage.");
  process.exitCode = 2;
}

(async function() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);
  const flags = rest.filter(a => a.startsWith("--"));
  const positional = rest.filter(a => !a.startsWith("--"));

  if (command && command !== "mcp") {
    const allowed = ALLOWED_FLAGS[command] || [];
    const unknown = flags.filter(f => !allowed.includes(f));
    if (unknown.length > 0) return usageError(`Unknown option for "${command}": ${unknown.join(", ")}`);
  }

  if (!command) {
    const interactive = await import("../dist/cli/interactive.min.js");
    await interactive.run();
    return;
  }

  switch (command) {
    case "mcp":
      await import("../dist/mcp/wrapper.min.js");
      break;
    case "setup": {
      if (positional.length === 0) {
        const interactive = await import("../dist/cli/interactive.min.js");
        await interactive.run("SETUP_MENU");
        break;
      }
      const setup = await import("../dist/cli/setup.min.js");
      if (positional.length > 1 || !setup.SETUP_CLIENT_VALUES.includes(positional[0])) {
        return usageError(`Unknown client "${positional.join(" ")}". Valid clients: ${setup.SETUP_CLIENT_VALUES.join(", ")}`);
      }
      finish(await setup.configureClient(positional[0]));
      break;
    }
    case "uninstall": {
      if (positional.length === 0) {
        const interactive = await import("../dist/cli/interactive.min.js");
        await interactive.run("UNINSTALL_MENU");
        break;
      }
      const setup = await import("../dist/cli/setup.min.js");
      if (positional.length > 1 || !setup.UNINSTALL_CLIENT_VALUES.includes(positional[0])) {
        return usageError(`Unknown client "${positional.join(" ")}". Valid: ${setup.UNINSTALL_CLIENT_VALUES.join(", ")}`);
      }
      const confirmed = flags.includes("--yes");
      if (positional[0] === "all" && !confirmed) {
        return usageError(
          "`web-mcp uninstall all` removes web-mcp from every client and deletes ~/.web-mcp, including the\n" +
          "Web MCP browser profile (your saved logins). Re-run with --yes to confirm."
        );
      }
      finish(await setup.uninstallClient(positional[0], { confirmed }));
      break;
    }
    case "test": {
      console.log("Testing configurations...");
      const { testConfigurations } = await import("../dist/cli/setup.min.js");
      finish(await testConfigurations());
      break;
    }
    case "browser":
    case "launch": {
      const { launchBrowser } = await import("../dist/cli/browser.min.js");
      finish(await launchBrowser());
      break;
    }
    case "install-browser": {
      const { installBrowser } = await import("../dist/cli/browser.min.js");
      finish(await installBrowser());
      break;
    }
    case "troubleshoot": {
      const { runTroubleshooter } = await import("../dist/cli/troubleshoot.min.js");
      finish(await runTroubleshooter({
        resetProfile: flags.includes("--reset-profile"),
        resetConfig: flags.includes("--reset-config"),
      }));
      break;
    }
    case "stop": {
      const stop = await import("../dist/cli/stop.min.js");
      finish(await stop.stopProcesses());
      break;
    }
    case "status": {
      const status = await import("../dist/cli/status.min.js");
      finish(await status.getStatus());
      break;
    }
    case "-v":
    case "--version": {
      const fs = await import("fs");
      const path = await import("path");
      const { fileURLToPath } = await import("url");
      const __filename = fileURLToPath(import.meta.url);
      const pkgPath = path.join(path.dirname(__filename), "..", "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      console.log("Web MCP v" + pkg.version);
      break;
    }
    case "help":
    case "--help":
    case "-h":
      await printHelp();
      break;
    case "about":
      await printHelp();
      console.log("Web MCP is a dedicated browser automation layer designed for AI assistants.");
      console.log("It uses a local server and a dedicated Chromium extension to provide a");
      console.log("collision-free, transparent browser automation experience.");
      console.log("");
      break;
    default:
      console.error(`\x1b[31mUnknown command: ${command}\x1b[0m`);
      await printHelp(true);
      process.exitCode = 2;
  }
})().catch((err) => {
  console.error("\x1b[31m" + ((err && err.stack) || err) + "\x1b[0m");
  process.exitCode = 1;
});
