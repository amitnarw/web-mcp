import { Orb } from "./orb.js";
import { HELP_LINES } from "./common.js";

type ViewState = "MAIN" | "SETUP_MENU" | "UNINSTALL_MENU" | "CONFIRM_UNINSTALL_ALL" | "INFO_VIEW";

const MAIN_OPTIONS = [
  { value: "setup", label: "Configure AI Client (Setup)" },
  { value: "test", label: "Test Setup & Configurations" },
  { value: "browser", label: "Launch Browser Manually" },
  { value: "troubleshoot", label: "Troubleshoot & Fix Issues" },
  { value: "uninstall", label: "Uninstall Web MCP" },
  { value: "status", label: "Check Server & Chromium Status" },
  { value: "stop", label: "Stop Server & Chromium" },
  { value: "help", label: "CLI Commands & Shortcuts" },
  { value: "about", label: "About Web MCP" },
  { value: "exit", label: "Exit" }
];

export async function run(startState: ViewState = "MAIN", initialInfoLines: string[] = []) {
  // Check before emitting any alt-screen / cursor / mouse escape codes, so a
  // piped or scripted invocation gets a clean message instead of garbage.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Interactive mode requires a TTY. Please run this command in a terminal.");
    console.error("For scripts and agents use e.g. `web-mcp setup cursor` (run `web-mcp help` for all commands).");
    process.exit(1);
  }

  const orb = new Orb();
  const { UNINSTALL_OPTIONS: UNINSTALL_MENU_OPTIONS } = await import("./setup.js");
  // The destructive "all" entry is never pre-selected: the uninstall menu opens on Cancel.
  const uninstallDefaultIndex = Math.max(0, UNINSTALL_MENU_OPTIONS.findIndex(o => o.value === "cancel"));

  let currentState: ViewState = startState;
  let mainIndex = 0;
  let setupIndex = 0;
  let uninstallIndex = uninstallDefaultIndex;

  let infoLines: string[] = initialInfoLines;
  let isProcessing = false;
  let configuredClients: string[] = [];

  let time = 0;
  let debugMsg = "Waiting for input...";

  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1002h\x1b[?1015h\x1b[?1006h");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<void>((resolve) => {
    let inputBuffer = "";
    let escTimeout: NodeJS.Timeout | null = null;

    const processBuffer = async () => {
      while (inputBuffer.length > 0) {
        let key = "";
        let isMouse = false;
        let isUp = false;
        let isDownKey = false;
        let isEnter = false;
        let isEsc = false;
        let isCtrlC = false;
        
        let button = -1;
        let y = -1;
        let isDown = false;

        const sgrMatch = inputBuffer.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
        const x11Match = inputBuffer.match(/^\x1b\[M(.)(.)(.)/);
        const ansiMatch = inputBuffer.match(/^\x1b\[[0-9;]*[a-zA-Z]/);

        if (sgrMatch) {
          key = sgrMatch[0];
          isMouse = true;
          button = parseInt(sgrMatch[1]);
          y = parseInt(sgrMatch[3]);
          isDown = sgrMatch[4] === 'M';
          debugMsg = `SGR Mouse: btn=${button} y=${y} isDown=${isDown}`;
        } else if (x11Match) {
          key = x11Match[0];
          isMouse = true;
          const bChar = x11Match[1].charCodeAt(0) - 32;
          y = x11Match[3].charCodeAt(0) - 32;
          isDown = (bChar & 3) !== 3;
          if (bChar === 64 || bChar === 96) button = 64;
          else if (bChar === 65 || bChar === 97) button = 65;
          else button = bChar & 3;
          debugMsg = `X11 Mouse: btn=${button} y=${y} isDown=${isDown}`;
        } else if (ansiMatch) {
          key = ansiMatch[0];
          if (key === "\x1b[A") isUp = true;
          if (key === "\x1b[B") isDownKey = true;
          debugMsg = `ANSI Key: ${key.replace(/\x1b/g, 'ESC')}`;
        } else if (inputBuffer.startsWith("\x1b")) {
          if (inputBuffer === "\x1b") {
            key = "\x1b";
            isEsc = true;
            debugMsg = `ESC Pressed`;
          } else if (inputBuffer.length < 16 && !inputBuffer.includes("M") && !inputBuffer.includes("m") && !inputBuffer.match(/[a-zA-Z]/)) {
            return; 
          } else {
            key = inputBuffer[0]; 
            debugMsg = `Unknown ESC sequence start`;
          }
        } else {
          key = inputBuffer[0];
          if (key === "\r" || key === "\n") isEnter = true;
          if (key === "\u0003") isCtrlC = true;
          debugMsg = `Raw Char: charCode=${key.charCodeAt(0)}`;
        }

        inputBuffer = inputBuffer.slice(key.length);

        if (isCtrlC) {
          cleanup();
          process.exit(0);
        }

        if (isProcessing) continue;

        if (isMouse && button !== -1) {
          if (button === 64) isUp = true;
          else if (button === 65) isDownKey = true;
          else if (isDown) {
            // It's a click. Let's process it.
            const menuStartY = 12;
            const optionIndex = y - menuStartY;
            
            if (currentState === "MAIN") {
              if (optionIndex >= 0 && optionIndex < MAIN_OPTIONS.length) {
                mainIndex = optionIndex;
                isEnter = true;
                debugMsg += ` -> Selected MAIN[${optionIndex}]`;
              } else {
                debugMsg += ` -> Missed MAIN (idx=${optionIndex})`;
              }
            } else if (currentState === "SETUP_MENU") {
              const { SETUP_OPTIONS } = await import("./setup.js");
              if (optionIndex >= 0 && optionIndex < SETUP_OPTIONS.length) {
                setupIndex = optionIndex;
                isEnter = true;
                debugMsg += ` -> Selected SETUP[${optionIndex}]`;
              } else {
                debugMsg += ` -> Missed SETUP (idx=${optionIndex})`;
              }
            } else if (currentState === "UNINSTALL_MENU") {
              const { UNINSTALL_OPTIONS } = await import("./setup.js");
              if (optionIndex >= 0 && optionIndex < UNINSTALL_OPTIONS.length) {
                uninstallIndex = optionIndex;
                isEnter = true;
              }
            }
          }
        }

        if (currentState === "MAIN") {
          if (isUp) mainIndex = Math.max(0, mainIndex - 1);
          else if (isDownKey) mainIndex = Math.min(MAIN_OPTIONS.length - 1, mainIndex + 1);
          else if (isEnter) {
            const sel = MAIN_OPTIONS[mainIndex].value;
            if (sel === "exit") {
              cleanup();
              process.exit(0);
            } else if (sel === "setup") {
              isProcessing = true;
              const { getConfiguredClients } = await import("./setup.js");
              configuredClients = getConfiguredClients();
              currentState = "SETUP_MENU";
              setupIndex = 0;
              isProcessing = false;
            } else if (sel === "uninstall") {
              isProcessing = true;
              currentState = "UNINSTALL_MENU";
              uninstallIndex = uninstallDefaultIndex;
              isProcessing = false;
            } else if (sel === "test") {
              isProcessing = true;
              infoLines = ["\x1b[36mTesting configurations...\x1b[0m"];
              currentState = "INFO_VIEW";
              const { testConfigurations } = await import("./setup.js");
              infoLines = await testConfigurations();
              isProcessing = false;
            } else if (sel === "browser") {
              isProcessing = true;
              infoLines = ["\x1b[36mLaunching Chromium...\x1b[0m"];
              currentState = "INFO_VIEW";
              const { launchBrowser } = await import("./browser.js");
              infoLines = await launchBrowser((lines) => { infoLines = lines; });
              isProcessing = false;
            } else if (sel === "troubleshoot") {
              isProcessing = true;
              infoLines = ["\x1b[36mTroubleshooting...\x1b[0m"];
              currentState = "INFO_VIEW";
              const { runTroubleshooter } = await import("./troubleshoot.js");
              infoLines = await runTroubleshooter({}, (lines) => { infoLines = lines; });
              isProcessing = false;
            } else if (sel === "status") {
              isProcessing = true;
              infoLines = ["\x1b[36mChecking status...\x1b[0m"];
              currentState = "INFO_VIEW";
              const { getStatus } = await import("./status.js");
              infoLines = await getStatus();
              isProcessing = false;
            } else if (sel === "stop") {
              isProcessing = true;
              infoLines = ["\x1b[36mStopping processes...\x1b[0m"];
              currentState = "INFO_VIEW";
              const { stopProcesses } = await import("./stop.js");
              infoLines = await stopProcesses();
              isProcessing = false;
            } else if (sel === "help") {
              infoLines = [...HELP_LINES];
              currentState = "INFO_VIEW";
            } else if (sel === "about") {
              infoLines = [
                "\x1b[1mWeb MCP - In-Browser Copilot\x1b[0m",
                "",
                "Web MCP is a dedicated browser automation layer for AI assistants.",
                "It runs a local server and Chromium extension to ensure stable,",
                "collision-free execution with complete visual transparency."
              ];
              currentState = "INFO_VIEW";
            }
          }
        } 
        else if (currentState === "SETUP_MENU") {
          if (isEsc) {
            currentState = "MAIN";
            continue;
          }
          
          const { SETUP_OPTIONS } = await import("./setup.js");
          if (isUp) setupIndex = Math.max(0, setupIndex - 1);
          else if (isDownKey) setupIndex = Math.min(SETUP_OPTIONS.length - 1, setupIndex + 1);
          else if (isEnter) {
            const sel = SETUP_OPTIONS[setupIndex].value;
            if (sel === "cancel") {
              currentState = "MAIN";
            } else {
              isProcessing = true;
              infoLines = ["\x1b[36mConfiguring...\x1b[0m"];
              currentState = "INFO_VIEW";
              const { configureClient } = await import("./setup.js");
              infoLines = await configureClient(sel);
              isProcessing = false;
            }
          }
        }
        else if (currentState === "UNINSTALL_MENU") {
          if (isEsc) {
            currentState = "MAIN";
            continue;
          }
          
          const { UNINSTALL_OPTIONS } = await import("./setup.js");
          if (isUp) uninstallIndex = Math.max(0, uninstallIndex - 1);
          else if (isDownKey) uninstallIndex = Math.min(UNINSTALL_OPTIONS.length - 1, uninstallIndex + 1);
          else if (isEnter) {
            const sel = UNINSTALL_OPTIONS[uninstallIndex].value;
            if (sel === "cancel") {
              currentState = "MAIN";
            } else if (sel === "all") {
              currentState = "CONFIRM_UNINSTALL_ALL";
            } else {
              isProcessing = true;
              infoLines = ["\x1b[36mUninstalling...\x1b[0m"];
              currentState = "INFO_VIEW";
              const { uninstallClient } = await import("./setup.js");
              infoLines = await uninstallClient(sel);
              isProcessing = false;
            }
          }
        }
        else if (currentState === "CONFIRM_UNINSTALL_ALL") {
          // Only an explicit "y" proceeds; any other key (or a click) cancels.
          if (key === "y" || key === "Y") {
            isProcessing = true;
            infoLines = ["\x1b[36mUninstalling from all clients...\x1b[0m"];
            currentState = "INFO_VIEW";
            const { uninstallClient } = await import("./setup.js");
            infoLines = await uninstallClient("all", { confirmed: true });
            isProcessing = false;
          } else if (!isMouse || isDown) {
            currentState = "UNINSTALL_MENU";
            uninstallIndex = uninstallDefaultIndex;
          }
        }
        else if (currentState === "INFO_VIEW") {
          if (isEnter || isEsc || (isMouse && button !== -1 && isDown)) {
            currentState = "MAIN";
          }
        }
      }
    };

    const onData = (chunk: string) => {
      inputBuffer += chunk;
      
      if (escTimeout) {
        clearTimeout(escTimeout);
        escTimeout = null;
      }
      
      processBuffer();
      
      if (inputBuffer === "\x1b") {
        escTimeout = setTimeout(() => {
          processBuffer();
        }, 50);
      }
    };
    
    process.stdin.on("data", onData);

    const renderLoop = setInterval(async () => {
      let out = "";
      
      out += `\x1b[1mWeb MCP\x1b[0m\x1b[K\n`;
      out += `\x1b[90mIn-Browser Copilot\x1b[0m\x1b[K\n`;
      out += `\x1b[K\n`;
      
      const orbFrames = orb.render(time);
      for (let i = 0; i < orbFrames.length; i++) {
        out += `${orbFrames[i]}\x1b[K\n`;
      }
      
      out += `\x1b[K\n`;
      
      if (currentState === "MAIN") {
        out += `\x1b[1mWhat would you like to do?\x1b[0m\x1b[K\n`;
        out += `\x1b[90mUse arrow keys or mouse. Press Enter to select.\x1b[0m\x1b[K\n`;
        
        for (let i = 0; i < MAIN_OPTIONS.length; i++) {
          if (i === mainIndex) {
            out += `> \x1b[36m${MAIN_OPTIONS[i].label}\x1b[0m\x1b[K\n`;
          } else {
            out += `  ${MAIN_OPTIONS[i].label}\x1b[K\n`;
          }
        }
      } 
      else if (currentState === "SETUP_MENU") {
        out += `\x1b[1mWhich AI client would you like to configure?\x1b[0m\x1b[K\n`;
        out += `\x1b[90mPress Esc to cancel.\x1b[0m\x1b[K\n`;
        
        const { SETUP_OPTIONS } = await import("./setup.js");
        for (let i = 0; i < SETUP_OPTIONS.length; i++) {
          const opt = SETUP_OPTIONS[i];
          const isConfigured = configuredClients.includes(opt.value);
          const tick = isConfigured ? " \x1b[32m[✓]\x1b[0m" : "";
          
          if (i === setupIndex) {
            out += `> \x1b[36m${opt.label}\x1b[0m${tick}\x1b[K\n`;
          } else {
            out += `  ${opt.label}${tick}\x1b[K\n`;
          }
        }
      }
      else if (currentState === "UNINSTALL_MENU") {
        out += `\x1b[1mWhich AI client should we uninstall from?\x1b[0m\x1b[K\n`;
        out += `\x1b[90mPress Esc to cancel.\x1b[0m\x1b[K\n`;
        
        const { UNINSTALL_OPTIONS } = await import("./setup.js");
        for (let i = 0; i < UNINSTALL_OPTIONS.length; i++) {
          const opt = UNINSTALL_OPTIONS[i];
          if (i === uninstallIndex) {
            out += `> \x1b[36m${opt.label}\x1b[0m\x1b[K\n`;
          } else {
            out += `  ${opt.label}\x1b[K\n`;
          }
        }
      }
      else if (currentState === "CONFIRM_UNINSTALL_ALL") {
        out += `\x1b[1m\x1b[31mUninstall from ALL clients?\x1b[0m\x1b[K\n`;
        out += `\x1b[K\n`;
        out += `This removes web-mcp from every configured AI client, stops Web MCP,\x1b[K\n`;
        out += `and deletes its local data — including the Web MCP browser profile,\x1b[K\n`;
        out += `so \x1b[1msaved logins in the Web MCP browser will be removed\x1b[0m.\x1b[K\n`;
        out += `\x1b[K\n`;
        out += `Proceed? \x1b[1m(y/N)\x1b[0m\x1b[K\n`;
      }
      else if (currentState === "INFO_VIEW") {
        for (const line of infoLines) {
          out += `${line}\x1b[K\n`;
        }
        out += `\x1b[K\n`;
        if (!isProcessing) {
          out += `\x1b[90m[ Press Enter or click to return to main menu ]\x1b[0m\x1b[K\n`;
        }
      }
      
      let uiLines = out.split("\n");
      if (uiLines[uiLines.length - 1] === "") {
        uiLines.pop(); 
      }
      
      const maxRows = Math.max(1, (process.stdout.rows || 24) - 1);
      if (uiLines.length > maxRows) {
        uiLines = uiLines.slice(0, maxRows); 
      }
      
      process.stdout.write(`\x1b[H${uiLines.join("\n")}\x1b[J`);
      
      time += 0.1;
    }, 50);

    function cleanup() {
      clearInterval(renderLoop);
      if (escTimeout) clearTimeout(escTimeout);
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdout.write("\x1b[?1049l\x1b[?1002l\x1b[?1015l\x1b[?1006l\x1b[?25h\n");
    }
  });
}
