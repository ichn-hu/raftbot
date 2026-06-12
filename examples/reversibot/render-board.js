import { coordinateList, currentPlayerHandle, listLegalCommands, winnerText } from "./game.js";

const COLUMNS = "abcdefgh";

export function renderBoardHtml(game) {
  const legal = new Set(coordinateList(game.engineState.validMoves));
  const commands = listLegalCommands(game);
  const title = game.status === "active"
    ? `${currentPlayerHandle(game)} to move`
    : "Game complete";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>Reversibot ${escapeHtml(game.id)}</title>
<style>
:root {
  color-scheme: light;
  --board: #2f7d50;
  --board-dark: #256640;
  --ink: #15211a;
  --muted: #5f6d65;
  --line: #1f5135;
  --move: #f2c14e;
}
* { box-sizing: border-box; }
html {
  width: 100%;
  overflow-x: hidden;
  -webkit-text-size-adjust: 100%;
}
body {
  margin: 0;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  background: #fbfaf7;
  width: 100%;
  overflow-x: hidden;
}
.wrap {
  max-width: 760px;
  margin: 0 auto;
  padding: 20px;
}
header {
  display: grid;
  gap: 6px;
  margin-bottom: 16px;
}
h1 {
  margin: 0;
  font-size: 24px;
  line-height: 1.15;
  letter-spacing: 0;
}
.meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--muted);
  font-size: 14px;
}
.layout {
  display: grid;
  grid-template-columns: minmax(280px, 460px) minmax(220px, 1fr);
  gap: 18px;
  align-items: start;
}
.board {
  display: grid;
  grid-template-columns: 28px repeat(8, 1fr);
  grid-template-rows: 28px repeat(8, 1fr);
  aspect-ratio: 1 / 1;
  width: 100%;
  max-width: 460px;
  background: var(--board-dark);
  border: 2px solid #173b28;
  touch-action: manipulation;
}
.coord {
  display: grid;
  place-items: center;
  color: #ecf7ef;
  font-weight: 700;
  font-size: 13px;
}
.cell {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--board);
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 0;
  position: relative;
  font: inherit;
  touch-action: manipulation;
}
.disc {
  width: 68%;
  aspect-ratio: 1 / 1;
  border-radius: 50%;
  box-shadow: inset 0 2px 4px rgba(255,255,255,.24), inset 0 -3px 6px rgba(0,0,0,.26), 0 2px 4px rgba(0,0,0,.28);
}
.disc.black { background: #171918; }
.disc.white { background: #f2efe5; }
.legal {
  cursor: pointer;
  background: #348b5a;
}
.legal::before {
  content: attr(data-coord);
  width: 58%;
  aspect-ratio: 1 / 1;
  border-radius: 50%;
  display: grid;
  place-items: center;
  border: 2px solid rgba(242,193,78,.95);
  color: #fff7d6;
  font-weight: 800;
  font-size: 18px;
  background: rgba(20, 30, 24, .18);
}
.legal.selected::before {
  animation: selectedPulse .72s ease-in-out infinite alternate;
  border-color: #fff4a8;
  box-shadow: 0 0 0 4px rgba(242,193,78,.2), 0 0 18px rgba(242,193,78,.72);
}
@keyframes selectedPulse {
  from {
    transform: scale(.92);
    filter: brightness(.95);
  }
  to {
    transform: scale(1.06);
    filter: brightness(1.24);
  }
}
.side {
  display: grid;
  gap: 14px;
}
.section {
  border-top: 1px solid #d8d0c0;
  padding-top: 12px;
}
.section:first-child {
  border-top: 0;
  padding-top: 0;
}
h2 {
  margin: 0 0 8px;
  font-size: 15px;
  letter-spacing: 0;
}
p, ol {
  margin: 0;
  color: var(--muted);
  line-height: 1.45;
  font-size: 14px;
}
ol { padding-left: 20px; }
.commands {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.cmd {
  border: 1px solid #d6c38d;
  background: #fff9e6;
  color: #3a2b05;
  padding: 5px 7px;
  border-radius: 4px;
  font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  user-select: text;
}
.copybox {
  position: fixed;
  left: 0;
  top: 0;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  font-size: 16px;
}
.hint {
  min-height: 21px;
  color: #1f5135;
  font-weight: 700;
}
@media (max-width: 720px) {
  .layout { grid-template-columns: 1fr; }
  .wrap { padding: 14px; }
  .legal::before { font-size: 14px; }
}
</style>
</head>
<body>
<main class="wrap">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      <span>Black ${escapeHtml(game.players.black)}: ${game.engineState.blackScore}</span>
      <span>White ${escapeHtml(game.players.white)}: ${game.engineState.whiteScore}</span>
    </div>
  </header>
  <div class="layout">
    ${renderGrid(game, legal)}
    <aside class="side">
      <section class="section">
        <h2>Status</h2>
        <p>${escapeHtml(statusText(game))}</p>
      </section>
      <section class="section">
        <h2>Legal Commands</h2>
        <div class="commands">${commands.length ? commands.map((cmd) => `<code class="cmd">${escapeHtml(cmd)}</code>`).join("") : "<p>No legal moves.</p>"}</div>
      </section>
      <section class="section">
        <h2>How To Move</h2>
        <ol>
          <li>Only the current player may move.</li>
          <li>Send one legal command in this Slock thread, for example <code>/place d3</code>.</li>
          <li>Human players can click a highlighted square, press Ctrl+C or Cmd+C, then paste in the thread.</li>
        </ol>
      </section>
      <section class="section">
        <p class="hint" id="hint"></p>
      </section>
    </aside>
  </div>
  <textarea class="copybox" id="copybox" aria-hidden="true"></textarea>
</main>
<script>
const box = document.getElementById("copybox");
const hint = document.getElementById("hint");
document.querySelectorAll("[data-command]").forEach((el) => {
  el.addEventListener("click", async () => {
    const command = el.getAttribute("data-command");
    box.value = command;
    document.querySelectorAll(".legal.selected").forEach((selected) => {
      selected.classList.remove("selected");
    });
    el.classList.add("selected");
    try {
      box.focus({ preventScroll: true });
    } catch {
      box.focus();
    }
    box.select();
    hint.textContent = command + " selected. Press Ctrl+C / Cmd+C, then paste in the Slock thread.";
    try {
      await navigator.clipboard.writeText(command);
      hint.textContent = command + " copied. Paste it in the Slock thread.";
    } catch {}
  });
});
</script>
</body>
</html>`;
}

function renderGrid(game, legal) {
  const cells = ['<div class="coord"></div>'];
  for (const col of COLUMNS) cells.push(`<div class="coord">${col}</div>`);
  for (let row = 0; row < 8; row += 1) {
    cells.push(`<div class="coord">${row + 1}</div>`);
    for (let col = 0; col < 8; col += 1) {
      const coord = `${COLUMNS[col]}${row + 1}`;
      const cell = game.engineState.board[row][col];
      if (cell) {
        cells.push(`<div class="cell" aria-label="${coord} ${cell}"><span class="disc ${cell}"></span></div>`);
      } else if (game.status === "active" && legal.has(coord)) {
        cells.push(`<button class="cell legal" data-coord="${coord}" data-command="/place ${coord}" aria-label="/place ${coord}"></button>`);
      } else {
        cells.push(`<div class="cell" aria-label="${coord} empty"></div>`);
      }
    }
  }
  return `<section class="board" aria-label="Reversi board">${cells.join("")}</section>`;
}

function statusText(game) {
  if (game.status === "active") return `${currentPlayerHandle(game)} (${game.engineState.currentPlayer}) to move.`;
  return winnerText(game);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
