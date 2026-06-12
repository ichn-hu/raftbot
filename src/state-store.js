import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class JsonStateStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  forAgent(agentId) {
    return new AgentJsonState(path.join(this.rootDir, agentId));
  }
}

class AgentJsonState {
  constructor(workspacePath) {
    this.workspacePath = workspacePath;
    this.statePath = path.join(workspacePath, "state.json");
    this.writeQueue = Promise.resolve();
  }

  async get(key, fallback = null) {
    const data = await this.readAll();
    return Object.hasOwn(data, key) ? data[key] : fallback;
  }

  async set(key, value) {
    await this.update((data) => {
      data[key] = value;
      return data;
    });
    return value;
  }

  async delete(key) {
    await this.update((data) => {
      delete data[key];
      return data;
    });
  }

  async all() {
    return this.readAll();
  }

  async update(mutator) {
    this.writeQueue = this.writeQueue.then(async () => {
      const current = await this.readAll();
      const next = await mutator({ ...current });
      await this.writeAll(next ?? current);
    });
    return this.writeQueue;
  }

  async readAll() {
    try {
      const text = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err?.code === "ENOENT") return {};
      throw err;
    }
  }

  async writeAll(data) {
    await mkdir(this.workspacePath, { recursive: true });
    const tmpPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    await rename(tmpPath, this.statePath);
  }
}
